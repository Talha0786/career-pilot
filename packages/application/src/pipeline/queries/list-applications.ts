import type { ApplicationRepository, JobPostingRepository, Actor } from '../../ports/repositories.js';
import type { Stage } from '@careerpilot/domain';

export interface ListApplicationsInput {
  stage?: Stage | undefined;
  staleDays?: number | undefined;
  limit: number;
}
export interface ListApplicationsItem {
  applicationId: string;
  jobPostingId: string;
  title: string;
  company: string | null;
  stage: Stage;
  updatedAt: string;
  staleDays: number;
}

/**
 * Task 057's `list_applications` MCP tool — a thin flattening of
 * `get-board.ts`'s per-stage columns into one filterable/limitable list
 * (§3: "Pipeline query | { stage?, staleDays?, limit }"), reusing
 * `ApplicationRepository.listForUser` directly rather than the board
 * query's column-bucketing (which this tool doesn't need).
 */
export function makeListApplicationsUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
}) {
  return async function listApplications(actor: Actor, input: ListApplicationsInput): Promise<ListApplicationsItem[]> {
    const apps = await deps.applications.listForUser(actor.userId);
    const now = Date.now();

    const items: ListApplicationsItem[] = [];
    for (const app of apps) {
      if (input.stage && app.stage !== input.stage) continue;
      const staleDays = Math.floor((now - app.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
      if (input.staleDays !== undefined && staleDays < input.staleDays) continue;

      const job = await deps.jobPostings.findByIdForUser(app.jobPostingId, actor.userId);
      if (job === null) continue; // orphaned reference — same "skip rather than crash" posture as get-board.ts

      items.push({
        applicationId: app.id,
        jobPostingId: job.id,
        title: job.title,
        company: job.company,
        stage: app.stage,
        updatedAt: app.updatedAt.toISOString(),
        staleDays,
      });
    }

    // Most recently updated first — matches the board's implicit recency bias.
    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return items.slice(0, input.limit);
  };
}
