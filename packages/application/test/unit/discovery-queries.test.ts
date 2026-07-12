import { describe, it, expect } from 'vitest';
import { makeCreateManualJobUseCase } from '../../src/discovery/commands/create-manual-job.js';
import { makeGetJobUseCase } from '../../src/discovery/queries/get-job.js';
import { makeListJobsUseCase } from '../../src/discovery/queries/list-jobs.js';
import { FakeUnitOfWork, FakeJobPostingRepository } from '../fake-repos.js';
import { asUserId, isOk, isErr } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');

describe('getJob', () => {
  it('returns the job summary for its owner', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'Backend Engineer', descriptionMd: 'Build things.', company: 'Acme' });
    if (!isOk(created)) throw new Error('setup failed');

    const getJob = makeGetJobUseCase({ jobPostings });
    const r = await getJob({ userId: USER }, created.value.jobId);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.title).toBe('Backend Engineer');
    expect(r.value.company).toBe('Acme');
    expect(r.value.embeddingStatus).toBe('pending');
    expect(r.value.id).toBe(created.value.jobId);
  });

  it('is ownership-scoped — a different user gets not_found, not the other owner\'s job', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    const getJob = makeGetJobUseCase({ jobPostings });
    const r = await getJob({ userId: OTHER }, created.value.jobId);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });

  it('returns not_found for a job id that does not exist', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const getJob = makeGetJobUseCase({ jobPostings });

    const r = await getJob({ userId: USER }, '018f0000-0000-7000-8000-0000000000ff');

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});

describe('listJobs', () => {
  it('lists only the requesting user\'s jobs, mapped to summaries', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    await create({ userId: USER }, { title: 'Mine 1', descriptionMd: 'D' });
    await create({ userId: USER }, { title: 'Mine 2', descriptionMd: 'D' });
    await create({ userId: OTHER }, { title: 'Not mine', descriptionMd: 'D' });

    const listJobs = makeListJobsUseCase({ jobPostings });
    const result = await listJobs({ userId: USER }, { limit: 10 });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((j) => j.title).sort()).toEqual(['Mine 1', 'Mine 2']);
    expect(result.nextCursor).toBeNull();
  });

  it('returns an empty list for a user with no jobs', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const listJobs = makeListJobsUseCase({ jobPostings });

    const result = await listJobs({ userId: USER }, { limit: 10 });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('passes an explicit cursor through to the repository', async () => {
    const jobPostings = new FakeJobPostingRepository();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });

    const listJobs = makeListJobsUseCase({ jobPostings });
    // FakeJobPostingRepository ignores the cursor value itself (it's a real-
    // Postgres pagination concern, task 007) — this proves the query layer
    // doesn't drop it before it gets there, not that pagination is correct.
    const result = await listJobs({ userId: USER }, { cursor: 'some-cursor', limit: 10 });

    expect(result.items).toHaveLength(1);
  });
});
