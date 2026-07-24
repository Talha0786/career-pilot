import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { makeEmbedCareerProfileUseCase } from '@careerpilot/application';
import type { ProfileRepository } from '@careerpilot/application';
import type { GuardedLlmPort } from '@careerpilot/application';

export interface ProfileFactsChangedPayload {
  careerProfileId: string;
  userId: string;
}

/**
 * Consumes `profile.facts_changed` (task 035) — the profile analogue of
 * `job-posted.handler.ts`'s `discovery.job_posted` consumer. Same posture:
 * no assumption of exactly-once delivery (ADR-007), so
 * `makeEmbedCareerProfileUseCase`'s idempotency (by model + non-stale
 * factsHash) is load-bearing, not aspirational.
 */
export function createProfileFactsChangedWorker(deps: {
  connection: Redis;
  profiles: ProfileRepository;
  llm: GuardedLlmPort;
  embeddingModel: string;
  logger: Logger;
}): Worker<ProfileFactsChangedPayload> {
  const embedCareerProfile = makeEmbedCareerProfileUseCase({
    profiles: deps.profiles,
    llm: deps.llm,
  });

  return new Worker<ProfileFactsChangedPayload>(
    'profile.facts_changed',
    async (job: Job<ProfileFactsChangedPayload>) => {
      const log = deps.logger.child({ jobId: job.id, careerProfileId: job.data.careerProfileId });
      log.info('embedding career profile');

      const result = await embedCareerProfile({
        careerProfileId: job.data.careerProfileId,
        userId: job.data.userId,
        model: deps.embeddingModel,
      });

      if (!result.ok) {
        // Same retry posture as job-posted.handler.ts: budget_exceeded and
        // not_found won't resolve by BullMQ retrying; provider errors do.
        if (result.error.code === 'budget_exceeded' || result.error.code === 'not_found') {
          log.warn({ code: result.error.code }, 'profile embedding not retried');
          return;
        }
        log.error({ error: result.error }, 'profile embedding failed, will retry');
        throw new Error(result.error.message);
      }

      log.info('profile embedding complete');
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
