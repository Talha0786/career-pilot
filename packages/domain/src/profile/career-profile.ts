import { createHash } from 'node:crypto';
import { AggregateRoot, createEvent } from '../shared/domain-event.js';
import { type CareerProfileId, type UserId, newCareerProfileId } from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, validationFailed, forbidden, notFound } from '../shared/errors.js';
import {
  ProfileSection,
  type ProfileSectionKind,
  type ProfileSectionContent,
  type ProfileSectionSnapshot,
} from './profile-section.js';

export type ProfileEmbeddingStatus = 'pending' | 'ready' | 'failed';

export interface CareerProfileSnapshot {
  readonly id: CareerProfileId;
  readonly userId: UserId;
  readonly title: string;
  readonly summary: string | null;
  readonly isActive: boolean;
  readonly embeddingStatus: ProfileEmbeddingStatus;
  readonly embeddingModel: string | null;
  readonly embedding: readonly number[] | null;
  /** The facts_hash the CURRENT embedding was computed from — used to derive staleness. */
  readonly embeddedFactsHash: string | null;
  readonly createdAt: Date;
  readonly sections: readonly ProfileSectionSnapshot[];
}

/**
 * Object-key-order-independent JSON serialization. Plain `JSON.stringify`
 * preserves insertion order, but Postgres `jsonb` does NOT — it re-encodes
 * object keys into its own internal order, so a section's `content` that
 * round-trips through the DB can come back with the same fields in a
 * different order. Hashing with `JSON.stringify` alone would then produce a
 * DIFFERENT hash for semantically identical content post-persistence,
 * silently breaking staleness detection. Sorting keys at every level makes
 * the hash stable across that round-trip (found by the task 021 integration
 * test — `profile.factsHash` computed pre-save didn't match the same
 * profile re-read from Postgres).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic hash of the profile's canonical facts (design §2:
 * `career_profiles.facts_hash`). Reused verbatim by `DocumentVersion` at
 * generation time (`profile_facts_hash`) so the UI can flag a document
 * "stale" by a cheap string comparison instead of re-diffing content.
 *
 * Determinism requires the input to be order-independent of insertion order
 * (sort by id) and to only include the fields that matter — `sort` does NOT
 * affect facts (reordering isn't a factual change).
 */
export function computeProfileFactsHash(
  sections: readonly { id: string; kind: ProfileSectionKind; content: ProfileSectionContent }[],
): string {
  const canonical = [...sections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ kind: s.kind, content: s.content }));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

/**
 * CareerProfile — Profile context aggregate root (ARCHITECTURE.md invariant:
 * "generated documents may only assert facts present in the profile").
 *
 * Sections are owned entities: they only come into existence through
 * `addSection`, which stamps `this.id` as the `profileId` — there is no path
 * by which a section can end up attached to more than one profile.
 */
export class CareerProfile extends AggregateRoot {
  private _sections: ProfileSection[];

  private constructor(
    readonly id: CareerProfileId,
    readonly userId: UserId,
    private _title: string,
    private _summary: string | null,
    private _isActive: boolean,
    private _embeddingStatus: ProfileEmbeddingStatus,
    private _embeddingModel: string | null,
    private _embedding: readonly number[] | null,
    private _embeddedFactsHash: string | null,
    readonly createdAt: Date,
    sections: ProfileSection[],
  ) {
    super();
    this._sections = sections;
  }

  static create(args: {
    userId: UserId;
    title: string;
    summary?: string | undefined;
    isActive?: boolean;
    now?: Date;
  }): Result<CareerProfile, DomainError> {
    const title = args.title.trim();
    if (title.length === 0) {
      return err(validationFailed('Title is required', { title: 'required' }));
    }
    if (title.length > 200) {
      return err(validationFailed('Title is too long', { title: 'max_length' }));
    }

    const profile = new CareerProfile(
      newCareerProfileId(),
      args.userId,
      title,
      args.summary?.trim() || null,
      args.isActive ?? true,
      'pending',
      null,
      null,
      null,
      args.now ?? new Date(),
      [],
    );

    profile.record(
      createEvent({
        eventType: 'profile.career_profile_created',
        aggregateType: 'CareerProfile',
        aggregateId: profile.id,
        payload: { careerProfileId: profile.id, userId: args.userId },
        occurredAt: profile.createdAt,
      }),
    );

    return ok(profile);
  }

  static fromSnapshot(s: CareerProfileSnapshot): CareerProfile {
    return new CareerProfile(
      s.id,
      s.userId,
      s.title,
      s.summary,
      s.isActive,
      s.embeddingStatus,
      s.embeddingModel,
      s.embedding,
      s.embeddedFactsHash,
      s.createdAt,
      s.sections.map((sec) => ProfileSection.fromSnapshot(sec)),
    );
  }

  /**
   * Appends a new section to this profile. `sort` defaults to "last" so
   * callers importing a resume don't have to compute ordering by hand.
   * Adding content marks the embedding stale (facts changed underneath it).
   */
  addSection(args: {
    kind: ProfileSectionKind;
    content: ProfileSectionContent;
    sort?: number | undefined;
  }): Result<ProfileSection, DomainError> {
    const sort = args.sort ?? this._sections.length;
    const created = ProfileSection.create({
      profileId: this.id,
      kind: args.kind,
      sort,
      content: args.content,
    });
    if (!created.ok) return created;

    this._sections.push(created.value);
    this.record(
      createEvent({
        eventType: 'profile.section_added',
        aggregateType: 'CareerProfile',
        aggregateId: this.id,
        payload: { careerProfileId: this.id, sectionId: created.value.id, kind: args.kind },
      }),
    );
    return created;
  }

  updateSection(
    sectionId: string,
    content: ProfileSectionContent,
  ): Result<void, DomainError> {
    const section = this._sections.find((s) => s.id === sectionId);
    if (!section) return err(notFound('Profile section not found'));
    const updated = section.updateContent(content);
    if (!updated.ok) return updated;

    this.record(
      createEvent({
        eventType: 'profile.section_updated',
        aggregateType: 'CareerProfile',
        aggregateId: this.id,
        payload: { careerProfileId: this.id, sectionId: section.id },
      }),
    );
    return ok(undefined);
  }

  removeSection(sectionId: string): Result<void, DomainError> {
    const idx = this._sections.findIndex((s) => s.id === sectionId);
    if (idx === -1) return err(notFound('Profile section not found'));
    this._sections.splice(idx, 1);
    this.record(
      createEvent({
        eventType: 'profile.section_removed',
        aggregateType: 'CareerProfile',
        aggregateId: this.id,
        payload: { careerProfileId: this.id, sectionId },
      }),
    );
    return ok(undefined);
  }

  updateDetails(args: {
    title?: string | undefined;
    summary?: string | null | undefined;
  }): Result<void, DomainError> {
    if (args.title !== undefined) {
      const title = args.title.trim();
      if (title.length === 0) return err(validationFailed('Title is required', { title: 'required' }));
      this._title = title;
    }
    if (args.summary !== undefined) {
      this._summary = args.summary?.trim() || null;
    }
    return ok(undefined);
  }

  /**
   * Attach an embedding computed FOR the given facts hash. Idempotent by
   * (model, factsHash) pair — same shape as JobPosting.attachEmbedding
   * (task 003), for the same at-least-once-delivery reason (ADR-007).
   */
  attachEmbedding(
    vector: readonly number[],
    model: string,
    factsHash: string,
  ): Result<void, DomainError> {
    if (vector.length === 0) {
      return err(validationFailed('Embedding vector is empty', { embedding: 'empty' }));
    }
    if (
      this._embeddingStatus === 'ready' &&
      this._embeddingModel === model &&
      this._embeddedFactsHash === factsHash
    ) {
      return ok(undefined); // idempotent replay
    }
    this._embedding = [...vector];
    this._embeddingModel = model;
    this._embeddingStatus = 'ready';
    this._embeddedFactsHash = factsHash;
    return ok(undefined);
  }

  markEmbeddingFailed(): void {
    this._embeddingStatus = 'failed';
  }

  assertOwnedBy(actorId: UserId): Result<void, DomainError> {
    return this.userId === actorId
      ? ok(undefined)
      : err(forbidden('You do not have access to this career profile'));
  }

  /** Deterministic hash of current facts (design §2 `facts_hash`). */
  get factsHash(): string {
    return computeProfileFactsHash(this._sections.map((s) => s.toSnapshot()));
  }

  /**
   * True whenever the stored embedding was computed for a facts_hash that no
   * longer matches — i.e. the profile changed since the last embed. This IS
   * the "embedding-stale flag" (task 019); it is derived, never stored
   * redundantly, so it can never drift out of sync with reality.
   */
  get isEmbeddingStale(): boolean {
    return this._embeddingStatus !== 'ready' || this._embeddedFactsHash !== this.factsHash;
  }

  get title(): string {
    return this._title;
  }
  get summary(): string | null {
    return this._summary;
  }
  get isActive(): boolean {
    return this._isActive;
  }
  get embeddingStatus(): ProfileEmbeddingStatus {
    return this._embeddingStatus;
  }
  get embeddingModel(): string | null {
    return this._embeddingModel;
  }
  get embedding(): readonly number[] | null {
    return this._embedding;
  }
  get sections(): readonly ProfileSection[] {
    return this._sections;
  }

  toSnapshot(): CareerProfileSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      title: this._title,
      summary: this._summary,
      isActive: this._isActive,
      embeddingStatus: this._embeddingStatus,
      embeddingModel: this._embeddingModel,
      embedding: this._embedding,
      embeddedFactsHash: this._embeddedFactsHash,
      createdAt: this.createdAt,
      sections: this._sections.map((s) => s.toSnapshot()),
    };
  }
}
