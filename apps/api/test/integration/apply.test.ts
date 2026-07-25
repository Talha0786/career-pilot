import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb, type Db,
  DrizzleUnitOfWork, DrizzleUserRepository, DrizzleJobPostingRepository, DrizzleApplicationRepository,
  DrizzleConnectorConfigRepository, DrizzleProfileRepository, DrizzleDocumentRepository, DrizzleMatchScoreRepository,
  DrizzleApplyTaskRepository, DrizzleOutboxPort, RedisApprovalTokenAdapter,
  OutboxRelay, BullMqOutboxPublisher, BullMqQueuePort, RedisDraftStore, DocumentRenderer,
  LocalFileObjectStorage, PostgresBudgetStore, Argon2Hasher,
} from '@careerpilot/infrastructure';
import { JobPosting, Document, isOk, ok } from '@careerpilot/domain';
import type { BrowserSubmitPort } from '@careerpilot/application';
import type { BrowserRunnerFieldsPort } from '../../src/lib/browser-runner-client.js';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

describe('apply-tasks routes (tasks 052/053, real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
  let jobPostings: DrizzleJobPostingRepository;
  let applications: DrizzleApplicationRepository;
  let documents: DrizzleDocumentRepository;
  let storageDir: string;
  let browserSubmit: BrowserSubmitPort & { calls: string[]; nextResult: Awaited<ReturnType<BrowserSubmitPort['submit']>> };
  let browserRunnerFields: BrowserRunnerFieldsPort & { calls: string[]; nextResult: Awaited<ReturnType<BrowserRunnerFieldsPort['getFields']>> };

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, apply_task_steps, apply_tasks, stage_transitions, applications,
        match_scores, job_postings, ingestion_runs, connector_configs, document_versions, documents,
        profile_sections, career_profiles, users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    jobQueue = new Queue('discovery.job_posted', { connection: redis });
    jobPostings = new DrizzleJobPostingRepository(db);
    applications = new DrizzleApplicationRepository(db);
    documents = new DrizzleDocumentRepository(db);
    storageDir = await mkdtemp(path.join(tmpdir(), 'careerpilot-apply-'));

    browserSubmit = {
      calls: [],
      nextResult: ok(undefined),
      async submit(applyTaskId: string) {
        this.calls.push(applyTaskId);
        return this.nextResult;
      },
    };

    browserRunnerFields = {
      calls: [],
      nextResult: ok([
        { taxonomyKey: 'firstName', label: 'First name', selector: '#first_name', mappedValue: 'Ada', neverAutoFill: false, confidence: 0.98, source: 'known_ats' },
        { taxonomyKey: 'eeoGender', label: 'Gender (voluntary self-identification)', selector: '#eeo_gender', mappedValue: null, neverAutoFill: true, confidence: 0, source: 'known_ats' },
      ]),
      async getFields(applyTaskId: string) {
        this.calls.push(applyTaskId);
        return this.nextResult;
      },
    };

    app = await buildApp({
      db, redis,
      uow: new DrizzleUnitOfWork(db),
      users: new DrizzleUserRepository(db),
      jobPostings,
      applications,
      connectorConfigs: new DrizzleConnectorConfigRepository(db),
      profiles: new DrizzleProfileRepository(db),
      documents,
      matchScores: new DrizzleMatchScoreRepository(db),
      queue: new BullMqQueuePort(redis),
      drafts: new RedisDraftStore(redis),
      renderer: new DocumentRenderer(),
      storage: new LocalFileObjectStorage(storageDir),
      hasher: new Argon2Hasher(),
      outboxRelay: new OutboxRelay(db, new BullMqOutboxPublisher(redis)),
      jobQueue,
      budgetStore: new PostgresBudgetStore(db),
      applyTasks: new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db)),
      approvalTokens: new RedisApprovalTokenAdapter(redis, 300),
      browserSubmit,
      browserRunnerFields,
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await jobQueue.close();
    await rm(storageDir, { recursive: true, force: true });
    await redis.quit();
    await closeDb();
  });

  async function registerAndLogin(email: string, password = 'correct horse battery staple') {
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
    const loginRes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    const cookie = extractCookie(loginRes.headers['set-cookie']);
    return { cookie, userId: loginRes.json().userId as string };
  }

  it('requires auth on every apply-tasks route', async () => {
    expect((await app.inject({ method: 'GET', url: '/apply-tasks' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/apply-tasks', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/apply-tasks/x/fields' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/apply-tasks/x/approve' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/apply-tasks/x/reject' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/apply-tasks/x/submit', payload: { token: 'x' } })).statusCode).toBe(401);
  });

  it('GET /apply-tasks/:id/fields — the ADR-003 review diff: real ownership check, real stage gate, real proxy to browser-runner', async () => {
    const { cookie, userId } = await registerAndLogin('fieldsflow@test.com');
    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobPostings.save(jobR.value);
    const appCreateRes = await app.inject({ method: 'POST', url: '/applications', headers: { cookie }, payload: { jobPostingId: jobR.value.id } });
    const applicationId = appCreateRes.json().applicationId as string;
    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    });
    if (!isOk(versionR)) throw new Error('setup');
    await documents.save(document);

    const startRes = await app.inject({
      method: 'POST', url: '/apply-tasks', headers: { cookie },
      payload: { applicationId, documentId: document.id, documentVersionId: versionR.value.id },
    });
    const applyTaskId = startRes.json().applyTaskId as string;

    // Not yet in awaiting_review/approved — no diff to review yet.
    const tooEarlyRes = await app.inject({ method: 'GET', url: `/apply-tasks/${applyTaskId}/fields`, headers: { cookie } });
    expect(tooEarlyRes.statusCode).toBe(409);
    expect(browserRunnerFields.calls).toHaveLength(0);

    const applyTasks = new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db));
    const task = await applyTasks.findByIdForUser(applyTaskId as never, userId as never);
    task!.transitionTo('mapping'); task!.transitionTo('filling'); task!.transitionTo('awaiting_review');
    await applyTasks.save(task!);

    const fieldsRes = await app.inject({ method: 'GET', url: `/apply-tasks/${applyTaskId}/fields`, headers: { cookie } });
    expect(fieldsRes.statusCode).toBe(200);
    expect(browserRunnerFields.calls).toEqual([applyTaskId]);
    const fields = fieldsRes.json().fields as { taxonomyKey: string; mappedValue: string | null; neverAutoFill: boolean }[];
    expect(fields).toHaveLength(2);
    const nameField = fields.find((f) => f.taxonomyKey === 'firstName');
    expect(nameField?.mappedValue).toBe('Ada');
    // The sensitive field is present (so the UI can surface it) but its value is NEVER populated.
    const sensitiveField = fields.find((f) => f.taxonomyKey === 'eeoGender');
    expect(sensitiveField?.neverAutoFill).toBe(true);
    expect(sensitiveField?.mappedValue).toBeNull();

    // Ownership-scoped — a different user can't read this task's diff.
    const { cookie: otherCookie } = await registerAndLogin('other-fieldsflow@test.com');
    const crossOwnerRes = await app.inject({ method: 'GET', url: `/apply-tasks/${applyTaskId}/fields`, headers: { cookie: otherCookie } });
    expect(crossOwnerRes.statusCode).toBe(404);
  });

  it('full happy path: start → approve (mints token) → submit — real round trip through Postgres+Redis', async () => {
    const { cookie, userId } = await registerAndLogin('applyflow@test.com');
    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobPostings.save(jobR.value);

    const appCreateRes = await app.inject({ method: 'POST', url: '/applications', headers: { cookie }, payload: { jobPostingId: jobR.value.id } });
    expect(appCreateRes.statusCode).toBe(201);
    const applicationId = appCreateRes.json().applicationId as string;

    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    });
    if (!isOk(versionR)) throw new Error('setup');
    await documents.save(document);

    // 1. Start
    const startRes = await app.inject({
      method: 'POST', url: '/apply-tasks', headers: { cookie },
      payload: { applicationId, documentId: document.id, documentVersionId: versionR.value.id },
    });
    expect(startRes.statusCode).toBe(201);
    const applyTaskId = startRes.json().applyTaskId as string;
    expect(startRes.json().stage).toBe('draft');

    // Drive to awaiting_review directly via the repository (mapping/filling
    // is Playwright-driven, task 051 — out of scope for THIS route test).
    const applyTasks = new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db));
    const task = await applyTasks.findByIdForUser(applyTaskId as never, userId as never);
    task!.transitionTo('mapping');
    task!.transitionTo('filling');
    task!.transitionTo('awaiting_review');
    await applyTasks.save(task!);

    // 2. List — shows up in the review queue.
    const listRes = await app.inject({ method: 'GET', url: '/apply-tasks?stage=awaiting_review', headers: { cookie } });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().tasks).toHaveLength(1);

    // 3. Approve — mints a real single-use token.
    const approveRes = await app.inject({ method: 'POST', url: `/apply-tasks/${applyTaskId}/approve`, headers: { cookie } });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().stage).toBe('approved');
    const token = approveRes.json().token as string;
    expect(token).toBeTruthy();

    // 4. Submit — real submitApplyTask call, real token consumption, real browser-runner call recorded.
    const submitRes = await app.inject({ method: 'POST', url: `/apply-tasks/${applyTaskId}/submit`, headers: { cookie }, payload: { token } });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().stage).toBe('submitted');
    expect(browserSubmit.calls).toEqual([applyTaskId]);

    // 5. Re-submitting with the SAME token fails — already consumed.
    const resubmitRes = await app.inject({ method: 'POST', url: `/apply-tasks/${applyTaskId}/submit`, headers: { cookie }, payload: { token } });
    expect(resubmitRes.statusCode).toBe(403);
    expect(browserSubmit.calls).toHaveLength(1); // still just 1
  });

  it('reject transitions to aborted and mints no token', async () => {
    const { cookie, userId } = await registerAndLogin('rejectflow@test.com');
    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobPostings.save(jobR.value);
    const appCreateRes = await app.inject({ method: 'POST', url: '/applications', headers: { cookie }, payload: { jobPostingId: jobR.value.id } });
    const applicationId = appCreateRes.json().applicationId as string;
    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
    });
    if (!isOk(versionR)) throw new Error('setup');
    await documents.save(document);

    const startRes = await app.inject({
      method: 'POST', url: '/apply-tasks', headers: { cookie },
      payload: { applicationId, documentId: document.id, documentVersionId: versionR.value.id },
    });
    const applyTaskId = startRes.json().applyTaskId as string;
    const applyTasks = new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db));
    const task = await applyTasks.findByIdForUser(applyTaskId as never, userId as never);
    task!.transitionTo('mapping'); task!.transitionTo('filling'); task!.transitionTo('awaiting_review');
    await applyTasks.save(task!);

    const rejectRes = await app.inject({ method: 'POST', url: `/apply-tasks/${applyTaskId}/reject`, headers: { cookie } });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().stage).toBe('aborted');
    expect(browserSubmit.calls).toHaveLength(0);
  });

  it('starting against a non-exportable document version is rejected with 400 (task 051\'s gate, exercised via HTTP)', async () => {
    const { cookie, userId } = await registerAndLogin('gateflow@test.com');
    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup');
    await jobPostings.save(jobR.value);
    const appCreateRes = await app.inject({ method: 'POST', url: '/applications', headers: { cookie }, payload: { jobPostingId: jobR.value.id } });
    const applicationId = appCreateRes.json().applicationId as string;

    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'generated',
      content: { schemaVersion: 1, kind: 'resume', contact: { name: 'A', email: 'a@b.com' }, summary: null, sections: [] },
      needsHumanReview: true,
      flaggedClaims: [{ text: 'unsupported', confidence: 0.9 }],
    });
    if (!isOk(versionR)) throw new Error('setup');
    await documents.save(document);

    const startRes = await app.inject({
      method: 'POST', url: '/apply-tasks', headers: { cookie },
      payload: { applicationId, documentId: document.id, documentVersionId: versionR.value.id },
    });
    expect(startRes.statusCode).toBe(400);
    expect(startRes.json().code).toBe('validation_failed');
  });
});
