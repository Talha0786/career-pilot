import type { Result, DomainError, User, JobPosting, Application, UserId, JobPostingId, ApplicationId } from '@careerpilot/domain';

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
