import { AggregateRoot, createEvent } from '../shared/domain-event.js';
import { type DocumentId, type UserId, newDocumentId } from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, validationFailed, forbidden, notFound, conflict } from '../shared/errors.js';
import { DocumentVersion, type DocumentVersionSnapshot, type DocumentVersionSource, type FlaggedClaim } from './document-version.js';
import { type DocumentContent } from './document-content.js';

export type DocumentKind = 'resume' | 'cover_letter' | 'other';
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['resume', 'cover_letter', 'other'];

export interface DocumentSnapshot {
  readonly id: DocumentId;
  readonly userId: UserId;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly versions: readonly DocumentVersionSnapshot[];
}

/**
 * Document — Profile context aggregate root (design §2). Owns an append-only
 * list of `DocumentVersion`s. There is deliberately NO `updateVersion`
 * method anywhere on this class — the only way to change what a document
 * says is `addVersion`, which always creates a new, immutable version and
 * bumps `currentVersionId`. This is the domain-layer enforcement half of
 * task 019's append-only acceptance criterion.
 *
 * Soft-delete only (design rule: "soft delete only where product requires
 * undo (documents)") — `deletedAt`, never a hard DELETE.
 */
export class Document extends AggregateRoot {
  private _versions: DocumentVersion[];

  private constructor(
    readonly id: DocumentId,
    readonly userId: UserId,
    readonly kind: DocumentKind,
    private _title: string,
    private _currentVersionId: string | null,
    private _deletedAt: Date | null,
    readonly createdAt: Date,
    versions: DocumentVersion[],
  ) {
    super();
    this._versions = versions;
  }

  static create(args: {
    userId: UserId;
    kind: DocumentKind;
    title: string;
    now?: Date;
  }): Result<Document, DomainError> {
    const title = args.title.trim();
    if (title.length === 0) {
      return err(validationFailed('Title is required', { title: 'required' }));
    }
    if (!DOCUMENT_KINDS.includes(args.kind)) {
      return err(validationFailed('Unknown document kind', { kind: String(args.kind) }));
    }

    const doc = new Document(
      newDocumentId(),
      args.userId,
      args.kind,
      title,
      null,
      null,
      args.now ?? new Date(),
      [],
    );

    doc.record(
      createEvent({
        eventType: 'documents.document_created',
        aggregateType: 'Document',
        aggregateId: doc.id,
        payload: { documentId: doc.id, userId: args.userId, kind: args.kind },
        occurredAt: doc.createdAt,
      }),
    );

    return ok(doc);
  }

  static fromSnapshot(s: DocumentSnapshot): Document {
    return new Document(
      s.id,
      s.userId,
      s.kind,
      s.title,
      s.currentVersionId,
      s.deletedAt,
      s.createdAt,
      s.versions.map((v) => DocumentVersion.fromSnapshot(v)),
    );
  }

  /**
   * Creates and appends a brand-new version — the ONLY mutation path for a
   * document's content. `version` is always this.nextVersionNumber; a caller
   * cannot target an existing version number (there is no parameter for it),
   * which is what makes "mutating an existing version" structurally
   * unreachable rather than merely discouraged.
   */
  addVersion(args: {
    source: DocumentVersionSource;
    content: DocumentContent;
    generationJobId?: string | undefined;
    profileFactsHash?: string | undefined;
    /** Task 040 — see DocumentVersion's doc comment. */
    needsHumanReview?: boolean | undefined;
    flaggedClaims?: readonly FlaggedClaim[] | null | undefined;
    now?: Date | undefined;
  }): Result<DocumentVersion, DomainError> {
    if (this._deletedAt !== null) {
      return err(conflict('Cannot add a version to a deleted document'));
    }
    if (args.content.kind !== this.kind) {
      return err(
        validationFailed('Version content kind must match the document kind', {
          expected: this.kind,
          actual: args.content.kind,
        }),
      );
    }

    const version = DocumentVersion.create({
      documentId: this.id,
      version: this.nextVersionNumber,
      source: args.source,
      content: args.content,
      generationJobId: args.generationJobId,
      profileFactsHash: args.profileFactsHash,
      needsHumanReview: args.needsHumanReview,
      flaggedClaims: args.flaggedClaims,
      now: args.now,
    });

    this._versions.push(version);
    this._currentVersionId = version.id;

    this.record(
      createEvent({
        eventType: 'documents.version_added',
        aggregateType: 'Document',
        aggregateId: this.id,
        payload: { documentId: this.id, versionId: version.id, version: version.version },
        occurredAt: version.createdAt,
      }),
    );

    return ok(version);
  }

  /**
   * Attaches a rendered artifact key to an EXISTING version by replacing it
   * with `withRenderedPdfKey`'s output (a new immutable instance, same
   * version number/content/createdAt) — not a content mutation, just filling
   * in the one field that's legitimately produced after the fact by the
   * renderer (task 024).
   */
  attachRenderedArtifact(versionId: string, renderedPdfKey: string): Result<void, DomainError> {
    const idx = this._versions.findIndex((v) => v.id === versionId);
    if (idx === -1) return err(notFound('Document version not found'));
    this._versions[idx] = this._versions[idx]!.withRenderedPdfKey(renderedPdfKey);
    return ok(undefined);
  }

  /**
   * Task 041 — resolves a pending human review of a `needsHumanReview:true`
   * version (task 040's gate). `approved: true` clears the flag and unblocks
   * export (`DocumentVersion.isExportable()`); `approved: false` records
   * that a human looked at it and confirmed it's NOT fine — the version
   * stays blocked (the caller is expected to regenerate via the tailoring
   * pipeline, task 039, not edit around the flag). Either outcome requires
   * a version that actually HAS a pending review — resolving a version
   * that was never flagged, or is already resolved, is a `conflict`, not a
   * silent no-op.
   */
  resolveReview(versionId: string, approved: boolean): Result<DocumentVersion, DomainError> {
    const idx = this._versions.findIndex((v) => v.id === versionId);
    if (idx === -1) return err(notFound('Document version not found'));

    const version = this._versions[idx]!;
    if (!version.needsHumanReview) {
      return err(conflict('This version has no pending review to resolve'));
    }

    if (!approved) {
      // Explicitly rejected — no state change, but a real, intentional
      // outcome (not an accidental no-op): the version stays blocked.
      return ok(version);
    }

    const resolved = version.withReviewResolved();
    this._versions[idx] = resolved;
    return ok(resolved);
  }

  rename(title: string): Result<void, DomainError> {
    const t = title.trim();
    if (t.length === 0) return err(validationFailed('Title is required', { title: 'required' }));
    this._title = t;
    return ok(undefined);
  }

  softDelete(now?: Date): Result<void, DomainError> {
    if (this._deletedAt !== null) return err(conflict('Document is already deleted'));
    this._deletedAt = now ?? new Date();
    return ok(undefined);
  }

  restore(): Result<void, DomainError> {
    if (this._deletedAt === null) return err(conflict('Document is not deleted'));
    this._deletedAt = null;
    return ok(undefined);
  }

  assertOwnedBy(actorId: UserId): Result<void, DomainError> {
    return this.userId === actorId
      ? ok(undefined)
      : err(forbidden('You do not have access to this document'));
  }

  get nextVersionNumber(): number {
    return this._versions.length === 0
      ? 1
      : Math.max(...this._versions.map((v) => v.version)) + 1;
  }

  get title(): string {
    return this._title;
  }
  get currentVersionId(): string | null {
    return this._currentVersionId;
  }
  get deletedAt(): Date | null {
    return this._deletedAt;
  }
  get isDeleted(): boolean {
    return this._deletedAt !== null;
  }
  get versions(): readonly DocumentVersion[] {
    return this._versions;
  }
  get currentVersion(): DocumentVersion | null {
    if (this._currentVersionId === null) return null;
    return this._versions.find((v) => v.id === this._currentVersionId) ?? null;
  }

  toSnapshot(): DocumentSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      kind: this.kind,
      title: this._title,
      currentVersionId: this._currentVersionId,
      deletedAt: this._deletedAt,
      createdAt: this.createdAt,
      versions: this._versions.map((v) => v.toSnapshot()),
    };
  }
}
