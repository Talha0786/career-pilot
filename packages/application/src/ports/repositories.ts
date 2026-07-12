import type { User, JobPosting, Application, UserId, JobPostingId, ApplicationId } from '@careerpilot/domain';

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
   * Serializes the read-check-embed-write sequence for one job posting
   * (task 017 — closes the last read-then-write race in this class, after
   * 015/016 closed the same shape for budget spend). Optional so a
   * repository that doesn't support locking still satisfies the interface —
   * the use case just runs unlocked, same as before.
   */
  withJobPostingLock?<T>(jobPostingId: string, fn: () => Promise<T>): Promise<T>;
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
  listForUser(userId: UserId): Promise<Application[]>;
  save(app: Application): Promise<void>;
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
  readonly outbox: OutboxPort;
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
