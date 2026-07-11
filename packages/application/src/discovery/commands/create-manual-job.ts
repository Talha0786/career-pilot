import { JobPosting, asUserId, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface CreateManualJobInput {
  title: string;
  descriptionMd: string;
  company?: string | undefined;
  url?: string | undefined;
}
export interface CreateManualJobOutput {
  jobId: string;
  embeddingStatus: 'pending' | 'ready' | 'failed';
}

/**
 * The use case at the center of the M2 slice. `withTransaction` guarantees
 * the JobPosting row and its JobPosted outbox event land together or not at
 * all — this is what ADR-007 promises, made real.
 */
export function makeCreateManualJobUseCase(deps: { uow: UnitOfWork }) {
  return async function createManualJob(
    actor: Actor,
    input: CreateManualJobInput,
  ): Promise<Result<CreateManualJobOutput, DomainError>> {
    const created = JobPosting.createManual({
      userId: actor.userId,
      title: input.title,
      descriptionMd: input.descriptionMd,
      company: input.company,
      url: input.url,
    });
    if (!created.ok) return created;

    const job = created.value;

    await deps.uow.withTransaction(async (ctx) => {
      await ctx.jobPostings.save(job);
      // Drain and forward to the outbox INSIDE the same transaction (ADR-007) —
      // this is the line that turns "dual write" into "one atomic write."
      const events = job.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);
    });

    return { ok: true, value: { jobId: job.id, embeddingStatus: job.embeddingStatus } };
  };
}
