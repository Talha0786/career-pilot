import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import IORedis from 'ioredis';
import { createDb, type Db, DrizzleUnitOfWork } from '@careerpilot/infrastructure';
import { makeCreateManualJobUseCase } from '@careerpilot/application';
import { User, Email, PasswordHash, isOk } from '@careerpilot/domain';
import { sql } from 'drizzle-orm';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/3'; // db 3 — isolated from unit/integration's db 2

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// tsx's actual CLI script, invoked via `node <script>` — avoids the
// .CMD/.ps1 shim-execution gotchas of spawning node_modules/.bin/tsx
// directly with child_process.spawn on Windows without shell:true.
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const workerEntry = path.join(repoRoot, 'apps', 'worker', 'src', 'main.ts');

const JOB_COUNT = 40;

/**
 * Task 014's chaos test. Acceptance criterion: "SIGKILL the worker mid-relay
 * -> zero lost events, zero duplicate rows." Unlike the application-level
 * concurrency tests in apps/worker/test/integration (which prove the code's
 * logic is safe under concurrent IN-PROCESS calls), this spawns the actual
 * worker binary as a real OS process and sends it a real SIGKILL — the
 * class of failure no in-process test can produce, because the process
 * dies with no chance to run any JS at all, mid-syscall.
 *
 * OUTBOX_BATCH_SIZE is deliberately small (5) against JOB_COUNT=40 so the
 * relay needs multiple poll cycles to drain the backlog — this makes "mid-
 * relay" a wide, reliably-hittable window instead of a sub-millisecond race
 * on a single transaction, without resorting to sleep()s inside production
 * code just to make it testable.
 */
describe('Chaos: SIGKILL the worker mid-relay', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let fakeLlmPort: number;
  let closeFakeLlm: () => Promise<void>;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, users RESTART IDENTITY CASCADE`);

    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();

    // Stands in for the LLM provider — no live model reachable from CI/test
    // sandboxes (same rationale as apps/worker/test/integration's fake server).
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
    fakeLlmPort = (server.address() as { port: number }).port;
    closeFakeLlm = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (!child.killed) child.kill('SIGKILL');
    }
    await closeFakeLlm();
    await closeDb();
    await redis.quit();
  });

  function spawnWorker(): ChildProcess {
    const child = spawn(process.execPath, [tsxCli, workerEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: TEST_URL,
        REDIS_URL,
        LLM_BASE_URL: `http://localhost:${fakeLlmPort}`,
        LLM_API_KEY: '',
        LLM_EMBEDDING_MODEL: 'nomic-embed-text',
        LLM_MONTHLY_BUDGET_USD: '100',
        OUTBOX_POLL_INTERVAL_MS: '100',
        OUTBOX_BATCH_SIZE: '5',
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawned.push(child);
    return child;
  }

  it(
    'restarted worker finishes the backlog with zero lost events and zero duplicate LLM calls',
    async () => {
      // 1. Seed a backlog of jobs — each one an outbox row waiting to be relayed.
      const user = User.register({
        email: (() => { const r = Email.create('chaos@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
        passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      });
      await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

      const uow = new DrizzleUnitOfWork(db);
      const createManualJob = makeCreateManualJobUseCase({ uow });
      for (let i = 0; i < JOB_COUNT; i++) {
        const created = await createManualJob({ userId: user.id }, { title: `Chaos job ${i}`, descriptionMd: 'D' });
        if (!isOk(created)) throw new Error('seed failed');
      }

      // 2. Start the REAL worker binary and let it get partway through the backlog.
      const first = spawnWorker();
      let stderr = '';
      first.stderr?.on('data', (c) => { stderr += String(c); });
      await new Promise((r) => setTimeout(r, 900)); // several poll cycles at 100ms/5-row batches

      // 3. No graceful shutdown — a real, abrupt kill mid-flight.
      first.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300)); // let the OS actually reap it

      // Sanity: this chaos test only proves something if the kill actually
      // landed before the backlog finished — otherwise it's not testing recovery.
      const midRun = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE embedding_status = 'pending'`);
      const stillPending = (midRun as unknown as { n: number }[])[0]!.n;
      expect(stillPending).toBeGreaterThan(0);

      // 4. Simulate an orchestrator (k8s/pm2/systemd) restarting the crashed worker.
      const second = spawnWorker();
      let stderr2 = '';
      second.stderr?.on('data', (c) => { stderr2 += String(c); });

      // 5. Wait for the whole backlog to reach a terminal state.
      const deadline = Date.now() + 30_000;
      let remaining = JOB_COUNT;
      while (Date.now() < deadline) {
        const row = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE embedding_status = 'pending'`);
        remaining = (row as unknown as { n: number }[])[0]!.n;
        if (remaining === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (remaining !== 0) {
        console.error('worker #1 stderr:\n' + stderr);
        console.error('worker #2 stderr:\n' + stderr2);
      }
      expect(remaining).toBe(0); // zero LOST events — everything eventually resolves

      const statuses = await db.execute(sql`SELECT embedding_status, count(*)::int AS n FROM job_postings GROUP BY embedding_status`);
      const byStatus = Object.fromEntries(
        (statuses as unknown as { embedding_status: string; n: number }[]).map((r) => [r.embedding_status, r.n]),
      );
      expect(byStatus['ready']).toBe(JOB_COUNT); // the fake LLM never errors, so every job should succeed

      // 6. THE guarantee: no job got double-billed by the crash-and-restart —
      // zero DUPLICATE processing, not just "eventually consistent state."
      const invocations = await db.execute(sql`SELECT count(*)::int AS n FROM ai_invocations`);
      expect((invocations as unknown as { n: number }[])[0]!.n).toBe(JOB_COUNT);

      const outbox = await db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`);
      expect((outbox as unknown as { n: number }[])[0]!.n).toBe(0); // zero rows stuck unpublished
    },
    45_000,
  );
});
