import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import type {
  UnitOfWork,
  ProfileRepository,
  JobPostingRepository,
  ApplicationRepository,
  DocumentRepository,
  MatchScoreRepository,
  InterviewPrepRepository,
  QueuePort,
  AuditPort,
  McpTokenStore,
  ApplyTaskPort,
  ApplicationNoteRepository,
  WebSearchPort,
  WebFetchPort,
} from '@careerpilot/application';
import { GuardedLlmPort, NotYetImplementedApplyTaskPort } from '@careerpilot/application';
import {
  createDb,
  DrizzleUnitOfWork,
  DrizzleProfileRepository,
  DrizzleJobPostingRepository,
  DrizzleApplicationRepository,
  DrizzleDocumentRepository,
  DrizzleMatchScoreRepository,
  DrizzleInterviewPrepRepository,
  DrizzleApplicationNoteRepository,
  DrizzleAuditPort,
  McpTokenAdapter,
  BullMqQueuePort,
  PostgresBudgetStore,
  OpenAiCompatibleLlmAdapter,
  TieredCostEstimator,
  FilePromptStore,
  HttpWebFetchAdapter,
  DuckDuckGoWebSearchAdapter,
  type Db,
} from '@careerpilot/infrastructure';
import type { PromptStore } from '@careerpilot/application';
import { McpRegistry } from './registry.js';
import { RedisRateLimiter, InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';

// apps/mcp-server/src/di.ts -> ../../../prompts, same resolution strategy
// as apps/worker/src/main.ts (task 038) — works under both `tsx src/*.ts`
// locally and the Docker image's WORKDIR /app/apps/mcp-server.
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');

export interface McpEnv {
  databaseUrl: string;
  redisUrl: string;
  logLevel: string;
  llmBaseUrl: string;
  llmApiKey: string | null;
  llmChatModel: string;
  llmMonthlyBudgetUsd: number;
}

export function loadMcpEnv(): McpEnv {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    llmBaseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
    llmApiKey: process.env.LLM_API_KEY || null,
    llmChatModel: process.env.LLM_CHAT_MODEL ?? 'llama3.1',
    llmMonthlyBudgetUsd: Number(process.env.LLM_MONTHLY_BUDGET_USD ?? 10),
  };
}

/**
 * Everything an MCP tool/resource/prompt handler needs — the MCP-server
 * analog of `apps/api`'s `AppDeps` (task 056: "reuses the same composition-
 * root pattern apps/api/src/app.ts already uses... so handlers get
 * identical budget-guard/validation/audit behavior across HTTP and MCP
 * interfaces"). Real adapters are wired in `main-stdio.ts`/`main-http.ts`;
 * tests supply fakes directly, same shape either way.
 */
export interface McpDeps {
  db: Db;
  uow: UnitOfWork;
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  applications: ApplicationRepository;
  documents: DocumentRepository;
  matchScores: MatchScoreRepository;
  interviewPreps: InterviewPrepRepository;
  applicationNotes: ApplicationNoteRepository;
  applyTasks: ApplyTaskPort;
  search: WebSearchPort;
  fetcher: WebFetchPort;
  queue: QueuePort;
  audit: AuditPort;
  tokens: McpTokenStore;
  guardedLlm: GuardedLlmPort;
  prompts: PromptStore;
  rateLimiter: RateLimiter;
  llmModel: string;
}

/** Builds an `McpRegistry` with every tool/resource/prompt registered, wired to the given deps. Called identically by both transports and by tests (with fake deps). */
export function buildRegistry(deps: McpDeps): McpRegistry {
  const registry = new McpRegistry({ tokens: deps.tokens, audit: deps.audit, rateLimiter: deps.rateLimiter });
  registerAllTools(registry, deps);
  registerAllResources(registry, deps);
  registerAllPrompts(registry);
  return registry;
}

export interface BuiltMcpApp {
  registry: McpRegistry;
  db: Db;
  redis: IORedis;
  close(): Promise<void>;
}

/** Real-adapter composition root — the only place `main-stdio.ts`/`main-http.ts` need to call. */
export function buildRealMcpApp(env: McpEnv = loadMcpEnv()): BuiltMcpApp {
  const logger = pino({ level: env.logLevel });
  const { db, close: closeDb } = createDb(env.databaseUrl);
  const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

  const uow = new DrizzleUnitOfWork(db);
  const profiles = new DrizzleProfileRepository(db);
  const jobPostings = new DrizzleJobPostingRepository(db);
  const applications = new DrizzleApplicationRepository(db);
  const documents = new DrizzleDocumentRepository(db);
  const matchScores = new DrizzleMatchScoreRepository(db);
  const interviewPreps = new DrizzleInterviewPrepRepository(db);
  const applicationNotes = new DrizzleApplicationNoteRepository(db);
  // Task 058's documented M6 integration seam — see apply-task.port.ts's
  // doc comment. Swapped for the real adapter once M6 lands; no other
  // change needed here or in prepare-application.ts.
  const applyTasks: ApplyTaskPort = new NotYetImplementedApplyTaskPort();
  const search = new DuckDuckGoWebSearchAdapter();
  const fetcher = new HttpWebFetchAdapter();
  const audit = new DrizzleAuditPort(db);
  const tokens = new McpTokenAdapter(db);
  const queue = new BullMqQueuePort(redis);
  const jobQueue = new Queue('mcp.audit_noop', { connection: redis });
  void jobQueue; // reserved: bullmq Queue kept alive only if a future tool needs direct queue introspection

  const budgetStore = new PostgresBudgetStore(db);
  const estimator = new TieredCostEstimator(undefined, {
    warn: (obj, msg) => logger.warn(obj, msg ?? 'cost-estimator warning'),
  });
  const llm = new OpenAiCompatibleLlmAdapter(env.llmBaseUrl, env.llmApiKey);
  const guardedLlm = new GuardedLlmPort(llm, budgetStore, estimator, env.llmMonthlyBudgetUsd, 'openai-compat');
  const prompts = new FilePromptStore(PROMPTS_DIR);
  const rateLimiter = new RedisRateLimiter(redis);

  const registry = buildRegistry({
    db, uow, profiles, jobPostings, applications, documents, matchScores, interviewPreps, applicationNotes, applyTasks,
    search, fetcher, queue, audit, tokens, guardedLlm, prompts, rateLimiter, llmModel: env.llmChatModel,
  });

  return {
    registry,
    db,
    redis,
    close: async () => {
      await closeDb();
      redis.disconnect();
    },
  };
}

/** Test helper — an in-memory rate limiter avoids requiring Redis for unit tests that don't otherwise need it. */
export function testRateLimiter(): RateLimiter {
  return new InMemoryRateLimiter();
}
