import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import {
  createDb,
  DrizzleUnitOfWork,
  DrizzleUserRepository,
  DrizzleJobPostingRepository,
  DrizzleApplicationRepository,
  DrizzleProfileRepository,
  DrizzleDocumentRepository,
  OutboxRelay,
  BullMqOutboxPublisher,
  BullMqQueuePort,
  RedisDraftStore,
  PostgresBudgetStore,
  Argon2Hasher,
} from '@careerpilot/infrastructure';
import type { JobEmbeddedEvent } from '@careerpilot/contracts';
import { buildApp } from './app.js';

const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  port: Number(process.env.API_PORT ?? 8080),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

const logger = pino({ level: env.logLevel });

async function main(): Promise<void> {
  const { db, close: closeDb } = createDb(env.databaseUrl);
  const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
  const wsSubscriber = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

  const uow = new DrizzleUnitOfWork(db);
  const users = new DrizzleUserRepository(db);
  const jobPostings = new DrizzleJobPostingRepository(db);
  const applications = new DrizzleApplicationRepository(db);
  const profiles = new DrizzleProfileRepository(db);
  const documents = new DrizzleDocumentRepository(db);
  const hasher = new Argon2Hasher();
  const budgetStore = new PostgresBudgetStore(db);
  const outboxRelay = new OutboxRelay(db, new BullMqOutboxPublisher(redis));
  const jobQueue = new Queue('discovery.job_posted', { connection: redis });
  const queue = new BullMqQueuePort(redis);
  const drafts = new RedisDraftStore(redis);

  const app = await buildApp({
    db,
    redis,
    uow,
    users,
    jobPostings,
    applications,
    profiles,
    documents,
    queue,
    drafts,
    hasher,
    outboxRelay,
    jobQueue,
    budgetStore,
    logger: { level: env.logLevel },
  });

  // Worker → Redis pub/sub → api → browser (M2 design §2). The worker
  // publishes here after every embed attempt (success or failure); this is
  // the only channel that fans job.embedded out to a live WebSocket.
  await wsSubscriber.subscribe('ws:job.embedded');
  wsSubscriber.on('message', (_channel, message) => {
    try {
      const event = JSON.parse(message) as JobEmbeddedEvent & { userId: string };
      app.hub.sendToUser(event.userId, { type: 'job.embedded', jobId: event.jobId, status: event.status });
    } catch (err) {
      app.log.warn({ err }, 'discarded malformed ws:job.embedded message');
    }
  });

  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info({ port: env.port }, 'api listening');

  const shutdown = async (): Promise<void> => {
    app.log.info('shutting down');
    await app.close();
    await jobQueue.close();
    await wsSubscriber.quit();
    await redis.quit();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
