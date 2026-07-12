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
  DrizzleProfileRepository,
  DrizzleDocumentRepository,
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
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings,
      document_versions, documents, profile_sections, career_profiles, users RESTART IDENTITY CASCADE`);

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
      profiles: new DrizzleProfileRepository(db),
      documents: new DrizzleDocumentRepository(db),
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

  describe('profile — GET/PUT upsert, sections, ownership', () => {
    it('GET /profile requires auth and returns not_found before any profile exists', async () => {
      const unauth = await app.inject({ method: 'GET', url: '/profile' });
      expect(unauth.statusCode).toBe(401);

      const { cookie } = await registerAndLogin('profile-none@test.com');
      const res = await app.inject({ method: 'GET', url: '/profile', headers: { cookie } });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    it('PUT /profile creates on first call (201), then updates the same profile on the next call (200)', async () => {
      const { cookie } = await registerAndLogin('profile-upsert@test.com');

      const created = await app.inject({
        method: 'PUT', url: '/profile', headers: { cookie },
        payload: { title: 'My Career', summary: 'Original summary' },
      });
      expect(created.statusCode).toBe(201);
      const profileId = created.json().profileId as string;

      const updated = await app.inject({
        method: 'PUT', url: '/profile', headers: { cookie },
        payload: { title: 'My Career, Updated', summary: 'New summary' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().profileId).toBe(profileId);

      const getRes = await app.inject({ method: 'GET', url: '/profile', headers: { cookie } });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().title).toBe('My Career, Updated');
      expect(getRes.json().isEmbeddingStale).toBe(true); // never embedded
    });

    it('POST /profile/sections adds a section to the caller\'s profile', async () => {
      const { cookie } = await registerAndLogin('profile-sections@test.com');
      await app.inject({ method: 'PUT', url: '/profile', headers: { cookie }, payload: { title: 'My Career' } });

      const res = await app.inject({
        method: 'POST', url: '/profile/sections', headers: { cookie },
        payload: {
          kind: 'experience',
          content: {
            schemaVersion: 1, title: 'Engineer', organization: 'Acme',
            startDate: '2020-01', endDate: null, bullets: ['Shipped things'],
          },
        },
      });
      expect(res.statusCode).toBe(201);

      const getRes = await app.inject({ method: 'GET', url: '/profile', headers: { cookie } });
      expect(getRes.json().sections).toHaveLength(1);
    });

    it('rejects a malformed section payload as validation_failed', async () => {
      const { cookie } = await registerAndLogin('profile-badsection@test.com');
      await app.inject({ method: 'PUT', url: '/profile', headers: { cookie }, payload: { title: 'My Career' } });

      const res = await app.inject({
        method: 'POST', url: '/profile/sections', headers: { cookie },
        payload: { kind: 'experience', content: { schemaVersion: 1 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation_failed');
    });

    it('each user\'s GET /profile only ever sees their own profile', async () => {
      const alice = await registerAndLogin('profile-alice@test.com');
      const bob = await registerAndLogin('profile-bob@test.com');
      await app.inject({ method: 'PUT', url: '/profile', headers: { cookie: alice.cookie }, payload: { title: 'Alice Career' } });

      const bobRes = await app.inject({ method: 'GET', url: '/profile', headers: { cookie: bob.cookie } });
      expect(bobRes.statusCode).toBe(404); // bob has no profile of his own — never sees alice's

      const aliceRes = await app.inject({ method: 'GET', url: '/profile', headers: { cookie: alice.cookie } });
      expect(aliceRes.json().title).toBe('Alice Career');
    });
  });

  describe('documents — CRUD, versions, audit, ownership', () => {
    async function resumeContent(summary: string) {
      return {
        schemaVersion: 1, kind: 'resume',
        contact: { name: 'Ada Lovelace', email: 'ada@example.com' },
        summary, sections: [],
      };
    }

    it('requires auth on every route', async () => {
      expect((await app.inject({ method: 'GET', url: '/documents' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/documents', payload: { kind: 'resume', title: 'x' } })).statusCode).toBe(401);
    });

    it('POST /documents returns 201 (creation is fully synchronous, unlike POST /jobs)', async () => {
      const { cookie } = await registerAndLogin('doc-create@test.com');
      const res = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie },
        payload: { kind: 'resume', title: 'My Resume' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().kind).toBe('resume');
    });

    it('POST /documents/:id/versions appends a version and writes an audit_log row', async () => {
      const { cookie, userId } = await registerAndLogin('doc-version@test.com');
      const created = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie },
        payload: { kind: 'resume', title: 'My Resume' },
      });
      const documentId = created.json().documentId as string;

      const versionRes = await app.inject({
        method: 'POST', url: `/documents/${documentId}/versions`, headers: { cookie },
        payload: { source: 'imported', content: await resumeContent('v1') },
      });
      expect(versionRes.statusCode).toBe(201);
      expect(versionRes.json().version).toBe(1);

      const auditRows = await db.execute(
        sql`SELECT action, subject_id FROM audit_log WHERE user_id = ${userId} AND action = 'document.version_created'`,
      );
      expect(auditRows).toHaveLength(1);
      expect((auditRows as unknown as { subject_id: string }[])[0]!.subject_id).toBe(documentId);
    });

    it('GET /documents/:id/versions/:versionId fetches a specific version', async () => {
      const { cookie } = await registerAndLogin('doc-getversion@test.com');
      const created = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie },
        payload: { kind: 'resume', title: 'My Resume' },
      });
      const documentId = created.json().documentId as string;
      const versionRes = await app.inject({
        method: 'POST', url: `/documents/${documentId}/versions`, headers: { cookie },
        payload: { source: 'imported', content: await resumeContent('v1') },
      });
      const versionId = versionRes.json().versionId as string;

      const getRes = await app.inject({ method: 'GET', url: `/documents/${documentId}/versions/${versionId}`, headers: { cookie } });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().version).toBe(1);
    });

    it('GET /documents lists the caller\'s documents with a currentVersion summary', async () => {
      const { cookie } = await registerAndLogin('doc-list@test.com');
      const created = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie },
        payload: { kind: 'resume', title: 'My Resume' },
      });
      const documentId = created.json().documentId as string;
      await app.inject({
        method: 'POST', url: `/documents/${documentId}/versions`, headers: { cookie },
        payload: { source: 'imported', content: await resumeContent('v1') },
      });

      const listRes = await app.inject({ method: 'GET', url: '/documents', headers: { cookie } });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().items).toHaveLength(1);
      expect(listRes.json().items[0].currentVersion).toBe(1);
    });

    it('never leaks another user\'s document — cross-owner GET/POST version are not_found, not forbidden', async () => {
      const owner = await registerAndLogin('doc-owner@test.com');
      const created = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie: owner.cookie },
        payload: { kind: 'resume', title: 'Secret Resume' },
      });
      const documentId = created.json().documentId as string;

      const intruder = await registerAndLogin('doc-intruder@test.com');

      const getRes = await app.inject({ method: 'GET', url: `/documents/${documentId}`, headers: { cookie: intruder.cookie } });
      expect(getRes.statusCode).toBe(404);
      expect(getRes.json().code).toBe('not_found');

      const versionRes = await app.inject({
        method: 'POST', url: `/documents/${documentId}/versions`, headers: { cookie: intruder.cookie },
        payload: { source: 'imported', content: await resumeContent('hijack') },
      });
      expect(versionRes.statusCode).toBe(404);
    });

    it('rejects a malformed create-document payload as validation_failed', async () => {
      const { cookie } = await registerAndLogin('doc-badcreate@test.com');
      const res = await app.inject({
        method: 'POST', url: '/documents', headers: { cookie },
        payload: { kind: 'not-a-real-kind', title: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation_failed');
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
