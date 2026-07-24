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
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

describe('GET/PATCH /connectors (task 032, real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
  let connectorConfigs: DrizzleConnectorConfigRepository;
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
    connectorConfigs = new DrizzleConnectorConfigRepository(db);
    storageDir = await mkdtemp(path.join(tmpdir(), 'careerpilot-documents-'));

    app = await buildApp({
      db,
      redis,
      uow: new DrizzleUnitOfWork(db),
      users: new DrizzleUserRepository(db),
      jobPostings: new DrizzleJobPostingRepository(db),
      applications: new DrizzleApplicationRepository(db),
      connectorConfigs,
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

  it('requires auth for both routes', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/connectors' });
    expect(getRes.statusCode).toBe(401);
    const patchRes = await app.inject({ method: 'PATCH', url: '/connectors/018f0000-0000-7000-8000-000000000001', payload: {} });
    expect(patchRes.statusCode).toBe(401);
  });

  it('GET lists the caller\'s own connector configs, scoped by ownership', async () => {
    const { cookie, userId } = await registerAndLogin('owner@test.com');
    const { userId: otherUserId } = await registerAndLogin('other@test.com');

    const now = new Date();
    await connectorConfigs.save({
      id: '018f0000-0000-7000-8000-0000000000a1',
      userId: userId as never,
      connectorKey: 'greenhouse',
      displayName: 'My Greenhouse',
      enabled: true,
      scheduleCron: '0 * * * *',
      config: { boardToken: 'acme' },
      credentialsRef: null,
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await connectorConfigs.save({
      id: '018f0000-0000-7000-8000-0000000000a2',
      userId: otherUserId as never,
      connectorKey: 'lever',
      displayName: 'Not mine',
      enabled: true,
      scheduleCron: null,
      config: {},
      credentialsRef: null,
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({ method: 'GET', url: '/connectors', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].connectorKey).toBe('greenhouse');
    expect(body.items[0].config).toEqual({ boardToken: 'acme' });
  });

  it('PATCH /connectors/:id for BYO-key config NEVER returns the stored key value in the response body (task 032 acceptance)', async () => {
    const { cookie, userId } = await registerAndLogin('byokey@test.com');
    const now = new Date();
    await connectorConfigs.save({
      id: '018f0000-0000-7000-8000-0000000000b1',
      userId: userId as never,
      connectorKey: 'serpapi-google-jobs',
      displayName: 'SerpApi',
      enabled: false,
      scheduleCron: null,
      config: { query: 'engineer' },
      credentialsRef: null,
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const secretLookingValue = 'sk-live-THIS_LOOKS_LIKE_A_REAL_API_KEY_1234567890';
    const res = await app.inject({
      method: 'PATCH',
      url: '/connectors/018f0000-0000-7000-8000-0000000000b1',
      headers: { cookie },
      payload: { enabled: true, credentialsRef: secretLookingValue },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    // THE assertion: the response body must not contain the field at all,
    // and — belt and suspenders — must not contain the value as a substring
    // anywhere in the serialized response, in case of a future field rename.
    expect(body).not.toHaveProperty('credentialsRef');
    expect(JSON.stringify(body)).not.toContain(secretLookingValue);

    // It WAS persisted server-side (this isn't "silently dropped", it's
    // "written but write-only on the way back out") — verified directly
    // against the DB, never through the API response.
    const stored = await connectorConfigs.findById('018f0000-0000-7000-8000-0000000000b1');
    expect(stored!.credentialsRef).toBe(secretLookingValue);

    // A second GET of the same resource also never leaks it.
    const getRes = await app.inject({ method: 'GET', url: '/connectors', headers: { cookie } });
    expect(JSON.stringify(getRes.json())).not.toContain(secretLookingValue);
  });

  it('PATCH returns 404 for a connector config that belongs to a different user (ownership check, not information leak)', async () => {
    const { userId: victimId } = await registerAndLogin('victim@test.com');
    const { cookie: attackerCookie } = await registerAndLogin('attacker@test.com');

    const now = new Date();
    await connectorConfigs.save({
      id: '018f0000-0000-7000-8000-0000000000c1',
      userId: victimId as never,
      connectorKey: 'greenhouse',
      displayName: 'Victim board',
      enabled: true,
      scheduleCron: null,
      config: {},
      credentialsRef: null,
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/connectors/018f0000-0000-7000-8000-0000000000c1',
      headers: { cookie: attackerCookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed PATCH body with a typed 400', async () => {
    const { cookie } = await registerAndLogin('malformed-patch@test.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/connectors/018f0000-0000-7000-8000-000000000099',
      headers: { cookie },
      payload: { enabled: 'not-a-boolean' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });
});
