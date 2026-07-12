import { type DocumentId, type DocumentVersionId, newDocumentVersionId } from '../shared/ids.js';
import { type DocumentContent } from './document-content.js';

export type DocumentVersionSource = 'imported' | 'generated' | 'edited';

export interface DocumentVersionSnapshot {
  readonly id: DocumentVersionId;
  readonly documentId: DocumentId;
  readonly version: number;
  readonly source: DocumentVersionSource;
  readonly content: DocumentContent;
  readonly renderedPdfKey: string | null;
  readonly generationJobId: string | null;
  /**
   * The owning profile's `factsHash` (CareerProfile, task 019) at the moment
   * this version was produced. The UI (task 025) flags a document "stale"
   * when this no longer matches the profile's CURRENT factsHash — design §2:
   * "lets UI flag documents stale relative to profile."
   */
  readonly profileFactsHash: string | null;
  readonly createdAt: Date;
}

/**
 * DocumentVersion — append-only entity (database design §2 invariant).
 * Deliberately has NO setters and NO `updateXxx` method: once constructed, a
 * DocumentVersion is immutable data. The only way to "change" a document's
 * content is `Document.addVersion`, which creates a brand new one. This is
 * the domain-layer half of task 019's append-only acceptance criterion; the
 * repository layer (task 021) enforces the other half (no UPDATE path, no
 * `updated_at` column).
 */
export class DocumentVersion {
  private constructor(
    readonly id: DocumentVersionId,
    readonly documentId: DocumentId,
    readonly version: number,
    readonly source: DocumentVersionSource,
    readonly content: DocumentContent,
    readonly renderedPdfKey: string | null,
    readonly generationJobId: string | null,
    readonly profileFactsHash: string | null,
    readonly createdAt: Date,
  ) {}

  /** Only called by `Document.addVersion` — never construct one standalone. */
  static create(args: {
    documentId: DocumentId;
    version: number;
    source: DocumentVersionSource;
    content: DocumentContent;
    generationJobId?: string | undefined;
    profileFactsHash?: string | undefined;
    now?: Date | undefined;
  }): DocumentVersion {
    return new DocumentVersion(
      newDocumentVersionId(),
      args.documentId,
      args.version,
      args.source,
      args.content,
      null,
      args.generationJobId ?? null,
      args.profileFactsHash ?? null,
      args.now ?? new Date(),
    );
  }

  static fromSnapshot(s: DocumentVersionSnapshot): DocumentVersion {
    return new DocumentVersion(
      s.id,
      s.documentId,
      s.version,
      s.source,
      s.content,
      s.renderedPdfKey,
      s.generationJobId,
      s.profileFactsHash,
      s.createdAt,
    );
  }

  /**
   * Returns a NEW DocumentVersion instance with `renderedPdfKey` set — this
   * is NOT a mutation (there is no setter). The renderer (task 024) calls
   * this after producing the artifact; the repository persists the returned
   * copy. `version`, `content`, and `createdAt` are carried over unchanged,
   * so the append-only row this represents never actually changes identity —
   * only the DB row's `rendered_pdf_key` column gets filled in once.
   */
  withRenderedPdfKey(key: string): DocumentVersion {
    return new DocumentVersion(
      this.id,
      this.documentId,
      this.version,
      this.source,
      this.content,
      key,
      this.generationJobId,
      this.profileFactsHash,
      this.createdAt,
    );
  }

  /** Stale relative to a profile whose current facts hash differs (or is unknown). */
  isStaleAgainst(currentProfileFactsHash: string): boolean {
    return this.profileFactsHash !== null && this.profileFactsHash !== currentProfileFactsHash;
  }

  toSnapshot(): DocumentVersionSnapshot {
    return {
      id: this.id,
      documentId: this.documentId,
      version: this.version,
      source: this.source,
      content: this.content,
      renderedPdfKey: this.renderedPdfKey,
      generationJobId: this.generationJobId,
      profileFactsHash: this.profileFactsHash,
      createdAt: this.createdAt,
    };
  }
}
