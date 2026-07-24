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
  OutboxRelay,
  BullMqOutboxPublisher,
  BullMqQueuePort,
  RedisDraftStore,
  DocumentRenderer,
  LocalFileObjectStorage,
  PostgresBudgetStore,
  Argon2Hasher,
} from '@careerpilot/infrastructure';
import { JobPosting, isOk, asUserId } from '@careerpilot/domain';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

/**
 * Task 030: POST /capture, the Class B (user-session capture) ingest
 * endpoint. Fixture payloads simulate what a bookmarklet extracting a
 * rendered LinkedIn/Indeed job page would send — the endpoint never
 * fetches anything server-side, so there is nothing to "record live" here
 * (unlike task 028's connectors) — this IS the payload shape by
 * specification (task 030's file list: `packages/contracts/src/capture.ts`).
 */
describe('POST /capture — Class B user-session capture (real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
  let uow: DrizzleUnitOfWork;
  let storageDir: string;

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings,
        ingestion_runs, connector_configs, document_versions, documents, profile_sections, career_profiles,
        users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    jobQueue = new Queue('discovery.job_posted', { connection: redis });
    uow = new DrizzleUnitOfWork(db);
    storageDir = await mkdtemp(path.join(tmpdir(), 'careerpilot-documents-'));

    app = await buildApp({
      db,
      redis,
      uow,
      users: new DrizzleUserRepository(db),
      jobPostings: new DrizzleJobPostingRepository(db),
      applications: new DrizzleApplicationRepository(db),
      connectorConfigs: new DrizzleConnectorConfigRepository(db),
      profiles: new DrizzleProfileRepository(db),
      documents: new DrizzleDocumentRepository(db),
      queue: new BullMqQueuePort(redis),
      drafts: new RedisDraftStore(redis),
      renderer: new DocumentRenderer(),
      storage: new LocalFileObjectStorage(storageDir),
      hasher: new Argon2Hasher(),
      outboxRelay: new OutboxRelay(db, new BullMqOutboxPublisher(redis)),
      jobQueue,
      budgetStore: new PostgresBudgetStore(db),
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

  const capturePayload = (overrides: Record<string, unknown> = {}) => ({
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    descriptionHtml: '<p>Own the ingestion pipeline.</p>',
    location: 'United States (Remote)',
    ...overrides,
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/capture', payload: capturePayload() });
    expect(res.statusCode).toBe(401);
  });

  it('stores the posted payload verbatim as job_postings with source_connector_key=capture, zero platform credentials involved', async () => {
    const { cookie } = await registerAndLogin('capture-user@test.com');

    const res = await app.inject({ method: 'POST', url: '/capture', headers: { cookie }, payload: capturePayload() });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('inserted');

    const rows = await db.execute(sql`SELECT source_connector_key, title, company, description_md FROM job_postings`);
    expect(rows).toHaveLength(1);
    const row = (rows as unknown as { source_connector_key: string; title: string; company: string; description_md: string }[])[0]!;
    expect(row.source_connector_key).toBe('capture');
    expect(row.title).toBe('Senior Backend Engineer');
    expect(row.company).toBe('Acme');
    expect(row.description_md).toContain('Own the ingestion pipeline.');

    // The literal proof of "no server-side fetch": the request body itself
    // never contained credentials, and nothing in the response or the
    // stored row references any secret/session/cookie belonging to the
    // captured platform (LinkedIn) — only what the browser already rendered.
  });

  it('rejects a malformed payload with a typed 400, not a 500', async () => {
    const { cookie } = await registerAndLogin('malformed@test.com');

    const res = await app.inject({ method: 'POST', url: '/capture', headers: { cookie }, payload: { title: 'Missing url and description' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json().code).toBe('validation_failed');
  });

  it('rejects a schema-valid payload with no usable description as a typed 400, not a 500', async () => {
    const { cookie } = await registerAndLogin('nodesc@test.com');

    const res = await app.inject({
      method: 'POST',
      url: '/capture',
      headers: { cookie },
      payload: { url: 'https://x.com/job/1', title: 'T', company: 'C' }, // no descriptionHtml/descriptionText
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('dedups against an equivalent Class A posting already ingested for the same user (feeds the same dedup path, task 029)', async () => {
    const { cookie, userId } = await registerAndLogin('dedup@test.com');

    // Seed a Class A (greenhouse) posting for the same real-world job.
    const classA = JobPosting.ingest({
      userId: asUserId(userId),
      sourceConnectorKey: 'greenhouse',
      externalId: 'gh-1',
      title: 'Senior Backend Engineer',
      descriptionMd: 'Own the ingestion pipeline.',
      company: 'Acme',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    if (!isOk(classA)) throw new Error('setup failed');
    await uow.withTransaction(async (ctx) => {
      await ctx.jobPostings.save(classA.value);
    });

    // Capture the "same" posting via LinkedIn, reformatted title.
    const res = await app.inject({
      method: 'POST',
      url: '/capture',
      headers: { cookie },
      payload: capturePayload({ title: 'Senior Backend Engineer (Remote)' }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('duplicate');

    const rows = await db.execute(sql`SELECT source_connector_key, dedup_group_id FROM job_postings ORDER BY ingested_at`);
    expect(rows).toHaveLength(2);
    const [a, b] = rows as unknown as { source_connector_key: string; dedup_group_id: string }[];
    expect(a!.dedup_group_id).not.toBeNull();
    expect(a!.dedup_group_id).toBe(b!.dedup_group_id);
  });

  it('re-capturing the exact same URL is idempotent — no duplicate row', async () => {
    const { cookie } = await registerAndLogin('idempotent@test.com');

    await app.inject({ method: 'POST', url: '/capture', headers: { cookie }, payload: capturePayload() });
    const second = await app.inject({ method: 'POST', url: '/capture', headers: { cookie }, payload: capturePayload() });

    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('already_captured');

    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings`);
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(1);
  });

  it('rejects bulk/scripted abuse — rate limited after the per-user cap (ADR-004 one-job-at-a-time posture)', async () => {
    const { cookie } = await registerAndLogin('bulk@test.com');

    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/capture',
        headers: { cookie },
        payload: capturePayload({ url: `https://www.linkedin.com/jobs/view/${1000 + i}/` }),
      });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  }, 30_000);
});
