import { asApplicationId, notFound, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ApplicationRepository, JobPostingRepository, Actor } from '../../ports/repositories.js';
import type { Stage } from '@careerpilot/domain';

export interface ApplicationDetail {
  applicationId: string;
  jobPostingId: string;
  title: string;
  company: string | null;
  stage: Stage;
  updatedAt: string;
  createdAt: string;
}

/** Task 059's `careerpilot://application/{id}` resource -- single-item counterpart to `list-applications.ts` (057), no query logic this codebase didn't already have a name for. */
export function makeGetApplicationUseCase(deps: { applications: ApplicationRepository; jobPostings: JobPostingRepository }) {
  return async function getApplication(actor: Actor, applicationId: string): Promise<Result<ApplicationDetail, DomainError>> {
    const app = await deps.applications.findByIdForUser(asApplicationId(applicationId), actor.userId);
    if (app === null) return err(notFound('Application not found'));

    const job = await deps.jobPostings.findByIdForUser(app.jobPostingId, actor.userId);
    if (job === null) return err(notFound('Job posting not found'));

    return ok({
      applicationId: app.id,
      jobPostingId: job.id,
      title: job.title,
      company: job.company,
      stage: app.stage,
      updatedAt: app.updatedAt.toISOString(),
      createdAt: app.createdAt.toISOString(),
    });
  };
}
