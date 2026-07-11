import { Application, asJobPostingId, notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface CreateApplicationInput {
  jobPostingId: string;
}
export interface CreateApplicationOutput {
  applicationId: string;
}

/**
 * Starts tracking a job posting on the user's pipeline board. The job must
 * exist and be owned by the actor — there is no unscoped lookup (security
 * model §2), so a job belonging to another user 404s exactly like a job
 * that doesn't exist at all, rather than leaking a 403.
 */
export function makeCreateApplicationUseCase(deps: { uow: UnitOfWork }) {
  return async function createApplication(
    actor: Actor,
    input: CreateApplicationInput,
  ): Promise<Result<CreateApplicationOutput, DomainError>> {
    const jobPostingId = asJobPostingId(input.jobPostingId);

    return deps.uow.withTransaction(async (ctx) => {
      const job = await ctx.jobPostings.findByIdForUser(jobPostingId, actor.userId);
      if (job === null) {
        return { ok: false, error: notFound('Job posting not found') };
      }

      const app = Application.create({ userId: actor.userId, jobPostingId });
      await ctx.applications.save(app);

      const events = app.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      return { ok: true, value: { applicationId: app.id } };
    });
  };
}
