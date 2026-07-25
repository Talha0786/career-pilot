import { z } from 'zod';
import {
  asUserId, asApplicationId, asJobPostingId, compileFactList, uuidv7,
  notFound, type Result, ok, err, type DomainError,
} from '@careerpilot/domain';
import type { ApplicationRepository, JobPostingRepository, ProfileRepository, Actor } from '../../ports/repositories.js';
import type { InterviewPrepRepository } from '../../ports/interview-prep.port.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import { makeGetProfileUseCase } from '../../profile/queries/get-profile.js';
import { makeGetJobUseCase } from '../../discovery/queries/get-job.js';

export const MOCK_INTERVIEW_TURN_CAP = 40;
/** Hard cap on LLM completions WITHIN one call to `runMockInterviewTurn` — bounds the internal tool_call sub-loop (get_profile/get_job re-checks) so a single turn can never itself run away, independent of the session-level 40-turn cap. */
const MAX_LLM_CALLS_PER_TURN = 4;

const ActionValidator = z.discriminatedUnion('action', [
  z.object({ action: z.literal('say'), message: z.string().min(1).max(5000) }),
  z.object({ action: z.literal('tool_call'), tool: z.enum(['get_profile', 'get_job']) }),
]);

export type MockInterviewStatus = 'in_progress' | 'completed_turn_cap' | 'ended_budget_exhausted';

interface Turn {
  role: 'interviewer' | 'candidate';
  content: string;
  at: string;
}

export interface RunMockInterviewTurnInput {
  applicationId: string;
  /** Omitted -> starts a new session. */
  sessionId?: string | undefined;
  /** Omitted only for the very first turn of a new session (the interviewer opens). */
  candidateMessage?: string | undefined;
}
export interface RunMockInterviewTurnOutput {
  sessionId: string;
  interviewerMessage: string | null;
  status: MockInterviewStatus;
  turnCount: number;
}

/**
 * Task 061 — one turn of the mock-interviewer chat loop
 * (`docs/06-agent-design.md` §5: "chat loop over (JD + profile + question
 * bank); tools: get_profile, get_job (read-only). Session transcript
 * stored under interview_preps. Turn cap 40; budget-guarded."). Reuses
 * 057's `makeGetProfileUseCase`/`makeGetJobUseCase` directly for the two
 * in-loop tools rather than forking a second read implementation.
 *
 * Two independent bounds, both hard caps, neither prompted-only:
 * - `MOCK_INTERVIEW_TURN_CAP` (40): session-level, checked BEFORE any LLM
 *   call on a turn that would exceed it — no LLM call happens once the
 *   cap is hit, this function just returns `completed_turn_cap`.
 * - `MAX_LLM_CALLS_PER_TURN` (4): turn-level, bounds the internal
 *   get_profile/get_job tool_call sub-loop within a single turn.
 *
 * `tool` is a closed zod enum of exactly the two read-only tools — any
 * other value (a write-shaped tool_call request, real or adversarial)
 * fails validation and is NEVER executed, just treated as a malformed
 * response and retried (bounded by MAX_LLM_CALLS_PER_TURN, so it can't
 * loop forever either).
 */
export function makeRunMockInterviewTurnUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
  profiles: ProfileRepository;
  interviewPreps: InterviewPrepRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
}) {
  const getProfile = makeGetProfileUseCase({ profiles: deps.profiles });
  const getJob = makeGetJobUseCase({ jobPostings: deps.jobPostings });

  return async function runMockInterviewTurn(
    actor: Actor,
    input: RunMockInterviewTurnInput,
  ): Promise<Result<RunMockInterviewTurnOutput, DomainError>> {
    const userId = asUserId(actor.userId);
    const applicationId = asApplicationId(input.applicationId);

    const app = await deps.applications.findByIdForUser(applicationId, userId);
    if (app === null) return err(notFound('Application not found'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(app.jobPostingId), userId);
    if (job === null) return err(notFound('Job posting not found'));

    const profile = await deps.profiles.findActiveForUser(userId);
    if (profile === null) return err(notFound('No career profile exists yet'));

    let sessionId = input.sessionId;
    let turns: Turn[];
    if (sessionId) {
      const existing = await deps.interviewPreps.findById(sessionId);
      if (existing === null || existing.applicationId !== input.applicationId || existing.kind !== 'mock_interview_transcript') {
        return err(notFound('Mock interview session not found'));
      }
      turns = (existing.content as { turns: Turn[] }).turns;
    } else {
      sessionId = uuidv7();
      turns = [];
    }

    const interviewerTurnCount = turns.filter((t) => t.role === 'interviewer').length;
    if (interviewerTurnCount >= MOCK_INTERVIEW_TURN_CAP) {
      await persist(deps.interviewPreps, sessionId, input.applicationId, turns, 'completed_turn_cap');
      return ok({ sessionId, interviewerMessage: null, status: 'completed_turn_cap', turnCount: interviewerTurnCount });
    }

    if (input.candidateMessage) {
      turns.push({ role: 'candidate', content: input.candidateMessage, at: new Date().toISOString() });
    }

    const promptResult = await deps.prompts.load('mock-interview');
    if (!promptResult.ok) return err({ code: 'validation_failed', message: `Could not load mock-interview prompt: ${promptResult.error.message}` });
    const prompt = promptResult.value;

    const questionsPreps = await deps.interviewPreps.listForApplication(input.applicationId, 'questions');
    const questionBank = questionsPreps.length > 0
      ? JSON.stringify((questionsPreps[0]!.content as { questions: unknown[] }).questions)
      : '(no question bank generated yet)';

    const facts = compileFactList(profile);
    const factsText = facts.length > 0 ? facts.map((f) => `${f.id}: ${f.text}`).join('\n') : '(no profile facts yet)';

    const ephemeral: string[] = [];
    let interviewerMessage: string | null = null;

    for (let i = 0; i < MAX_LLM_CALLS_PER_TURN; i++) {
      const transcriptText = [
        ...turns.map((t) => `${t.role.toUpperCase()}: ${t.content}`),
        ...ephemeral,
      ].join('\n') || '(interview has not started yet — open with a greeting and your first question)';

      const promptText = prompt.render({
        job_title: job.title,
        job_company: job.company ?? 'Unknown',
        job_description: job.descriptionMd,
        profile_facts: factsText,
        question_bank: questionBank,
        transcript: transcriptText,
      });

      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText, jsonSchema: { type: 'object' }, temperature: prompt.frontmatter.temperature },
        { userId: actor.userId, refId: sessionId, context: 'interview' },
      );

      if (!completion.ok) {
        if (completion.error.code === 'budget_exceeded' || completion.error.code === 'rate_limited') {
          // Graceful end — transcript-so-far persisted, no crash, no data loss.
          await persist(deps.interviewPreps, sessionId, input.applicationId, turns, 'ended_budget_exhausted');
          return ok({ sessionId, interviewerMessage: null, status: 'ended_budget_exhausted', turnCount: interviewerTurnCount });
        }
        return err({ code: 'validation_failed', message: `LLM call failed: ${completion.error.message}` });
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        ephemeral.push('SYSTEM: your last response was not valid JSON. Respond with ONLY one action JSON object (say or tool_call).');
        continue;
      }
      const parsed = ActionValidator.safeParse(parsedJson);
      if (!parsed.success) {
        ephemeral.push('SYSTEM: your last response did not match the required schema (only "say" or "tool_call" with tool get_profile/get_job are valid). Respond with ONLY one action JSON object.');
        continue;
      }

      if (parsed.data.action === 'say') {
        interviewerMessage = parsed.data.message;
        break;
      }

      // tool_call — execute the read-only lookup and feed the result back in.
      if (parsed.data.tool === 'get_profile') {
        const result = await getProfile({ userId });
        ephemeral.push(`TOOL get_profile -> ${result.ok ? JSON.stringify(result.value) : `error: ${result.error.message}`}`);
      } else {
        const result = await getJob({ userId }, job.id);
        ephemeral.push(`TOOL get_job -> ${result.ok ? JSON.stringify(result.value) : `error: ${result.error.message}`}`);
      }
    }

    if (interviewerMessage === null) {
      // MAX_LLM_CALLS_PER_TURN exhausted without a `say` — never leave the
      // turn without SOME output; a real crash/hang is worse than a
      // generic fallback, and the session remains resumable.
      interviewerMessage = "Sorry, let's move on — could you walk me through your most relevant experience for this role?";
    }
    turns.push({ role: 'interviewer', content: interviewerMessage, at: new Date().toISOString() });

    const newInterviewerCount = turns.filter((t) => t.role === 'interviewer').length;
    const status: MockInterviewStatus = newInterviewerCount >= MOCK_INTERVIEW_TURN_CAP ? 'completed_turn_cap' : 'in_progress';
    await persist(deps.interviewPreps, sessionId, input.applicationId, turns, status);

    return ok({ sessionId, interviewerMessage, status, turnCount: newInterviewerCount });
  };
}

async function persist(
  repo: InterviewPrepRepository,
  sessionId: string,
  applicationId: string,
  turns: Turn[],
  status: MockInterviewStatus,
): Promise<void> {
  await repo.save({
    id: sessionId,
    applicationId,
    kind: 'mock_interview_transcript',
    content: { applicationId, turns, status },
  });
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
