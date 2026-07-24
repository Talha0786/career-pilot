import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { makeScoreMatchUseCase, MATCH_SCORE_QUEUE, type ScoreMatchRequestedPayload } from '@careerpilot/application';
import type { ProfileRepository, JobPostingRepository, MatchScoreRepository, GuardedLlmPort, PromptStore } from '@careerpilot/application';

/**
 * Consumes `matching.score_requested` (task 038) — enqueued on-demand by
 * `POST /profile/rescan` (`request-match-scan.ts`). Unlike the embed
 * handlers, this is a plain `QueuePort` job, not an outbox-drained domain
 * event (no aggregate write needs to be atomic with it — same reasoning as
 * `parse-resume.handler.ts`), so there's no at-least-once-delivery
 * idempotency contract to prove here: `makeScoreMatchUseCase`'s
 * upsert-on-recompute persistence already makes a redelivered rescan a safe
 * no-op in effect (same components recomputed, same row overwritten), it's
 * just not FREE the way the embed path's model+factsHash check makes a
 * replay free — an acceptable cost for a job class that's on-demand and
 * infrequent (a user-triggered rescan button, not a per-event hot path).
 */
export function createScoreMatchWorker(deps: {
  connection: Redis;
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  matchScores: MatchScoreRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
  logger: Logger;
}): Worker<ScoreMatchRequestedPayload> {
  const scoreMatch = makeScoreMatchUseCase({
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    matchScores: deps.matchScores,
    llm: deps.llm,
    prompts: deps.prompts,
    model: deps.model,
  });

  return new Worker<ScoreMatchRequestedPayload>(
    MATCH_SCORE_QUEUE,
    async (job: Job<ScoreMatchRequestedPayload>) => {
      const log = deps.logger.child({ jobId: job.id, profileId: job.data.profileId });
      log.info('scoring matches for profile');

      const result = await scoreMatch({
        profileId: job.data.profileId,
        userId: job.data.userId,
        limit: job.data.limit,
      });

      if (!result.ok) {
        // not_found / validation_failed (profile gone, embedding not ready)
        // aren't worth BullMQ's retry backoff — they won't resolve by
        // waiting on the same stale request.
        log.warn({ code: result.error.code }, 'score-match request rejected');
        return;
      }

      log.info(
        { scored: result.value.scored.length, failed: result.value.failures.length },
        'match scoring complete',
      );
      if (result.value.failures.length > 0) {
        log.warn({ failures: result.value.failures }, 'some candidates failed to score');
      }
    },
    { connection: deps.connection, concurrency: 2 },
  );
}
