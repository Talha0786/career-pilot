import { describe, it, expect } from 'vitest';
import { CareerProfile, computeProfileFactsHash } from './career-profile.js';
import { ProfileSection } from './profile-section.js';
import { asUserId, asCareerProfileId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');

const validExperience = () => ({
  schemaVersion: 1 as const,
  title: 'Senior Engineer',
  organization: 'Acme',
  startDate: '2020-01',
  endDate: null,
  bullets: ['Shipped things'],
});

describe('CareerProfile.create', () => {
  it('creates a profile pending embedding and emits an event', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.value.embeddingStatus).toBe('pending');
    expect(r.value.sections).toHaveLength(0);
    const events = r.value.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('profile.career_profile_created');
  });

  const validProfile = () => ({ userId: USER, title: 'ok' });

  it.each([
    ['blank title', { title: '   ' }],
    ['over-long title', { title: 'x'.repeat(201) }],
  ])('rejects %s', (_label, override) => {
    expect(isErr(CareerProfile.create({ ...validProfile(), ...override }))).toBe(true);
  });
});

describe('CareerProfile.addSection — sections belong to exactly one profile', () => {
  it('stamps the profile id onto every added section', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;

    const added = profile.addSection({ kind: 'experience', content: validExperience() });
    expect(isOk(added)).toBe(true);
    if (!isOk(added)) return;

    expect(added.value.profileId).toBe(profile.id);
    expect(profile.sections).toHaveLength(1);
    expect(profile.sections[0]!.profileId).toBe(profile.id);
  });

  it('rejects an unknown section kind', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    // @ts-expect-error deliberately invalid kind for the runtime check
    const added = r.value.addSection({ kind: 'hobbies', content: {} });
    expect(isErr(added)).toBe(true);
  });

  it('rejects invalid content for a given kind', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const added = r.value.addSection({
      kind: 'experience',
      // @ts-expect-error missing required fields
      content: { schemaVersion: 1 },
    });
    expect(isErr(added)).toBe(true);
  });

  it('defaults sort to append-at-end', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    profile.addSection({ kind: 'experience', content: validExperience() });
    profile.addSection({ kind: 'experience', content: validExperience() });
    expect(profile.sections[0]!.sort).toBe(0);
    expect(profile.sections[1]!.sort).toBe(1);
  });
});

describe('CareerProfile.updateSection / removeSection', () => {
  it('updates content on an existing section', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    const added = profile.addSection({ kind: 'experience', content: validExperience() });
    if (!isOk(added)) throw new Error('setup failed');

    const updated = profile.updateSection(added.value.id, { ...validExperience(), title: 'Staff Engineer' });
    expect(isOk(updated)).toBe(true);
    expect((profile.sections[0]!.content as { title: string }).title).toBe('Staff Engineer');
  });

  it('returns not_found for a section id that does not exist', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const updated = r.value.updateSection('018f0000-0000-7000-8000-0000000000ff', validExperience());
    expect(isErr(updated)).toBe(true);
    if (isErr(updated)) expect(updated.error.code).toBe('not_found');
  });

  it('removes a section', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    const added = profile.addSection({ kind: 'experience', content: validExperience() });
    if (!isOk(added)) throw new Error('setup failed');

    const removed = profile.removeSection(added.value.id);
    expect(isOk(removed)).toBe(true);
    expect(profile.sections).toHaveLength(0);
  });
});

describe('CareerProfile embedding staleness (facts hash)', () => {
  it('is stale before any embedding exists', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    expect(r.value.isEmbeddingStale).toBe(true);
  });

  it('becomes fresh once embedded against the current facts hash, stale again after a content change', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    profile.addSection({ kind: 'experience', content: validExperience() });

    const hashAtEmbed = profile.factsHash;
    profile.attachEmbedding([0.1, 0.2, 0.3], 'nomic-embed-text', hashAtEmbed);
    expect(profile.isEmbeddingStale).toBe(false);

    profile.addSection({ kind: 'project', content: { schemaVersion: 1, name: 'Side project', description: 'x', bullets: [] } });
    expect(profile.isEmbeddingStale).toBe(true);
  });

  it('attachEmbedding is idempotent for the same (model, factsHash) pair', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    const hash = profile.factsHash;

    profile.attachEmbedding([0.1, 0.2], 'model-a', hash);
    const replay = profile.attachEmbedding([0.9, 0.9], 'model-a', hash);
    expect(isOk(replay)).toBe(true);
    expect(profile.embedding).toEqual([0.1, 0.2]); // unchanged
  });

  it('rejects an empty embedding vector', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    expect(isErr(r.value.attachEmbedding([], 'm', 'h'))).toBe(true);
  });
});

describe('computeProfileFactsHash — determinism', () => {
  it('is stable across recomputation of the same content', () => {
    const sections = [
      { id: 'a', kind: 'experience' as const, content: validExperience() },
      { id: 'b', kind: 'summary' as const, content: { schemaVersion: 1 as const, text: 'hi' } },
    ];
    expect(computeProfileFactsHash(sections)).toBe(computeProfileFactsHash(sections));
  });

  it('is independent of array insertion order (order-stable by id)', () => {
    const a = { id: 'a', kind: 'experience' as const, content: validExperience() };
    const b = { id: 'b', kind: 'summary' as const, content: { schemaVersion: 1 as const, text: 'hi' } };
    expect(computeProfileFactsHash([a, b])).toBe(computeProfileFactsHash([b, a]));
  });

  it('changes when content changes', () => {
    const a = { id: 'a', kind: 'experience' as const, content: validExperience() };
    const changed = { id: 'a', kind: 'experience' as const, content: { ...validExperience(), title: 'Different' } };
    expect(computeProfileFactsHash([a])).not.toBe(computeProfileFactsHash([changed]));
  });

  it('is unaffected by sort (reordering is not a factual change)', () => {
    // sort isn't part of the hashed shape at all (computeProfileFactsHash
    // only reads {id, kind, content}) — reordering a section must not move
    // the profile's facts_hash / re-trigger a "stale embedding" state.
    const profileId = asCareerProfileId('018f0000-0000-7000-8000-000000000003');
    const created = ProfileSection.create({
      profileId,
      kind: 'experience',
      sort: 0,
      content: validExperience(),
    });
    if (!isOk(created)) throw new Error('setup failed');
    const section = created.value;

    const before = computeProfileFactsHash([{ id: section.id, kind: section.kind, content: section.content }]);
    section.reorder(5);
    expect(section.sort).toBe(5); // reorder took effect...
    const after = computeProfileFactsHash([{ id: section.id, kind: section.kind, content: section.content }]);
    expect(after).toBe(before); // ...but the facts hash is unchanged
  });
});

describe('CareerProfile.assertOwnedBy', () => {
  it('permits the owner and forbids everyone else', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career' });
    if (!isOk(r)) throw new Error('setup failed');
    expect(isOk(r.value.assertOwnedBy(USER))).toBe(true);
    const denied = r.value.assertOwnedBy(OTHER);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe('forbidden');
  });
});

describe('CareerProfile snapshot round-trip', () => {
  it('survives toSnapshot -> fromSnapshot without loss, including sections', () => {
    const r = CareerProfile.create({ userId: USER, title: 'My Career', summary: 'A summary' });
    if (!isOk(r)) throw new Error('setup failed');
    const profile = r.value;
    profile.addSection({ kind: 'experience', content: validExperience() });
    profile.attachEmbedding([0.1, 0.2], 'm', profile.factsHash);

    const restored = CareerProfile.fromSnapshot(profile.toSnapshot());
    expect(restored.toSnapshot()).toEqual(profile.toSnapshot());
    expect(restored.pullEvents()).toHaveLength(0);
  });
});
