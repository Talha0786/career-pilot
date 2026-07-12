import { describe, it, expect } from 'vitest';
import { makeCreateManualJobUseCase } from '../../src/discovery/commands/create-manual-job.js';
import { makeEmbedJobPostingUseCase } from '../../src/discovery/commands/embed-job-posting.js';
import { FakeUnitOfWork, FakeJobPostingRepository } from '../fake-repos.js';
import { FakeLlmPort, InMemoryBudgetStore, FakeCostEstimator } from '../fakes.js';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import { asUserId, isOk, isErr } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

describe('createManualJob', () => {
  it('persists the job AND its outbox event atomically', async () => {
    const uow = new FakeUnitOfWork();
    const createManualJob = makeCreateManualJobUseCase({ uow });

    const r = await createManualJob(
      { userId: USER },
      { title: 'Backend Engineer', descriptionMd: 'Build things with Postgres.' },
    );

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    expect(r.value.embeddingStatus).toBe('pending');

    // The event MUST be in the outbox — this is ADR-007's guarantee, tested
    // at the use-case level (the transactional adapter is tested in task 007).
    expect(uow.outbox.enqueued).toHaveLength(1);
    expect(uow.outbox.enqueued[0]!.eventType).toBe('discovery.job_posted');

    const stored = await uow.jobPostings.findByIdForUser(
      r.value.jobId as never,
      USER,
    );
    expect(stored).not.toBeNull();
  });

  it('rejects invalid input and writes nothing', async () => {
    const uow = new FakeUnitOfWork();
    const createManualJob = makeCreateManualJobUseCase({ uow });

    const r = await createManualJob({ userId: USER }, { title: '', descriptionMd: 'x' });

    expect(isErr(r)).toBe(true);
    expect(uow.outbox.enqueued).toHaveLength(0);
  });
});

describe('embedJobPosting — idempotency under at-least-once delivery (ADR-007)', () => {
  function setup(budgetUsd = 10) {
    const jobPostings = new FakeJobPostingRepository();
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    const guarded = new GuardedLlmPort(inner, store, new FakeCostEstimator(), budgetUsd, 'fake');
    const embedJobPosting = makeEmbedJobPostingUseCase({ jobPostings, llm: guarded });
    return { jobPostings, inner, store, embedJobPosting };
  }

  it('embeds a pending job and marks it ready', async () => {
    const { jobPostings, embedJobPosting } = setup();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    const r = await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'test-model' });
    expect(isOk(r)).toBe(true);

    const job = await jobPostings.findByIdAnyOwner(created.value.jobId as never);
    expect(job!.embeddingStatus).toBe('ready');
  });

  it('is a no-op on redelivery — the LLM is called exactly once', async () => {
    const { jobPostings, inner, embedJobPosting } = setup();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    // Simulate the outbox relay delivering the SAME event twice.
    await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'test-model' });
    await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'test-model' });

    expect(inner.callCount).toBe(1); // NOT 2 — this is the whole point of the test
  });

  it('re-embeds when the model changes (legitimate upgrade, not a duplicate)', async () => {
    const { jobPostings, inner, embedJobPosting } = setup();
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'model-a' });
    await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'model-b' });

    expect(inner.callCount).toBe(2);
  });

  it('marks the job failed (not crashed) when the budget blocks the call', async () => {
    const { jobPostings, embedJobPosting } = setup(0); // $0 budget
    const uow = new FakeUnitOfWork(undefined, jobPostings);
    const create = makeCreateManualJobUseCase({ uow });
    const created = await create({ userId: USER }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    const r = await embedJobPosting({ jobPostingId: created.value.jobId, userId: USER, model: 'm' });
    expect(isErr(r)).toBe(true);

    const job = await jobPostings.findByIdAnyOwner(created.value.jobId as never);
    expect(job!.embeddingStatus).toBe('failed');
  });

  it('returns not_found for a job that no longer exists (deleted between enqueue and consume)', async () => {
    const { embedJobPosting } = setup();
    const r = await embedJobPosting({
      jobPostingId: '018f0000-0000-7000-8000-0000000000ff',
      userId: USER,
      model: 'm',
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('not_found');
  });
});
