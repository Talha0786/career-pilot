import {
  asDocumentId,
  notFound,
  type DocumentContent,
  type DocumentVersionSource,
  type Result,
  type DomainError,
} from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface AddDocumentVersionInput {
  documentId: string;
  source: DocumentVersionSource;
  content: DocumentContent;
  generationJobId?: string | undefined;
  profileFactsHash?: string | undefined;
}
export interface AddDocumentVersionOutput {
  documentId: string;
  versionId: string;
  version: number;
}

/**
 * Always creates a NEW version — there is no "target version id" parameter,
 * so there is no way for a caller to ask this use case to mutate an
 * existing one. The invariant-violation path task 020's test plan calls
 * for is exercised via `Document.addVersion`'s own guards (task 019): e.g.
 * adding a version to a soft-deleted document surfaces the domain's
 * `conflict` error unchanged, rather than the use case papering over it.
 *
 * Every successful call writes an `audit_log` row (task 022 acceptance:
 * "audit_log entry written on document version creation") in the SAME
 * transaction as the version itself and its outbox event.
 */
export function makeAddDocumentVersionUseCase(deps: { uow: UnitOfWork }) {
  return async function addDocumentVersion(
    actor: Actor,
    input: AddDocumentVersionInput,
  ): Promise<Result<AddDocumentVersionOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const doc = await ctx.documents.findByIdForUser(asDocumentId(input.documentId), actor.userId);
      if (doc === null) {
        return { ok: false, error: notFound('Document not found') };
      }

      const added = doc.addVersion({
        source: input.source,
        content: input.content,
        generationJobId: input.generationJobId,
        profileFactsHash: input.profileFactsHash,
      });
      if (!added.ok) return added;

      await ctx.documents.save(doc);

      const events = doc.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      await ctx.audit.record({
        userId: actor.userId,
        action: 'document.version_created',
        subjectType: 'document',
        subjectId: doc.id,
        detail: { versionId: added.value.id, version: added.value.version, source: input.source },
      });

      return {
        ok: true,
        value: { documentId: doc.id, versionId: added.value.id, version: added.value.version },
      };
    });
  };
}
