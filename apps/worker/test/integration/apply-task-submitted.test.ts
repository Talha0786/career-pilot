import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { createDb, type Db } from '@careerpilot/infrastructure';
import {
  OutboxRelay, BullMqOutboxPublisher, DrizzleUserRepository, DrizzleJobPostingRepository,
  DrizzleApplicationRepository, DrizzleDocumentRepository, DrizzleApplyTaskRepository, DrizzleOutboxPort,
  RedisApprovalTokenAdapter,
} from '@careerpilot/infrastructure';
import {
  makeSubmitApplyTaskUseCase, type BrowserSubmitPort,
} from '@careerpilot/application';
import { createApplyTaskSubmittedWorker } from '../../src/handlers/apply-task-submitted.handler.js';
import { User, Email, PasswordHash, JobPosting, Application, Document, ApplyTask, isOk, ok } from '@careerpilot/domain';
import pino from 'pino';
import { sql } from 'drizzle-orm';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

/**
 * Task 053's literal acceptance criterion, proven end-to-end with the REAL
 * outbox/relay/BullMQ/worker chain (mirrors `profile-embed.test.ts`'s
 * task-035 pattern): "A successful submit transitions the linked
 * Application to applied automatically."
 */
describe('End-to-end: submitApplyTask → outbox → relay → BullMQ → worker → Application.applied (task 053)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    close = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, apply_task_steps, apply_tasks, stage_transitions, applications, job_postings, document_versions, documents, career_profiles, users RESTART IDENTITY CASCADE`);
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterEach(async () => {
    await close();
    await redis.quit();
  });

  it('a real submitted ApplyTask drives the real Application to applied with zero manual wiring beyond the real components', async () => {
    const email = (() => { const r = Email.create('e2e-apply@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })();
    const hash = (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })();
    const user = User.register({ email, passwordHash: hash });
    const users = new DrizzleUserRepository(db);
    await users.save(user);

    const jobs = new DrizzleJobPostingRepository(db);
    const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobs.save(jobR.value);

    const applications = new DrizzleApplicationRepository(db);
    const application = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
    await applications.save(application);
    expect(application.stage).toBe('discovered');

    const docs = new DrizzleDocumentRepository(db);
    const docR = Document.create({ userId: user.id, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    });
    if (!isOk(versionR)) throw new Error('setup');
    await docs.save(document);

    const outbox = new DrizzleOutboxPort(db);
    const applyTasks = new DrizzleApplyTaskRepository(db, outbox);
    const task = ApplyTask.create({
      userId: user.id, applicationId: application.id, jobPostingId: jobR.value.id, documentVersionId: versionR.value.id,
    });
    for (const stage of ['mapping', 'filling', 'awaiting_review', 'approved'] as const) task.transitionTo(stage);
    await applyTasks.save(task);

    const approvalTokens = new RedisApprovalTokenAdapter(redis, 300);
    const browserSubmit: BrowserSubmitPort = { submit: async () => ok(undefined) };
    const submitApplyTask = makeSubmitApplyTaskUseCase({ applyTasks, approvalTokens, browserSubmit });

    const { token } = await approvalTokens.mint(task.id);
    const submitResult = await submitApplyTask({ userId: user.id, applyTaskId: task.id, token });
    expect(isOk(submitResult)).toBe(true);
    if (isOk(submitResult)) expect(submitResult.value.stage).toBe('submitted');

    // Real relay: publishes the REAL apply.task_submitted outbox row to REAL BullMQ.
    const publisher = new BullMqOutboxPublisher(redis);
    const relay = new OutboxRelay(db, publisher);
    const stats = await relay.pollOnce();
    expect(stats.published).toBeGreaterThanOrEqual(1);

    const logger = pino({ level: 'silent' });
    const worker = createApplyTaskSubmittedWorker({ connection: redis, applications, logger });

    try {
      const deadline = Date.now() + 10_000;
      let finalStage: string | null = null;
      while (Date.now() < deadline) {
        const reloaded = await applications.findByIdForUser(application.id, user.id);
        if (reloaded?.stage === 'applied') { finalStage = reloaded.stage; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(finalStage).toBe('applied');
    } finally {
      await worker.close();
      await publisher.closeAll();
    }
  }, 20_000);
});
