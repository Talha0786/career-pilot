import { asDocumentId, asJobPostingId, notFound, validationFailed, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { DocumentRepository, ProfileRepository, JobPostingRepository } from '../../ports/repositories.js';
import type { QueuePort } from '../../ports/queue.port.js';
import type { Actor } from '../../ports/repositories.js';
import { TAILOR_DOCUMENT_QUEUE, type TailorDocumentRequestedPayload, type TailoringKind } from './tailor-document.js';

export interface RequestDocumentTailoringInput {
  documentId: string;
  jobPostingId: string;
  /** Task 058 — when supplied (the MCP `tailor_document` tool always supplies one), threaded onto the payload so `get_generation_status` can poll for it later. */
  generationJobId?: string | undefined;
}
export interface RequestDocumentTailoringOutput {
  queued: true;
  generationJobId: string | null;
}

const TAILORABLE_KINDS: readonly TailoringKind[] = ['resume', 'cover_letter'];

/**
 * The producer half of task 039's async tailoring pipeline — enqueues
 * `tailoring.document_requested` for `apps/worker`'s
 * `createTailorDocumentWorker` to consume. Same "fail fast with a clear
 * error rather than silently enqueue a job that will immediately fail"
 * posture as `request-match-scan.ts` (task 038): validates the document
 * exists, is owned by the caller, is a tailorable kind (resume/cover_letter
 * — not `other`), and that the target job posting exists, before ever
 * touching the queue.
 */
export function makeRequestDocumentTailoringUseCase(deps: {
  documents: DocumentRepository;
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  queue: QueuePort;
}) {
  return async function requestDocumentTailoring(
    actor: Actor,
    input: RequestDocumentTailoringInput,
  ): Promise<Result<RequestDocumentTailoringOutput, DomainError>> {
    const doc = await deps.documents.findByIdForUser(asDocumentId(input.documentId), actor.userId);
    if (doc === null) return err(notFound('Document not found'));
    if (doc.isDeleted) return err(validationFailed('Cannot tailor a deleted document'));
    if (!TAILORABLE_KINDS.includes(doc.kind as TailoringKind)) {
      return err(validationFailed(`Documents of kind "${doc.kind}" cannot be tailored`, { kind: doc.kind }));
    }

    // Deliberately NOT checking profile.embeddingStatus here — tailoring
    // reads facts via compileFactList (task 037), a pure function over
    // profile.sections, not the embedding. A profile can have real facts
    // and be perfectly tailorable before its embedding finishes (or even if
    // embedding fails entirely) — those are two independent concerns.
    const profile = await deps.profiles.findActiveForUser(actor.userId);
    if (profile === null) return err(notFound('No career profile exists yet'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(input.jobPostingId), actor.userId);
    if (job === null) return err(notFound('Job posting not found'));

    const payload: TailorDocumentRequestedPayload = {
      documentId: doc.id,
      profileId: profile.id,
      jobPostingId: job.id,
      userId: actor.userId,
      kind: doc.kind as TailoringKind,
      generationJobId: input.generationJobId,
    };
    await deps.queue.enqueue(TAILOR_DOCUMENT_QUEUE, payload as unknown as Record<string, unknown>);

    return ok({ queued: true, generationJobId: input.generationJobId ?? null });
  };
}
