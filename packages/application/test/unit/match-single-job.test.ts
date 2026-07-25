import { describe, it, expect } from 'vitest';
import { CareerProfile, JobPosting, MatchScore, asUserId, isOk, notFound } from '@careerpilot/domain';
import type { Result } from '@careerpilot/domain';
import { makeMatchSingleJobUseCase } from '../../src/matching/commands/match-single-job.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError, EmbedResponse } from '../../src/ports/llm.port.js';
import { FakeProfileRepository, FakeJobPostingRepository, FakeMatchScoreRepository } from '../fake-repos.js';
import { InMemoryBudgetStore, FakeCostEstimator, FakePromptStore } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const VALID_SCORE_JSON = JSON.stringify({
  skills: 0.8, experience: 0.7, seniority: 0.9, domain: 0.6, location: 0.5,
  overall: 0.75, rationale: 'Strong skills overlap.',
});

class ScriptedLlmPort implements LlmPort {
  public completeCalls: CompleteRequest[] = [];
  async embed(): Promise<Result<EmbedResponse, LlmError>> {
    throw new Error('not used in this test');
  }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCalls.push(req);
    return { ok: true, value: { text: VALID_SCORE_JSON, model: req.model, promptTokens: 10, completionTokens: 10 } };
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

async function makeJob(jobPostings: FakeJobPostingRepository) {
  const created = JobPosting.createManual({ userId: USER, title: 'Backend Engineer', descriptionMd: 'desc' });
  if (!isOk(created)) throw new Error('setup failed');
  await jobPostings.save(created.value);
  return created.value;
}

function setup(budgetUsd = 100) {
  const profiles = new FakeProfileRepository();
  const jobPostings = new FakeJobPostingRepository();
  const matchScores = new FakeMatchScoreRepository();
  const inner = new ScriptedLlmPort();
  const store = new InMemoryBudgetStore();
  const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
  const prompts = new FakePromptStore();
  const matchSingleJob = makeMatchSingleJobUseCase({
    profiles, jobPostings, matchScores, llm: guarded, prompts, model: 'test-model',
  });
  return { profiles, jobPostings, matchScores, inner, prompts, matchSingleJob };
}

describe('matchSingleJob', () => {
  it('returns notFound when the user has no active profile', async () => {
    const { jobPostings, matchSingleJob } = setup();
    const job = await makeJob(jobPostings);
    const result = await matchSingleJob({ userId: USER }, { jobId: job.id });
    expect(result).toEqual({ ok: false, error: notFound('No career profile exists yet') });
  });

  it('returns notFound when the job posting does not exist', async () => {
    const { profiles, matchSingleJob } = setup();
    await makeEmbeddedProfile(profiles);
    const result = await matchSingleJob({ userId: USER }, { jobId: '018f0000-0000-7000-8000-0000000000ff' });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe('not_found');
  });

  it('method=embedding (default) with no existing score returns null components, not an error', async () => {
    const { profiles, jobPostings, matchSingleJob } = setup();
    await makeEmbeddedProfile(profiles);
    const job = await makeJob(jobPostings);

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toMatchObject({ components: null, computedAt: null, stale: false, method: 'embedding' });
  });

  it('method=embedding with an existing score returns it and flags staleness against the CURRENT profile factsHash', async () => {
    const { profiles, jobPostings, matchScores, matchSingleJob } = setup();
    const profile = await makeEmbeddedProfile(profiles);
    const job = await makeJob(jobPostings);

    await matchScores.save(MatchScore.create({
      profileId: profile.id, jobPostingId: job.id,
      components: { skills: 0.5, experience: 0.5, seniority: 0.5, domain: 0.5, location: 0.5, overall: 0.5, rationale: 'r' },
      factsHash: 'stale-hash-not-matching-current-profile',
      embeddingModel: 'test-embed-model',
    }));

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.components).not.toBeNull();
    expect(result.value.stale).toBe(true); // factsHash mismatch
  });

  it('method=rubric fails with validationFailed when the profile has no embedding yet', async () => {
    const { profiles, jobPostings, matchSingleJob } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value); // no attachEmbedding — embedding stays null, status stays pending
    const job = await makeJob(jobPostings);

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id, method: 'rubric' });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe('validation_failed');
  });

  it('method=rubric fails with validationFailed when embeddingStatus is not ready, even if an embedding vector is present', async () => {
    const { profiles, jobPostings, matchSingleJob } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    const profile = created.value;
    const attached = profile.attachEmbedding(Array.from({ length: 8 }, (_, i) => i / 8), 'm', profile.factsHash);
    if (!attached.ok) throw new Error('setup failed');
    profile.markEmbeddingFailed(); // embedding vector stays set, but status flips away from 'ready'
    await profiles.save(profile);
    const job = await makeJob(jobPostings);

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id, method: 'rubric' });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe('validation_failed');
  });

  it('method=rubric fails with validationFailed when the match-score prompt cannot be loaded', async () => {
    const { profiles, jobPostings, matchSingleJob } = setup();
    await makeEmbeddedProfile(profiles);
    const job = await makeJob(jobPostings);
    // FakePromptStore with no template registered for 'match-score' -> load() fails.

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id, method: 'rubric' });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe('validation_failed');
  });

  it('method=rubric happy path: scores the job, persists via MatchScoreRepository, and returns fresh (non-stale) components', async () => {
    const { profiles, jobPostings, matchScores, prompts, matchSingleJob } = setup();
    await makeEmbeddedProfile(profiles);
    const job = await makeJob(jobPostings);
    prompts.register(
      'match-score',
      'Score {{job_title}} at {{job_company}} against:\n{{profile_facts}}\n\n{{job_description}}',
    );

    const result = await matchSingleJob({ userId: USER }, { jobId: job.id, method: 'rubric' });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.components?.overall).toBeCloseTo(0.75, 5);
    expect(result.value.stale).toBe(false);
    expect(matchScores.saveCount).toBe(1);
  });
});
