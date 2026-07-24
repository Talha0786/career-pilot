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
} from '@careerpilot/infrastructure';
import { CareerProfile, JobPosting, MatchScore, isOk } from '@careerpilot/domain';
import { buildApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header on response');
  return raw.split(';')[0]!;
}

describe('POST /profile/rescan, GET /profile/matches (task 038, real Postgres + Redis)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let app: FastifyInstance;
  let jobQueue: Queue;
  let matchScoreQueue: Queue;
  let profiles: DrizzleProfileRepository;
  let jobPostings: DrizzleJobPostingRepository;
  let matchScores: DrizzleMatchScoreRepository;
  let storageDir: string;

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, match_scores, job_postings,
        ingestion_runs, connector_configs, document_versions, documents, profile_sections, career_profiles,
        users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
    jobQueue = new Queue('discovery.job_posted', { connection: redis });
    matchScoreQueue = new Queue('matching.score_requested', { connection: redis });
    profiles = new DrizzleProfileRepository(db);
    jobPostings = new DrizzleJobPostingRepository(db);
    matchScores = new DrizzleMatchScoreRepository(db);
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
      documents: new DrizzleDocumentRepository(db),
      matchScores,
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
    await matchScoreQueue.close();
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
    const rescanRes = await app.inject({ method: 'POST', url: '/profile/rescan' });
    expect(rescanRes.statusCode).toBe(401);
    const matchesRes = await app.inject({ method: 'GET', url: '/profile/matches' });
    expect(matchesRes.statusCode).toBe(401);
  });

  it('POST /profile/rescan returns 404 when the caller has no career profile yet', async () => {
    const { cookie } = await registerAndLogin('norescan@test.com');
    const res = await app.inject({ method: 'POST', url: '/profile/rescan', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });

  it('POST /profile/rescan returns 400 when the profile exists but has no ready embedding yet', async () => {
    const { cookie, userId } = await registerAndLogin('notready@test.com');
    const created = CareerProfile.create({ userId: userId as never, title: 'My Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);

    const res = await app.inject({ method: 'POST', url: '/profile/rescan', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation_failed');
  });

  it('POST /profile/rescan returns 202 {queued:true} AND actually enqueues a matching.score_requested BullMQ job for an embedding-ready profile — the real round-trip, not just an HTTP status assertion', async () => {
    const { cookie, userId } = await registerAndLogin('ready@test.com');
    const created = CareerProfile.create({ userId: userId as never, title: 'My Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    const profile = created.value;
    const added = profile.addSection({ kind: 'summary', content: { schemaVersion: 1, text: 'Backend engineer.' } });
    if (!isOk(added)) throw new Error('setup failed');
    const attached = profile.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'test-model', profile.factsHash);
    if (!attached.ok) throw new Error('setup failed');
    await profiles.save(profile);

    const res = await app.inject({ method: 'POST', url: '/profile/rescan', headers: { cookie } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });

    // THE round-trip: a real job landed in the real BullMQ queue this
    // route enqueues to, with the right payload — not just "the HTTP call
    // didn't error."
    const jobs = await matchScoreQueue.getJobs(['waiting', 'active', 'completed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ profileId: profile.id, userId });
  });

  it('GET /profile/matches returns an empty list before any score exists, and the ranked list (highest overall first) once scores are persisted', async () => {
    const { cookie, userId } = await registerAndLogin('matches@test.com');
    const created = CareerProfile.create({ userId: userId as never, title: 'My Profile' });
    if (!isOk(created)) throw new Error('setup failed');
    await profiles.save(created.value);

    const empty = await app.inject({ method: 'GET', url: '/profile/matches', headers: { cookie } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ matches: [] });

    const jobLow = JobPosting.createManual({ userId: userId as never, title: 'Low Match', descriptionMd: 'd' });
    const jobHigh = JobPosting.createManual({ userId: userId as never, title: 'High Match', descriptionMd: 'd' });
    if (!isOk(jobLow) || !isOk(jobHigh)) throw new Error('setup failed');
    await jobPostings.save(jobLow.value);
    await jobPostings.save(jobHigh.value);

    const componentsFor = (overall: number) => ({
      skills: 0.5, experience: 0.5, seniority: 0.5, domain: 0.5, location: 0.5, overall, rationale: 'r',
    });
    await matchScores.save(MatchScore.create({
      profileId: created.value.id, jobPostingId: jobLow.value.id,
      components: componentsFor(0.3), factsHash: created.value.factsHash, embeddingModel: 'm',
    }));
    await matchScores.save(MatchScore.create({
      profileId: created.value.id, jobPostingId: jobHigh.value.id,
      components: componentsFor(0.9), factsHash: created.value.factsHash, embeddingModel: 'm',
    }));

    const res = await app.inject({ method: 'GET', url: '/profile/matches', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0].title).toBe('High Match'); // ranked highest-overall-first
    expect(body.matches[0].components.overall).toBeCloseTo(0.9, 5);
    expect(body.matches[1].title).toBe('Low Match');
  });
});
