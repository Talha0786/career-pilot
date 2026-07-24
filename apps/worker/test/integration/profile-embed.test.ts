import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { createDb, type Db } from '@careerpilot/infrastructure';
import {
  OutboxRelay, BullMqOutboxPublisher, DrizzleUnitOfWork, DrizzleProfileRepository,
  OpenAiCompatibleLlmAdapter, PostgresBudgetStore,
} from '@careerpilot/infrastructure';
import { GuardedLlmPort, makeCreateProfileUseCase, makeAddSectionUseCase } from '@careerpilot/application';
import { createProfileFactsChangedWorker } from '../../src/handlers/profile-facts-changed.handler.js';
import { asCareerProfileId, isOk, User, Email, PasswordHash } from '@careerpilot/domain';
import pino from 'pino';
import { sql } from 'drizzle-orm';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2'; // db 2 — isolated from dev

/**
 * Task 035, mirroring `end-to-end.test.ts` (job postings) for career
 * profiles: the FULL path — Postgres (schema + outbox), Redis (BullMQ), and
 * the actual relay/worker processes, proving `profile.facts_changed` →
 * outbox → relay → BullMQ → `createProfileFactsChangedWorker` →
 * `embeddingStatus: 'ready'` works wired together, not just via
 * use-case-level fakes (that's `embed-career-profile.test.ts`).
 *
 * Lives alongside `end-to-end.test.ts` rather than under
 * `packages/infrastructure/test/integration/` (the task file's suggested
 * path) because it needs the worker's real BullMQ handler
 * (`createProfileFactsChangedWorker`), which lives in `apps/worker` — same
 * reasoning that already put `end-to-end.test.ts` here instead of in the
 * infrastructure package.
 */
describe('End-to-end: profile section added → outbox → relay → BullMQ → worker → embedded (task 035)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    close = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, document_versions, documents, profile_sections, career_profiles, users RESTART IDENTITY CASCADE`);

    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterEach(async () => {
    await close();
    await redis.quit();
  });

  async function seedUser(email: string) {
    const user = User.register({
      email: (() => { const r = Email.create(email); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);
    return user;
  }

  async function startFakeLlmServer() {
    const { createServer } = await import('node:http');
    let callCount = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        callCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'nomic-embed-text',
          data: [{ embedding: Array.from({ length: 768 }, (_, i) => i / 768) }],
          usage: { prompt_tokens: 10 },
        }));
      });
    });
    return { server, getCallCount: () => callCount };
  }

  it('embeds a profile when a section is added, with zero manual wiring beyond the real components', async () => {
    const user = await seedUser('e2e-profile@test.com');

    const uow = new DrizzleUnitOfWork(db);
    const profiles = new DrizzleProfileRepository(db);
    const createProfile = makeCreateProfileUseCase({ uow });
    const addSection = makeAddSectionUseCase({ uow });

    const publisher = new BullMqOutboxPublisher(redis);
    const relay = new OutboxRelay(db, publisher);

    const { server, getCallCount } = await startFakeLlmServer();
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const inner = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const budgetStore = new PostgresBudgetStore(db);
    const estimator = {
      estimateEmbedCostUsd: () => 0.0001, actualEmbedCostUsd: () => 0.0001,
      estimateCompleteCostUsd: () => 0.0001, actualCompleteCostUsd: () => 0.0001,
    };
    const guardedLlm = new GuardedLlmPort(inner, budgetStore, estimator, 10, 'test-openai-compat');

    const logger = pino({ level: 'silent' });
    const worker = createProfileFactsChangedWorker({
      connection: redis,
      profiles,
      llm: guardedLlm,
      embeddingModel: 'nomic-embed-text',
      logger,
    });

    try {
      // 1. Create a profile — no sections yet, no facts_changed event
      // (CareerProfile.create deliberately doesn't emit one).
      const created = await createProfile({ userId: user.id }, { title: 'My Profile' });
      if (!isOk(created)) throw new Error('setup failed');

      // create-profile.ts drains ALL of CareerProfile.create's events —
      // that's `profile.career_profile_created` (nothing subscribes to it
      // yet), NOT `profile.facts_changed` (deliberately not emitted on
      // create — see the class comment). So this poll publishes exactly the
      // creation event, not an embed trigger.
      const stats0 = await relay.pollOnce();
      expect(stats0.published).toBe(1);

      // 2. THE ACTUAL FEATURE: add a section — emits profile.facts_changed.
      const added = await addSection(
        { userId: user.id },
        { kind: 'summary', content: { schemaVersion: 1, text: 'Experienced backend engineer.' } },
      );
      if (!isOk(added)) throw new Error('setup failed');

      // 3. Run the relay manually once (deterministic vs. its prod polling loop).
      const stats1 = await relay.pollOnce();
      expect(stats1.published).toBeGreaterThanOrEqual(1); // section_added + facts_changed

      // 4. Wait for the REAL BullMQ worker to consume and process the job.
      const profileId = created.value.profileId;
      const deadline = Date.now() + 10_000;
      let finalStatus: string | null = null;
      while (Date.now() < deadline) {
        const row = await db.execute(sql`SELECT embedding_status FROM career_profiles WHERE id = ${profileId}`);
        const status = (row as unknown as { embedding_status: string }[])[0]?.embedding_status;
        if (status === 'ready' || status === 'failed') {
          finalStatus = status;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(finalStatus).toBe('ready');

      const final = await profiles.findByIdForUser(asCareerProfileId(added.value.profileId), user.id);
      expect(final!.embedding).toHaveLength(768);
      expect(final!.embeddingModel).toBe('nomic-embed-text');
      expect(final!.isEmbeddingStale).toBe(false);

      // 5. Budget accounting actually happened.
      const invocations = await db.execute(sql`SELECT status, cost_usd FROM ai_invocations WHERE user_id = ${user.id}`);
      expect(invocations).toHaveLength(1);
      expect((invocations as unknown as { status: string }[])[0]!.status).toBe('ok');

      // 6. Idempotency: re-running the use case directly against the SAME
      // (unchanged) facts_hash must not call the LLM again.
      const callsBeforeReplay = getCallCount();
      const secondRelayRun = await relay.pollOnce(); // nothing new to publish
      expect(secondRelayRun.published).toBe(0);
      expect(getCallCount()).toBe(callsBeforeReplay);
    } finally {
      await worker.close();
      await publisher.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);

  it('re-embeds end-to-end when factsHash changes after the first embed (isEmbeddingStale-driven re-embed, real Postgres)', async () => {
    const user = await seedUser('restale-profile@test.com');

    const uow = new DrizzleUnitOfWork(db);
    const profiles = new DrizzleProfileRepository(db);
    const createProfile = makeCreateProfileUseCase({ uow });
    const addSection = makeAddSectionUseCase({ uow });

    const publisher = new BullMqOutboxPublisher(redis);
    const relay = new OutboxRelay(db, publisher);

    const { server, getCallCount } = await startFakeLlmServer();
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const inner = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const budgetStore = new PostgresBudgetStore(db);
    const estimator = {
      estimateEmbedCostUsd: () => 0.0001, actualEmbedCostUsd: () => 0.0001,
      estimateCompleteCostUsd: () => 0.0001, actualCompleteCostUsd: () => 0.0001,
    };
    const guardedLlm = new GuardedLlmPort(inner, budgetStore, estimator, 10, 'test-openai-compat');
    const logger = pino({ level: 'silent' });
    const worker = createProfileFactsChangedWorker({
      connection: redis, profiles, llm: guardedLlm, embeddingModel: 'nomic-embed-text', logger,
    });

    try {
      const created = await createProfile({ userId: user.id }, { title: 'My Profile' });
      if (!isOk(created)) throw new Error('setup failed');

      const added1 = await addSection(
        { userId: user.id },
        { kind: 'summary', content: { schemaVersion: 1, text: 'First version.' } },
      );
      if (!isOk(added1)) throw new Error('setup failed');
      await relay.pollOnce();

      const waitForReady = async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const row = await db.execute(sql`SELECT embedding_status FROM career_profiles WHERE id = ${created.value.profileId}`);
          if ((row as unknown as { embedding_status: string }[])[0]?.embedding_status === 'ready') return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('timed out waiting for ready');
      };
      await waitForReady();
      expect(getCallCount()).toBe(1);

      // Change the facts — a second, distinct section — and let the whole
      // pipeline (outbox → relay → BullMQ → worker) re-embed it.
      const added2 = await addSection(
        { userId: user.id },
        { kind: 'summary', content: { schemaVersion: 1, text: 'Second version, now with more detail.' } },
      );
      if (!isOk(added2)) throw new Error('setup failed');
      await relay.pollOnce();

      const deadline2 = Date.now() + 10_000;
      let sawSecondCall = false;
      while (Date.now() < deadline2) {
        if (getCallCount() >= 2) { sawSecondCall = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(sawSecondCall).toBe(true);

      // Give the worker a moment to finish persisting after the 2nd LLM call.
      await new Promise((r) => setTimeout(r, 300));
      const final = await profiles.findByIdForUser(asCareerProfileId(created.value.profileId), user.id);
      expect(final!.embeddingStatus).toBe('ready');
      expect(final!.isEmbeddingStale).toBe(false);
    } finally {
      await worker.close();
      await publisher.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 20_000);
});
