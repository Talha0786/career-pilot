import type { FastifyInstance } from 'fastify';
import { CreateManualJobRequestSchema, ListJobsQuerySchema } from '@careerpilot/contracts';
import {
  makeCreateManualJobUseCase,
  makeListJobsUseCase,
  makeGetJobUseCase,
} from '@careerpilot/application';
import type { UnitOfWork, JobPostingRepository } from '@careerpilot/application';
import { sendDomainError, sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

export function registerJobRoutes(
  app: FastifyInstance,
  deps: { uow: UnitOfWork; jobPostings: JobPostingRepository },
): void {
  const createManualJob = makeCreateManualJobUseCase({ uow: deps.uow });
  const listJobs = makeListJobsUseCase({ jobPostings: deps.jobPostings });
  const getJob = makeGetJobUseCase({ jobPostings: deps.jobPostings });

  // 202, not 201 — the resource exists but embedding is still pending. This
  // is the contract that forces async-aware UI from day one (M2 design §6).
  app.post('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = CreateManualJobRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const result = await createManualJob(request.actor!, parsed.data);
    if (!result.ok) return sendDomainError(reply, result.error);

    return reply.code(202).send(result.value);
  });

  app.get('/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = ListJobsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid query' });
    }

    const result = await listJobs(request.actor!, parsed.data);
    return reply.send(result);
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', { preHandler: requireAuth }, async (request, reply) => {
    const result = await getJob(request.actor!, request.params.id);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.send(result.value);
  });
}
