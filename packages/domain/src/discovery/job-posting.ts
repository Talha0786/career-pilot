import { createHash } from 'node:crypto';
import { AggregateRoot, createEvent } from '../shared/domain-event.js';
import {
  type JobPostingId,
  type UserId,
  newJobPostingId,
} from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, validationFailed, forbidden } from '../shared/errors.js';
import { JobUrl } from './value-objects.js';

export type EmbeddingStatus = 'pending' | 'ready' | 'failed';

export interface JobPostingSnapshot {
  readonly id: JobPostingId;
  readonly userId: UserId;
  readonly sourceConnectorKey: string;
  readonly url: string | null;
  readonly urlHash: string | null;
  readonly company: string | null;
  readonly title: string;
  readonly descriptionMd: string;
  readonly embeddingStatus: EmbeddingStatus;
  readonly embeddingModel: string | null;
  readonly embedding: readonly number[] | null;
  readonly ingestedAt: Date;
}

export interface JobPostedPayload {
  readonly jobPostingId: string;
  readonly userId: string;
}

const MAX_DESCRIPTION_CHARS = 100_000;

/**
 * JobPosting — Discovery context aggregate root.
 *
 * M2 scope: manual paste only. Connector-sourced postings arrive in M4 through
 * the same aggregate, which is why `sourceConnectorKey` exists now.
 */
export class JobPosting extends AggregateRoot {
  private constructor(
    readonly id: JobPostingId,
    readonly userId: UserId,
    readonly sourceConnectorKey: string,
    private _url: JobUrl | null,
    private _company: string | null,
    private _title: string,
    private _descriptionMd: string,
    private _embeddingStatus: EmbeddingStatus,
    private _embeddingModel: string | null,
    private _embedding: readonly number[] | null,
    readonly ingestedAt: Date,
  ) {
    super();
  }

  /**
   * Create from a user-pasted job description.
   *
   * NOTE: `descriptionMd` must already be sanitized Markdown. Sanitization is
   * an infrastructure concern (HTML → Markdown with an allowlist) and happens
   * before we get here — the domain refuses to depend on a sanitizer library.
   */
  static createManual(args: {
    userId: UserId;
    title: string;
    descriptionMd: string;
    company?: string | undefined;
    url?: string | undefined;
    now?: Date;
  }): Result<JobPosting, DomainError> {
    const title = args.title.trim();
    if (title.length === 0) {
      return err(validationFailed('Title is required', { title: 'required' }));
    }
    if (title.length > 300) {
      return err(validationFailed('Title is too long', { title: 'max_length' }));
    }

    const description = args.descriptionMd.trim();
    if (description.length === 0) {
      return err(
        validationFailed('Description is required', { descriptionMd: 'required' }),
      );
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return err(
        validationFailed('Description is too long', { descriptionMd: 'max_length' }),
      );
    }

    let url: JobUrl | null = null;
    if (args.url !== undefined && args.url.trim() !== '') {
      const parsed = JobUrl.create(args.url);
      if (!parsed.ok) return parsed;
      url = parsed.value;
    }

    const company = args.company?.trim();

    const posting = new JobPosting(
      newJobPostingId(),
      args.userId,
      'manual',
      url,
      company !== undefined && company !== '' ? company : null,
      title,
      description,
      'pending',
      null,
      null,
      args.now ?? new Date(),
    );

    // Written to the outbox in the same transaction as the row (ADR-007).
    posting.record(
      createEvent<JobPostedPayload>({
        eventType: 'discovery.job_posted',
        aggregateType: 'JobPosting',
        aggregateId: posting.id,
        payload: { jobPostingId: posting.id, userId: args.userId },
        occurredAt: posting.ingestedAt,
      }),
    );

    return ok(posting);
  }

  /** Rehydrate from persistence. Emits no events. */
  static fromSnapshot(s: JobPostingSnapshot): JobPosting {
    let url: JobUrl | null = null;
    if (s.url !== null) {
      const parsed = JobUrl.create(s.url);
      // Trust the DB: a row that got in was valid at write time.
      url = parsed.ok ? parsed.value : null;
    }
    return new JobPosting(
      s.id,
      s.userId,
      s.sourceConnectorKey,
      url,
      s.company,
      s.title,
      s.descriptionMd,
      s.embeddingStatus,
      s.embeddingModel,
      s.embedding,
      s.ingestedAt,
    );
  }

  /**
   * Attach an embedding. IDEMPOTENT BY DESIGN.
   *
   * ADR-007 makes queue delivery at-least-once, so this WILL be called twice
   * with the same model. A second call with the same model is a no-op, not an
   * error — the handler must be safely replayable. A call with a *different*
   * model overwrites (a re-embed after a model upgrade is legitimate).
   */
  attachEmbedding(vector: readonly number[], model: string): Result<void, DomainError> {
    if (vector.length === 0) {
      return err(validationFailed('Embedding vector is empty', { embedding: 'empty' }));
    }

    if (this._embeddingStatus === 'ready' && this._embeddingModel === model) {
      return ok(undefined); // idempotent replay — no state change, no event
    }

    this._embedding = [...vector];
    this._embeddingModel = model;
    this._embeddingStatus = 'ready';
    return ok(undefined);
  }

  markEmbeddingFailed(): void {
    // Terminal only for this attempt; a retry may still set it ready.
    this._embeddingStatus = 'failed';
  }

  /** Ownership check — every read path must call this (security model §2). */
  assertOwnedBy(actorId: UserId): Result<void, DomainError> {
    return this.userId === actorId
      ? ok(undefined)
      : err(forbidden('You do not have access to this job posting'));
  }

  /** SHA-256 of the canonical URL — the exact-match half of dedup (M4). */
  get urlHash(): string | null {
    if (this._url === null) return null;
    return createHash('sha256').update(this._url.canonical()).digest('hex');
  }

  get url(): string | null {
    return this._url?.value ?? null;
  }
  get company(): string | null {
    return this._company;
  }
  get title(): string {
    return this._title;
  }
  get descriptionMd(): string {
    return this._descriptionMd;
  }
  get embeddingStatus(): EmbeddingStatus {
    return this._embeddingStatus;
  }
  get embeddingModel(): string | null {
    return this._embeddingModel;
  }
  get embedding(): readonly number[] | null {
    return this._embedding;
  }

  toSnapshot(): JobPostingSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      sourceConnectorKey: this.sourceConnectorKey,
      url: this.url,
      urlHash: this.urlHash,
      company: this._company,
      title: this._title,
      descriptionMd: this._descriptionMd,
      embeddingStatus: this._embeddingStatus,
      embeddingModel: this._embeddingModel,
      embedding: this._embedding,
      ingestedAt: this.ingestedAt,
    };
  }
}
