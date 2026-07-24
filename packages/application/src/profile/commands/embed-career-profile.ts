import { asCareerProfileId, asUserId, notFound, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ProfileRepository } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';

export interface EmbedCareerProfileInput {
  careerProfileId: string;
  userId: string;
  model: string;
}

/**
 * Mirrors `embed-job-posting.ts`'s shape exactly (task 035). Consumed by the
 * worker after `profile.facts_changed` crosses the outbox — MUST be
 * idempotent for the same at-least-once-delivery reason (ADR-007).
 * `CareerProfile.attachEmbedding` is idempotent by (model, factsHash), same
 * as `JobPosting.attachEmbedding` — this use case just has to not do
 * anything unsafe on top of that guarantee.
 *
 * KNOWN LIMITATION (documented, not silently omitted): unlike
 * `JobPostingRepository.withJobPostingLock` (task 017), `ProfileRepository`
 * has no equivalent per-profile lock yet, so two genuinely-simultaneous
 * deliveries for the same profile could both pass the
 * ready+model+non-stale check before either writes and both call the LLM.
 * This is the same race class task 017 closed for job postings, not yet
 * closed here — out of this task's file list; worth a follow-up task if
 * profile-embedding volume ever makes it matter in practice.
 */
export function makeEmbedCareerProfileUseCase(deps: {
  profiles: ProfileRepository;
  llm: GuardedLlmPort;
}) {
  return async function embedCareerProfile(
    input: EmbedCareerProfileInput,
  ): Promise<Result<void, DomainError | LlmError>> {
    const profileId = asCareerProfileId(input.careerProfileId);
    const userId = asUserId(input.userId);
    const profile = await deps.profiles.findByIdForUser(profileId, userId);
    if (profile === null) {
      // The profile may have been deleted, or the facts_changed event may be
      // stale relative to a since-changed owner — not worth retrying over.
      return err(notFound('Career profile no longer exists'));
    }

    // Idempotent replay: already embedded with this exact model, for the
    // CURRENT facts — nothing changed since the last successful embed, so
    // no LLM call needed (cheaper AND correct, same posture as job postings).
    if (
      profile.embeddingStatus === 'ready' &&
      profile.embeddingModel === input.model &&
      !profile.isEmbeddingStale
    ) {
      return ok(undefined);
    }

    const factsHashAtDispatch = profile.factsHash;
    const inputText = profile.sections.map((s) => s.toContentText()).join('\n');

    // A profile with no sections yet has nothing meaningful to embed. Not
    // an error — just leave the status as-is until the first section lands
    // (CareerProfile.create deliberately doesn't emit facts_changed, so in
    // practice this only fires if a profile is later emptied out again via
    // removeSection).
    if (inputText.trim().length === 0) {
      return ok(undefined);
    }

    const result = await deps.llm.embed(
      { input: inputText, model: input.model },
      { userId: input.userId, refId: profile.id, context: 'matching' },
    );

    if (!result.ok) {
      profile.markEmbeddingFailed();
      await deps.profiles.save(profile);
      return result;
    }

    const attached = profile.attachEmbedding(result.value.vector, result.value.model, factsHashAtDispatch);
    if (!attached.ok) return attached;

    await deps.profiles.save(profile);
    return ok(undefined);
  };
}
