import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import {
  createDb,
  type Db,
  DrizzleUnitOfWork,
  DrizzleUserRepository,
  DrizzleJobPostingRepository,
  DrizzleApplicationRepository,
  DrizzleConnectorConfigRepository,
  OutboxRelay,
  BullMqOutboxPublisher,
  PostgresBudgetStore,
  Argon2Hasher,
} from '@careerpilot/infrastructure';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

describe('API — auth, jobs, board, ownership (real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, ingestion_runs, connector_configs, users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();

    jobQueue = new Queue('discovery.job_posted', { connection: redis });

    app = await buildApp({
      db,
      redis,
      uow: new DrizzleUnitOfWork(db),
      users: new DrizzleUserRepository(db),
      jobPostings: new DrizzleJobPostingRepository(db),
      applications: new DrizzleApplicationRepository(db),
      connectorConfigs: new DrizzleConnectorConfigRepository(db),
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
    await redis.quit();
    await closeDb();
  });

  async function registerAndLogin(email: string, password = 'correct horse battery staple') {
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
    const loginRes = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    const cookie = extractCookie(loginRes.headers['set-cookie']);
    return { cookie, userId: loginRes.json().userId as string };
  }

  describe('auth', () => {
    it('registers, logs in, reads /auth/me, and logs out', async () => {
      const registerRes = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'alice@test.com', password: 'correct horse battery staple' },
      });
      expect(registerRes.statusCode).toBe(201);

      const loginRes = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'alice@test.com', password: 'correct horse battery staple' },
      });
      expect(loginRes.statusCode).toBe(200);
      const cookie = extractCookie(loginRes.headers['set-cookie']);

      const meRes = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().email).toBe('alice@test.com');

      const logoutRes = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
      expect(logoutRes.statusCode).toBe(204);

      const meAfterLogout = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
      expect(meAfterLogout.statusCode).toBe(401);
    });

    it('rejects a duplicate email with conflict, as problem+json', async () => {
      await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'dup@test.com', password: 'password1234' } });
      const second = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'dup@test.com', password: 'password1234' } });

      expect(second.statusCode).toBe(409);
      expect(second.headers['content-type']).toContain('application/problem+json');
      expect(second.json().code).toBe('conflict');
    });

    it('rejects an invalid login without leaking which field was wrong', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@test.com', password: 'wrongwrong' } });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('invalid_credentials');
    });

    it('returns validation_failed as problem+json for a malformed request', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'not-an-email', password: '123' } });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().code).toBe('validation_failed');
    });
  });

  describe('jobs — creation, listing, and ownership', () => {
    it('requires auth', async () => {
      const res = await app.inject({ method: 'POST', url: '/jobs', payload: { title: 'T', descriptionMd: 'D' } });
      expect(res.statusCode).toBe(401);
    });

    it('returns 202 pending on creation — the async contract (M2 design §6)', async () => {
      const { cookie } = await registerAndLogin('bob@test.com');
      const res = await app.inject({
        method: 'POST',
        url: '/jobs',
        headers: { cookie },
        payload: { title: 'Backend Engineer', descriptionMd: 'Build things.' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().embeddingStatus).toBe('pending');
    });

    it('lists jobs for the owner and fetches one by id', async () => {
      const { cookie } = await registerAndLogin('carol@test.com');
      const created = await app.inject({
        method: 'POST', url: '/jobs', headers: { cookie },
        payload: { title: 'Staff Engineer', descriptionMd: 'D' },
      });
      const jobId = created.json().jobId as string;

      const listRes = await app.inject({ method: 'GET', url: '/jobs', headers: { cookie } });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().items).toHaveLength(1);

      const getRes = await app.inject({ method: 'GET', url: `/jobs/${jobId}`, headers: { cookie } });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().title).toBe('Staff Engineer');
    });

    it('never leaks another user\'s job — cross-owner GET is not_found, not forbidden', async () => {
      const owner = await registerAndLogin('owner@test.com');
      const created = await app.inject({
        method: 'POST', url: '/jobs', headers: { cookie: owner.cookie },
        payload: { title: 'Secret Role', descriptionMd: 'D' },
      });
      const jobId = created.json().jobId as string;

      const intruder = await registerAndLogin('intruder@test.com');
      const res = await app.inject({ method: 'GET', url: `/jobs/${jobId}`, headers: { cookie: intruder.cookie } });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    });

    it('rejects an empty title as validation_failed', async () => {
      const { cookie } = await registerAndLogin('dave@test.com');
      const res = await app.inject({ method: 'POST', url: '/jobs', headers: { cookie }, payload: { title: '', descriptionMd: 'D' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation_failed');
    });
  });

  describe('applications, board, and stage transitions', () => {
    it('creating an application puts it on the board in the discovered column', async () => {
      const { cookie } = await registerAndLogin('erin@test.com');
      const job = await app.inject({ method: 'POST', url: '/jobs', headers: { cookie }, payload: { title: 'T', descriptionMd: 'D' } });
      const jobId = job.json().jobId as string;

      const appRes = await app.inject({ method: 'POST', url: '/applications', headers: { cookie }, payload: { jobPostingId: jobId } });
      expect(appRes.statusCode).toBe(201);

      const boardRes = await app.inject({ method: 'GET', url: '/board', headers: { cookie } });
      expect(boardRes.statusCode).toBe(200);
      expect(boardRes.json().columns.discovered).toHaveLength(1);
    });

    it('moves an application through a legal transition', async () => {
      const { cookie } = await registerAndLogin('frank@test.com');
      const job = await app.inject({ method: 'POST', url: '/jobs', headers: { cookie }, payload: { title: 'T', descriptionMd: 'D' } });
      const application = await app.inject({
        method: 'POST', url: '/applications', headers: { cookie },
        payload: { jobPostingId: job.json().jobId },
      });
      const applicationId = application.json().applicationId as string;

      const res = await app.inject({
        method: 'PATCH', url: `/applications/${applicationId}/stage`, headers: { cookie },
        payload: { toStage: 'applied' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().application.stage).toBe('applied');
    });

    it('rejects an illegal transition as invalid_transition, as problem+json', async () => {
      const { cookie } = await registerAndLogin('grace@test.com');
      const job = await app.inject({ method: 'POST', url: '/jobs', headers: { cookie }, payload: { title: 'T', descriptionMd: 'D' } });
      const application = await app.inject({
        method: 'POST', url: '/applications', headers: { cookie },
        payload: { jobPostingId: job.json().jobId },
      });

      const res = await app.inject({
        method: 'PATCH', url: `/applications/${application.json().applicationId}/stage`, headers: { cookie },
        payload: { toStage: 'offer' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().code).toBe('invalid_transition');
    });
  });

  describe('ops surface', () => {
    it('/healthz always answers, no auth required', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    });

    it('/readyz reports ready when Postgres and Redis are both reachable', async () => {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ready');
    });

    it('/admin/status requires auth and reports queue/outbox/spend', async () => {
      const unauth = await app.inject({ method: 'GET', url: '/admin/status' });
      expect(unauth.statusCode).toBe(401);

      const { cookie } = await registerAndLogin('henry@test.com');
      const res = await app.inject({ method: 'GET', url: '/admin/status', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('queueDepth');
      expect(body).toHaveProperty('outboxBacklog');
      expect(body).toHaveProperty('llmSpendMtd');
    });
  });

  describe('unmatched route', () => {
    it('returns not_found as problem+json instead of Fastify\'s default 404 body', async () => {
      const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json().code).toBe('not_found');
    });
  });
});
