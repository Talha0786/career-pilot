import { describe, it, expect } from 'vitest';
import { Application, CareerProfile, JobPosting, asUserId, isOk } from '@careerpilot/domain';
import type { Result } from '@careerpilot/domain';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import {
  FakeApplicationRepository, FakeJobPostingRepository, FakeProfileRepository,
} from '../fake-repos.js';
import {
  InMemoryBudgetStore, FakeCostEstimator, FakePromptStore,
  FakeInterviewPrepRepository, FakeWebSearchPort, FakeWebFetchPort,
} from '../fakes.js';
import { makeGenerateQuestionsUseCase } from '../../src/interview-prep/commands/generate-questions.js';
import { makeResearchCompanyUseCase, MAX_TOOL_CALLS } from '../../src/interview-prep/commands/research-company.js';
import { makeRunMockInterviewTurnUseCase, MOCK_INTERVIEW_TURN_CAP } from '../../src/interview-prep/commands/run-mock-interview-turn.js';

const USER = asUserId('018f0000-0000-7000-8000-0000000000a1');

/** Per-call scripted responses (FIFO) — same pattern as packages/application/test/unit/score-match.test.ts's ScriptedLlmPort. */
class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  private queue: string[] = [];
  private staticResponse: string | null = null;

  queueResponses(...texts: string[]): void {
    this.queue.push(...texts);
  }
  /** After the queue drains, keep returning this for every subsequent call — used for the "always wants another tool call" pathological-loop tests. */
  setFallback(text: string): void {
    this.staticResponse = text;
  }

  async embed(): Promise<Result<EmbedResponse, LlmError>> {
    throw new Error('not used in this test');
  }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    const text = this.queue.shift() ?? this.staticResponse ?? '{}';
    return { ok: true, value: { text, model: req.model, promptTokens: 10, completionTokens: 10 } };
  }
}

async function setupWorld() {
  const applications = new FakeApplicationRepository();
  const jobPostings = new FakeJobPostingRepository();
  const profiles = new FakeProfileRepository();
  const interviewPreps = new FakeInterviewPrepRepository();

  const jobCreated = JobPosting.createManual({ userId: USER, title: 'Staff Engineer', company: 'Acme', descriptionMd: 'Build things.' });
  if (!isOk(jobCreated)) throw new Error('setup failed');
  const job = jobCreated.value;
  await jobPostings.save(job);

  const profileCreated = CareerProfile.create({ userId: USER, title: 'My Profile' });
  if (!isOk(profileCreated)) throw new Error('setup failed');
  const profile = profileCreated.value;
  const sectionAdded = profile.addSection({ kind: 'summary', content: { schemaVersion: 1, text: 'Backend engineer, 8 years.' } });
  if (!isOk(sectionAdded)) throw new Error('setup failed');
  await profiles.save(profile);

  const app = Application.create({ userId: USER, jobPostingId: job.id });
  await applications.save(app);

  return { applications, jobPostings, profiles, interviewPreps, job, profile, app };
}

function makeGuardedLlm(inner: LlmPort, budgetUsd = 100) {
  const store = new InMemoryBudgetStore();
  return { guarded: new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake'), store };
}

describe('generate-questions (task 060)', () => {
  it('validates a well-formed LLM response and persists a questions interview_prep', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    inner.queueResponses(JSON.stringify({
      questions: [{ question: 'Tell me about a time you led a migration.', category: 'behavioral' }],
    }));
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('interview-questions', '{{job_title}} {{job_company}} {{job_description}} {{profile_facts}}');

    const generateQuestions = makeGenerateQuestionsUseCase({
      applications: world.applications, jobPostings: world.jobPostings, profiles: world.profiles,
      interviewPreps: world.interviewPreps, llm: guarded, prompts, model: 'test-model',
    });

    const result = await generateQuestions({ userId: USER }, { applicationId: world.app.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toHaveLength(1);
    const persisted = await world.interviewPreps.findById(result.value.interviewPrepId);
    expect(persisted?.kind).toBe('questions');
  });

  it('repairs once then fails on persistently malformed LLM JSON (ADR-006)', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    inner.queueResponses('not json at all', 'still not json');
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('interview-questions', '{{job_title}} {{job_company}} {{job_description}} {{profile_facts}}');

    const generateQuestions = makeGenerateQuestionsUseCase({
      applications: world.applications, jobPostings: world.jobPostings, profiles: world.profiles,
      interviewPreps: world.interviewPreps, llm: guarded, prompts, model: 'test-model',
    });

    const result = await generateQuestions({ userId: USER }, { applicationId: world.app.id });
    expect(result.ok).toBe(false);
    expect(inner.completeCalls).toHaveLength(2); // initial + exactly one repair attempt
  });
});

describe('research-company bounded tool loop (task 060)', () => {
  it('drops claims with no citation to a URL actually observed this session', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    const search = new FakeWebSearchPort();
    const fetcher = new FakeWebFetchPort();
    search.queueResults([{ title: 'Acme raises Series B', url: 'https://news.example.com/acme-series-b', snippet: '...' }]);

    inner.queueResponses(
      JSON.stringify({ action: 'search', query: 'Acme funding' }),
      JSON.stringify({
        action: 'final',
        brief: {
          companyName: 'Acme',
          summary: 'A fast-growing startup.',
          claims: [
            { claim: 'Acme raised a Series B round.', citations: [{ url: 'https://news.example.com/acme-series-b' }] },
            { claim: 'Acme was founded on the moon.', citations: [] }, // no citation -- must be dropped
            { claim: 'Acme has 500 employees.', citations: [{ url: 'https://never-actually-seen.example.com' }] }, // cites an unseen URL -- must ALSO be dropped
          ],
        },
      }),
    );
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('company-research', '{{company_name}} {{job_title}} {{max_tool_calls}} {{remaining_calls}} {{transcript}}');

    const researchCompany = makeResearchCompanyUseCase({
      applications: world.applications, jobPostings: world.jobPostings, interviewPreps: world.interviewPreps,
      llm: guarded, prompts, search, fetcher, model: 'test-model',
    });

    const result = await researchCompany({ userId: USER }, { applicationId: world.app.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.brief.claims).toHaveLength(1);
    expect(result.value.brief.claims[0]?.claim).toBe('Acme raised a Series B round.');
    expect(result.value.brief.droppedUncitedClaimCount).toBe(2);
    expect(result.value.brief.toolCallsUsed).toBe(1);
  });

  it('hard-caps at MAX_TOOL_CALLS even when the model always requests another search', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    inner.setFallback(JSON.stringify({ action: 'search', query: 'keep searching forever' }));
    const search = new FakeWebSearchPort();
    const fetcher = new FakeWebFetchPort();
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('company-research', '{{company_name}} {{job_title}} {{max_tool_calls}} {{remaining_calls}} {{transcript}}');

    const researchCompany = makeResearchCompanyUseCase({
      applications: world.applications, jobPostings: world.jobPostings, interviewPreps: world.interviewPreps,
      llm: guarded, prompts, search, fetcher, model: 'test-model',
    });

    const result = await researchCompany({ userId: USER }, { applicationId: world.app.id });
    expect(result.ok).toBe(false); // never reached `final` within budget
    expect(search.calls).toHaveLength(MAX_TOOL_CALLS);
    expect(MAX_TOOL_CALLS).toBe(8); // pins the documented §5 "max 8 tool calls" number
  });
});

describe('mock interviewer turn loop (task 061)', () => {
  it('never exceeds the 40-turn cap, even called again past it', async () => {
    const world = await setupWorld();
    const sessionId = '018f0000-0000-7000-8000-0000000000b1';
    const turns = Array.from({ length: MOCK_INTERVIEW_TURN_CAP }, (_, i) => ({
      role: 'interviewer' as const, content: `Question ${i}`, at: new Date().toISOString(),
    }));
    await world.interviewPreps.save({
      id: sessionId, applicationId: world.app.id, kind: 'mock_interview_transcript',
      content: { applicationId: world.app.id, turns, status: 'in_progress' },
    });

    const inner = new ScriptedLlmPort();
    inner.setFallback(JSON.stringify({ action: 'say', message: 'should never be reached' }));
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('mock-interview', '{{job_title}} {{job_company}} {{job_description}} {{profile_facts}} {{question_bank}} {{transcript}}');

    const runTurn = makeRunMockInterviewTurnUseCase({
      applications: world.applications, jobPostings: world.jobPostings, profiles: world.profiles,
      interviewPreps: world.interviewPreps, llm: guarded, prompts, model: 'test-model',
    });

    const result = await runTurn({ userId: USER }, { applicationId: world.app.id, sessionId, candidateMessage: 'one more please' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('completed_turn_cap');
    expect(result.value.turnCount).toBe(MOCK_INTERVIEW_TURN_CAP);
    expect(inner.completeCalls).toHaveLength(0); // cap checked BEFORE any LLM call
    expect(MOCK_INTERVIEW_TURN_CAP).toBe(40); // pins the documented §5 "Turn cap 40" number
  });

  it('never executes a write-shaped tool_call request -- only get_profile/get_job are reachable', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    // Every attempt asks for a tool that isn't in the closed enum -- this
    // must NEVER be honored, only retried (bounded) then falls back.
    inner.setFallback(JSON.stringify({ action: 'tool_call', tool: 'update_application_stage' }));
    const { guarded } = makeGuardedLlm(inner);
    const prompts = new FakePromptStore();
    prompts.register('mock-interview', '{{job_title}} {{job_company}} {{job_description}} {{profile_facts}} {{question_bank}} {{transcript}}');

    const runTurn = makeRunMockInterviewTurnUseCase({
      applications: world.applications, jobPostings: world.jobPostings, profiles: world.profiles,
      interviewPreps: world.interviewPreps, llm: guarded, prompts, model: 'test-model',
    });

    const result = await runTurn({ userId: USER }, { applicationId: world.app.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The application was never mutated -- proves no write tool was reachable, not just "wasn't named".
    const reloaded = await world.applications.findByIdForUser(world.app.id, USER);
    expect(reloaded?.stage).toBe('discovered');
    // Turn still produces SOME output (the bounded-retry fallback), never hangs or crashes.
    expect(result.value.interviewerMessage).toBeTruthy();
  });

  it('ends gracefully (transcript-so-far intact) when the budget is exhausted mid-loop', async () => {
    const world = await setupWorld();
    const inner = new ScriptedLlmPort();
    inner.setFallback(JSON.stringify({ action: 'say', message: 'should never be reached -- budget is zero' }));
    const { guarded } = makeGuardedLlm(inner, 0); // zero budget -- every complete() call is refused pre-dispatch
    const prompts = new FakePromptStore();
    prompts.register('mock-interview', '{{job_title}} {{job_company}} {{job_description}} {{profile_facts}} {{question_bank}} {{transcript}}');

    const runTurn = makeRunMockInterviewTurnUseCase({
      applications: world.applications, jobPostings: world.jobPostings, profiles: world.profiles,
      interviewPreps: world.interviewPreps, llm: guarded, prompts, model: 'test-model',
    });

    const result = await runTurn({ userId: USER }, { applicationId: world.app.id, candidateMessage: 'Hi, ready to start.' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('ended_budget_exhausted');
    expect(inner.completeCalls).toHaveLength(0); // budget guard rejects before any dispatch

    const persisted = await world.interviewPreps.findById(result.value.sessionId);
    expect(persisted).not.toBeNull();
    const content = persisted!.content as { turns: { role: string; content: string }[] };
    // The candidate's message that triggered this turn is preserved, not discarded.
    expect(content.turns.some((t) => t.role === 'candidate' && t.content === 'Hi, ready to start.')).toBe(true);
  });
});
