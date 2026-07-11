import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@careerpilot/application';
import { asUserId } from '@careerpilot/domain';
import type { SessionStore } from './session.js';
import { SESSION_COOKIE_NAME } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/**
 * Resolves `request.actor` from the session cookie on EVERY request (cheap:
 * one Redis GET) so downstream code never has to special-case "did auth
 * run yet." Routes that require a logged-in actor call `requireAuth`
 * explicitly — this plugin only populates, it never rejects.
 */
export async function registerAuthPlugin(app: FastifyInstance, deps: { sessions: SessionStore }): Promise<void> {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) return;

    const session = await deps.sessions.get(sessionId);
    request.actor = session ? { userId: asUserId(session.userId) } : null;
  });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.actor) {
    await reply.code(401).send({ code: 'invalid_credentials', message: 'Authentication required' });
  }
}
