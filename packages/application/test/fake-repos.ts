import type { User, JobPosting, Application, UserId, JobPostingId, ApplicationId } from '@careerpilot/domain';
import type {
  UserRepository, JobPostingRepository, ApplicationRepository,
  OutboxPort, UnitOfWork, TransactionContext, HasherPort, DedupCandidate,
  ConnectorConfigRepository, ConnectorConfig, IngestionRunRepository, IngestionRun, IngestionRunStats,
} from '../src/ports/repositories.js';
import { DEGRADED_AFTER_CONSECUTIVE_FAILURES, DISABLED_AFTER_CONSECUTIVE_FAILURES } from '../src/discovery/commands/update-connector-health.js';

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
  ) {}

  async withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      users: this.users,
      jobPostings: this.jobPostings,
      applications: this.applications,
      outbox: this.outbox,
    });
  }
}

export class FakeConnectorConfigRepository implements ConnectorConfigRepository {
  private byId = new Map<string, ConnectorConfig>();

  async findById(id: string): Promise<ConnectorConfig | null> {
    return this.byId.get(id) ?? null;
  }
  async findByIdForUser(id: string, userId: UserId): Promise<ConnectorConfig | null> {
    const c = this.byId.get(id);
    return c && c.userId === userId ? c : null;
  }
  async listEnabled(): Promise<ConnectorConfig[]> {
    return [...this.byId.values()].filter((c) => c.enabled);
  }
  async listForUser(userId: UserId): Promise<ConnectorConfig[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId);
  }
  async save(config: ConnectorConfig): Promise<void> {
    this.byId.set(config.id, config);
  }
  /**
   * In-memory equivalent of the real repository's atomic UPDATE (task 032):
   * no `await` between the `get` and the `set`, so nothing can interleave
   * between them — this is what makes it safe even if two calls for the
   * same id are kicked off "concurrently" via `Promise.all` in a test; the
   * synchronous JS section between them still runs to completion atomically.
   */
  async recordRunOutcome(connectorConfigId: string, succeeded: boolean, now: Date): Promise<ConnectorConfig | null> {
    const existing = this.byId.get(connectorConfigId);
    if (!existing) return null;
    const consecutiveFailures = succeeded ? 0 : existing.consecutiveFailures + 1;
    const health = succeeded
      ? 'healthy'
      : consecutiveFailures >= DISABLED_AFTER_CONSECUTIVE_FAILURES
        ? 'disabled'
        : consecutiveFailures >= DEGRADED_AFTER_CONSECUTIVE_FAILURES
          ? 'degraded'
          : 'healthy';
    const updated: ConnectorConfig = {
      ...existing,
      consecutiveFailures,
      health,
      lastSuccessAt: succeeded ? now : existing.lastSuccessAt,
      updatedAt: now,
    };
    this.byId.set(connectorConfigId, updated);
    return updated;
  }
}

export class FakeIngestionRunRepository implements IngestionRunRepository {
  private byId = new Map<string, IngestionRun>();
  private seq = 0;

  async start(connectorConfigId: string, startedAt: Date): Promise<IngestionRun> {
    const run: IngestionRun = {
      id: `run-${++this.seq}`,
      connectorConfigId,
      startedAt,
      finishedAt: null,
      status: 'running',
      stats: { fetched: 0, deduped: 0, inserted: 0 },
      error: null,
    };
    this.byId.set(run.id, run);
    return run;
  }
  async complete(
    id: string,
    result: { status: 'ok' | 'partial' | 'failed'; stats: IngestionRunStats; error?: string | null; finishedAt: Date },
  ): Promise<void> {
    const run = this.byId.get(id);
    if (!run) throw new Error(`no such ingestion run: ${id}`);
    this.byId.set(id, { ...run, status: result.status, stats: result.stats, error: result.error ?? null, finishedAt: result.finishedAt });
  }
  async listRecentForConnector(connectorConfigId: string, limit: number): Promise<IngestionRun[]> {
    return [...this.byId.values()]
      .filter((r) => r.connectorConfigId === connectorConfigId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
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
