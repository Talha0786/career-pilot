import { Worker, Queue, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type {
  ConnectorConfigRepository, IngestionRunRepository, ClockPort, makeIngestJobBatchUseCase,
} from '@careerpilot/application';
import type { ConnectorRegistry, RawJob } from '@careerpilot/connectors';

export const CONNECTOR_INGESTION_QUEUE = 'discovery.run_connector_ingestion';

export interface RunConnectorIngestionPayload {
  connectorConfigId: string;
}

export interface RunConnectorIngestionDeps {
  connectorConfigs: ConnectorConfigRepository;
  ingestionRuns: IngestionRunRepository;
  ingestJobBatch: ReturnType<typeof makeIngestJobBatchUseCase>;
  registry: ConnectorRegistry;
  clock: ClockPort;
  logger: Logger;
}

/**
 * Runs one connector's ingestion once (task 029). This is the function BOTH
 * the BullMQ worker below AND task 032's chaos test call directly — keeping
 * the "what happens for one connector run" logic separate from "how BullMQ
 * invokes it" means the chaos test doesn't need a live Redis/queue to prove
 * isolation, only a real broken `ConnectorPort` (task 032 acceptance: "a
 * real broken connector implementation, not a simulated flag").
 *
 * ISOLATION (task 029 acceptance criterion): this function never lets a
 * connector's failure propagate as an unhandled rejection out of a single
 * run — every failure mode (missing registration, invalid config, a thrown
 * exception from `fetchJobs`, an error mid-stream) is caught and recorded
 * as an `ingestion_runs` row with status 'partial'/'failed', not a crash.
 * Combined with BullMQ's own per-job isolation (one job throwing does not
 * stop the worker from processing others), a single connector throwing on
 * every call cannot block or fail any OTHER connector's scheduled run.
 */
export async function runConnectorIngestionOnce(deps: RunConnectorIngestionDeps, connectorConfigId: string): Promise<void> {
  const log = deps.logger.child({ connectorConfigId });
  const config = await deps.connectorConfigs.findById(connectorConfigId);
  if (!config) {
    log.warn('connector config not found — skipping run (deleted between schedule and run)');
    return;
  }
  if (!config.enabled) {
    log.debug('connector disabled — skipping run');
    return;
  }

  const connector = deps.registry.get(config.connectorKey);
  if (!connector) {
    await recordFailure(deps, config.id, `No connector registered for key "${config.connectorKey}"`);
    return;
  }

  const parsedConfig = connector.configSchema.safeParse(config.config);
  if (!parsedConfig.success) {
    await recordFailure(deps, config.id, `Invalid connector config: ${parsedConfig.error.message}`);
    return;
  }

  const run = await deps.ingestionRuns.start(config.id, deps.clock.now());
  const rawJobs: RawJob[] = [];
  let fetched = 0;
  let lastError: string | null = null;
  let lastErrorRetryable = true;

  try {
    for await (const item of connector.fetchJobs(parsedConfig.data, null)) {
      fetched++;
      if (item.ok) {
        rawJobs.push(item.value);
      } else {
        lastError = item.error.message;
        lastErrorRetryable = item.error.retryable;
        // A non-retryable error (auth/config) means further pages won't
        // help either — stop pulling, but keep whatever was already collected.
        if (!item.error.retryable) break;
      }
    }
  } catch (e) {
    // A connector that throws is non-compliant with the contract (task 026),
    // but the SCHEDULER must survive it regardless — this is the isolation
    // boundary task 032's chaos test exercises directly.
    lastError = `Connector threw unexpectedly: ${String(e)}`;
    lastErrorRetryable = false;
  }

  const batchResult = await deps.ingestJobBatch({
    userId: config.userId,
    sourceConnectorKey: config.connectorKey,
    rawJobs,
  });

  const status = lastError === null ? 'ok' : rawJobs.length > 0 ? 'partial' : 'failed';
  await deps.ingestionRuns.complete(run.id, {
    status,
    stats: { fetched, deduped: batchResult.deduped, inserted: batchResult.inserted },
    error: lastError,
    finishedAt: deps.clock.now(),
  });

  log.info({ status, fetched, inserted: batchResult.inserted, deduped: batchResult.deduped, error: lastError }, 'connector ingestion run complete');
  void lastErrorRetryable; // reserved for task 032's retry/backoff policy — recorded but not yet acted on here
}

async function recordFailure(deps: RunConnectorIngestionDeps, connectorConfigId: string, message: string): Promise<void> {
  const run = await deps.ingestionRuns.start(connectorConfigId, deps.clock.now());
  await deps.ingestionRuns.complete(run.id, {
    status: 'failed',
    stats: { fetched: 0, deduped: 0, inserted: 0 },
    error: message,
    finishedAt: deps.clock.now(),
  });
  deps.logger.error({ connectorConfigId, error: message }, 'connector ingestion run failed before fetching');
}

export function createRunConnectorIngestionWorker(deps: RunConnectorIngestionDeps & { connection: Redis }): Worker<RunConnectorIngestionPayload> {
  return new Worker<RunConnectorIngestionPayload>(
    CONNECTOR_INGESTION_QUEUE,
    async (job: Job<RunConnectorIngestionPayload>) => {
      // Deliberately does NOT rethrow on a connector failure — see
      // runConnectorIngestionOnce's isolation contract above. BullMQ would
      // otherwise mark this job "failed" and retry it, which is fine for a
      // genuinely transient error but wrong for the common "this connector
      // is just broken" case this exists to isolate, not amplify.
      await runConnectorIngestionOnce(deps, job.data.connectorConfigId);
    },
    { connection: deps.connection, concurrency: 4 },
  );
}

/**
 * Registers (or updates) one BullMQ repeatable job per enabled connector
 * config, keyed so re-running this at worker startup is idempotent (BullMQ
 * dedupes repeatable jobs by their `jobId` + pattern). Cron comes straight
 * from `connector_configs.schedule_cron` (design §2) — a config without one
 * configured is simply not scheduled (still runnable on demand by enqueueing
 * `{ connectorConfigId }` directly, e.g. a future "run now" API action).
 */
export async function scheduleConnectorIngestions(
  queue: Queue<RunConnectorIngestionPayload>,
  connectorConfigs: ConnectorConfigRepository,
): Promise<void> {
  const enabled = await connectorConfigs.listEnabled();
  for (const config of enabled) {
    if (!config.scheduleCron) continue;
    await queue.add(
      `connector:${config.id}`,
      { connectorConfigId: config.id },
      { repeat: { pattern: config.scheduleCron }, jobId: `connector-schedule:${config.id}` },
    );
  }
}
