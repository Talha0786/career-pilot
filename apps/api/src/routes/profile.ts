import type { FastifyInstance } from 'fastify';
import { PutProfileRequestSchema, AddSectionRequestSchema } from '@careerpilot/contracts';
import {
  makeGetProfileUseCase,
  makeCreateProfileUseCase,
  makeUpdateProfileUseCase,
  makeAddSectionUseCase,
} from '@careerpilot/application';
import type { UnitOfWork, ProfileRepository } from '@careerpilot/application';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * NOTE on paths: task 022 spec's wording uses an `/api/profile` prefix, but
 * NO other M2 route in this codebase is prefixed with `/api` (`/jobs`,
 * `/applications`, `/board` — see apps/api/src/routes/*.ts). Following the
 * task's own instruction to "match task 011's auth/route conventions" over
 * its literal path strings — these routes are unprefixed, consistent with
 * every other route this API serves.
 */
export function registerProfileRoutes(
  app: FastifyInstance,
  deps: { uow: UnitOfWork; profiles: ProfileRepository },
): void {
  const getProfile = makeGetProfileUseCase({ profiles: deps.profiles });
  const createProfile = makeCreateProfileUseCase({ uow: deps.uow });
  const updateProfile = makeUpdateProfileUseCase({ uow: deps.uow });
  const addSection = makeAddSectionUseCase({ uow: deps.uow });

  app.get('/profile', { preHandler: requireAuth }, async (request, reply) => {
    const result = await getProfile(request.actor!);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.send(result.value);
  });

  // Upsert semantics: update the user's active profile if one exists,
  // otherwise create it. Two single-purpose use cases (task 020) composed
  // here rather than a single "upsert" use case — the route just tries
  // update first and falls back to create on not_found; no business logic
  // lives in the route itself.
  app.put('/profile', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = PutProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const updated = await updateProfile(request.actor!, parsed.data);
    if (updated.ok) return reply.send(updated.value);
    if (updated.error.code !== 'not_found') return sendDomainError(reply, updated.error);

    const created = await createProfile(request.actor!, parsed.data);
    if (!created.ok) return sendDomainError(reply, created.error);
    return reply.code(201).send(created.value);
  });

  app.post('/profile/sections', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = AddSectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await addSection(request.actor!, parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.code(201).send(result.value);
  });
}
