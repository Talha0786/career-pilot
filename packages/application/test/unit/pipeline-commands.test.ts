import { describe, it, expect } from 'vitest';
import { makeCreateManualJobUseCase } from '../../src/discovery/commands/create-manual-job.js';
import { makeCreateApplicationUseCase } from '../../src/pipeline/commands/create-application.js';
import { makeUpdateStageUseCase } from '../../src/pipeline/commands/update-stage.js';
import { FakeUnitOfWork } from '../fake-repos.js';
import { asUserId, isOk, isErr } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');

async function seedJob(uow: FakeUnitOfWork, userId = USER) {
  const createManualJob = makeCreateManualJobUseCase({ uow });
  const created = await createManualJob({ userId }, { title: 'T', descriptionMd: 'D' });
  if (!isOk(created)) throw new Error('setup failed');
  return created.value.jobId;
}

describe('createApplication', () => {
  it('creates an application in the discovered stage and enqueues its event', async () => {
    const uow = new FakeUnitOfWork();
    const jobId = await seedJob(uow);
    const createApplication = makeCreateApplicationUseCase({ uow });

    const r = await createApplication({ userId: USER }, { jobPostingId: jobId });

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const stored = await uow.applications.findByIdForUser(r.value.applicationId as never, USER);
    expect(stored?.stage).toBe('discovered');
    expect(uow.outbox.enqueued.some((e) => e.eventType === 'pipeline.application_created')).toBe(true);
  });

  it('returns not_found for a job owned by a different user (no ownership leak)', async () => {
    const uow = new FakeUnitOfWork();
    const jobId = await seedJob(uow, OTHER);
    const createApplication = makeCreateApplicationUseCase({ uow });

    const r = await createApplication({ userId: USER }, { jobPostingId: jobId });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });

  it('returns not_found for a job that does not exist', async () => {
    const uow = new FakeUnitOfWork();
    const createApplication = makeCreateApplicationUseCase({ uow });

    const r = await createApplication({ userId: USER }, { jobPostingId: '018f0000-0000-7000-8000-0000000000ff' });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});

describe('updateStage', () => {
  it('moves an application through a legal transition and records it', async () => {
    const uow = new FakeUnitOfWork();
    const jobId = await seedJob(uow);
    const createApplication = makeCreateApplicationUseCase({ uow });
    const created = await createApplication({ userId: USER }, { jobPostingId: jobId });
    if (!isOk(created)) throw new Error('setup failed');

    const updateStage = makeUpdateStageUseCase({ uow });
    const r = await updateStage({ userId: USER }, { applicationId: created.value.applicationId, toStage: 'applied' });

    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.stage).toBe('applied');
  });

  it('rejects an illegal transition (domain state machine, not a UI concern)', async () => {
    const uow = new FakeUnitOfWork();
    const jobId = await seedJob(uow);
    const createApplication = makeCreateApplicationUseCase({ uow });
    const created = await createApplication({ userId: USER }, { jobPostingId: jobId });
    if (!isOk(created)) throw new Error('setup failed');

    const updateStage = makeUpdateStageUseCase({ uow });
    const r = await updateStage({ userId: USER }, { applicationId: created.value.applicationId, toStage: 'offer' });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('invalid_transition');
  });

  it('returns not_found for another user\'s application (ownership enforced)', async () => {
    const uow = new FakeUnitOfWork();
    const jobId = await seedJob(uow, OTHER);
    const createApplication = makeCreateApplicationUseCase({ uow });
    const created = await createApplication({ userId: OTHER }, { jobPostingId: jobId });
    if (!isOk(created)) throw new Error('setup failed');

    const updateStage = makeUpdateStageUseCase({ uow });
    const r = await updateStage({ userId: USER }, { applicationId: created.value.applicationId, toStage: 'applied' });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});
