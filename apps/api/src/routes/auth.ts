import type { FastifyInstance } from 'fastify';
import { RegisterRequestSchema, LoginRequestSchema } from '@careerpilot/contracts';
import { makeRegisterUseCase, makeLoginUseCase } from '@careerpilot/application';
import type { UserRepository, HasherPort } from '@careerpilot/application';
import { asUserId } from '@careerpilot/domain';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';
import type { SessionStore } from '../plugins/session.js';
import { SESSION_COOKIE_NAME } from '../plugins/session.js';

const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { users: UserRepository; hasher: HasherPort; sessions: SessionStore },
): void {
  const register = makeRegisterUseCase(deps);
  const login = makeLoginUseCase(deps);
  const isProd = process.env.NODE_ENV === 'production';

  app.post('/auth/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await register(parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);

    return reply.code(201).send({ userId: result.value.userId });
  });

  app.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await login(parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);

    const sessionId = await deps.sessions.create({ userId: result.value.userId });
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    return reply.code(200).send({ userId: result.value.userId });
  });

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) await deps.sessions.destroy(sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await deps.users.findById(asUserId(request.actor!.userId));
    if (!user) return sendProblem(reply, 404, { code: 'not_found', message: 'User not found' });
    return reply.send({ userId: user.id, email: user.email.value });
  });
}
