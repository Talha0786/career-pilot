import { z } from 'zod';
import {
  asUserId, asApplicationId, asJobPostingId, uuidv7,
  notFound, validationFailed, type Result, ok, err, type DomainError,
} from '@careerpilot/domain';
import type { ApplicationRepository, JobPostingRepository, Actor } from '../../ports/repositories.js';
import type { InterviewPrepRepository } from '../../ports/interview-prep.port.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import type { WebSearchPort, WebFetchPort } from '../../ports/research.port.js';

export const MAX_TOOL_CALLS = 8;

const CitationValidator = z.object({ url: z.string().url(), title: z.string().max(300).optional() });
const RawClaimValidator = z.object({ claim: z.string().min(1).max(1000), citations: z.array(CitationValidator).max(5) });
const RawBriefValidator = z.object({
  companyName: z.string().min(1).max(300),
  summary: z.string().max(2000),
  claims: z.array(RawClaimValidator).max(30),
});

const ActionValidator = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), query: z.string().min(1).max(300) }),
  z.object({ action: z.literal('fetch'), url: z.string().url() }),
  z.object({ action: z.literal('final'), brief: RawBriefValidator }),
]);

export interface CompanyResearchClaim {
  claim: string;
  citations: { url: string; title?: string | undefined }[];
}
export interface CompanyResearchBriefResult {
  companyName: string;
  summary: string;
  claims: CompanyResearchClaim[];
  droppedUncitedClaimCount: number;
  toolCallsUsed: number;
}
export interface ResearchCompanyInput {
  applicationId: string;
}
export interface ResearchCompanyOutput {
  interviewPrepId: string;
  brief: CompanyResearchBriefResult;
}

/**
 * Task 060 — `docs/06-agent-design.md` §5's bounded tool loop: "max 8 tool
 * calls: web search/fetch -> synthesize brief with citations. No write
 * tools. Output schema-validated; uncited claims dropped."
 *
 * The `LlmPort` (ADR-006) has no native function/tool-calling parameter —
 * this loop is a text-protocol ReAct pattern instead (the model responds
 * with ONE of `{action:"search"|"fetch"|"final", ...}` per turn, see
 * `prompts/company-research/v1.md`), which is a legitimate, real tool-loop
 * implementation, just not backed by a provider-native tool-calling API.
 *
 * The 8-call cap is enforced by a plain loop counter that increments ONLY
 * on `search`/`fetch` actions — `final` doesn't consume budget (it's the
 * terminal decision). If the model never emits `final` within 8 tool
 * calls, the loop stops and returns a typed failure — this is the "a
 * pathological forever-searching fake tool response still terminates at
 * 8" acceptance criterion, verified with a fake LLM that always requests
 * another search.
 *
 * Citation enforcement is POST-validation, not just prompted: every claim
 * in the model's raw `final` brief is checked against the set of URLs
 * actually observed via `search`/`fetch` THIS session (`seenUrls`) — a
 * citation to a URL the model never actually looked at is treated the
 * same as no citation at all (dropped), closing the gap a purely
 * prompt-based "must cite" instruction can't close on its own (mirrors
 * task 040's adversarial-verification posture, applied to "must cite a
 * real source" instead of "must cite a profile fact").
 */
export function makeResearchCompanyUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
  interviewPreps: InterviewPrepRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  search: WebSearchPort;
  fetcher: WebFetchPort;
  model: string;
}) {
  return async function researchCompany(
    actor: Actor,
    input: ResearchCompanyInput,
  ): Promise<Result<ResearchCompanyOutput, DomainError>> {
    const userId = asUserId(actor.userId);
    const applicationId = asApplicationId(input.applicationId);

    const app = await deps.applications.findByIdForUser(applicationId, userId);
    if (app === null) return err(notFound('Application not found'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(app.jobPostingId), userId);
    if (job === null) return err(notFound('Job posting not found'));

    const promptResult = await deps.prompts.load('company-research');
    if (!promptResult.ok) return err(validationFailed(`Could not load company-research prompt: ${promptResult.error.message}`));
    const prompt = promptResult.value;

    const companyName = job.company ?? job.title;
    const transcriptLines: string[] = [];
    const seenUrls = new Set<string>();
    let toolCallsUsed = 0;

    while (toolCallsUsed < MAX_TOOL_CALLS) {
      const promptText = prompt.render({
        company_name: companyName,
        job_title: job.title,
        max_tool_calls: String(MAX_TOOL_CALLS),
        remaining_calls: String(MAX_TOOL_CALLS - toolCallsUsed),
        transcript: transcriptLines.length > 0 ? transcriptLines.join('\n') : '(nothing yet — this is your first turn)',
      });

      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText, jsonSchema: { type: 'object' }, temperature: prompt.frontmatter.temperature },
        { userId: actor.userId, refId: input.applicationId, context: 'agent' },
      );
      if (!completion.ok) return err(validationFailed(`LLM call failed: ${completion.error.message}`));

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        transcriptLines.push('SYSTEM: your last response was not valid JSON. Respond with ONLY the action JSON object.');
        continue;
      }
      const parsedAction = ActionValidator.safeParse(parsedJson);
      if (!parsedAction.success) {
        transcriptLines.push('SYSTEM: your last response did not match the required action schema. Respond with ONLY one action JSON object (search, fetch, or final).');
        continue;
      }
      const action = parsedAction.data;

      if (action.action === 'search') {
        toolCallsUsed += 1;
        const results = await deps.search.search(action.query);
        for (const r of results) seenUrls.add(normalizeUrl(r.url));
        transcriptLines.push(
          `SEARCH "${action.query}" -> ${results.length === 0 ? '(no results)' : results.map((r) => `[${r.title}](${r.url}): ${r.snippet}`).join(' | ')}`,
        );
        continue;
      }

      if (action.action === 'fetch') {
        toolCallsUsed += 1;
        const result = await deps.fetcher.fetch(action.url);
        seenUrls.add(normalizeUrl(result.url));
        transcriptLines.push(`FETCH ${action.url} -> ${result.title ?? '(no title)'}: ${result.text.slice(0, 1500)}`);
        continue;
      }

      // action.action === 'final'
      const brief = stripUncitedClaims(action.brief, seenUrls);
      const id = uuidv7();
      const content: CompanyResearchBriefResult = { ...brief, toolCallsUsed };
      await deps.interviewPreps.save({ id, applicationId: input.applicationId, kind: 'company_research', content });
      return ok({ interviewPrepId: id, brief: content });
    }

    return err(validationFailed(`Company research did not finish within the ${MAX_TOOL_CALLS}-tool-call budget`, {
      toolCallsUsed: String(toolCallsUsed),
    }));
  };
}

/**
 * Drops any claim whose EVERY citation is either absent or points to a URL
 * this session never actually observed (`seenUrls`) — "schema-enforced,
 * not just prompted" per the task's acceptance criterion. A claim
 * survives only if at least one of its citations matches a URL actually
 * seen via search/fetch this session.
 */
function stripUncitedClaims(
  raw: z.infer<typeof RawBriefValidator>,
  seenUrls: Set<string>,
): { companyName: string; summary: string; claims: CompanyResearchClaim[]; droppedUncitedClaimCount: number } {
  const kept: CompanyResearchClaim[] = [];
  let dropped = 0;
  for (const claim of raw.claims) {
    const validCitations = claim.citations.filter((c) => seenUrls.has(normalizeUrl(c.url)));
    if (validCitations.length === 0) {
      dropped += 1;
      continue;
    }
    kept.push({ claim: claim.claim, citations: validCitations });
  }
  return { companyName: raw.companyName, summary: raw.summary, claims: kept, droppedUncitedClaimCount: dropped };
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '').toLowerCase();
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
