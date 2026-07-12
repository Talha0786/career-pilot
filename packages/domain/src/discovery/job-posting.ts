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

/**
 * M4 additions (task 027) — the full `job_postings` shape (design §2) that
 * M2 deliberately left out, now needed so connector-sourced postings
 * (task 028/029/030/031) carry the same information the manual-paste path
 * always could type in free text. Deliberately NOT a value object per field:
 * these are inbound facts about a job description as reported by a source,
 * not something the domain validates business rules against beyond shape.
 */
export interface PostingLocation {
  readonly raw: string;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
}

export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export interface PostingSalary {
  readonly min?: number;
  readonly max?: number;
  readonly currency?: string;
  readonly period?: 'year' | 'month' | 'hour';
}

export type PostingStatus = 'active' | 'closed' | 'expired';

export interface JobPostingSnapshot {
  readonly id: JobPostingId;
  readonly userId: UserId;
  readonly sourceConnectorKey: string;
  /** Null for legacy/manual rows predating task 027; connector-sourced postings always set it. */
  readonly externalId: string | null;
  readonly url: string | null;
  readonly urlHash: string | null;
  readonly company: string | null;
  readonly title: string;
  readonly descriptionMd: string;
  readonly status: PostingStatus;
  readonly location: PostingLocation | null;
  readonly remote: RemoteType;
  readonly salary: PostingSalary | null;
  readonly postedAt: Date | null;
  /** Cross-source dedup group (task 029). Null until the dedup pass assigns one. */
  readonly dedupGroupId: string | null;
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
    readonly externalId: string | null,
    private _url: JobUrl | null,
    private _company: string | null,
    private _title: string,
    private _descriptionMd: string,
    private _status: PostingStatus,
    private _location: PostingLocation | null,
    private _remote: RemoteType,
    private _salary: PostingSalary | null,
    private _postedAt: Date | null,
    private _dedupGroupId: string | null,
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
      null, // externalId — manual pastes have none; the unique (source_connector_key, external_id)
      //                index tolerates unlimited NULLs, so this never collides (task 027).
      url,
      company !== undefined && company !== '' ? company : null,
      title,
      description,
      'active',
      null,
      'unknown',
      null,
      null,
      null,
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

  /**
   * Create from a connector-normalized `RawJob` (task 028/029/030/031's
   * common path — Class A/B/C all funnel through this, never `createManual`).
   * Unlike `createManual`, `externalId` is required: it's the connector's
   * own identifier for the posting and is what the unique
   * `(source_connector_key, external_id)` index enforces "don't ingest the
   * same posting from the same source twice" against.
   */
  static ingest(args: {
    userId: UserId;
    sourceConnectorKey: string;
    externalId: string;
    title: string;
    descriptionMd: string;
    company: string;
    url?: string | undefined;
    location?: PostingLocation | null | undefined;
    remote?: RemoteType | undefined;
    salary?: PostingSalary | null | undefined;
    postedAt?: Date | null | undefined;
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
      return err(validationFailed('Description is required', { descriptionMd: 'required' }));
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return err(validationFailed('Description is too long', { descriptionMd: 'max_length' }));
    }

    const externalId = args.externalId.trim();
    if (externalId.length === 0) {
      return err(validationFailed('External id is required for a connector-sourced posting', { externalId: 'required' }));
    }

    const sourceConnectorKey = args.sourceConnectorKey.trim();
    if (sourceConnectorKey.length === 0) {
      return err(validationFailed('Source connector key is required', { sourceConnectorKey: 'required' }));
    }

    let url: JobUrl | null = null;
    if (args.url !== undefined && args.url.trim() !== '') {
      const parsed = JobUrl.create(args.url);
      if (!parsed.ok) return parsed;
      url = parsed.value;
    }

    const company = args.company.trim();

    const posting = new JobPosting(
      newJobPostingId(),
      args.userId,
      sourceConnectorKey,
      externalId,
      url,
      company !== '' ? company : null,
      title,
      description,
      'active',
      args.location ?? null,
      args.remote ?? 'unknown',
      args.salary ?? null,
      args.postedAt ?? null,
      null,
      'pending',
      null,
      null,
      args.now ?? new Date(),
    );

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
      s.externalId,
      url,
      s.company,
      s.title,
      s.descriptionMd,
      s.status,
      s.location,
      s.remote,
      s.salary,
      s.postedAt,
      s.dedupGroupId,
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

  /**
   * Assign this posting to a cross-source dedup group (task 029's dedup
   * pass). Idempotent: re-assigning the same group id is a no-op; assigning
   * a different one overwrites (a re-run with a refined threshold may
   * regroup postings).
   */
  assignDedupGroup(dedupGroupId: string): void {
    this._dedupGroupId = dedupGroupId;
  }

  markClosed(): void {
    this._status = 'closed';
  }

  markExpired(): void {
    this._status = 'expired';
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
  get status(): PostingStatus {
    return this._status;
  }
  get location(): PostingLocation | null {
    return this._location;
  }
  get remote(): RemoteType {
    return this._remote;
  }
  get salary(): PostingSalary | null {
    return this._salary;
  }
  get postedAt(): Date | null {
    return this._postedAt;
  }
  get dedupGroupId(): string | null {
    return this._dedupGroupId;
  }

  toSnapshot(): JobPostingSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      sourceConnectorKey: this.sourceConnectorKey,
      externalId: this.externalId,
      url: this.url,
      urlHash: this.urlHash,
      company: this._company,
      title: this._title,
      descriptionMd: this._descriptionMd,
      status: this._status,
      location: this._location,
      remote: this._remote,
      salary: this._salary,
      postedAt: this._postedAt,
      dedupGroupId: this._dedupGroupId,
      embeddingStatus: this._embeddingStatus,
      embeddingModel: this._embeddingModel,
      embedding: this._embedding,
      ingestedAt: this.ingestedAt,
    };
  }
}
