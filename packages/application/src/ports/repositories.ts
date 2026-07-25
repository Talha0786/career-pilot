import type {
  User, JobPosting, Application, CareerProfile, Document, MatchScore, ApplyTask,
  UserId, JobPostingId, ApplicationId, CareerProfileId, DocumentId, ApplyTaskId,
} from '@careerpilot/domain';
import type { AuditPort } from './audit.port.js';

/** Minimal projection used by `discovery/dedup.ts`'s pure matcher (task 029). */
export interface DedupCandidate {
  readonly id: string;
  readonly urlHash: string | null;
  readonly title: string;
  readonly company: string | null;
  readonly dedupGroupId: string | null;
}

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: UserId): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface JobPostingRepository {
  /** Ownership-scoped by design — there is no unscoped findById (security model §2). */
  findByIdForUser(id: JobPostingId, userId: UserId): Promise<JobPosting | null>;
  findByIdAnyOwner(id: JobPostingId): Promise<JobPosting | null>; // worker path only
  listForUser(userId: UserId, opts: { cursor?: string; limit: number }): Promise<{
    items: JobPosting[];
    nextCursor: string | null;
  }>;
  save(job: JobPosting): Promise<void>;
  /**
   * Ingestion-path lookup (task 027/029): "has this connector already
   * ingested this external id?" — the pre-write half of the
   * `(source_connector_key, external_id)` unique index, used by the
   * ingestion pipeline to decide insert-vs-skip before it ever attempts a
   * write. Unscoped by user — a connector ingests on behalf of a user, but
   * "does this posting already exist" is a source-level fact, not an
   * ownership-scoped read.
   */
  findBySourceAndExternalId(sourceConnectorKey: string, externalId: string): Promise<JobPosting | null>;
  /**
   * Dedup candidate pool for one user (task 029): the minimal projection
   * `dedup.ts`'s pure matcher needs (id, urlHash, title, company,
   * dedupGroupId), not full `JobPosting` aggregates with `descriptionMd`/
   * embeddings — ingestion runs this once per newly-fetched job, so it's
   * deliberately cheap. KNOWN LIMITATION: returns up to `limit` of the
   * user's most-recently-ingested postings, not an indexed
   * trigram/embedding similarity search — adequate for this milestone's
   * scale, revisit (real SQL similarity search, per design §2's "trigram on
   * title+company") before the per-user posting count gets large enough for
   * this to matter.
   */
  listDedupCandidatesForUser(userId: UserId, limit: number): Promise<DedupCandidate[]>;
  /**
   * Serializes the read-check-embed-write sequence for one job posting
   * (task 017 — closes the last read-then-write race in this class, after
   * 015/016 closed the same shape for budget spend). Optional so a
   * repository that doesn't support locking still satisfies the interface —
   * the use case just runs unlocked, same as before.
   */
  withJobPostingLock?<T>(jobPostingId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Task 036: the embedding prefilter (docs/06-agent-design.md §3 — "embedding
   * prefilter caps volume" before the LLM rubric-scoring pass, task 038).
   * Returns job postings ordered by ASCENDING cosine distance to `embedding`
   * (nearest/most-similar first), backed by the HNSW index (migration
   * 0004_ann_index.sql). Only postings that already have an embedding are
   * eligible — a NULL `embedding` column can never match an ANN query.
   * `excludeStatuses` lets callers skip e.g. `closed`/`expired` postings
   * without a separate filter pass.
   */
  findNearestByEmbedding(
    embedding: readonly number[],
    opts: { limit: number; excludeStatuses?: readonly string[] },
  ): Promise<JobPosting[]>;
}

// ── M4 (task 027): connector configuration + ingestion history ────────────

export type ConnectorHealth = 'healthy' | 'degraded' | 'disabled';

export interface ConnectorConfig {
  readonly id: string;
  readonly userId: UserId;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly scheduleCron: string | null;
  readonly config: Record<string, unknown>;
  /** Reference into the secrets store — never a raw credential value (security model §4). */
  readonly credentialsRef: string | null;
  readonly health: ConnectorHealth;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConnectorConfigRepository {
  findById(id: string): Promise<ConnectorConfig | null>;
  /** Ownership-scoped read for user-facing routes (task 032's PATCH /connectors/:id). */
  findByIdForUser(id: string, userId: UserId): Promise<ConnectorConfig | null>;
  /** Scheduler's hot path (task 029): every enabled config across every user, regardless of owner. */
  listEnabled(): Promise<ConnectorConfig[]>;
  listForUser(userId: UserId): Promise<ConnectorConfig[]>;
  save(config: ConnectorConfig): Promise<void>;
  /**
   * Atomic health-tracking update (task 032) — increments/resets
   * `consecutive_failures` and recomputes `health` in a SINGLE
   * read-modify-write against the database row, not a separate
   * findById-then-save pair. Two connector runs for the SAME connector can
   * genuinely complete concurrently (the scheduler processes multiple
   * connectors — or, rarely, overlapping runs of the same one — in
   * parallel); a naive findById/save pair racing on this counter is the
   * exact same lost-update class task 015/016 closed for budget spend, just
   * for a different counter. Returns the updated config, or null if the
   * config was deleted between the run finishing and this call.
   */
  recordRunOutcome(connectorConfigId: string, succeeded: boolean, now: Date): Promise<ConnectorConfig | null>;
}

export type IngestionStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface IngestionRunStats {
  readonly fetched: number;
  readonly deduped: number;
  readonly inserted: number;
}

export interface IngestionRun {
  readonly id: string;
  readonly connectorConfigId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly status: IngestionStatus;
  readonly stats: IngestionRunStats;
  readonly error: string | null;
}

/**
 * Append-only by API shape, not just convention: there is no `update`/`save`
 * — only `start` (insert a 'running' row) and `complete` (set that same
 * row's terminal fields exactly once). Same posture as `OutboxPort`/
 * `stage_transitions`.
 */
export interface IngestionRunRepository {
  start(connectorConfigId: string, startedAt: Date): Promise<IngestionRun>;
  complete(
    id: string,
    result: { status: 'ok' | 'partial' | 'failed'; stats: IngestionRunStats; error?: string | null; finishedAt: Date },
  ): Promise<void>;
  listRecentForConnector(connectorConfigId: string, limit: number): Promise<IngestionRun[]>;
}

export interface ApplicationRepository {
  findByIdForUser(id: ApplicationId, userId: UserId): Promise<Application | null>;
  /**
   * Task 053 — the worker's `apply.task_submitted` handler consumes an
   * outbox event whose payload carries only `applicationId` (no user), so
   * it has no ownership scope to check against — same shape/reasoning as
   * `JobPostingRepository.findByIdAnyOwner` (worker path only).
   */
  findByIdAnyOwner(id: ApplicationId): Promise<Application | null>;
  listForUser(userId: UserId): Promise<Application[]>;
  save(app: Application): Promise<void>;
}

/**
 * M7 (task 058, `add_application_note` MCP tool). Deliberately NOT modeled
 * as an `Application` aggregate method/event (unlike `transitionTo`) —
 * notes are an append-only, unordered-w.r.t.-stage annotation log with no
 * state-machine rules to enforce, so a plain insert-only table +
 * repository is the right weight; forcing it through the aggregate would
 * mean inventing a domain event with no consumer.
 */
export interface ApplicationNote {
  readonly id: string;
  readonly applicationId: string;
  readonly noteMd: string;
  readonly actor: 'user' | 'system' | 'agent';
  readonly createdAt: Date;
}
export interface ApplicationNoteRepository {
  add(note: { id: string; applicationId: string; noteMd: string; actor: 'user' | 'system' | 'agent' }): Promise<void>;
  listForApplication(applicationId: string): Promise<ApplicationNote[]>;
}

/**
 * M3 treats "career profile" as a per-user singleton in the API surface
 * (`GET/PUT /api/profile`, no profile id in the URL — task 022) even though
 * the schema allows multiple rows per user (design §2 `is_active` flag).
 * `findActiveForUser` is the lookup the singleton routes use;
 * `findByIdForUser` stays available for anything that already has an id
 * (e.g. a future multi-profile UI) without requiring a schema change.
 */
export interface ProfileRepository {
  findByIdForUser(id: CareerProfileId, userId: UserId): Promise<CareerProfile | null>;
  findActiveForUser(userId: UserId): Promise<CareerProfile | null>;
  save(profile: CareerProfile): Promise<void>;
}

export interface DocumentRepository {
  findByIdForUser(id: DocumentId, userId: UserId): Promise<Document | null>;
  /** Excludes soft-deleted documents unless `includeDeleted` is set. */
  listForUser(userId: UserId, opts?: { includeDeleted?: boolean }): Promise<Document[]>;
  save(document: Document): Promise<void>;
  /** Task 058 — `get_generation_status`'s polling lookup: the document (if any) that has a version stamped with this `generationJobId`, ownership-scoped. Returns null both when no such version exists yet (still generating) and when it belongs to another user (never distinguished — same "404, not 403" posture as every other ownership-scoped lookup in this codebase). */
  findByGenerationJobId(generationJobId: string, userId: UserId): Promise<Document | null>;
}

/**
 * Task 038. Unique on `(profile_id, job_posting_id)` — `save` is
 * upsert-on-recompute (a rescan REPLACES the row, it does not append a new
 * one). Deliberately simpler than `docs/02-database-design.md`'s original
 * `match_scores` sketch (unique on `(job_posting_id, profile_id, method)`,
 * append-many, "latest wins by created_at") — this milestone only ever
 * produces one scoring method (`rubric_llm` via the LLM pass), so a second
 * dimension purely to support a method this system doesn't yet compute
 * would be speculative complexity. Documented here as a deliberate,
 * scoped-down deviation from the design doc, not a silent drift.
 */
export interface MatchScoreRepository {
  findByProfileAndJob(profileId: CareerProfileId, jobPostingId: JobPostingId): Promise<MatchScore | null>;
  listForProfile(profileId: CareerProfileId, opts?: { limit?: number }): Promise<MatchScore[]>;
  save(score: MatchScore): Promise<void>;
}

/**
 * Task 045. `save` persists BOTH the current stage on `apply_tasks` AND
 * drains+appends `task.pullSteps()` to the append-only `apply_task_steps`
 * table, in one call — mirrors `ApplicationRepository`'s
 * save-drains-transitions posture. `findByIdForUser` is ownership-scoped
 * (security model §2, same as every other per-user aggregate here);
 * `findByIdAnyOwner` exists for the browser-runner's internal task API
 * (task 047) and worker handlers, which act on behalf of a task, not a
 * logged-in HTTP user.
 */
/** Task 052 — a persisted `apply_task_steps` row, read-side projection (append-only, never mutated — see migration 0007). */
export interface ApplyTaskStepRecord {
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly action: string | null;
  readonly redactedPayload: Record<string, unknown> | null;
  readonly screenshotKey: string | null;
  readonly createdAt: Date;
}

export interface ApplyTaskRepository {
  findByIdForUser(id: ApplyTaskId, userId: UserId): Promise<ApplyTask | null>;
  findByIdAnyOwner(id: ApplyTaskId): Promise<ApplyTask | null>;
  listForUser(userId: UserId, opts?: { stage?: string }): Promise<ApplyTask[]>;
  save(task: ApplyTask): Promise<void>;
  /** Task 052 — the review-diff read endpoint's data source: every recorded step, oldest first. */
  listSteps(id: ApplyTaskId): Promise<ApplyTaskStepRecord[]>;
}

/** Emitted by aggregates, drained by repositories, written to the outbox (ADR-007). */
export interface OutboxPort {
  enqueue(events: readonly { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[]): Promise<void>;
}

/**
 * Wraps a unit of work in one DB transaction. The aggregate write and its
 * outbox row land together or not at all — this is what makes ADR-007 true.
 */
export interface UnitOfWork {
  withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TransactionContext {
  readonly users: UserRepository;
  readonly jobPostings: JobPostingRepository;
  readonly applications: ApplicationRepository;
  readonly profiles: ProfileRepository;
  readonly documents: DocumentRepository;
  readonly outbox: OutboxPort;
  readonly audit: AuditPort;
}

export interface ClockPort {
  now(): Date;
}

export interface HasherPort {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}

export interface Actor {
  readonly userId: UserId;
}
