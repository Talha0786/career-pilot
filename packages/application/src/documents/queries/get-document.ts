import { asDocumentId, notFound, type Document, type DocumentVersion, type Result, type DomainError } from '@careerpilot/domain';
import type { DocumentRepository, Actor } from '../../ports/repositories.js';

export interface DocumentVersionSummary {
  id: string;
  version: number;
  source: string;
  content: unknown;
  renderedPdfKey: string | null;
  profileFactsHash: string | null;
  createdAt: string;
}
export interface DocumentSummary {
  id: string;
  kind: string;
  title: string;
  currentVersionId: string | null;
  deletedAt: string | null;
  createdAt: string;
  versions: DocumentVersionSummary[];
}

function toVersionSummary(v: DocumentVersion): DocumentVersionSummary {
  return {
    id: v.id,
    version: v.version,
    source: v.source,
    content: v.content,
    renderedPdfKey: v.renderedPdfKey,
    profileFactsHash: v.profileFactsHash,
    createdAt: v.createdAt.toISOString(),
  };
}

function toSummary(doc: Document): DocumentSummary {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    currentVersionId: doc.currentVersionId,
    deletedAt: doc.deletedAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    versions: doc.versions.map(toVersionSummary),
  };
}

export function makeGetDocumentUseCase(deps: { documents: DocumentRepository }) {
  return async function getDocument(actor: Actor, documentId: string): Promise<Result<DocumentSummary, DomainError>> {
    const doc = await deps.documents.findByIdForUser(asDocumentId(documentId), actor.userId);
    if (doc === null) return { ok: false, error: notFound('Document not found') };
    return { ok: true, value: toSummary(doc) };
  };
}

/** Backs `GET /api/documents/:id/versions/:versionId` (task 022). */
export function makeGetDocumentVersionUseCase(deps: { documents: DocumentRepository }) {
  return async function getDocumentVersion(
    actor: Actor,
    documentId: string,
    versionId: string,
  ): Promise<Result<DocumentVersionSummary, DomainError>> {
    const doc = await deps.documents.findByIdForUser(asDocumentId(documentId), actor.userId);
    if (doc === null) return { ok: false, error: notFound('Document not found') };

    const version = doc.versions.find((v) => v.id === versionId);
    if (version === undefined) return { ok: false, error: notFound('Document version not found') };

    return { ok: true, value: toVersionSummary(version) };
  };
}
