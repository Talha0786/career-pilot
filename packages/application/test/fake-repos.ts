import type {
  User, JobPosting, Application, CareerProfile, Document,
  UserId, JobPostingId, ApplicationId, CareerProfileId, DocumentId,
} from '@careerpilot/domain';
import type {
  UserRepository, JobPostingRepository, ApplicationRepository,
  ProfileRepository, DocumentRepository,
  OutboxPort, UnitOfWork, TransactionContext, HasherPort,
} from '../src/ports/repositories.js';
import type { AuditPort, AuditRecord } from '../src/ports/audit.port.js';

/**
 * In-memory fakes for pure application-layer unit tests (task 005 acceptance:
 * "all tests here use fake ports; zero infrastructure"). The REAL Postgres
 * versions are task 007 and are tested against a live database, not mocks.
 */
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

export class FakeJobPostingRepository implements JobPostingRepository {
  private byId = new Map<string, JobPosting>();

  async findByIdForUser(id: JobPostingId, userId: UserId): Promise<JobPosting | null> {
    const job = this.byId.get(id);
    return job && job.userId === userId ? job : null;
  }
  async findByIdAnyOwner(id: JobPostingId): Promise<JobPosting | null> {
    return this.byId.get(id) ?? null;
  }
  async listForUser(userId: UserId, opts: { cursor?: string; limit: number }) {
    const items = [...this.byId.values()].filter((j) => j.userId === userId).slice(0, opts.limit);
    return { items, nextCursor: null };
  }
  async save(job: JobPosting): Promise<void> {
    this.byId.set(job.id, job);
  }
}

export class FakeApplicationRepository implements ApplicationRepository {
  private byId = new Map<string, Application>();

  async findByIdForUser(id: ApplicationId, userId: UserId): Promise<Application | null> {
    const app = this.byId.get(id);
    return app && app.userId === userId ? app : null;
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
    return [...this.byId.values()].filter(
      (d) => d.userId === userId && (opts?.includeDeleted === true || !d.isDeleted),
    );
  }
  async save(document: Document): Promise<void> {
    this.byId.set(document.id, document);
  }
}

export class FakeAuditPort implements AuditPort {
  public records: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
  }
}

export class FakeOutboxPort implements OutboxPort {
  public enqueued: { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[] = [];
  async enqueue(events: readonly { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[]) {
    this.enqueued.push(...events);
  }
}

/** No real transaction, but same shape — good enough for application-layer unit tests. */
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
      users: this.users,
      jobPostings: this.jobPostings,
      applications: this.applications,
      profiles: this.profiles,
      documents: this.documents,
      outbox: this.outbox,
      audit: this.audit,
    });
  }
}

export class FakeHasher implements HasherPort {
  async hash(plaintext: string): Promise<string> {
    return `$argon2id$fake$${plaintext.length}$${plaintext}`;
  }
  async verify(hash: string, plaintext: string): Promise<boolean> {
    return hash === `$argon2id$fake$${plaintext.length}$${plaintext}`;
  }
}
