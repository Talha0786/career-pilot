import { fileURLToPath } from 'node:url';
import path from 'node:path';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import pino from 'pino';
import {
  createDb,
  DrizzleJobPostingRepository,
  DrizzleProfileRepository,
  DrizzleMatchScoreRepository,
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
  TieredCostEstimator,
  FilePromptStore,
} from '@careerpilot/infrastructure';
import { GuardedLlmPort, makeIngestJobBatchUseCase, makeUpdateConnectorHealthUseCase, MATCH_SCORE_QUEUE } from '@careerpilot/application';
import { ConnectorRegistry } from '@careerpilot/connectors';
import {
  createGreenhouseConnector, createLeverConnector, createAshbyConnector,
  createUsajobsConnector, createRssConnector, createManualConnector,
} from '@careerpilot/connectors';
import { createJobPostedWorker } from './handlers/job-posted.handler.js';
import { createProfileFactsChangedWorker } from './handlers/profile-facts-changed.handler.js';
import { createScoreMatchWorker } from './handlers/score-match.handler.js';
import {
  createRunConnectorIngestionWorker, scheduleConnectorIngestions, CONNECTOR_INGESTION_QUEUE,
  type RunConnectorIngestionPayload,
} from './handlers/run-connector-ingestion.handler.js';
import { createParseResumeWorker } from './handlers/parse-resume.handler.js';

// apps/worker/src/main.ts -> ../../../prompts is the repo root's prompts/
// dir in BOTH local dev (ts-node/tsx running from source) and the Docker
// image (Dockerfile COPYs prompts/ to /app/prompts, preserving the same
// apps/worker/src -> repo-root relative layout) — resolved from this
// file's own location, never process.cwd() (task 038; same posture task
// 034's FilePromptStore already requires — injected path, not hardcoded).
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');

const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
  llmApiKey: process.env.LLM_API_KEY || null,
  llmEmbeddingModel: process.env.LLM_EMBEDDING_MODEL ?? 'nomic-embed-text',
  // Task 038: separate from the embedding model — match scoring needs a
  // chat/completion-capable model, not an embeddings-only one. Defaults to
  // a common local Ollama chat model; BYO cloud key path (ADR-006) would
  // override this to a stronger model for quality-sensitive routing.
  llmMatchModel: process.env.LLM_MATCH_MODEL ?? 'llama3.1',
  llmMonthlyBudgetUsd: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 10),
  outboxPollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000),
  outboxBatchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
  outboxMaxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5),
};

const logger = pino({ level: env.logLevel });

// Task 033: real per-model pricing table, replacing the M2 coarse stub
// (ADR-006 — "real per-provider pricing tables are an M5 concern"). Logs a
// warning (via `logger`, wired below) rather than console.warn once the
// logger exists; constructed after `logger` so we can pass it through.
const estimator = new TieredCostEstimator(undefined, {
  warn: (obj, msg) => logger.warn(obj, msg ?? 'cost-estimator warning'),
});

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
  const profileWorkerConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const matchWorkerConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const matchQueueConnection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
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

  // Task 035: profile embedding — same outbox → worker → guarded-LLM path as
  // job postings, consuming `profile.facts_changed` instead of
  // `discovery.job_posted`.
  const profiles = new DrizzleProfileRepository(db);
  // Task 038: "job-triggered" match-scoring path — automatically requests a
  // rescan once a profile's embedding is ready, so a user never has to
  // manually hit the on-demand API route just to get an initial score.
  // Best-effort: a failed enqueue here logs and moves on rather than
  // failing the embed itself (the embed already succeeded and persisted;
  // losing the auto-rescan trigger is recoverable via the on-demand route,
  // losing the embed result would not be).
  const matchScoreQueue = new Queue(MATCH_SCORE_QUEUE, { connection: matchQueueConnection });
  const profileWorker = createProfileFactsChangedWorker({
    connection: profileWorkerConnection,
    profiles,
    llm: guardedLlm,
    embeddingModel: env.llmEmbeddingModel,
    logger,
    onEmbedded: async (event) => {
      try {
        await matchScoreQueue.add(MATCH_SCORE_QUEUE, { profileId: event.careerProfileId, userId: event.userId });
      } catch (err) {
        logger.error({ err, profileId: event.careerProfileId }, 'failed to enqueue auto-rescan after profile embed');
      }
    },
  });

  // Task 038: match rubric scoring — consumes matching.score_requested,
  // whether it was enqueued automatically (above) or on-demand via
  // POST /profile/rescan (apps/api/src/routes/matching.ts).
  const matchScores = new DrizzleMatchScoreRepository(db);
  const prompts = new FilePromptStore(PROMPTS_DIR);
  const matchWorker = createScoreMatchWorker({
    connection: matchWorkerConnection,
    profiles,
    jobPostings,
    matchScores,
    llm: guardedLlm,
    prompts,
    model: env.llmMatchModel,
    logger,
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
    await profileWorker.close();
    await matchWorker.close();
    await matchScoreQueue.close();
    await connectorIngestionWorker.close();
    await connectorIngestionQueue.close();
    await resumeWorker.close();
    await relayPublisher.closeAll();
    await workerConnection.quit();
    await profileWorkerConnection.quit();
    await matchWorkerConnection.quit();
    await matchQueueConnection.quit();
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
