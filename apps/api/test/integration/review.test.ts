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
import { Document, isOk } from '@careerpilot/domain';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

const resumeContent = () => ({
  schemaVersion: 1 as const,
  kind: 'resume' as const,
  contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
  summary: 'Engineer',
  sections: [],
});

/**
 * Task 041's full round-trip, real Postgres + Redis: tailor (represented
 * here by directly persisting a `needsHumanReview:true` generated version —
 * the ACTUAL tailoring LLM call is proven end-to-end in
 * apps/worker/test/integration/tailor-document.test.ts, task 040; this test
 * proves the review->export-unblock path that starts from that state) ->
 * GET the version (flaggedClaims visible) -> POST review -> GET again
 * (needsHumanReview cleared) -> POST render (now succeeds, was blocked
 * before).
 */
describe('POST /documents/:id/versions/:versionId/review (task 041, real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
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
    documents = new DrizzleDocumentRepository(db);
    storageDir = await mkdtemp(path.join(tmpdir(), 'careerpilot-review-'));

    app = await buildApp({
      db,
      redis,
      uow: new DrizzleUnitOfWork(db),
      users: new DrizzleUserRepository(db),
      jobPostings: new DrizzleJobPostingRepository(db),
      applications: new DrizzleApplicationRepository(db),
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
      mcpTokens: new McpTokenAdapter(db),
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

  it('the FULL round-trip: needs_human version -> visible via GET -> reviewed -> needsHumanReview cleared -> export unblocked', async () => {
    const { cookie, userId } = await registerAndLogin('reviewer@test.com');

    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'My Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    const added = docR.value.addVersion({
      source: 'generated',
      content: resumeContent(),
      profileFactsHash: 'hash-1',
      needsHumanReview: true,
      flaggedClaims: [{ text: 'Led a team of 12 engineers', confidence: 0.15 }],
    });
    if (!added.ok) throw new Error('setup failed');
    await documents.save(docR.value);
    const versionId = added.value.id;

    // 1. Fetch the review payload — the diff-review UI's data source (task
    // 041: "fetch a version's ClaimAudit + diff data" — served by the
    // existing GET /documents/:id, now carrying needsHumanReview/flaggedClaims).
    const getRes = await app.inject({ method: 'GET', url: `/documents/${docR.value.id}`, headers: { cookie } });
    expect(getRes.statusCode).toBe(200);
    const before = getRes.json();
    const versionBefore = before.versions.find((v: { id: string }) => v.id === versionId);
    expect(versionBefore.needsHumanReview).toBe(true);
    expect(versionBefore.flaggedClaims).toEqual([{ text: 'Led a team of 12 engineers', confidence: 0.15 }]);

    // 2. Export is BLOCKED before review.
    const blockedRender = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/versions/${versionId}/render`, headers: { cookie },
      payload: { format: 'pdf', template: 'classic' },
    });
    expect(blockedRender.statusCode).toBe(409);
    expect(blockedRender.json().code).toBe('conflict');

    // 3. Submit the review — reviewer accepts the flagged claim as fine.
    const reviewRes = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/versions/${versionId}/review`, headers: { cookie },
      payload: { approved: true },
    });
    expect(reviewRes.statusCode).toBe(200);
    expect(reviewRes.json()).toEqual({ documentId: docR.value.id, versionId, needsHumanReview: false });

    // 4. GET again — needsHumanReview cleared, flaggedClaims kept as history.
    const getResAfter = await app.inject({ method: 'GET', url: `/documents/${docR.value.id}`, headers: { cookie } });
    const versionAfter = getResAfter.json().versions.find((v: { id: string }) => v.id === versionId);
    expect(versionAfter.needsHumanReview).toBe(false);
    expect(versionAfter.flaggedClaims).toEqual([{ text: 'Led a team of 12 engineers', confidence: 0.15 }]);

    // 5. Export is now UNBLOCKED — the whole point of task 041.
    const unblockedRender = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/versions/${versionId}/render`, headers: { cookie },
      payload: { format: 'pdf', template: 'classic' },
    });
    expect(unblockedRender.statusCode).toBe(200);
  });

  it('rejecting a claim (approved:false) keeps export blocked — the edge case task 041 explicitly asks to prove', async () => {
    const { cookie, userId } = await registerAndLogin('rejecter@test.com');

    const docR = Document.create({ userId: userId as never, kind: 'resume', title: 'My Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    const added = docR.value.addVersion({
      source: 'generated',
      content: resumeContent(),
      profileFactsHash: 'hash-1',
      needsHumanReview: true,
      flaggedClaims: [{ text: 'Fabricated claim', confidence: 0.05 }],
    });
    if (!added.ok) throw new Error('setup failed');
    await documents.save(docR.value);
    const versionId = added.value.id;

    const reviewRes = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/versions/${versionId}/review`, headers: { cookie },
      payload: { approved: false },
    });
    expect(reviewRes.statusCode).toBe(200);
    expect(reviewRes.json().needsHumanReview).toBe(true);

    const renderRes = await app.inject({
      method: 'POST', url: `/documents/${docR.value.id}/versions/${versionId}/render`, headers: { cookie },
      payload: { format: 'pdf', template: 'classic' },
    });
    expect(renderRes.statusCode).toBe(409);
  });

  it('requires auth', async () => {
    const res = await app.inject({
      method: 'POST', url: '/documents/018f0000-0000-7000-8000-000000000001/versions/018f0000-0000-7000-8000-000000000002/review',
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for a document not owned by the caller', async () => {
    const { cookie } = await registerAndLogin('notmine2@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/documents/018f0000-0000-7000-8000-0000000000ff/versions/018f0000-0000-7000-8000-0000000000ff/review',
      headers: { cookie },
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
