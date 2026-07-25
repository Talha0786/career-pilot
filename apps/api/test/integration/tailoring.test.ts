import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDb,
  type Db,
  DrizzleUnitOfWork,
  DrizzleUserRepository,
  DrizzleJobPostingRepository,
  DrizzleApplicationRepository,
  DrizzleConnectorConfigRepository,
  DrizzleProfileRepository,
  DrizzleDocumentRepository,
  DrizzleMatchScoreRepository,
  OutboxRelay,
  BullMqOutboxPublisher,
  BullMqQueuePort,
  RedisDraftStore,
  DocumentRenderer,
  LocalFileObjectStorage,
  PostgresBudgetStore,
  Argon2Hasher,
  McpTokenAdapter,
} from '@careerpilot/infrastructure';
import { CareerProfile, JobPosting, Document, isOk } from '@careerpilot/domain';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

describe('POST /documents/:id/tailor (task 039, real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
  let tailorQueue: Queue;
  let profiles: DrizzleProfileRepository;
  let jobPostings: DrizzleJobPostingRepository;
  let documents: DrizzleDocumentRepository;
  let storageDir: string;

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, mcp_tokens, interview_preps, application_notes, ai_invocations, outbox, stage_transitions, applications, match_scores, job_postings,
        ingestion_runs, connector_configs, document_versions, documents, profile_sections, career_profiles,
        users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    jobQueue = new Queue('discovery.job_posted', { connection: redis });
    tailorQueue = new Queue('tailoring.document_requested', { connection: redis });
    profiles = new DrizzleProfileRepository(db);
    jobPostings = new DrizzleJobPostingRepository(db);
    documents = new DrizzleDocumentRepository(db);
    storageDir = await mkdtemp(path.join(tmpdir(), 'careerpilot-documents-'));

    app = await buildApp({
      db,
      redis,
      uow: new DrizzleUnitOfWork(db),
      users: new DrizzleUserRepository(db),
      jobPostings,
      applications: new DrizzleApplicationRepository(db),
      connectorConfigs: new DrizzleConnectorConfigRepository(db),
      profiles,
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
      mcpTokens: new McpTokenAdapter(db),
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await jobQueue.close();
    await tailorQueue.close();
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

  it('requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/documents/018f0000-0000-7000-8000-000000000001/tailor', payload: { jobPostingId: '018f0000-0000-7000-8000-000000000002' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for a document that does not exist / is not owned by the caller', async () => {
    const { cookie } = await registerAndLogin('notmine@test.com');
    const res = await app.inject({
      method: 'POST', url: '/documents/018f0000-0000-7000-8000-0000000000ff/tailor', headers: { cookie },
      payload: { jobPostingId: '018f0000-0000-7000-8000-0000000000ff' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a document of kind "other" (not tailorable)', async () => {
    const { cookie, userId } = await registerAndLogin('otherkind@test.com');
    const docR = Document.create({ userId: userId as never, kind: 'other', title: 'Notes' });
    if (!isOk(docR)) throw new Error('setup failed');
    await documents.save(docR.value);

    const res = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/tailor`, headers: { cookie },
      payload: { jobPostingId: '018f0000-0000-7000-8000-0000000000ff' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('returns 202 {queued:true} and actually enqueues a tailoring.document_requested BullMQ job with the right payload — the real round-trip', async () => {
    const { cookie, userId } = await registerAndLogin('tailorme@test.com');

    const profileR = CareerProfile.create({ userId: userId as never, title: 'My Profile' });
    if (!isOk(profileR)) throw new Error('setup failed');
    await profiles.save(profileR.value);

    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup failed');
    await jobPostings.save(jobR.value);

    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'My Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    await documents.save(docR.value);

    const res = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/tailor`, headers: { cookie },
      payload: { jobPostingId: jobR.value.id },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });

    const jobs = await tailorQueue.getJobs(['waiting', 'active', 'completed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      documentId: docR.value.id, profileId: profileR.value.id, jobPostingId: jobR.value.id, userId, kind: 'resume',
    });
  });

  it('returns 404 when the caller has no active career profile yet', async () => {
    const { cookie, userId } = await registerAndLogin('noprofile@test.com');
    const jobR = JobPosting.createManual({ userId: userId as never, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup failed');
    await jobPostings.save(jobR.value);
    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'My Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    await documents.save(docR.value);

    const res = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/tailor`, headers: { cookie },
      payload: { jobPostingId: jobR.value.id },
    });
    expect(res.statusCode).toBe(404);
  });
});
