import type {
  JobPosting, Application, CareerProfile, Document, MatchScore, UserId, JobPostingId, ApplicationId, DocumentId,
} from '@careerpilot/domain';
import type {
  JobPostingRepository, ApplicationRepository, ProfileRepository, DocumentRepository, MatchScoreRepository,
  DedupCandidate, McpTokenStore, McpTokenRecord, McpTokenVerification, McpScope,
  InterviewPrepRepository, InterviewPrepRecord, InterviewPrepKind,
} from '@careerpilot/application';
import type { AuditPort, AuditRecord } from '@careerpilot/application';

/**
 * Local fakes for `apps/mcp-server` unit tests. NOT imported from
 * `packages/application/test/fake-repos.ts` — that file lives inside
 * `packages/application`'s own `test/` directory, which isn't part of the
 * package's public API surface (`src/index.ts`); reaching into another
 * package's `test/` dir would be a relative cross-package import,
 * exactly what `import/no-relative-packages` (verified by
 * `scripts/verify-boundary-enforcement.mjs`) exists to catch. Same
 * "duplicate a small local fake rather than reach across the boundary"
 * precedent `packages/intelligence-evals/src/fake-infra.ts` already set.
 */

export class FakeJobPostingRepository implements JobPostingRepository {
  private byId = new Map<string, JobPosting>();

  async findByIdForUser(id: JobPostingId, userId: UserId): Promise<JobPosting | null> {
    const job = this.byId.get(id);
    return job && job.userId === userId ? job : null;
  }
  async findByIdAnyOwner(id: JobPostingId): Promise<JobPosting | null> {
    return this.byId.get(id) ?? null;
  }
  async findBySourceAndExternalId(): Promise<JobPosting | null> {
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
  async findNearestByEmbedding(): Promise<JobPosting[]> {
    return [];
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

  async findByIdForUser(id: string, userId: UserId): Promise<CareerProfile | null> {
    const p = this.byId.get(id);
    return p && p.userId === userId ? p : null;
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
  async findByGenerationJobId(generationJobId: string, userId: UserId): Promise<Document | null> {
    for (const doc of this.byId.values()) {
      if (doc.userId !== userId) continue;
      if (doc.versions.some((v) => v.generationJobId === generationJobId)) return doc;
    }
    return null;
  }
}

export class FakeMatchScoreRepository implements MatchScoreRepository {
  private byKey = new Map<string, MatchScore>();
  private key(profileId: string, jobPostingId: string): string {
    return `${profileId}::${jobPostingId}`;
  }
  async findByProfileAndJob(profileId: string, jobPostingId: string): Promise<MatchScore | null> {
    return this.byKey.get(this.key(profileId, jobPostingId)) ?? null;
  }
  async listForProfile(profileId: string, opts?: { limit?: number }): Promise<MatchScore[]> {
    const all = [...this.byKey.values()].filter((s) => s.profileId === profileId);
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }
  async save(score: MatchScore): Promise<void> {
    this.byKey.set(this.key(score.profileId, score.jobPostingId), score);
  }
}

export class FakeInterviewPrepRepository implements InterviewPrepRepository {
  private byId = new Map<string, InterviewPrepRecord>();
  async save(record: { id: string; applicationId: string; kind: InterviewPrepKind; content: unknown }): Promise<InterviewPrepRecord> {
    const now = new Date();
    const created = this.byId.get(record.id)?.createdAt ?? now;
    const saved: InterviewPrepRecord = { ...record, createdAt: created, updatedAt: now };
    this.byId.set(record.id, saved);
    return saved;
  }
  async findById(id: string): Promise<InterviewPrepRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async listForApplication(applicationId: string, kind?: InterviewPrepKind): Promise<InterviewPrepRecord[]> {
    return [...this.byId.values()].filter((r) => r.applicationId === applicationId && (kind === undefined || r.kind === kind));
  }
}

/** Functional in-memory bearer-token store — mirrors `McpTokenAdapter`'s CONTRACT (mint/verify/revoke/list), not its SHA-256/Postgres implementation. */
export class FakeMcpTokenStore implements McpTokenStore {
  private byToken = new Map<string, McpTokenRecord>();
  private nextId = 1;

  async mint(userId: string, label: string, scopes: readonly McpScope[]): Promise<{ id: string; token: string }> {
    const id = `token-${this.nextId++}`;
    const token = `fake-token-${id}`;
    this.byToken.set(token, { id, userId, label, scopes, createdAt: new Date(), lastUsedAt: null, revokedAt: null });
    return { id, token };
  }
  async revoke(id: string, userId: string): Promise<boolean> {
    for (const [token, record] of this.byToken) {
      if (record.id === id && record.userId === userId && record.revokedAt === null) {
        this.byToken.set(token, { ...record, revokedAt: new Date() });
        return true;
      }
    }
    return false;
  }
  async list(userId: string): Promise<McpTokenRecord[]> {
    return [...this.byToken.values()].filter((r) => r.userId === userId);
  }
  async verify(token: string): Promise<McpTokenVerification | null> {
    const record = this.byToken.get(token);
    if (!record || record.revokedAt !== null) return null;
    return { tokenId: record.id, userId: record.userId, scopes: record.scopes };
  }
}

export class FakeAuditPort implements AuditPort {
  public records: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.records.push(entry);
  }
}

/**
 * A type-satisfying stub for any port this test doesn't exercise.
 * Throws loudly if a method is actually CALLED — which must never happen
 * during tool/resource/prompt REGISTRATION (every `make*Tool`/`make*
 * UseCase` factory in this codebase closures over its deps without
 * touching them until a handler actually runs, task 056's composition-
 * root pattern). If this throws during a "catalog exactness" test, that
 * itself is a finding: registration stopped being side-effect-free.
 */
export function stub<T extends object>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`unimplemented stub method "${name}.${String(prop)}" was called — registration should be side-effect-free`);
        };
      },
    },
  ) as T;
}
