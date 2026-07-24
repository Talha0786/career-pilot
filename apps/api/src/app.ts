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
  QueuePort,
  DraftStorePort,
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
import { registerWsRoutes } from './routes/ws.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerDocumentRoutes } from './routes/documents.js';
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
  hasher: HasherPort;
  outboxRelay: OutboxRelay;
  jobQueue: Queue;
  budgetStore: PostgresBudgetStore;
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
  registerBoardRoutes(app, { applications: deps.applications, jobPostings: deps.jobPostings });
  registerProfileRoutes(app, { uow: deps.uow, profiles: deps.profiles, queue: deps.queue, drafts: deps.drafts });
  registerDocumentRoutes(app, { uow: deps.uow, documents: deps.documents, profiles: deps.profiles });
  registerAdminRoutes(app, { jobQueue: deps.jobQueue, outboxRelay: deps.outboxRelay, budgetStore: deps.budgetStore });
  registerWsRoutes(app, { hub });

  return app;
}
