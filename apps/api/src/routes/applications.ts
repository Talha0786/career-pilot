import type { FastifyInstance } from 'fastify';
import { CreateApplicationRequestSchema, UpdateStageRequestSchema } from '@careerpilot/contracts';
import { makeCreateApplicationUseCase, makeUpdateStageUseCase } from '@careerpilot/application';
import type { UnitOfWork } from '@careerpilot/application';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

export function registerApplicationRoutes(app: FastifyInstance, deps: { uow: UnitOfWork }): void {
  const createApplication = makeCreateApplicationUseCase({ uow: deps.uow });
  const updateStage = makeUpdateStageUseCase({ uow: deps.uow });

  app.post('/applications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateApplicationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await createApplication(request.actor!, parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);

    return reply.code(201).send(result.value);
  });

  app.patch<{ Params: { id: string } }>('/applications/:id/stage', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = UpdateStageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await updateStage(request.actor!, { applicationId: request.params.id, ...parsed.data });
    if (!result.ok) return sendDomainError(reply, result.error);

    return reply.send({ application: result.value });
  });
}
