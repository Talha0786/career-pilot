import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import pino from 'pino';
import {
  createDb,
  DrizzleJobPostingRepository,
  DrizzleConnectorConfigRepository,
  DrizzleIngestionRunRepository,
  DrizzleUnitOfWork,
  SystemClock,
  OutboxRelay,
  BullMqOutboxPublisher,
  PostgresBudgetStore,
  OpenAiCompatibleLlmAdapter,
  DocumentTextExtractor,
  RedisDraftStore,
} from '@careerpilot/infrastructure';
import { GuardedLlmPort, makeIngestJobBatchUseCase, makeUpdateConnectorHealthUseCase } from '@careerpilot/application';
import { ConnectorRegistry } from '@careerpilot/connectors';
import {
  createGreenhouseConnector, createLeverConnector, createAshbyConnector,
  createUsajobsConnector, createRssConnector, createManualConnector,
} from '@careerpilot/connectors';
import { createJobPostedWorker } from './handlers/job-posted.handler.js';
import {
  createRunConnectorIngestionWorker, scheduleConnectorIngestions, CONNECTOR_INGESTION_QUEUE,
  type RunConnectorIngestionPayload,
} from './handlers/run-connector-ingestion.handler.js';
import { createParseResumeWorker } from './handlers/parse-resume.handler.js';

const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
  llmApiKey: process.env.LLM_API_KEY || null,
  llmEmbeddingModel: process.env.LLM_EMBEDDING_MODEL ?? 'nomic-embed-text',
  llmMonthlyBudgetUsd: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 10),
  outboxPollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000),
  outboxBatchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
  outboxMaxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5),
};

const logger = pino({ level: env.logLevel });

// Cost estimation is deliberately coarse for M2 — real per-provider pricing
// tables are an M5 concern (ADR-006). This is enough to prove the budget
// guard actually blocks dispatch, which is what M2 needs to prove.
const estimator = {
  estimateEmbedCostUsd: (req: { input: string }) => (req.input.length / 4) * 0.00001,
  actualEmbedCostUsd: (_model: string, promptTokens: number) => promptTokens * 0.00001,
  estimateCompleteCostUsd: (req: { prompt: string }) => (req.prompt.length / 4) * 0.00002,
  actualCompleteCostUsd: (_model: string, promptTokens: number, completionTokens: number) =>
    (promptTokens + completionTokens) * 0.00002,
};

/** Composition root registers connectors — packages/connectors itself has no import-time side effects (README). */
function buildConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createGreenhouseConnector());
  registry.register(createLeverConnector());
  registry.register(createAshbyConnector());
  registry.register(createUsajobsConnector());
  registry.register(createRssConnector());
  registry.register(createManualConnector());
  return registry;
}

async function main(): Promise<void> {
  const { db, close: closeDb } = createDb(env.databaseUrl);
  const workerConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const resumeWorkerConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const relayConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const wsPublisher = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const ingestionConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const draftStoreConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

  const jobPostings = new DrizzleJobPostingRepository(db);
  const llm = new OpenAiCompatibleLlmAdapter(env.llmBaseUrl, env.llmApiKey);
  const budgetStore = new PostgresBudgetStore(db);
  const guardedLlm = new GuardedLlmPort(llm, budgetStore, estimator, env.llmMonthlyBudgetUsd, 'openai-compat');

  const worker = createJobPostedWorker({
    connection: workerConnection,
    jobPostings,
    llm: guardedLlm,
    embeddingModel: env.llmEmbeddingModel,
    logger,
    publishWsEvent: async (event) => {
      await wsPublisher.publish('ws:job.embedded', JSON.stringify(event));
    },
  });

  // Task 029: scheduler + ingestion pipeline. A connector run reuses the
  // same outbox mechanism as everything else (ADR-007) via ingestJobBatch's
  // UnitOfWork — no separate event-delivery path.
  const connectorConfigs = new DrizzleConnectorConfigRepository(db);
  const ingestionRuns = new DrizzleIngestionRunRepository(db);
  const ingestJobBatch = makeIngestJobBatchUseCase({ uow: new DrizzleUnitOfWork(db) });
  const updateConnectorHealth = makeUpdateConnectorHealthUseCase({ connectorConfigs });
  const registry = buildConnectorRegistry();
  const connectorIngestionQueue = new Queue<RunConnectorIngestionPayload>(CONNECTOR_INGESTION_QUEUE, { connection: ingestionConnection });
  const connectorIngestionWorker = createRunConnectorIngestionWorker({
    connection: ingestionConnection,
    connectorConfigs,
    ingestionRuns,
    ingestJobBatch,
    updateConnectorHealth,
    registry,
    clock: new SystemClock(),
    logger,
  });
  try {
    await scheduleConnectorIngestions(connectorIngestionQueue, connectorConfigs);
  } catch (err) {
    // Scheduling is best-effort at startup — an empty/misconfigured
    // connector_configs table must never prevent the worker (embeddings,
    // outbox relay) from starting.
    logger.error({ err }, 'failed to schedule connector ingestions at startup');
  }

  // Task 023: resume import parsing. Deliberately does NOT go through
  // guardedLlm — mapResumeTextToDraft is heuristic/network-free (see its
  // file-level comment); nothing here spends LLM budget.
  const resumeWorker = createParseResumeWorker({
    connection: resumeWorkerConnection,
    extractor: new DocumentTextExtractor(),
    drafts: new RedisDraftStore(draftStoreConnection),
    logger,
  });

  const relayPublisher = new BullMqOutboxPublisher(relayConnection);
  const relay = new OutboxRelay(db, relayPublisher, env.outboxMaxAttempts);

  let relayRunning = true;
  const relayLoop = (async () => {
    while (relayRunning) {
      try {
        const stats = await relay.pollOnce(env.outboxBatchSize);
        if (stats.claimed > 0) logger.debug(stats, 'outbox relay poll');
      } catch (err) {
        logger.error({ err }, 'outbox relay poll failed');
      }
      await new Promise((r) => setTimeout(r, env.outboxPollIntervalMs));
    }
  })();

  logger.info('worker + outbox relay + connector ingestion running');

  const shutdown = async (): Promise<void> => {
    logger.info('shutting down');
    relayRunning = false;
    await relayLoop;
    await worker.close();
    await connectorIngestionWorker.close();
    await connectorIngestionQueue.close();
    await resumeWorker.close();
    await relayPublisher.closeAll();
    await workerConnection.quit();
    await resumeWorkerConnection.quit();
    await relayConnection.quit();
    await wsPublisher.quit();
    await ingestionConnection.quit();
    await draftStoreConnection.quit();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
