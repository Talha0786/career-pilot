import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  createDb, type Db, DrizzleUnitOfWork, DrizzleConnectorConfigRepository, DrizzleIngestionRunRepository, SystemClock,
} from '@careerpilot/infrastructure';
import { makeIngestJobBatchUseCase } from '@careerpilot/application';
import { ok, err } from '@careerpilot/domain';
import type { ConnectorPort, RawJob } from '@careerpilot/application';
import { ConnectorRegistry } from '@careerpilot/connectors';
import { User, Email, PasswordHash, isOk, uuidv7 } from '@careerpilot/domain';
import { runConnectorIngestionOnce } from '../../src/handlers/run-connector-ingestion.handler.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';

const configSchema = z.object({});

function healthyConnector(jobs: RawJob[]): ConnectorPort<Record<string, never>> {
  return {
    metadata: { key: 'healthy-fake', displayName: 'Healthy Fake', complianceClass: 'A' },
    configSchema,
    async *fetchJobs() {
      for (const j of jobs) yield ok(j);
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

/**
 * REAL broken connector — throws on every call, exactly the task 026
 * contract violation the SDK's contract test-kit would catch if this were
 * registered as a first-party connector. Used here to prove the SCHEDULER
 * survives a connector that doesn't play by the rules, not just a
 * well-behaved one that returns a typed error.
 */
function brokenConnector(): ConnectorPort<Record<string, never>> {
  return {
    metadata: { key: 'broken-fake', displayName: 'Broken Fake', complianceClass: 'A' },
    configSchema,
    // eslint-disable-next-line require-yield -- deliberately throws before yielding, see file header.
    async *fetchJobs() {
      throw new Error('upstream is permanently on fire');
    },
    async healthCheck() {
      return err({ code: 'upstream_error', message: 'always down', retryable: true });
    },
  };
}

describe('runConnectorIngestionOnce — connector isolation (task 029 acceptance)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, ingestion_runs, connector_configs, users RESTART IDENTITY CASCADE`,
    );
  });

  afterEach(async () => {
    await closeDb();
  });

  it('a broken connector fails its OWN run without blocking or failing a healthy connector\'s run', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('isolation@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const uow = new DrizzleUnitOfWork(db);
    const connectorConfigs = new DrizzleConnectorConfigRepository(db);
    const ingestionRuns = new DrizzleIngestionRunRepository(db);
    const ingestJobBatch = makeIngestJobBatchUseCase({ uow });
    const registry = new ConnectorRegistry();

    const rawJob: RawJob = {
      externalId: 'ext-1',
      url: 'https://example.com/jobs/1',
      title: 'Backend Engineer',
      company: 'Acme',
      location: null,
      remote: 'unknown',
      salary: null,
      descriptionMd: 'D',
      postedAt: null,
    };
    registry.register(healthyConnector([rawJob]));
    registry.register(brokenConnector());

    const now = new Date();
    const healthyConfig = {
      id: uuidv7(),
      userId: user.id,
      connectorKey: 'healthy-fake',
      displayName: 'Healthy',
      enabled: true,
      scheduleCron: '0 * * * *',
      config: {},
      credentialsRef: null,
      health: 'healthy' as const,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const brokenConfig = { ...healthyConfig, id: uuidv7(), connectorKey: 'broken-fake', displayName: 'Broken' };
    await connectorConfigs.save(healthyConfig);
    await connectorConfigs.save(brokenConfig);

    const deps = { connectorConfigs, ingestionRuns, ingestJobBatch, registry, clock: new SystemClock(), logger: pino({ level: 'silent' }) };

    // Run both "scheduled jobs" concurrently — the shape a real scheduler
    // would present them in — and assert the broken one's rejection (if it
    // even threw at this level, which it should NOT, since the isolation
    // contract is that runConnectorIngestionOnce itself never rejects) does
    // not prevent the healthy one from completing.
    await Promise.all([
      runConnectorIngestionOnce(deps, healthyConfig.id),
      runConnectorIngestionOnce(deps, brokenConfig.id),
    ]);

    // The healthy connector's job landed.
    const healthyJobRows = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE user_id = ${user.id}`);
    expect((healthyJobRows as unknown as { n: number }[])[0]!.n).toBe(1);

    const healthyRuns = await ingestionRuns.listRecentForConnector(healthyConfig.id, 5);
    expect(healthyRuns).toHaveLength(1);
    expect(healthyRuns[0]!.status).toBe('ok');
    expect(healthyRuns[0]!.stats).toEqual({ fetched: 1, deduped: 0, inserted: 1 });

    // The broken connector's failure is isolated AND recorded — not silently swallowed.
    const brokenRuns = await ingestionRuns.listRecentForConnector(brokenConfig.id, 5);
    expect(brokenRuns).toHaveLength(1);
    expect(brokenRuns[0]!.status).toBe('failed');
    expect(brokenRuns[0]!.error).toContain('upstream is permanently on fire');
    expect(brokenRuns[0]!.stats).toEqual({ fetched: 0, deduped: 0, inserted: 0 });
  });

  it('every run — ok AND failed — writes an ingestion_runs row (task 029 acceptance: stats jsonb for every run)', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('runs@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const uow = new DrizzleUnitOfWork(db);
    const connectorConfigs = new DrizzleConnectorConfigRepository(db);
    const ingestionRuns = new DrizzleIngestionRunRepository(db);
    const ingestJobBatch = makeIngestJobBatchUseCase({ uow });
    const registry = new ConnectorRegistry();
    registry.register(brokenConnector());

    const now = new Date();
    const config = {
      id: uuidv7(),
      userId: user.id,
      connectorKey: 'broken-fake',
      displayName: 'Broken',
      enabled: true,
      scheduleCron: null,
      config: {},
      credentialsRef: null,
      health: 'healthy' as const,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await connectorConfigs.save(config);

    const deps = { connectorConfigs, ingestionRuns, ingestJobBatch, registry, clock: new SystemClock(), logger: pino({ level: 'silent' }) };
    await runConnectorIngestionOnce(deps, config.id);

    const rows = await db.execute(sql`SELECT status, stats FROM ingestion_runs WHERE connector_config_id = ${config.id}`);
    expect(rows).toHaveLength(1);
    expect((rows as unknown as { status: string }[])[0]!.status).toBe('failed');
  });

  it('a disabled connector config is skipped without writing an ingestion_runs row', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('disabled@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const uow = new DrizzleUnitOfWork(db);
    const connectorConfigs = new DrizzleConnectorConfigRepository(db);
    const ingestionRuns = new DrizzleIngestionRunRepository(db);
    const ingestJobBatch = makeIngestJobBatchUseCase({ uow });
    const registry = new ConnectorRegistry();
    registry.register(healthyConnector([]));

    const now = new Date();
    const config = {
      id: uuidv7(),
      userId: user.id,
      connectorKey: 'healthy-fake',
      displayName: 'Disabled',
      enabled: false,
      scheduleCron: null,
      config: {},
      credentialsRef: null,
      health: 'healthy' as const,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await connectorConfigs.save(config);

    const deps = { connectorConfigs, ingestionRuns, ingestJobBatch, registry, clock: new SystemClock(), logger: pino({ level: 'silent' }) };
    await runConnectorIngestionOnce(deps, config.id);

    const rows = await db.execute(sql`SELECT count(*)::int AS n FROM ingestion_runs WHERE connector_config_id = ${config.id}`);
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
  });
});
