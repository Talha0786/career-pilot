import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type {
  UnitOfWork,
  UserRepository,
  JobPostingRepository,
  ApplicationRepository,
  ProfileRepository,
  DocumentRepository,
  HasherPort,
  ConnectorConfigRepository,
  QueuePort,
  DraftStorePort,
  DocumentRendererPort,
  ObjectStoragePort,
  MatchScoreRepository,
  McpTokenStore,
  ApplyTaskRepository,
  ApprovalTokenPort,
  BrowserSubmitPort,
} from '@careerpilot/application';
import type { Db, OutboxRelay, PostgresBudgetStore } from '@careerpilot/infrastructure';
import { registerAuthPlugin } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { SessionStore } from './plugins/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerApplicationRoutes } from './routes/applications.js';
import { registerBoardRoutes } from './routes/board.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCaptureRoutes } from './routes/capture.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerMatchingRoutes } from './routes/matching.js';
import { registerMcpTokenRoutes } from './routes/mcp-tokens.js';
import { registerApplyRoutes } from './routes/apply.js';
import type { BrowserRunnerFieldsPort } from './lib/browser-runner-client.js';
import { ConnectionHub } from './ws/hub.js';

declare module 'fastify' {
  interface FastifyInstance {
    hub: ConnectionHub;
  }
}

export interface AppDeps {
  db: Db;
  redis: Redis;
  uow: UnitOfWork;
  users: UserRepository;
  jobPostings: JobPostingRepository;
  applications: ApplicationRepository;
  profiles: ProfileRepository;
  documents: DocumentRepository;
  queue: QueuePort;
  drafts: DraftStorePort;
  renderer: DocumentRendererPort;
  storage: ObjectStoragePort;
  hasher: HasherPort;
  outboxRelay: OutboxRelay;
  jobQueue: Queue;
  budgetStore: PostgresBudgetStore;
  connectorConfigs: ConnectorConfigRepository;
  matchScores: MatchScoreRepository;
  mcpTokens: McpTokenStore;
  /** Task 052/053 — optional so every existing test that builds `AppDeps` without them keeps working unchanged; apply routes are skipped entirely when absent. */
  applyTasks?: ApplyTaskRepository;
  approvalTokens?: ApprovalTokenPort;
  browserSubmit?: BrowserSubmitPort;
  browserRunnerFields?: BrowserRunnerFieldsPort;
  /** Fastify owns and creates the pino instance from this — false disables
   * logging entirely, which is what tests want (Fastify inject is noisy
   * otherwise). */
  logger?: boolean | FastifyLoggerOptions | undefined;
}

/**
 * Composition root's building block: wires every port implementation the
 * routes need. `main.ts` supplies REAL adapters; tests supply fakes/real
 * test infra directly, same shape either way — see task 011 test plan.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? true, trustProxy: true });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  registerErrorHandler(app);

  const sessions = new SessionStore(deps.redis);
  await registerAuthPlugin(app, { sessions });

  const hub = new ConnectionHub();
  app.hub = hub;

  registerHealthRoutes(app, { db: deps.db, redis: deps.redis });
  registerAuthRoutes(app, { users: deps.users, hasher: deps.hasher, sessions });
  registerJobRoutes(app, { uow: deps.uow, jobPostings: deps.jobPostings });
  registerApplicationRoutes(app, { uow: deps.uow });
  registerBoardRoutes(app, {
    applications: deps.applications, jobPostings: deps.jobPostings, profiles: deps.profiles, matchScores: deps.matchScores,
  });
  registerProfileRoutes(app, { uow: deps.uow, profiles: deps.profiles, queue: deps.queue, drafts: deps.drafts });
  registerDocumentRoutes(app, {
    uow: deps.uow,
    documents: deps.documents,
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    renderer: deps.renderer,
    storage: deps.storage,
    queue: deps.queue,
  });
  registerAdminRoutes(app, { jobQueue: deps.jobQueue, outboxRelay: deps.outboxRelay, budgetStore: deps.budgetStore });
  registerCaptureRoutes(app, { uow: deps.uow });
  registerConnectorRoutes(app, { connectorConfigs: deps.connectorConfigs });
  registerMatchingRoutes(app, {
    profiles: deps.profiles, jobPostings: deps.jobPostings, matchScores: deps.matchScores, queue: deps.queue,
  });
  registerMcpTokenRoutes(app, { tokens: deps.mcpTokens });
  registerWsRoutes(app, { hub });

  if (deps.applyTasks && deps.approvalTokens && deps.browserSubmit && deps.browserRunnerFields) {
    registerApplyRoutes(app, {
      applyTasks: deps.applyTasks,
      applications: deps.applications,
      documents: deps.documents,
      approvalTokens: deps.approvalTokens,
      browserSubmit: deps.browserSubmit,
      browserRunnerFields: deps.browserRunnerFields,
    });
  }

  return app;
}
