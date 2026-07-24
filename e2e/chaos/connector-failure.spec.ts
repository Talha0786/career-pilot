import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { createDb, type Db, DrizzleConnectorConfigRepository } from '@careerpilot/infrastructure';
import { User, Email, PasswordHash, isOk, uuidv7 } from '@careerpilot/domain';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/4'; // db 4 — isolated from every other suite's db number

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const chaosWorkerEntry = path.join(repoRoot, 'apps', 'worker', 'src', 'chaos-connector-worker.ts');

const FAIL_COUNT = 3; // matches DEGRADED_AFTER_CONSECUTIVE_FAILURES (task 032)

// Queue name + payload shape mirrored here as plain values rather than
// imported from apps/worker/src (a relative cross-package import would trip
// this repo's own boundary-enforcement lint rule, task 001/014) — this is a
// test client of the worker's queue, not a consumer of its internals, so it
// only needs the wire contract, which is a stable string + JSON shape.
const CONNECTOR_INGESTION_QUEUE = 'discovery.run_connector_ingestion';
interface RunConnectorIngestionPayload {
  connectorConfigId: string;
}

/**
 * Task 032's chaos test. Acceptance criteria proven here:
 *   1. Health transitions are driven by REAL consecutive-failure counting
 *      against `ingestion_runs` (not a mocked signal) — we never call
 *      `updateConnectorHealth` directly; we only enqueue real BullMQ jobs
 *      and observe the DB.
 *   2. The broken connector is a REAL implementation that throws for real
 *      on every one of its first N calls (`apps/worker/src/chaos-connector-
 *      worker.ts`) — not a simulated flag — running inside a REAL spawned
 *      OS process, matching task 014's `worker-kill.spec.ts` standard.
 *   3. Other connectors (chaos-healthy here) are provably unaffected the
 *      entire time — isolation, not just "eventually recovers."
 *   4. Health flips back to healthy after a subsequent real success.
 */
describe('Chaos: a real broken connector degrades and recovers without affecting a healthy one', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;
  let connectorConfigs: DrizzleConnectorConfigRepository;
  let ingestionQueue: Queue<RunConnectorIngestionPayload>;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, ingestion_runs, connector_configs, users RESTART IDENTITY CASCADE`,
    );

    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();

    connectorConfigs = new DrizzleConnectorConfigRepository(db);
    ingestionQueue = new Queue<RunConnectorIngestionPayload>(CONNECTOR_INGESTION_QUEUE, { connection: redis });
  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (!child.killed) child.kill('SIGKILL');
    }
    await ingestionQueue.close();
    await redis.quit();
    await closeDb();
  });

  function spawnChaosWorker(): ChildProcess {
    const child = spawn(process.execPath, [tsxCli, chaosWorkerEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: TEST_URL,
        REDIS_URL,
        CHAOS_BROKEN_FAIL_COUNT: String(FAIL_COUNT),
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    spawned.push(child);
    return child;
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  it(
    'chaos-broken degrades after 3 consecutive real failures while chaos-healthy stays healthy throughout, then recovers',
    async () => {
      // 1. Seed a user and both connector configs — no schedule_cron; this
      // test drives runs by enqueueing directly, the same payload shape the
      // real scheduler (task 029) would produce, without waiting on real
      // cron intervals (the minimum cron granularity is far too coarse for
      // a fast test).
      const user = User.register({
        email: (() => { const r = Email.create('chaos-connector@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
        passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      });
      await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

      const now = new Date();
      const healthyConfigId = uuidv7();
      const brokenConfigId = uuidv7();
      await connectorConfigs.save({
        id: healthyConfigId, userId: user.id, connectorKey: 'chaos-healthy', displayName: 'Chaos Healthy',
        enabled: true, scheduleCron: null, config: {}, credentialsRef: null,
        health: 'healthy', consecutiveFailures: 0, lastSuccessAt: null, createdAt: now, updatedAt: now,
      });
      await connectorConfigs.save({
        id: brokenConfigId, userId: user.id, connectorKey: 'chaos-broken', displayName: 'Chaos Broken',
        enabled: true, scheduleCron: null, config: {}, credentialsRef: null,
        health: 'healthy', consecutiveFailures: 0, lastSuccessAt: null, createdAt: now, updatedAt: now,
      });

      // 2. Start the REAL chaos worker process.
      const worker = spawnChaosWorker();
      let stderr = '';
      worker.stderr?.on('data', (c) => { stderr += String(c); });

      // 3. Drive FAIL_COUNT real failed runs of chaos-broken, interleaved
      // with real successful runs of chaos-healthy — this interleaving is
      // the isolation proof: they share nothing but the same worker process
      // and queue, and one's failure must never touch the other's outcome.
      for (let i = 0; i < FAIL_COUNT; i++) {
        await ingestionQueue.add('run', { connectorConfigId: brokenConfigId });
        await ingestionQueue.add('run', { connectorConfigId: healthyConfigId });
      }

      // 4. Wait for the real consecutive-failure count to cross the real
      // threshold and flip health to 'degraded' — this is what the
      // production makeUpdateConnectorHealthUseCase actually computed from
      // real ingestion_runs rows the chaos worker actually wrote, not
      // anything this test asserted into existence.
      await waitFor(async () => {
        const cfg = await connectorConfigs.findById(brokenConfigId);
        return cfg !== null && cfg.health === 'degraded';
      }, 20_000, 'chaos-broken to flip to degraded');

      const brokenAfterFailures = await connectorConfigs.findById(brokenConfigId);
      expect(brokenAfterFailures!.health).toBe('degraded');
      expect(brokenAfterFailures!.consecutiveFailures).toBe(FAIL_COUNT);

      const brokenRuns = await db.execute(
        sql`SELECT status, error FROM ingestion_runs WHERE connector_config_id = ${brokenConfigId} ORDER BY started_at`,
      );
      expect(brokenRuns).toHaveLength(FAIL_COUNT);
      for (const row of brokenRuns as unknown as { status: string; error: string }[]) {
        expect(row.status).toBe('failed');
        expect(row.error).toContain('chaos: deliberate failure');
      }

      // 5. ISOLATION, proven for real: throughout all of the broken
      // connector's failures, the healthy one's runs all succeeded and its
      // health was never touched.
      await waitFor(async () => {
        const rows = await db.execute(sql`SELECT count(*)::int AS n FROM ingestion_runs WHERE connector_config_id = ${healthyConfigId} AND status = 'ok'`);
        return (rows as unknown as { n: number }[])[0]!.n === FAIL_COUNT;
      }, 10_000, 'chaos-healthy to have completed all its runs');

      const healthyAfter = await connectorConfigs.findById(healthyConfigId);
      if (stderr && healthyAfter?.health !== 'healthy') console.error('chaos worker stderr:\n' + stderr);
      expect(healthyAfter!.health).toBe('healthy');
      expect(healthyAfter!.consecutiveFailures).toBe(0);
      const jobRows = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE source_connector_key = 'chaos-healthy'`);
      expect((jobRows as unknown as { n: number }[])[0]!.n).toBe(FAIL_COUNT); // every healthy run actually inserted its job

      // 6. RECOVERY: one more run of chaos-broken now succeeds (the chaos
      // worker's fail counter has passed FAIL_COUNT) — health flips back to
      // healthy, exactly the task's stated acceptance.
      await ingestionQueue.add('run', { connectorConfigId: brokenConfigId });
      await waitFor(async () => {
        const cfg = await connectorConfigs.findById(brokenConfigId);
        return cfg !== null && cfg.health === 'healthy';
      }, 15_000, 'chaos-broken to recover to healthy after a real success');

      const brokenAfterRecovery = await connectorConfigs.findById(brokenConfigId);
      expect(brokenAfterRecovery!.health).toBe('healthy');
      expect(brokenAfterRecovery!.consecutiveFailures).toBe(0);
      expect(brokenAfterRecovery!.lastSuccessAt).not.toBeNull();

      const recoveredRun = await db.execute(
        sql`SELECT status FROM ingestion_runs WHERE connector_config_id = ${brokenConfigId} ORDER BY started_at DESC LIMIT 1`,
      );
      expect((recoveredRun as unknown as { status: string }[])[0]!.status).toBe('ok');
    },
    45_000,
  );
});
