import { describe, it, expect } from 'vitest';
import { CareerProfile, JobPosting, asUserId, isOk } from '@careerpilot/domain';
import type { Result } from '@careerpilot/domain';
import { makeScoreMatchUseCase } from '../../src/matching/commands/score-match.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import { FakeProfileRepository, FakeJobPostingRepository, FakeMatchScoreRepository } from '../fake-repos.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakePromptStore } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const VALID_SCORE_JSON = JSON.stringify({
  skills: 0.8, experience: 0.7, seniority: 0.9, domain: 0.6, location: 0.5,
  overall: 0.75, rationale: 'Strong skills overlap.',
});

/** A scripted LlmPort — `complete` returns responses off a queue (FIFO), one per call, so tests can control exactly what the N-th call returns (FakeLlmPort in fakes.ts only supports one canned response for every call). */
class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  private queue: string[] = [];

  queueResponses(...texts: string[]): void {
    this.queue.push(...texts);
  }

  async embed(): Promise<Result<EmbedResponse, LlmError>> {
    throw new Error('not used in this test');
  }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    const text = this.queue.shift() ?? VALID_SCORE_JSON;
    return { ok: true, value: { text, model: req.model, promptTokens: 10, completionTokens: 10 } };
  }
}

async function makeEmbeddedProfile(profiles: FakeProfileRepository) {
  const created = CareerProfile.create({ userId: USER, title: 'Profile' });
  if (!isOk(created)) throw new Error('setup failed');
  const profile = created.value;
  const added = profile.addSection({ kind: 'summary', content: { schemaVersion: 1, text: 'Backend engineer.' } });
  if (!isOk(added)) throw new Error('setup failed');
  const attached = profile.attachEmbedding(Array.from({ length: 8 }, (_, i) => i / 8), 'test-embed-model', profile.factsHash);
  if (!attached.ok) throw new Error('setup failed');
  await profiles.save(profile);
  return profile;
}

async function makeEmbeddedJob(jobPostings: FakeJobPostingRepository, title: string, vector: number[]) {
  const created = JobPosting.createManual({ userId: USER, title, descriptionMd: `Description for ${title}` });
  if (!isOk(created)) throw new Error('setup failed');
  const job = created.value;
  job.attachEmbedding(vector, 'test-embed-model');
  await jobPostings.save(job);
  return job;
}

function setup(budgetUsd = 100) {
  const profiles = new FakeProfileRepository();
  const jobPostings = new FakeJobPostingRepository();
  const matchScores = new FakeMatchScoreRepository();
  const inner = new ScriptedLlmPort();
  const store = new InMemoryBudgetStore();
  const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
  const prompts = new FakePromptStore();
  prompts.register(
    'match-score',
    'Score {{job_title}} at {{job_company}} against:\n{{profile_facts}}\n\n{{job_description}}',
  );
  const scoreMatch = makeScoreMatchUseCase({ profiles, jobPostings, matchScores, llm: guarded, prompts, model: 'test-model' });
  return { profiles, jobPostings, matchScores, inner, scoreMatch };
}

describe('scoreMatch — prefilter-then-score orchestration', () => {
  it('scores every ANN-prefiltered candidate and persists via MatchScoreRepository', async () => {
    const { profiles, jobPostings, matchScores, scoreMatch } = setup();
    const profile = await makeEmbeddedProfile(profiles);
    await makeEmbeddedJob(jobPostings, 'Job A', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    await makeEmbeddedJob(jobPostings, 'Job B', [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);

    const result = await scoreMatch({ profileId: profile.id, userId: USER });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.scored).toHaveLength(2);
    expect(result.value.failures).toHaveLength(0);
    expect(matchScores.saveCount).toBe(2);
    for (const score of result.value.scored) {
      expect(score.components.overall).toBeCloseTo(0.75, 5);
      expect(score.factsHash).toBe(profile.factsHash);
    }
  });

  it('ENFORCES the prefilter: only scores the ANN top-N, never every job posting the user has (not just documented, actually tested)', async () => {
    const { profiles, jobPostings, inner, scoreMatch } = setup();
    const profile = await makeEmbeddedProfile(profiles);
    for (let i = 0; i < 5; i++) {
      await makeEmbeddedJob(jobPostings, `Job ${i}`, [i / 10, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    }

    const result = await scoreMatch({ profileId: profile.id, userId: USER, limit: 2 });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.scored).toHaveLength(2); // NOT 5
    expect(inner.completeCalls).toHaveLength(2); // exactly one LLM call per prefiltered candidate, not per posting
  });

  it('zod-repair-then-fail: a deliberately malformed response that NEVER recovers triggers exactly one repair retry, then a typed failure — no crash', async () => {
    const { profiles, jobPostings, inner, scoreMatch } = setup();
    const profile = await makeEmbeddedProfile(profiles);
    const brokenJob = await makeEmbeddedJob(jobPostings, 'Broken Job', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    inner.queueResponses('not json at all', 'still not valid {"skills": "not-a-number"}');

    const result = await scoreMatch({ profileId: profile.id, userId: USER });
    expect(isOk(result)).toBe(true); // the BATCH command doesn't crash even though one candidate failed
    if (!isOk(result)) return;

    expect(result.value.scored).toHaveLength(0);
    expect(result.value.failures).toHaveLength(1);
    expect(result.value.failures[0]!.jobPostingId).toBe(brokenJob.id);
    expect(inner.completeCalls).toHaveLength(2); // exactly 1 original + 1 repair, not more
  });

  it('repair succeeds: first response invalid, second (repaired) response valid → scored successfully', async () => {
    const { profiles, jobPostings, matchScores, inner, scoreMatch } = setup();
    const profile = await makeEmbeddedProfile(profiles);
    await makeEmbeddedJob(jobPostings, 'Recoverable Job', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    inner.queueResponses('garbage output', VALID_SCORE_JSON);

    const result = await scoreMatch({ profileId: profile.id, userId: USER });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.scored).toHaveLength(1);
    expect(result.value.failures).toHaveLength(0);
    expect(matchScores.saveCount).toBe(1);
    expect(inner.completeCalls).toHaveLength(2);
  });

  it('budget guard is exercised on every call — a $0 budget blocks scoring with a recorded failure, not a crash', async () => {
    const { profiles, jobPostings, matchScores, scoreMatch } = setup(0);
    const profile = await makeEmbeddedProfile(profiles);
    await makeEmbeddedJob(jobPostings, 'Job', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);

    const result = await scoreMatch({ profileId: profile.id, userId: USER });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.scored).toHaveLength(0);
    expect(result.value.failures).toHaveLength(1);
    expect(matchScores.saveCount).toBe(0);
  });

  it('returns not_found for a profile that does not belong to the caller', async () => {
    const { scoreMatch } = setup();
    const result = await scoreMatch({ profileId: '018f0000-0000-7000-8000-0000000000ff', userId: USER });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('returns validation_failed for a profile whose embedding is not ready yet', async () => {
    const { profiles, scoreMatch } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Unembedded' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);

    const result = await scoreMatch({ profileId: created.value.id, userId: USER });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_failed');
  });
});
