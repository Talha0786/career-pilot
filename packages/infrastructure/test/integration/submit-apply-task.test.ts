import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleApplicationRepository } from '../../src/db/repositories/application.repository.js';
import { DrizzleDocumentRepository } from '../../src/db/repositories/document.repository.js';
import { DrizzleApplyTaskRepository } from '../../src/db/repositories/drizzle-apply-task.repository.js';
import { DrizzleOutboxPort } from '../../src/db/repositories/outbox.repository.js';
import { RedisApprovalTokenAdapter } from '../../src/auth/redis-approval-token.adapter.js';
import { User, Email, PasswordHash, JobPosting, Application, Document, ApplyTask, isOk, ok, err, uuidv7, type Result } from '@careerpilot/domain';
import { makeSubmitApplyTaskUseCase, type BrowserSubmitPort, type BrowserSubmitError } from '@careerpilot/application';
import { sql } from 'drizzle-orm';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/5';

const email = (s: string) => {
  const r = Email.create(s);
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};
const hash = () => {
  const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y');
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};

/** Real ATS click isn't what this test is proving — this counts real, concurrent invocations. */
class CountingBrowserSubmitPort implements BrowserSubmitPort {
  public callCount = 0;
  async submit(): Promise<Result<void, BrowserSubmitError>> {
    this.callCount++;
    await new Promise((r) => setTimeout(r, 5)); // small artificial window, same posture as budget-lock.test.ts's race proofs
    return ok(undefined);
  }
}

describe('submitApplyTask — REAL Postgres + REAL Redis exactly-once proof (task 053)', () => {
  let redis: IORedis;

  beforeAll(() => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  });
  afterAll(async () => redis.quit());
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
    await redis.flushdb();
  });

  async function seedApprovedTask(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const users = new DrizzleUserRepository(db);
    const jobs = new DrizzleJobPostingRepository(db);
    const apps = new DrizzleApplicationRepository(db);
    const docs = new DrizzleDocumentRepository(db);
    const applyTasks = new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db));

    const user = User.register({ email: email(`u-${uuidv7()}@test.com`), passwordHash: hash() });
    await users.save(user);
    const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobs.save(jobR.value);
    const application = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
    await apps.save(application);
    const docR = Document.create({ userId: user.id, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    });
    if (!isOk(versionR)) throw new Error('setup');
    await docs.save(document);

    const task = ApplyTask.create({
      userId: user.id, applicationId: application.id, jobPostingId: jobR.value.id, documentVersionId: versionR.value.id,
    });
    for (const stage of ['mapping', 'filling', 'awaiting_review', 'approved'] as const) task.transitionTo(stage);
    await applyTasks.save(task);

    return { user, task, applyTasks };
  }

  it('happy path against REAL Postgres — submitted, and the apply.task_submitted event lands in the REAL outbox table', async () => {
    await withTestDb(async (db) => {
      const { user, task, applyTasks } = await seedApprovedTask(db);
      const approvalTokens = new RedisApprovalTokenAdapter(redis, 300);
      const browserSubmit = new CountingBrowserSubmitPort();
      const useCase = makeSubmitApplyTaskUseCase({ applyTasks, approvalTokens, browserSubmit });

      const { token } = await approvalTokens.mint(task.id);
      const result = await useCase({ userId: user.id, applyTaskId: task.id, token });
      expect(isOk(result)).toBe(true);

      const reloaded = await applyTasks.findByIdForUser(task.id, user.id);
      expect(reloaded!.stage).toBe('submitted');

      const outboxRows = await db.execute(
        sql`SELECT event_type FROM outbox WHERE aggregate_id = ${task.id} AND event_type = 'apply.task_submitted'`,
      );
      expect((outboxRows as unknown as { event_type: string }[]).length).toBe(1);
    });
  });

  it('EXACTLY ONE of 20 concurrent submitApplyTask calls (same token) succeeds — real Postgres + real Redis, real Promise.all', async () => {
    await withTestDb(async (db) => {
      const { user, task, applyTasks } = await seedApprovedTask(db);
      const approvalTokens = new RedisApprovalTokenAdapter(redis, 300);
      const browserSubmit = new CountingBrowserSubmitPort();
      const useCase = makeSubmitApplyTaskUseCase({ applyTasks, approvalTokens, browserSubmit });

      const { token } = await approvalTokens.mint(task.id);

      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, () => useCase({ userId: user.id, applyTaskId: task.id, token })),
      );

      const successes = results.filter(isOk).filter((r) => r.value.stage === 'submitted');
      expect(successes).toHaveLength(1);
      expect(browserSubmit.callCount).toBe(1); // the real (counted) submit action fired exactly once

      const reloaded = await applyTasks.findByIdForUser(task.id, user.id);
      expect(reloaded!.stage).toBe('submitted');

      // Exactly one apply_task_steps row recording the submit-started
      // action exists too — not one per concurrent attempt.
      const steps = await db.execute(
        sql`SELECT action FROM apply_task_steps WHERE apply_task_id = ${task.id} AND action = 'submit-started'`,
      );
      expect((steps as unknown as unknown[]).length).toBe(1);
    });
  });

  it('a browser-runner failure leaves the task in failed, real Postgres round-trip, and the token stays consumed (no retry path)', async () => {
    await withTestDb(async (db) => {
      const { user, task, applyTasks } = await seedApprovedTask(db);
      const approvalTokens = new RedisApprovalTokenAdapter(redis, 300);
      const failingSubmit: BrowserSubmitPort = { submit: async () => err({ code: 'ats_error', message: 'boom' }) };
      const useCase = makeSubmitApplyTaskUseCase({ applyTasks, approvalTokens, browserSubmit: failingSubmit });

      const { token } = await approvalTokens.mint(task.id);
      const result = await useCase({ userId: user.id, applyTaskId: task.id, token });
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.stage).toBe('failed');

      const reloaded = await applyTasks.findByIdForUser(task.id, user.id);
      expect(reloaded!.stage).toBe('failed');

      const retry = await useCase({ userId: user.id, applyTaskId: task.id, token });
      expect(retry.ok).toBe(false); // token already consumed — no retry possible
    });
  });
});
