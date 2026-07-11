import type { FastifyInstance } from 'fastify';
import { makeGetBoardUseCase } from '@careerpilot/application';
import type { ApplicationRepository, JobPostingRepository } from '@careerpilot/application';
import { requireAuth } from '../plugins/auth.js';

export function registerBoardRoutes(
  app: FastifyInstance,
  deps: { applications: ApplicationRepository; jobPostings: JobPostingRepository },
): void {
  const getBoard = makeGetBoardUseCase(deps);

  app.get('/board', { preHandler: requireAuth }, async (request, reply) => {
    const columns = await getBoard(request.actor!);
    return reply.send({ columns });
  });
}
