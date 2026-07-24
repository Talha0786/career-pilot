/**
 * TEST-ONLY entry point for `e2e/chaos/connector-failure.spec.ts` (task
 * 032). NOT used by docker-compose, `main.ts`, or any production process —
 * this exists purely so the chaos test can spawn a REAL OS process running
 * the REAL `runConnectorIngestionOnce`/`createRunConnectorIngestionWorker`/
 * `makeUpdateConnectorHealthUseCase` machinery against a genuinely-throwing
 * `ConnectorPort`, matching task 014's "real process, real failure" chaos
 * standard rather than an in-process function call.
 *
 * Registers two connectors under test-only keys:
 *   - `chaos-healthy`  — always succeeds, one job per run.
 *   - `chaos-broken`   — throws for real on its first `CHAOS_BROKEN_FAIL_COUNT`
 *                        invocations (env-controlled, default 3), then
 *                        starts succeeding. The FAILURE MECHANISM is 100%
 *                        real (an actual thrown Error propagating through a
 *                        real async generator, caught by the real
 *                        `runConnectorIngestionOnce`) — only the trigger for
 *                        WHEN it stops failing is test-controlled, so the
 *                        test can observe both a degrade and a recovery
 *                        without needing to patch/redeploy code mid-run.
 */
import IORedis from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import {
  createDb, DrizzleUnitOfWork, DrizzleConnectorConfigRepository, DrizzleIngestionRunRepository, SystemClock,
} from '@careerpilot/infrastructure';
import { makeIngestJobBatchUseCase, makeUpdateConnectorHealthUseCase } from '@careerpilot/application';
import type { RawJob } from '@careerpilot/application';
import { ok } from '@careerpilot/domain';
import { ConnectorRegistry } from '@careerpilot/connectors';
import type { ConnectorPort } from '@careerpilot/connectors';
import { createRunConnectorIngestionWorker } from './handlers/run-connector-ingestion.handler.js';

const databaseUrl = process.env.DATABASE_URL!;
const redisUrl = process.env.REDIS_URL!;
const failCount = Number(process.env.CHAOS_BROKEN_FAIL_COUNT ?? 3);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'silent' });

const configSchema = z.object({});

function chaosHealthyConnector(): ConnectorPort<Record<string, never>> {
  return {
    metadata: { key: 'chaos-healthy', displayName: 'Chaos Healthy', complianceClass: 'A' },
    configSchema,
    async *fetchJobs() {
      const job: RawJob = {
        externalId: `healthy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        url: 'https://example.com/healthy',
        title: 'Healthy Job',
        company: 'Acme',
        location: null,
        remote: 'unknown',
        salary: null,
        descriptionMd: 'D',
        postedAt: null,
      };
      yield ok(job);
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

let brokenCallCount = 0;

function chaosBrokenConnector(): ConnectorPort<Record<string, never>> {
  return {
    metadata: { key: 'chaos-broken', displayName: 'Chaos Broken', complianceClass: 'A' },
    configSchema,
    async *fetchJobs() {
      brokenCallCount++;
      if (brokenCallCount <= failCount) {
        // A REAL thrown error — not a typed Result, not a flag. This is
        // exactly the "connector is genuinely broken" case task 029's
        // isolation logic and task 032's health tracking exist to survive.
        throw new Error(`chaos: deliberate failure #${brokenCallCount} of ${failCount}`);
      }
      const job: RawJob = {
        externalId: `recovered-${Date.now()}`,
        url: 'https://example.com/recovered',
        title: 'Recovered Job',
        company: 'Acme',
        location: null,
        remote: 'unknown',
        salary: null,
        descriptionMd: 'D',
        postedAt: null,
      };
      yield ok(job);
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

async function main(): Promise<void> {
  const { db } = createDb(databaseUrl);
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const connectorConfigs = new DrizzleConnectorConfigRepository(db);
  const ingestionRuns = new DrizzleIngestionRunRepository(db);
  const ingestJobBatch = makeIngestJobBatchUseCase({ uow: new DrizzleUnitOfWork(db) });
  const updateConnectorHealth = makeUpdateConnectorHealthUseCase({ connectorConfigs });
  const registry = new ConnectorRegistry();
  registry.register(chaosHealthyConnector());
  registry.register(chaosBrokenConnector());

  const worker = createRunConnectorIngestionWorker({
    connection,
    connectorConfigs,
    ingestionRuns,
    ingestJobBatch,
    updateConnectorHealth,
    registry,
    clock: new SystemClock(),
    logger,
  });

  const shutdown = async (): Promise<void> => {
    await worker.close();
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('chaos connector worker running');
}

main().catch((err) => {
  console.error('chaos connector worker failed to start:', err);
  process.exit(1);
});
