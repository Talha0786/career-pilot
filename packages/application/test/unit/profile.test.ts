import { describe, it, expect } from 'vitest';
import { makeCreateProfileUseCase } from '../../src/profile/commands/create-profile.js';
import { makeUpdateProfileUseCase } from '../../src/profile/commands/update-profile.js';
import { makeAddSectionUseCase } from '../../src/profile/commands/add-section.js';
import { makeGetProfileUseCase } from '../../src/profile/queries/get-profile.js';
import { FakeUnitOfWork } from '../fake-repos.js';
import { asUserId, isOk, isErr } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

describe('createProfile', () => {
  it('creates a profile and enqueues its creation event atomically', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });

    const r = await createProfile({ userId: USER }, { title: 'My Career', summary: 'A summary' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(uow.outbox.enqueued).toHaveLength(1);
    expect(uow.outbox.enqueued[0]!.eventType).toBe('profile.career_profile_created');

    const stored = await uow.profiles.findActiveForUser(USER);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(r.value.profileId);
  });

  it('rejects a second active profile for the same user (conflict)', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });

    await createProfile({ userId: USER }, { title: 'First' });
    const second = await createProfile({ userId: USER }, { title: 'Second' });

    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error.code).toBe('conflict');
  });

  it('rejects invalid input and writes nothing', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });

    const r = await createProfile({ userId: USER }, { title: '' });
    expect(isErr(r)).toBe(true);
    expect(uow.outbox.enqueued).toHaveLength(0);
  });
});

describe('updateProfile', () => {
  it('updates title and summary on an existing profile', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });
    const updateProfile = makeUpdateProfileUseCase({ uow });

    await createProfile({ userId: USER }, { title: 'Original' });
    const r = await updateProfile({ userId: USER }, { title: 'Updated', summary: 'New summary' });
    expect(isOk(r)).toBe(true);

    const stored = await uow.profiles.findActiveForUser(USER);
    expect(stored!.title).toBe('Updated');
    expect(stored!.summary).toBe('New summary');
  });

  it('returns not_found when no profile exists yet', async () => {
    const uow = new FakeUnitOfWork();
    const updateProfile = makeUpdateProfileUseCase({ uow });

    const r = await updateProfile({ userId: USER }, { title: 'x' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});

describe('addSection', () => {
  const experience = () => ({
    schemaVersion: 1 as const,
    title: 'Engineer',
    organization: 'Acme',
    startDate: '2021-01',
    endDate: null,
    bullets: ['Did things'],
  });

  it('adds a section to the active profile', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });
    const addSection = makeAddSectionUseCase({ uow });

    await createProfile({ userId: USER }, { title: 'My Career' });
    const r = await addSection({ userId: USER }, { kind: 'experience', content: experience() });
    expect(isOk(r)).toBe(true);

    const stored = await uow.profiles.findActiveForUser(USER);
    expect(stored!.sections).toHaveLength(1);
  });

  it('returns not_found when no profile exists yet', async () => {
    const uow = new FakeUnitOfWork();
    const addSection = makeAddSectionUseCase({ uow });

    const r = await addSection({ userId: USER }, { kind: 'experience', content: experience() });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });

  it('surfaces the domain validation error for malformed content', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });
    const addSection = makeAddSectionUseCase({ uow });

    await createProfile({ userId: USER }, { title: 'My Career' });
    const r = await addSection({ userId: USER }, {
      kind: 'experience',
      // @ts-expect-error deliberately missing required fields
      content: { schemaVersion: 1 },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('validation_failed');
  });
});

describe('getProfile', () => {
  it('returns the summary including derived isEmbeddingStale', async () => {
    const uow = new FakeUnitOfWork();
    const createProfile = makeCreateProfileUseCase({ uow });
    const getProfile = makeGetProfileUseCase({ profiles: uow.profiles });

    await createProfile({ userId: USER }, { title: 'My Career' });
    const r = await getProfile({ userId: USER });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.title).toBe('My Career');
      expect(r.value.isEmbeddingStale).toBe(true);
    }
  });

  it('returns not_found when no profile exists', async () => {
    const uow = new FakeUnitOfWork();
    const getProfile = makeGetProfileUseCase({ profiles: uow.profiles });
    const r = await getProfile({ userId: USER });
    expect(isErr(r)).toBe(true);
  });
});
