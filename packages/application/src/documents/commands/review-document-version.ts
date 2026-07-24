import { asDocumentId, notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface ReviewDocumentVersionInput {
  documentId: string;
  versionId: string;
  /** true = accept the flagged claims as fine, clears needsHumanReview and unblocks export. false = confirm they're NOT fine; stays blocked. */
  approved: boolean;
}
export interface ReviewDocumentVersionOutput {
  documentId: string;
  versionId: string;
  needsHumanReview: boolean;
}

/**
 * Task 041 — the human-review resolution endpoint's use case. This is what
 * makes task 040's `needs_human` flag meaningful rather than a dead end:
 * without a path to clear it, a flagged document could never be exported,
 * ever (docs/06-agent-design.md §4 point 4: "Human review is
 * non-skippable before export/use" — non-skippable, not impossible).
 */
export function makeReviewDocumentVersionUseCase(deps: { uow: UnitOfWork }) {
  return async function reviewDocumentVersion(
    actor: Actor,
    input: ReviewDocumentVersionInput,
  ): Promise<Result<ReviewDocumentVersionOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const doc = await ctx.documents.findByIdForUser(asDocumentId(input.documentId), actor.userId);
      if (doc === null) return { ok: false, error: notFound('Document not found') };

      const resolved = doc.resolveReview(input.versionId, input.approved);
      if (!resolved.ok) return resolved;

      await ctx.documents.save(doc);

      await ctx.audit.record({
        userId: actor.userId,
        action: input.approved ? 'document.review_approved' : 'document.review_rejected',
        subjectType: 'document_version',
        subjectId: resolved.value.id,
        detail: { documentId: doc.id, flaggedClaimCount: String(resolved.value.flaggedClaims?.length ?? 0) },
      });

      return {
        ok: true,
        value: { documentId: doc.id, versionId: resolved.value.id, needsHumanReview: resolved.value.needsHumanReview },
      };
    });
  };
}
