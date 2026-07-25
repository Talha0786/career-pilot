import { z } from 'zod';
import {
  MatchScore, asCareerProfileId, asUserId, compileFactList,
  notFound, validationFailed, type Result, ok, err, type DomainError, type ScoreComponents,
} from '@careerpilot/domain';
import type { JobPosting } from '@careerpilot/domain';
import type { ProfileRepository, JobPostingRepository, MatchScoreRepository } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';

/** BullMQ queue name for an on-demand or job-triggered rescan (task 038). */
export const MATCH_SCORE_QUEUE = 'matching.score_requested';

/**
 * Application-layer zod validator for the LLM's raw JSON response (ADR-006:
 * "structured outputs validated with zod"). Deliberately NOT imported from
 * `@careerpilot/contracts` — this package's own `package.json` declares zod
 * directly and has no dependency on the contracts package (contracts is the
 * HTTP/DTO boundary; validating an LLM's output is an application-layer
 * concern, same boundary `resume-field-mapper.ts` would live at if it
 * needed schema validation). Field-for-field identical to
 * `packages/contracts/src/matching.ts`'s `ScoreComponentsSchema` — keep
 * them in sync if the rubric shape ever changes.
 */
const ScoreComponentsValidator = z.object({
  skills: z.number().min(0).max(1),
  experience: z.number().min(0).max(1),
  seniority: z.number().min(0).max(1),
  domain: z.number().min(0).max(1),
  location: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

export interface ScoreMatchRequestedPayload {
  readonly profileId: string;
  readonly userId: string;
  readonly limit?: number | undefined;
}

const DEFAULT_PREFILTER_LIMIT = 20;
const CLOSED_STATUSES = ['closed', 'expired'] as const;

export interface ScoreMatchInput {
  profileId: string;
  userId: string;
  limit?: number | undefined;
}

export interface ScoreMatchFailure {
  readonly jobPostingId: string;
  readonly reason: string;
}

export interface ScoreMatchOutput {
  readonly scored: MatchScore[];
  readonly failures: ScoreMatchFailure[];
}

/**
 * Orchestrates the match-rubric-scoring pipeline (task 038,
 * docs/06-agent-design.md §3): ANN prefilter (task 036) narrows the
 * candidate pool to the top-N nearest job postings by embedding, THEN a
 * guarded LLM call scores each candidate against the rubric prompt (task
 * 034's `prompts/match-score/v1.md`) — the whole point of the prefilter is
 * that the (potentially expensive) LLM pass only ever runs against the
 * prefiltered set, never every posting a user has, which this function
 * enforces structurally (it never even reads postings outside what
 * `findNearestByEmbedding` returns).
 *
 * Per-candidate failures (a malformed LLM response that doesn't recover
 * after one repair attempt, a budget refusal, a provider error) do NOT
 * abort the batch — they're collected in `failures` so one bad candidate
 * can't silently swallow every other candidate's score. This mirrors the
 * job-posting/profile embedding handlers' "log and move on" posture for
 * per-item failures, just surfaced back to the caller instead of only to a
 * logger, since this command IS the caller-facing unit of work (unlike the
 * fire-and-forget worker handlers).
 */
export function makeScoreMatchUseCase(deps: {
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  matchScores: MatchScoreRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
}) {
  return async function scoreMatch(input: ScoreMatchInput): Promise<Result<ScoreMatchOutput, DomainError>> {
    const profileId = asCareerProfileId(input.profileId);
    const userId = asUserId(input.userId);

    const profile = await deps.profiles.findByIdForUser(profileId, userId);
    if (profile === null) {
      return err(notFound('Career profile not found'));
    }
    if (profile.embedding === null || profile.embeddingStatus !== 'ready') {
      return err(validationFailed('Profile has no ready embedding yet — cannot prefilter candidates', {
        embeddingStatus: profile.embeddingStatus,
      }));
    }

    const candidates = await deps.jobPostings.findNearestByEmbedding(profile.embedding, {
      limit: input.limit ?? DEFAULT_PREFILTER_LIMIT,
      excludeStatuses: CLOSED_STATUSES,
    });

    const promptResult = await deps.prompts.load('match-score');
    if (!promptResult.ok) {
      return err(validationFailed(`Could not load match-score prompt: ${promptResult.error.message}`));
    }
    const prompt = promptResult.value;

    const facts = compileFactList(profile);
    const factsText = facts.length > 0
      ? facts.map((f) => `${f.id}: ${f.text}`).join('\n')
      : '(no profile facts yet)';

    const scored: MatchScore[] = [];
    const failures: ScoreMatchFailure[] = [];

    for (const job of candidates) {
      const result = await scoreOneCandidate({
        profile, job, factsText, promptRender: prompt.render, temperature: prompt.frontmatter.temperature,
        model: deps.model, llm: deps.llm, userId: input.userId,
      });
      if (result.ok) {
        await deps.matchScores.save(result.value);
        scored.push(result.value);
      } else {
        failures.push({ jobPostingId: job.id, reason: result.error.message });
      }
    }

    return ok({ scored, failures });
  };
}

/**
 * Exported (task 057's `match_job` MCP tool reuses this instead of
 * forking a second implementation of the same LLM-call/repair/validate
 * sequence) — behavior unchanged from the private helper `score-match.ts`
 * already had; this is purely a visibility change.
 */
export async function scoreOneCandidate(args: {
  profile: { id: string; factsHash: string; embeddingModel: string | null };
  job: JobPosting;
  factsText: string;
  promptRender: (vars: Record<string, string>) => string;
  temperature: number;
  model: string;
  llm: GuardedLlmPort;
  userId: string;
}): Promise<Result<MatchScore, DomainError | LlmError>> {
  const vars = {
    profile_facts: args.factsText,
    job_title: args.job.title,
    job_company: args.job.company ?? 'Unknown',
    job_description: args.job.descriptionMd,
  };

  const basePrompt = args.promptRender(vars);

  const attempt = async (promptText: string): Promise<Result<ScoreComponents, DomainError | LlmError>> => {
    const completion = await args.llm.complete(
      // `jsonSchema` presence (not its content, see llm.port.ts) is what
      // makes `OpenAiCompatibleLlmAdapter` set `response_format:
      // {type:'json_object'}` — found missing here by task 042's real-Ollama
      // eval run: without it, a small key-free local model (llama3.1) relies
      // on prompt instructions alone and sometimes emits prose-wrapped or
      // truncated JSON that fails even the ADR-006 one-repair-attempt retry.
      // Cheap, structural fix; does not change what's asked of the model,
      // only how the provider is told to constrain decoding.
      { model: args.model, prompt: promptText, jsonSchema: { type: 'object' }, temperature: args.temperature },
      { userId: args.userId, refId: args.job.id, context: 'matching' },
    );
    if (!completion.ok) return completion;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonObject(completion.value.text));
    } catch {
      return err({ code: 'invalid_response', message: 'LLM response was not valid JSON' });
    }

    const validated = ScoreComponentsValidator.safeParse(parsedJson);
    if (!validated.success) {
      return err({
        code: 'invalid_response',
        message: `LLM response did not match ScoreComponentsSchema: ${validated.error.issues.map((i) => i.message).join('; ')}`,
      });
    }
    return ok(validated.data);
  };

  // ADR-006: structured outputs validated with zod; on validation failure →
  // ONE repair attempt → fail with the raw output available for triage
  // (the failure message below IS that triage trail — this command doesn't
  // have a separate raw-output store, unlike task 039/040's persisted
  // DocumentVersion, since a match score has no "draft" state to attach one to).
  let result = await attempt(basePrompt);
  if (!result.ok && result.error.code === 'invalid_response') {
    const repairPrompt = `${basePrompt}\n\nYour previous response did not match the required JSON schema exactly (skills, experience, seniority, domain, location, overall as numbers 0-1, rationale as a string). Return ONLY the corrected JSON object, no other text.`;
    result = await attempt(repairPrompt);
  }
  if (!result.ok) return result;

  return ok(
    MatchScore.create({
      profileId: asCareerProfileId(args.profile.id),
      jobPostingId: args.job.id,
      components: result.value,
      factsHash: args.profile.factsHash,
      embeddingModel: args.profile.embeddingModel ?? args.model,
    }),
  );
}

/** LLMs sometimes wrap JSON in prose or code fences despite instructions — extract the first `{...}` block defensively rather than trusting `response.trim()` to already be bare JSON. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
