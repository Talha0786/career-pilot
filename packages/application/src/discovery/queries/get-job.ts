import { asJobPostingId, notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { JobPostingRepository, Actor } from '../../ports/repositories.js';
import type { JobPostingSummary } from './list-jobs.js';

export function makeGetJobUseCase(deps: { jobPostings: JobPostingRepository }) {
  return async function getJob(actor: Actor, jobId: string): Promise<Result<JobPostingSummary, DomainError>> {
    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(jobId), actor.userId);
    if (job === null) return { ok: false, error: notFound('Job posting not found') };
    return {
      ok: true,
      value: {
        id: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        descriptionMd: job.descriptionMd,
        sourceConnectorKey: job.sourceConnectorKey,
        embeddingStatus: job.embeddingStatus,
        ingestedAt: job.ingestedAt.toISOString(),
      },
    };
  };
}
