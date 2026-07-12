import { asJobPostingId, notFound, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { JobPostingRepository } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';

export interface EmbedJobPostingInput {
  jobPostingId: string;
  userId: string;
  model: string;
}

/**
 * Consumed by the worker after JobPosted crosses the outbox. MUST be
 * idempotent: ADR-007 makes delivery at-least-once, so this WILL run twice
 * for the same event in production. `JobPosting.attachEmbedding` is already
 * idempotent by model (domain layer, task 003) — this use case just has to
 * not do anything unsafe on top of that guarantee.
 */
export function makeEmbedJobPostingUseCase(deps: {
  jobPostings: JobPostingRepository;
  llm: GuardedLlmPort;
}) {
  return async function embedJobPosting(
    input: EmbedJobPostingInput,
  ): Promise<Result<void, DomainError | LlmError>> {
    // Task 017: serializes the whole read-check-embed-write sequence per
    // jobPostingId when the repository supports it, so two deliveries that
    // start genuinely simultaneously (not just sequential redelivery, which
    // was already free via the ready+model check below) still result in
    // exactly one LLM call — the second delivery blocks on the lock, then
    // sees embeddingStatus==='ready' once it acquires it. Optional so a
    // repository without locking still works (unlocked, same as before).
    if (deps.jobPostings.withJobPostingLock) {
      return deps.jobPostings.withJobPostingLock(input.jobPostingId, () => doEmbed(deps, input));
    }
    return doEmbed(deps, input);
  };
}

async function doEmbed(
  deps: { jobPostings: JobPostingRepository; llm: GuardedLlmPort },
  input: EmbedJobPostingInput,
): Promise<Result<void, DomainError | LlmError>> {
  const jobId = asJobPostingId(input.jobPostingId);
  const job = await deps.jobPostings.findByIdAnyOwner(jobId);
  if (job === null) {
    // The job may have been deleted between enqueue and consume — not an
    // error worth retrying over; log and move on.
    return err(notFound('Job posting no longer exists'));
  }

  // Already embedded with this exact model — a replay. Return success
  // without touching the LLM at all (cheaper AND correct).
  if (job.embeddingStatus === 'ready' && job.embeddingModel === input.model) {
    return ok(undefined);
  }

  const result = await deps.llm.embed(
    { input: job.descriptionMd, model: input.model },
    { userId: input.userId, refId: job.id, context: 'matching' },
  );

  if (!result.ok) {
    job.markEmbeddingFailed();
    await deps.jobPostings.save(job);
    return result;
  }

  const attached = job.attachEmbedding(result.value.vector, result.value.model);
  if (!attached.ok) return attached;

  await deps.jobPostings.save(job);
  return ok(undefined);
}
