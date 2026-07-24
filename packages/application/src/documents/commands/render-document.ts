import { asDocumentId, notFound, conflict, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';
import type { DocumentRendererPort, RenderFormat, RenderTemplate } from '../../ports/document-renderer.port.js';
import type { ObjectStoragePort } from '../../ports/object-storage.port.js';

export interface RenderDocumentInput {
  documentId: string;
  versionId: string;
  format: RenderFormat;
  template: RenderTemplate;
}
export interface RenderDocumentOutput {
  documentId: string;
  versionId: string;
  renderedKey: string;
}

/**
 * Renders an EXISTING version's content and attaches the artifact key —
 * never mutates the version's content/source/createdAt (task 019/021
 * append-only invariant; `Document.attachRenderedArtifact` is the one
 * legitimate post-hoc field, task 024's whole reason to exist).
 */
export function makeRenderDocumentUseCase(deps: {
  uow: UnitOfWork;
  renderer: DocumentRendererPort;
  storage: ObjectStoragePort;
}) {
  return async function renderDocument(
    actor: Actor,
    input: RenderDocumentInput,
  ): Promise<Result<RenderDocumentOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const doc = await ctx.documents.findByIdForUser(asDocumentId(input.documentId), actor.userId);
      if (doc === null) return { ok: false, error: notFound('Document not found') };

      const version = doc.versions.find((v) => v.id === input.versionId);
      if (version === undefined) return { ok: false, error: notFound('Document version not found') };

      // Task 040's export-blocking gate (docs/06-agent-design.md §4 point
      // 4): a version with unresolved flagged claims is NOT exportable —
      // enforced here in code (the ONLY path that produces a downloadable
      // artifact), not left to the UI to merely hide the button.
      if (!version.isExportable()) {
        return {
          ok: false,
          error: conflict('This version has unresolved flagged claims and requires human review before it can be exported', {
            versionId: version.id,
            flaggedClaimCount: String(version.flaggedClaims?.length ?? 0),
          }),
        };
      }

      const bytes = await deps.renderer.render(version.content, input.format, input.template);
      const key = `documents/${doc.id}/${version.id}.${input.format}`;
      await deps.storage.put(key, bytes);

      const attached = doc.attachRenderedArtifact(version.id, key);
      if (!attached.ok) return attached;

      await ctx.documents.save(doc);

      return { ok: true, value: { documentId: doc.id, versionId: version.id, renderedKey: key } };
    });
  };
}
