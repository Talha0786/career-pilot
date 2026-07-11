import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { makeEmbedJobPostingUseCase } from '@careerpilot/application';
import type { JobPostingRepository } from '@careerpilot/application';
import type { GuardedLlmPort } from '@careerpilot/application';

export interface JobPostedPayload {
  jobPostingId: string;
  userId: string;
}

/**
 * Consumes `discovery.job_posted`. This is the reference handler every
 * future handler copies (M2 design §10): correlation-id logging, and no
 * assumption of exactly-once delivery — ADR-007 guarantees at-least-once,
 * so idempotency is load-bearing, not aspirational, and it's tested as such
 * (application/test/unit/discovery.test.ts already proves the use case is
 * idempotent; this test proves the QUEUE round-trip is too).
 */
export function createJobPostedWorker(deps: {
  connection: Redis;
  jobPostings: JobPostingRepository;
  llm: GuardedLlmPort;
  embeddingModel: string;
  logger: Logger;
}): Worker<JobPostedPayload> {
  const embedJobPosting = makeEmbedJobPostingUseCase({
    jobPostings: deps.jobPostings,
    llm: deps.llm,
  });

  return new Worker<JobPostedPayload>(
    'discovery.job_posted',
    async (job: Job<JobPostedPayload>) => {
      const log = deps.logger.child({ jobId: job.id, jobPostingId: job.data.jobPostingId });
      log.info('embedding job posting');

      const result = await embedJobPosting({
        jobPostingId: job.data.jobPostingId,
        userId: job.data.userId,
        model: deps.embeddingModel,
      });

      if (!result.ok) {
        // BudgetExceeded and NotFound are not worth BullMQ's retry backoff —
        // they won't resolve by waiting. Provider errors (rate_limited,
        // provider_unavailable) DO benefit from retry, so we let those throw.
        if (result.error.code === 'budget_exceeded' || result.error.code === 'not_found') {
          log.warn({ code: result.error.code }, 'embedding not retried');
          return;
        }
        log.error({ error: result.error }, 'embedding failed, will retry');
        throw new Error(result.error.message);
      }

      log.info('embedding complete');
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
