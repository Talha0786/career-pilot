/**
 * Minimal in-memory Port implementations so the eval harness can invoke the
 * REAL application-layer use cases (`makeScoreMatchUseCase`,
 * `makeTailorDocumentUseCase`, `makeVerifyClaimsUseCase` — unmodified
 * production code, task 038/039/040) without needing a live Postgres —
 * same Ports & Adapters seam every other layer of this codebase already
 * uses, just swapped for in-memory adapters here instead of Drizzle ones.
 * Deliberately NOT imported from `packages/application/test/fake-repos.ts`
 * (a test-only file, not part of that package's public surface / build
 * output) — this is a small, independent, eval-scoped reimplementation.
 */
import {
  type User, type JobPosting, type Application, type CareerProfile, type Document,
  type UserId, type JobPostingId, type ApplicationId, type CareerProfileId, type DocumentId,
} from '@careerpilot/domain';
import type {
  UserRepository, JobPostingRepository, ApplicationRepository, ProfileRepository, DocumentRepository,
  MatchScoreRepository, OutboxPort, UnitOfWork, TransactionContext, DedupCandidate,
} from '@careerpilot/application';
import type { MatchScore } from '@careerpilot/domain';
import type { AuditPort, AuditRecord, AiInvocationRecord } from '@careerpilot/application';

export class FakeUserRepository implements UserRepository {
  private byId = new Map<string, User>();
  async findByEmail(email: string): Promise<User | null> {
    for (const u of this.byId.values()) if (u.email.value === email) return u;
    return null;
  }
  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }
  async save(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class FakeJobPostingRepository implements JobPostingRepository {
  private byId = new Map<string, JobPosting>();
  async findByIdForUser(id: JobPostingId, userId: UserId): Promise<JobPosting | null> {
    const job = this.byId.get(id);
    return job && job.userId === userId ? job : null;
  }
  async findByIdAnyOwner(id: JobPostingId): Promise<JobPosting | null> {
    return this.byId.get(id) ?? null;
  }
  async findBySourceAndExternalId(sourceConnectorKey: string, externalId: string): Promise<JobPosting | null> {
    for (const job of this.byId.values()) {
      if (job.sourceConnectorKey === sourceConnectorKey && job.externalId === externalId) return job;
    }
    return null;
  }
  async listDedupCandidatesForUser(userId: UserId, limit: number): Promise<DedupCandidate[]> {
    return [...this.byId.values()]
      .filter((j) => j.userId === userId)
      .slice(0, limit)
      .map((j) => ({ id: j.id, urlHash: j.urlHash, title: j.title, company: j.company, dedupGroupId: j.dedupGroupId }));
  }
  async listForUser(userId: UserId, opts: { cursor?: string; limit: number }) {
    const items = [...this.byId.values()].filter((j) => j.userId === userId).slice(0, opts.limit);
    return { items, nextCursor: null };
  }
  async save(job: JobPosting): Promise<void> {
    this.byId.set(job.id, job);
  }
  async findNearestByEmbedding(
    embedding: readonly number[],
    opts: { limit: number; excludeStatuses?: readonly string[] },
  ): Promise<JobPosting[]> {
    const excluded = new Set(opts.excludeStatuses ?? []);
    return [...this.byId.values()]
      .filter((j) => j.embedding !== null && !excluded.has(j.status))
      .map((j) => ({ job: j, distance: cosineDistance(embedding, j.embedding!) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, opts.limit)
      .map((r) => r.job);
  }
}

export class FakeApplicationRepository implements ApplicationRepository {
  private byId = new Map<string, Application>();
  async findByIdForUser(id: ApplicationId, userId: UserId): Promise<Application | null> {
    const app = this.byId.get(id);
    return app && app.userId === userId ? app : null;
  }
  async findByIdAnyOwner(id: ApplicationId): Promise<Application | null> {
    return this.byId.get(id) ?? null;
  }
  async listForUser(userId: UserId): Promise<Application[]> {
    return [...this.byId.values()].filter((a) => a.userId === userId);
  }
  async save(app: Application): Promise<void> {
    this.byId.set(app.id, app);
  }
}

export class FakeProfileRepository implements ProfileRepository {
  private byId = new Map<string, CareerProfile>();
  async findByIdForUser(id: CareerProfileId, userId: UserId): Promise<CareerProfile | null> {
    const profile = this.byId.get(id);
    return profile && profile.userId === userId ? profile : null;
  }
  async findActiveForUser(userId: UserId): Promise<CareerProfile | null> {
    for (const p of this.byId.values()) if (p.userId === userId && p.isActive) return p;
    return null;
  }
  async save(profile: CareerProfile): Promise<void> {
    this.byId.set(profile.id, profile);
  }
}

export class FakeDocumentRepository implements DocumentRepository {
  private byId = new Map<string, Document>();
  async findByIdForUser(id: DocumentId, userId: UserId): Promise<Document | null> {
    const doc = this.byId.get(id);
    return doc && doc.userId === userId ? doc : null;
  }
  async listForUser(userId: UserId, opts?: { includeDeleted?: boolean }): Promise<Document[]> {
    return [...this.byId.values()].filter((d) => d.userId === userId && (opts?.includeDeleted === true || !d.isDeleted));
  }
  async save(document: Document): Promise<void> {
    this.byId.set(document.id, document);
  }
}

export class FakeMatchScoreRepository implements MatchScoreRepository {
  private byKey = new Map<string, MatchScore>();
  private key(profileId: string, jobPostingId: string): string {
    return `${profileId}::${jobPostingId}`;
  }
  async findByProfileAndJob(profileId: CareerProfileId, jobPostingId: JobPostingId): Promise<MatchScore | null> {
    return this.byKey.get(this.key(profileId, jobPostingId)) ?? null;
  }
  async listForProfile(profileId: CareerProfileId, opts?: { limit?: number }): Promise<MatchScore[]> {
    const all = [...this.byKey.values()].filter((s) => s.profileId === profileId);
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }
  async save(score: MatchScore): Promise<void> {
    this.byKey.set(this.key(score.profileId, score.jobPostingId), score);
  }
}

export class FakeOutboxPort implements OutboxPort {
  public enqueued: { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[] = [];
  async enqueue(events: readonly { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[]) {
    this.enqueued.push(...events);
  }
}

export class FakeAuditPort implements AuditPort {
  public records: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
  }
}

/** No real transaction — same in-memory shape as `packages/application/test/fake-repos.ts`'s FakeUnitOfWork, good enough for a single-process eval run. */
export class FakeUnitOfWork implements UnitOfWork {
  constructor(
    public users: FakeUserRepository = new FakeUserRepository(),
    public jobPostings: FakeJobPostingRepository = new FakeJobPostingRepository(),
    public applications: FakeApplicationRepository = new FakeApplicationRepository(),
    public outbox: FakeOutboxPort = new FakeOutboxPort(),
    public profiles: FakeProfileRepository = new FakeProfileRepository(),
    public documents: FakeDocumentRepository = new FakeDocumentRepository(),
    public audit: FakeAuditPort = new FakeAuditPort(),
  ) {}

  async withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      users: this.users, jobPostings: this.jobPostings, applications: this.applications,
      profiles: this.profiles, documents: this.documents, outbox: this.outbox, audit: this.audit,
    });
  }
}

/**
 * In-memory month-to-date spend tracker — implements `BudgetStore` (the same
 * port `PostgresBudgetStore` implements for production), no lock needed for
 * a single-process, non-concurrent eval run (task 043 already proves the
 * concurrent-lock path against real Postgres; this harness runs fixtures
 * strictly sequentially, see `run-matching-eval.ts`/`run-tailoring-eval.ts`).
 * Constructed with a high budget so real eval traffic is never rejected —
 * this harness is measuring output quality, not re-proving the budget gate.
 */
export class InMemoryBudgetStore {
  private spend = new Map<string, number>();
  public invocations: AiInvocationRecord[] = [];
  async getMonthlySpend(userId: string): Promise<number> {
    return this.spend.get(userId) ?? 0;
  }
  async recordInvocation(record: AiInvocationRecord): Promise<void> {
    this.spend.set(record.userId, (this.spend.get(record.userId) ?? 0) + record.costUsd);
    this.invocations.push(record);
  }
}
