import { describe, it, expect } from 'vitest';
import { Application, CareerProfile, MatchScore, asUserId, isOk } from '@careerpilot/domain';
import type { Stage } from '@careerpilot/domain';
import { makeGetPipelineAnalyticsUseCase } from '../../src/pipeline/queries/get-pipeline-analytics.js';
import { FakeApplicationRepository, FakeProfileRepository, FakeMatchScoreRepository } from '../fake-repos.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_PATH: readonly Stage[] = ['interested', 'applied', 'screening', 'interview', 'offer'];

function setup() {
  const applications = new FakeApplicationRepository();
  const profiles = new FakeProfileRepository();
  const matchScores = new FakeMatchScoreRepository();
  const getPipelineAnalytics = makeGetPipelineAnalyticsUseCase({ applications, matchScores, profiles });
  return { applications, profiles, matchScores, getPipelineAnalytics };
}

async function makeApp(applications: FakeApplicationRepository, ageDays: number, stage: Stage = 'discovered') {
  const now = new Date(Date.now() - ageDays * DAY_MS);
  const app = Application.create({ userId: USER, jobPostingId: '018f0000-0000-7000-8000-0000000000ff' as never, now });
  if (stage !== 'discovered') {
    // walk a legal path to the target stage rather than assuming a direct edge exists
    const path = stage === 'rejected' || stage === 'withdrawn'
      ? (['interested', stage] as const)
      : STAGE_PATH.slice(0, STAGE_PATH.indexOf(stage) + 1);
    for (const s of path) {
      const t = app.transitionTo({ toStage: s, actor: 'user', now });
      if (!t.ok) throw new Error(`setup failed transitioning to ${s}: ${t.error.message}`);
    }
  }
  await applications.save(app);
  return app;
}

describe('getPipelineAnalytics', () => {
  it('returns zeroed-out analytics for a user with no applications', async () => {
    const { getPipelineAnalytics } = setup();
    const result = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(result.totalApplications).toBe(0);
    expect(result.staleApplications).toBe(0);
    expect(result.averageMatchScore).toBeNull();
    expect(Object.values(result.byStage).every((n) => n === 0)).toBe(true);
  });

  it('range=all includes everything regardless of age; a narrower range excludes older applications', async () => {
    const { applications, getPipelineAnalytics } = setup();
    await makeApp(applications, 1); // recent
    await makeApp(applications, 40); // old

    const all = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(all.totalApplications).toBe(2);

    const narrow = await getPipelineAnalytics({ userId: USER }, { range: '7d' });
    expect(narrow.totalApplications).toBe(1); // the 40-day-old one is excluded by the cutoff
  });

  it('counts an old application in an active stage as stale, but not one in a terminal stage or a recent one', async () => {
    const { applications, getPipelineAnalytics } = setup();
    await makeApp(applications, 20, 'interested'); // old + active -> stale
    await makeApp(applications, 20, 'rejected'); // old but terminal -> not stale
    await makeApp(applications, 2, 'interested'); // active but recent -> not stale

    const result = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(result.totalApplications).toBe(3);
    expect(result.staleApplications).toBe(1);
  });

  it('averageMatchScore is null when the user has no active profile', async () => {
    const { getPipelineAnalytics } = setup();
    const result = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(result.averageMatchScore).toBeNull();
  });

  it('averageMatchScore is null when a profile exists but has no scored jobs yet', async () => {
    const { profiles, getPipelineAnalytics } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);

    const result = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(result.averageMatchScore).toBeNull();
  });

  it('averageMatchScore is the mean overall score across the profile\'s match scores', async () => {
    const { profiles, matchScores, getPipelineAnalytics } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    const profile = created.value;
    await profiles.save(profile);

    const components = (overall: number) => ({
      skills: overall, experience: overall, seniority: overall, domain: overall, location: overall,
      overall, rationale: 'test',
    });
    await matchScores.save(MatchScore.create({
      profileId: profile.id, jobPostingId: '018f0000-0000-7000-8000-0000000000f1' as never,
      components: components(0.6), factsHash: profile.factsHash, embeddingModel: 'test-model',
    }));
    await matchScores.save(MatchScore.create({
      profileId: profile.id, jobPostingId: '018f0000-0000-7000-8000-0000000000f2' as never,
      components: components(0.8), factsHash: profile.factsHash, embeddingModel: 'test-model',
    }));

    const result = await getPipelineAnalytics({ userId: USER }, { range: 'all' });
    expect(result.averageMatchScore).toBeCloseTo(0.7, 5);
  });
});
