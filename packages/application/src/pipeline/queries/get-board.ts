import type { ApplicationRepository, JobPostingRepository, Actor } from '../../ports/repositories.js';
import type { Stage } from '@careerpilot/domain';

export interface BoardCard {
  applicationId: string;
  jobPostingId: string;
  title: string;
  company: string | null;
  stage: Stage;
  embeddingStatus: 'pending' | 'ready' | 'failed';
  updatedAt: string;
}

export function makeGetBoardUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
}) {
  return async function getBoard(actor: Actor): Promise<Record<Stage, BoardCard[]>> {
    const apps = await deps.applications.listForUser(actor.userId);

    const columns = Object.fromEntries(
      (['discovered', 'interested', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn'] as Stage[]).map(
        (s) => [s, [] as BoardCard[]],
      ),
    ) as Record<Stage, BoardCard[]>;

    for (const app of apps) {
      const job = await deps.jobPostings.findByIdForUser(app.jobPostingId, actor.userId);
      if (job === null) continue; // orphaned reference — skip rather than crash the board
      columns[app.stage].push({
        applicationId: app.id,
        jobPostingId: job.id,
        title: job.title,
        company: job.company,
        stage: app.stage,
        embeddingStatus: job.embeddingStatus,
        updatedAt: app.updatedAt.toISOString(),
      });
    }

    return columns;
  };
}
