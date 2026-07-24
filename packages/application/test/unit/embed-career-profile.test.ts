import { describe, it, expect } from 'vitest';
import { CareerProfile, asUserId, isOk, isErr } from '@careerpilot/domain';
import { makeEmbedCareerProfileUseCase } from '../../src/profile/commands/embed-career-profile.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import { FakeProfileRepository } from '../fake-repos.js';
import { FakeLlmPort, InMemoryBudgetStore, FakeCostEstimator } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

function setup(budgetUsd = 10) {
  const profiles = new FakeProfileRepository();
  const inner = new FakeLlmPort();
  const store = new InMemoryBudgetStore();
  const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
  const embedCareerProfile = makeEmbedCareerProfileUseCase({ profiles, llm: guarded });
  return { profiles, inner, store, embedCareerProfile };
}

async function createProfileWithSection(profiles: FakeProfileRepository) {
  const created = CareerProfile.create({ userId: USER, title: 'My Profile' });
  if (!isOk(created)) throw new Error('setup failed');
  const profile = created.value;
  const added = profile.addSection({
    kind: 'summary',
    content: { schemaVersion: 1, text: 'Experienced backend engineer.' },
  });
  if (!isOk(added)) throw new Error('setup failed');
  await profiles.save(profile);
  return profile;
}

describe('embedCareerProfile — idempotency under at-least-once delivery (ADR-007), mirrors embed-job-posting', () => {
  it('embeds a profile with sections and marks it ready', async () => {
    const { profiles, embedCareerProfile } = setup();
    const profile = await createProfileWithSection(profiles);

    const r = await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'test-model' });
    expect(isOk(r)).toBe(true);

    const stored = await profiles.findByIdForUser(profile.id, USER);
    expect(stored!.embeddingStatus).toBe('ready');
    expect(stored!.embedding).not.toBeNull();
    expect(stored!.isEmbeddingStale).toBe(false);
  });

  it('is a no-op on redelivery for an unchanged factsHash — the LLM is called exactly once', async () => {
    const { profiles, inner, embedCareerProfile } = setup();
    const profile = await createProfileWithSection(profiles);

    await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'test-model' });
    await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'test-model' });

    expect(inner.callCount).toBe(1); // NOT 2 — the whole point of the test
  });

  it('re-embeds when the model changes (legitimate upgrade, not a duplicate)', async () => {
    const { profiles, inner, embedCareerProfile } = setup();
    const profile = await createProfileWithSection(profiles);

    await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'model-a' });
    await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'model-b' });

    expect(inner.callCount).toBe(2);
  });

  it('re-embeds end-to-end when a section changes after the first embed (isEmbeddingStale flips, then clears)', async () => {
    const { profiles, inner, embedCareerProfile } = setup();
    const profile = await createProfileWithSection(profiles);

    const first = await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'test-model' });
    expect(isOk(first)).toBe(true);
    expect(inner.callCount).toBe(1);

    // Simulate the "profile.facts_changed" outbox event firing again after a
    // content edit — mutate the SAME stored aggregate (as a real repository
    // round-trip through Postgres would return) and re-save, exactly what
    // application/src/profile/commands/add-section.ts does.
    const stored = await profiles.findByIdForUser(profile.id, USER);
    const added = stored!.addSection({
      kind: 'summary',
      content: { schemaVersion: 1, text: 'Experienced backend engineer, now with more.' },
    });
    expect(isOk(added)).toBe(true);
    await profiles.save(stored!);
    expect(stored!.isEmbeddingStale).toBe(true);

    const second = await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'test-model' });
    expect(isOk(second)).toBe(true);
    expect(inner.callCount).toBe(2); // a genuinely new embed call, not a skipped replay

    const final = await profiles.findByIdForUser(profile.id, USER);
    expect(final!.embeddingStatus).toBe('ready');
    expect(final!.isEmbeddingStale).toBe(false);
  });

  it('marks the profile failed (not crashed) when the budget blocks the call', async () => {
    const { profiles, embedCareerProfile } = setup(0); // $0 budget
    const profile = await createProfileWithSection(profiles);

    const r = await embedCareerProfile({ careerProfileId: profile.id, userId: USER, model: 'm' });
    expect(isErr(r)).toBe(true);

    const stored = await profiles.findByIdForUser(profile.id, USER);
    expect(stored!.embeddingStatus).toBe('failed');
  });

  it('returns not_found for a profile that no longer exists (deleted between enqueue and consume)', async () => {
    const { embedCareerProfile } = setup();
    const r = await embedCareerProfile({
      careerProfileId: '018f0000-0000-7000-8000-0000000000ff',
      userId: USER,
      model: 'm',
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });

  it('a brand-new profile with no sections is a safe no-op, not an error (nothing meaningful to embed yet)', async () => {
    const { profiles, inner, embedCareerProfile } = setup();
    const created = CareerProfile.create({ userId: USER, title: 'Empty Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);

    const r = await embedCareerProfile({ careerProfileId: created.value.id, userId: USER, model: 'm' });
    expect(isOk(r)).toBe(true);
    expect(inner.callCount).toBe(0);

    const stored = await profiles.findByIdForUser(created.value.id, USER);
    expect(stored!.embeddingStatus).toBe('pending');
  });
});
