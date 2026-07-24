import type { FastifyInstance } from 'fastify';
import { makeGetBoardUseCase } from '@careerpilot/application';
import type { ApplicationRepository, JobPostingRepository, ProfileRepository, MatchScoreRepository } from '@careerpilot/application';
import { requireAuth } from '../plugins/auth.js';

export function registerBoardRoutes(
  app: FastifyInstance,
  deps: {
    applications: ApplicationRepository;
    jobPostings: JobPostingRepository;
    profiles?: ProfileRepository;
    matchScores?: MatchScoreRepository;
  },
): void {
  const getBoard = makeGetBoardUseCase(deps);

  app.get('/board', { preHandler: requireAuth }, async (request, reply) => {
    const columns = await getBoard(request.actor!);
    return reply.send({ columns });
  });
}
