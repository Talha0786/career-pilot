import { asUserId } from '@careerpilot/domain';
import type { JobPostingRepository, Actor } from '../../ports/repositories.js';

export interface ListJobsInput {
  cursor?: string | undefined;
  limit: number;
}
export interface JobPostingSummary {
  id: string;
  title: string;
  company: string | null;
  url: string | null;
  descriptionMd: string;
  sourceConnectorKey: string;
  embeddingStatus: 'pending' | 'ready' | 'failed';
  ingestedAt: string;
}

export function makeListJobsUseCase(deps: { jobPostings: JobPostingRepository }) {
  return async function listJobs(
    actor: Actor,
    input: ListJobsInput,
  ): Promise<{ items: JobPostingSummary[]; nextCursor: string | null }> {
    const { items, nextCursor } = await deps.jobPostings.listForUser(asUserId(actor.userId), {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      limit: input.limit,
    });
    return {
      items: items.map((job) => ({
        id: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        descriptionMd: job.descriptionMd,
        sourceConnectorKey: job.sourceConnectorKey,
        embeddingStatus: job.embeddingStatus,
        ingestedAt: job.ingestedAt.toISOString(),
      })),
      nextCursor,
    };
  };
}
