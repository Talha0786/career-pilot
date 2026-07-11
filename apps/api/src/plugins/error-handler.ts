import type { FastifyInstance, FastifyError } from 'fastify';
import { sendProblem } from '../lib/problem.js';

/**
 * The single place stack traces are allowed to exist — they go to the
 * logger, never to the client (task 011 acceptance criteria). Anything that
 * reaches here is either a malformed request Fastify itself rejected
 * (bad JSON, wrong content-type) or a genuine bug; both get a stable
 * problem+json shape instead of Fastify's default error body.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      await sendProblem(reply, 500, { code: 'internal_error', message: 'An unexpected error occurred' });
      return;
    }

    request.log.warn({ err: error }, 'request rejected');
    await sendProblem(reply, statusCode, {
      code: 'validation_failed',
      message: error.message,
    });
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await sendProblem(reply, 404, { code: 'not_found', message: 'Route not found' });
  });
}
