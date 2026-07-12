import { eq, and, isNull } from 'drizzle-orm';
import {
  Document,
  asUserId,
  asDocumentId,
  asDocumentVersionId,
  type DocumentContent,
  type DocumentKind,
  type DocumentVersionSource,
} from '@careerpilot/domain';
import type { DocumentRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { documents, documentVersions } from '../schema/index.js';

export class DrizzleDocumentRepository implements DocumentRepository {
  constructor(private readonly db: Db) {}

  async findByIdForUser(
    id: ReturnType<typeof asDocumentId>,
    userId: ReturnType<typeof asUserId>,
  ): Promise<Document | null> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? await this.toDomain(row) : null;
  }

  async listForUser(
    userId: ReturnType<typeof asUserId>,
    opts?: { includeDeleted?: boolean },
  ): Promise<Document[]> {
    const conditions = [eq(documents.userId, userId)];
    if (opts?.includeDeleted !== true) conditions.push(isNull(documents.deletedAt));

    const rows = await this.db.select().from(documents).where(and(...conditions));
    return Promise.all(rows.map((r) => this.toDomain(r)));
  }

  async save(document: Document): Promise<void> {
    const snap = document.toSnapshot();

    await this.db
      .insert(documents)
      .values({
        id: snap.id,
        userId: snap.userId,
        kind: snap.kind,
        title: snap.title,
        currentVersionId: snap.currentVersionId,
        deletedAt: snap.deletedAt,
        createdAt: snap.createdAt,
      })
      .onConflictDoUpdate({
        target: documents.id,
        set: {
          title: snap.title,
          currentVersionId: snap.currentVersionId,
          deletedAt: snap.deletedAt,
        },
      });

    // Append-only (design §2 / task 019/021 invariant): every version is
    // INSERT-only. `onConflictDoUpdate` here only exists to make `save`
    // idempotent for the ONE legitimate post-hoc field —
    // `renderedPdfKey`, set by `Document.attachRenderedArtifact` (task
    // 024) on an already-persisted version — content/version/source/
    // createdAt are never included in the `set` clause, so they can never
    // be overwritten even if a caller tried.
    for (const version of snap.versions) {
      await this.db
        .insert(documentVersions)
        .values({
          id: version.id,
          documentId: snap.id,
          version: version.version,
          source: version.source,
          content: version.content,
          renderedPdfKey: version.renderedPdfKey,
          generationJobId: version.generationJobId,
          profileFactsHash: version.profileFactsHash,
          createdAt: version.createdAt,
        })
        .onConflictDoUpdate({
          target: documentVersions.id,
          set: { renderedPdfKey: version.renderedPdfKey },
        });
    }
  }

  private async toDomain(row: typeof documents.$inferSelect): Promise<Document> {
    const versionRows = await this.db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, row.id))
      .orderBy(documentVersions.version);

    return Document.fromSnapshot({
      id: asDocumentId(row.id),
      userId: asUserId(row.userId),
      kind: row.kind as DocumentKind,
      title: row.title,
      currentVersionId: row.currentVersionId,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      versions: versionRows.map((v) => ({
        id: asDocumentVersionId(v.id),
        documentId: asDocumentId(v.documentId),
        version: v.version,
        source: v.source as DocumentVersionSource,
        content: v.content as DocumentContent,
        renderedPdfKey: v.renderedPdfKey,
        generationJobId: v.generationJobId,
        profileFactsHash: v.profileFactsHash,
        createdAt: v.createdAt,
      })),
    });
  }
}
