import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '@careerpilot/infrastructure';
import type Redis from 'ioredis';

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Db; redis: Redis }): void {
  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_request, reply) => {
    const [pgOk, redisOk] = await Promise.all([
      deps.db.execute(sql`SELECT 1`).then(
        () => true,
        () => false,
      ),
      deps.redis.ping().then(
        () => true,
        () => false,
      ),
    ]);

    if (!pgOk || !redisOk) {
      return reply.code(503).send({ status: 'not_ready', postgres: pgOk, redis: redisOk });
    }
    return reply.code(200).send({ status: 'ready', postgres: pgOk, redis: redisOk });
  });
}
