import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import {
  createDb, type Db,
  DrizzleProfileRepository, DrizzleJobPostingRepository, DrizzleMatchScoreRepository,
  OpenAiCompatibleLlmAdapter, PostgresBudgetStore, FilePromptStore,
} from '@careerpilot/infrastructure';
import { GuardedLlmPort } from '@careerpilot/application';
import { CareerProfile, JobPosting, User, Email, PasswordHash, isOk } from '@careerpilot/domain';
import { createScoreMatchWorker } from '../../src/handlers/score-match.handler.js';
import { MATCH_SCORE_QUEUE } from '@careerpilot/application';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../prompts');

/**
 * Task 038 end-to-end: matching.score_requested -> createScoreMatchWorker ->
 * real ANN prefilter (real Postgres + pgvector) -> real match-score/v1.md
 * prompt (task 034) -> guarded LLM call against a local HTTP stand-in
 * (same "no live model reachable from this sandbox" reasoning as
 * end-to-end.test.ts) -> match_scores persisted. Mirrors end-to-end.test.ts's
 * shape for the embedding pipeline, one layer up the M5 stack.
 */
describe('End-to-end: matching.score_requested -> worker -> real ANN prefilter -> real prompt -> match_scores persisted (task 038)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    close = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, match_scores, job_postings, profile_sections, career_profiles, users RESTART IDENTITY CASCADE`);
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterEach(async () => {
    await close();
    await redis.quit();
  });

  it('scores the ANN-prefiltered candidates and persists real match_scores rows', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('score-e2e@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const profiles = new DrizzleProfileRepository(db);
    const jobPostings = new DrizzleJobPostingRepository(db);
    const matchScores = new DrizzleMatchScoreRepository(db);

    const profileR = CareerProfile.create({ userId: user.id, title: 'Profile' });
    if (!isOk(profileR)) throw new Error('setup failed');
    const profile = profileR.value;
    const addedR = profile.addSection({
      kind: 'experience',
      content: { schemaVersion: 1, title: 'Backend Engineer', organization: 'Acme', startDate: '2021-01', endDate: null, bullets: ['Built APIs'] },
    });
    if (!isOk(addedR)) throw new Error('setup failed');
    const attached = profile.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'test-embed-model', profile.factsHash);
    if (!attached.ok) throw new Error('setup failed');
    await profiles.save(profile);

    const jobR = JobPosting.createManual({ userId: user.id, title: 'Backend Engineer', descriptionMd: 'Build APIs with Postgres.' });
    if (!isOk(jobR)) throw new Error('setup failed');
    const job = jobR.value;
    job.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'test-embed-model'); // identical vector -> definitely in the prefilter
    await jobPostings.save(job);

    // Local HTTP stand-in for the LLM provider's /chat/completions.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'test-match-model',
          choices: [{ message: { content: JSON.stringify({
            skills: 0.9, experience: 0.8, seniority: 0.85, domain: 0.7, location: 0.6,
            overall: 0.83, rationale: 'Strong overlap in backend engineering skills.',
          }) } }],
          usage: { prompt_tokens: 50, completion_tokens: 30 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const inner = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const budgetStore = new PostgresBudgetStore(db);
    const estimator = {
      estimateEmbedCostUsd: () => 0, actualEmbedCostUsd: () => 0,
      estimateCompleteCostUsd: () => 0.0001, actualCompleteCostUsd: () => 0.0001,
    };
    const guardedLlm = new GuardedLlmPort(inner, budgetStore, estimator, 10, 'test-openai-compat');
    const prompts = new FilePromptStore(PROMPTS_DIR);

    const queue = new Queue(MATCH_SCORE_QUEUE, { connection: redis });
    const worker = createScoreMatchWorker({
      connection: redis, profiles, jobPostings, matchScores, llm: guardedLlm, prompts,
      model: 'test-match-model', logger: pino({ level: 'silent' }),
    });

    try {
      await queue.add(MATCH_SCORE_QUEUE, { profileId: profile.id, userId: user.id });

      const deadline = Date.now() + 10_000;
      let found: Awaited<ReturnType<typeof matchScores.findByProfileAndJob>> = null;
      while (Date.now() < deadline) {
        found = await matchScores.findByProfileAndJob(profile.id, job.id);
        if (found) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(found).not.toBeNull();
      expect(found!.components.overall).toBeCloseTo(0.83, 5);
      expect(found!.components.rationale).toContain('backend engineering');
      expect(found!.factsHash).toBe(profile.factsHash);

      // Budget accounting actually happened for this completion call.
      const invocations = await db.execute(sql`SELECT status, context FROM ai_invocations WHERE user_id = ${user.id}`);
      expect(invocations).toHaveLength(1);
      expect((invocations as unknown as { status: string; context: string }[])[0]).toMatchObject({ status: 'ok', context: 'matching' });
    } finally {
      await worker.close();
      await queue.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
