import { notFound, validationFailed, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ProfileRepository } from '../../ports/repositories.js';
import type { QueuePort } from '../../ports/queue.port.js';
import type { Actor } from '../../ports/repositories.js';
import { MATCH_SCORE_QUEUE, type ScoreMatchRequestedPayload } from './score-match.js';

export interface RequestMatchScanOutput {
  queued: true;
}

/**
 * The producer half of task 038's "on-demand" rescan path — mirrors
 * `import-resume.ts`'s enqueue-and-return-immediately shape (task 023):
 * no aggregate write happens here, so there's nothing for the outbox to be
 * atomic with (`QueuePort`'s own doc comment). Fails FAST with a clear
 * error if the caller's active profile isn't embedding-ready yet, rather
 * than silently enqueueing a job that the worker will immediately reject
 * for the same reason — the same "check before dispatch" posture
 * `GuardedLlmPort` already applies to the LLM call itself, applied one
 * layer up to the whole scan request.
 */
export function makeRequestMatchScanUseCase(deps: { profiles: ProfileRepository; queue: QueuePort }) {
  return async function requestMatchScan(actor: Actor): Promise<Result<RequestMatchScanOutput, DomainError>> {
    const profile = await deps.profiles.findActiveForUser(actor.userId);
    if (profile === null) {
      return err(notFound('No career profile exists yet'));
    }
    if (profile.embedding === null || profile.embeddingStatus !== 'ready') {
      return err(
        validationFailed('Profile embedding is not ready yet — try again once the profile finishes embedding', {
          embeddingStatus: profile.embeddingStatus,
        }),
      );
    }

    const payload: ScoreMatchRequestedPayload = { profileId: profile.id, userId: actor.userId };
    await deps.queue.enqueue(MATCH_SCORE_QUEUE, payload as unknown as Record<string, unknown>);

    return ok({ queued: true });
  };
}
