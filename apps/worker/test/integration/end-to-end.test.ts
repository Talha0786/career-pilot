import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { createDb, type Db } from '@careerpilot/infrastructure';
import { OutboxRelay, BullMqOutboxPublisher, DrizzleUnitOfWork, DrizzleJobPostingRepository } from '@careerpilot/infrastructure';
import { GuardedLlmPort } from '@careerpilot/application';
import { makeCreateManualJobUseCase } from '@careerpilot/application';
import { createJobPostedWorker } from '../../src/handlers/job-posted.handler.js';
import { asUserId, asJobPostingId, isOk, User, Email, PasswordHash } from '@careerpilot/domain';
import pino from 'pino';
import { sql } from 'drizzle-orm';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2'; // db 2 — isolated from dev

/**
 * The FULL widened M2 slice, proven end-to-end against REAL infrastructure:
 * Postgres (schema + outbox), Redis (BullMQ), and the actual relay/worker
 * processes — not the use-case-level fakes from the application package
 * tests. This is the test that answers "does the architecture actually
 * work when wired together," which unit tests with fakes cannot answer by
 * construction.
 */
describe('End-to-end: paste job → outbox → relay → BullMQ → worker → embedded', () => {
  let db: Db;
  let close: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    close = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, users RESTART IDENTITY CASCADE`);

    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterEach(async () => {
    await close();
    await redis.quit();
  });

  it('embeds a manually pasted job with zero manual wiring beyond the real components', async () => {
    // 1. Seed a user (the use case needs an owner to attribute the job to).
    const user = User.register({
      email: (() => { const r = Email.create('e2e@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    // 2. Real components, wired exactly as production would wire them.
    const uow = new DrizzleUnitOfWork(db);
    const jobPostings = new DrizzleJobPostingRepository(db);
    const createManualJob = makeCreateManualJobUseCase({ uow });

    const publisher = new BullMqOutboxPublisher(redis);
    const relay = new OutboxRelay(db, publisher);

    // A local HTTP server standing in for the LLM provider (no live model
    // reachable from this sandbox — see llm-adapter.test.ts for why).
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'nomic-embed-text',
          data: [{ embedding: Array.from({ length: 768 }, (_, i) => i / 768) }],
          usage: { prompt_tokens: 10 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const { OpenAiCompatibleLlmAdapter } = await import('@careerpilot/infrastructure');
    const { PostgresBudgetStore } = await import('@careerpilot/infrastructure');
    const inner = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const budgetStore = new PostgresBudgetStore(db);
    const estimator = { estimateEmbedCostUsd: () => 0.0001, actualEmbedCostUsd: () => 0.0001 };
    const guardedLlm = new GuardedLlmPort(inner, budgetStore, estimator, 10, 'test-openai-compat');

    const logger = pino({ level: 'silent' });
    const worker = createJobPostedWorker({
      connection: redis,
      jobPostings,
      llm: guardedLlm,
      embeddingModel: 'nomic-embed-text',
      logger,
    });

    try {
      // 3. THE ACTUAL FEATURE: paste a job.
      const created = await createManualJob(
        { userId: user.id },
        { title: 'Full Stack Engineer', descriptionMd: 'Build the whole spine.' },
      );
      if (!isOk(created)) throw new Error('setup failed');
      expect(created.value.embeddingStatus).toBe('pending');

      // 4. Run the relay manually once (in prod this is a polling loop;
      // one explicit call is the deterministic way to test it).
      const stats = await relay.pollOnce();
      expect(stats.published).toBe(1);

      // 5. Wait for the REAL BullMQ worker to consume and process the job.
      const jobId = created.value.jobId;
      const deadline = Date.now() + 10_000;
      let finalStatus: string | null = null;
      while (Date.now() < deadline) {
        const row = await db.execute(sql`SELECT embedding_status FROM job_postings WHERE id = ${jobId}`);
        const status = (row as unknown as { embedding_status: string }[])[0]?.embedding_status;
        if (status === 'ready' || status === 'failed') {
          finalStatus = status;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(finalStatus).toBe('ready');

      const final = await jobPostings.findByIdForUser(asJobPostingId(jobId), user.id);
      expect(final!.embedding).toHaveLength(768);
      expect(final!.embeddingModel).toBe('nomic-embed-text');

      // 6. Budget accounting actually happened — ai_invocations has a row.
      const invocations = await db.execute(sql`SELECT status, cost_usd FROM ai_invocations WHERE user_id = ${user.id}`);
      expect(invocations).toHaveLength(1);
      expect((invocations as unknown as { status: string }[])[0]!.status).toBe('ok');
    } finally {
      await worker.close();
      await publisher.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it('SEQUENTIAL redelivery (the realistic ADR-007 case: relay crashes after publish, before marking published, republishes on restart) costs NOTHING the second time', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('redeliver@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const uow = new DrizzleUnitOfWork(db);
    const jobPostings = new DrizzleJobPostingRepository(db);
    const createManualJob = makeCreateManualJobUseCase({ uow });

    const created = await createManualJob({ userId: user.id }, { title: 'T', descriptionMd: 'D' });
    if (!isOk(created)) throw new Error('setup failed');

    const queue = new Queue('discovery.job_posted', { connection: redis });
    let callCount = 0;
    const countingLlm: import('@careerpilot/application').LlmPort = {
      embed: async (req) => {
        callCount += 1;
        return { ok: true, value: { vector: Array.from({ length: 768 }, () => 0.1), model: req.model, promptTokens: 5 } };
      },
    };
    const { PostgresBudgetStore } = await import('@careerpilot/infrastructure');
    const guardedLlm = new GuardedLlmPort(countingLlm, new PostgresBudgetStore(db), { estimateEmbedCostUsd: () => 0, actualEmbedCostUsd: () => 0 }, 100, 'test');

    const worker = createJobPostedWorker({
      connection: redis, jobPostings, llm: guardedLlm, embeddingModel: 'nomic-embed-text',
      logger: pino({ level: 'silent' }),
    });

    try {
      const payload = { jobPostingId: created.value.jobId, userId: user.id };

      // First delivery — let it run to completion before the second, since
      // that's the actual scenario ADR-007 describes (a crash-and-retry
      // happens well after the original delivery, not simultaneously with
      // it). Simultaneous redelivery is a DIFFERENT, narrower race — see the
      // note below — and is not what this test is claiming to cover.
      await queue.add('discovery.job_posted', payload, { jobId: 'delivery-attempt-1' });
      const deadline1 = Date.now() + 10_000;
      while (Date.now() < deadline1) {
        const row = await db.execute(sql`SELECT embedding_status FROM job_postings WHERE id = ${created.value.jobId}`);
        if ((row as unknown as { embedding_status: string }[])[0]?.embedding_status === 'ready') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(callCount).toBe(1);

      // NOW simulate the relay's redelivery of the SAME domain event, as a
      // separate BullMQ job (different id, same payload) — the actual shape
      // of an at-least-once redelivery after the fact.
      await queue.add('discovery.job_posted', payload, { jobId: 'delivery-attempt-2' });
      await new Promise((r) => setTimeout(r, 1500)); // give it every chance to (wrongly) re-call

      // THE guarantee: the second delivery does not touch the LLM at all —
      // makeEmbedJobPostingUseCase checks embeddingStatus==='ready' with a
      // matching model and returns before ever reaching guardedLlm.embed.
      // Stronger than "eventually consistent": it's "free the second time."
      expect(callCount).toBe(1);
      const invocations = await db.execute(sql`SELECT count(*)::int AS n FROM ai_invocations WHERE user_id = ${user.id}`);
      expect((invocations as unknown as { n: number }[])[0]!.n).toBe(1); // billed exactly once, not twice

      const final = await db.execute(sql`SELECT embedding_status FROM job_postings WHERE id = ${created.value.jobId}`);
      expect((final as unknown as { embedding_status: string }[])[0]!.embedding_status).toBe('ready');
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 15_000);

  it.todo(
    'KNOWN LIMITATION: truly SIMULTANEOUS redelivery (both deliveries read "pending" before either writes "ready") can still ' +
    'call the LLM twice — final DB state stays correct (attachEmbedding is idempotent per-model, task 003), but cost dedup is ' +
    'only guaranteed for sequential redelivery, not a genuine race. Same class of gap as task 015/016 (read-then-write without ' +
    'a lock); closing it fully would mean an advisory lock keyed on jobPostingId around the read-check-embed-write sequence. ' +
    'Documented rather than silently assumed away — not fixed in M2.',
  );
});
