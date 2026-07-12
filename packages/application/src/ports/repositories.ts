import type {
  User, JobPosting, Application, CareerProfile, Document,
  UserId, JobPostingId, ApplicationId, CareerProfileId, DocumentId,
} from '@careerpilot/domain';
import type { AuditPort } from './audit.port.js';

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
   * Serializes the read-check-embed-write sequence for one job posting
   * (task 017 — closes the last read-then-write race in this class, after
   * 015/016 closed the same shape for budget spend). Optional so a
   * repository that doesn't support locking still satisfies the interface —
   * the use case just runs unlocked, same as before.
   */
  withJobPostingLock?<T>(jobPostingId: string, fn: () => Promise<T>): Promise<T>;
}

export interface ApplicationRepository {
  findByIdForUser(id: ApplicationId, userId: UserId): Promise<Application | null>;
  listForUser(userId: UserId): Promise<Application[]>;
  save(app: Application): Promise<void>;
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
