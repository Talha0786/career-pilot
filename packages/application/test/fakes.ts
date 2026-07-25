import { ok, err, type Result, type DocumentContent, type DomainError } from '@careerpilot/domain';
import type {
  LlmPort, EmbedRequest, EmbedResponse, CompleteRequest, CompleteResponse, LlmError,
} from '../src/ports/llm.port.js';
import type { BudgetStore, CostEstimator } from '../src/ports/budget-guard.js';
import type { AiInvocationRecord } from '../src/ports/llm.port.js';
import type { DocumentRendererPort, RenderFormat, RenderTemplate } from '../src/ports/document-renderer.port.js';
import type { ObjectStoragePort } from '../src/ports/object-storage.port.js';
import { PromptRenderError, type PromptStore, type PromptTemplate, type PromptError } from '../src/ports/prompt-store.port.js';
import type { InterviewPrepRepository, InterviewPrepRecord, InterviewPrepKind } from '../src/ports/interview-prep.port.js';
import type { WebSearchPort, WebSearchResult, WebFetchPort, WebFetchResult } from '../src/ports/research.port.js';
import type { ApplicationNoteRepository, ApplicationNote } from '../src/ports/repositories.js';
import type { ApplyTaskPort, PrepareApplicationResult } from '../src/ports/apply-task.port.js';
import type { ApprovalTokenPort, ApprovalTokenConsumeError } from '../src/ports/approval-token.port.js';

/** Deterministic fake — no network, ever. The default in all unit tests. */
export class FakeLlmPort implements LlmPort {
  public callCount = 0;
  public lastRequest: EmbedRequest | null = null;
  public completeCallCount = 0;
  public lastCompleteRequest: CompleteRequest | null = null;
  /** Tests set this to control what `complete` returns. */
  public completeResponseText = '{}';

  async embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>> {
    this.callCount += 1;
    this.lastRequest = req;
    // Deterministic 8-dim vector derived from input length — good enough to
    // assert "something was returned" without pretending to be a real model.
    const vector = Array.from({ length: 8 }, (_, i) => (req.input.length + i) / 100);
    return ok({ vector, model: req.model, promptTokens: Math.ceil(req.input.length / 4) });
  }

  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.completeCallCount += 1;
    this.lastCompleteRequest = req;
    return ok({
      text: this.completeResponseText,
      model: req.model,
      promptTokens: Math.ceil(req.prompt.length / 4),
      completionTokens: Math.ceil(this.completeResponseText.length / 4),
    });
  }
}

export class InMemoryBudgetStore implements BudgetStore {
  public records: AiInvocationRecord[] = [];
  private spend = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();

  setSpend(userId: string, amountUsd: number): void {
    this.spend.set(userId, amountUsd);
  }

  async getMonthlySpend(userId: string): Promise<number> {
    return this.spend.get(userId) ?? 0;
  }

  async recordInvocation(record: AiInvocationRecord): Promise<void> {
    this.records.push(record);
    this.spend.set(record.userId, (this.spend.get(record.userId) ?? 0) + record.costUsd);
  }

  /**
   * Single-flight per user id — the in-memory equivalent of
   * PostgresBudgetStore's pg_advisory_xact_lock (task 016). Chains onto
   * whatever's currently pending for this user so calls for the SAME user
   * run strictly one at a time; different users never block each other.
   */
  async withUserBudgetLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    // `prior` is always a settle-quietly promise (see the .catch below), so
    // chaining with a single onFulfilled handler is enough — it never rejects.
    const prior = this.locks.get(userId) ?? Promise.resolve();
    const run = prior.then(() => fn());
    this.locks.set(userId, run.catch(() => undefined));
    return run;
  }
}

export class FakeDocumentRenderer implements DocumentRendererPort {
  public calls: { content: DocumentContent; format: RenderFormat; template: RenderTemplate }[] = [];
  async render(content: DocumentContent, format: RenderFormat, template: RenderTemplate): Promise<Buffer> {
    this.calls.push({ content, format, template });
    return Buffer.from(`fake-${format}-${template}-rendering`);
  }
}

export class InMemoryObjectStorage implements ObjectStoragePort {
  private files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> {
    this.files.set(key, bytes);
  }
  async get(key: string): Promise<Buffer | null> {
    return this.files.get(key) ?? null;
  }
}

/**
 * In-memory `PromptStore` for application-layer unit tests — a canned
 * `{{placeholder}}` template registered per task, with the SAME
 * fail-loud-on-unfilled-placeholder behavior as `FilePromptStore` (task
 * 034), so a test using this fake still exercises the real render contract.
 */
export class FakePromptStore implements PromptStore {
  private templates = new Map<string, { body: string; frontmatter: PromptTemplate['frontmatter'] }>();

  register(task: string, body: string, frontmatter?: Partial<PromptTemplate['frontmatter']>): void {
    this.templates.set(task, {
      body,
      frontmatter: { modelTier: 'mid', temperature: 0.1, outputSchema: 'Unspecified', ...frontmatter },
    });
  }

  async load(task: string): Promise<Result<PromptTemplate, PromptError>> {
    const found = this.templates.get(task);
    if (!found) return err({ code: 'task_not_found', message: `no fake template registered for "${task}"` });

    return ok({
      task,
      version: 'v1',
      frontmatter: found.frontmatter,
      render: (vars) => {
        const placeholders = [...found.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
        for (const key of placeholders) {
          if (!(key in vars)) throw new PromptRenderError(`Missing value for placeholder "{{${key}}}"`);
        }
        return found.body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_w, key: string) => vars[key]!);
      },
    });
  }
}

/** M7 (task 060/061) — in-memory `interview_preps` table, upsert-by-id, same semantics as `DrizzleInterviewPrepRepository`. */
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
    return [...this.byId.values()]
      .filter((r) => r.applicationId === applicationId && (kind === undefined || r.kind === kind))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

/** M7 (task 060) — a scripted search tool: tests control results per-query via `queueResults`, defaulting to empty. */
export class FakeWebSearchPort implements WebSearchPort {
  public calls: string[] = [];
  private queue: WebSearchResult[][] = [];

  queueResults(...results: WebSearchResult[][]): void {
    this.queue.push(...results);
  }
  async search(query: string): Promise<WebSearchResult[]> {
    this.calls.push(query);
    return this.queue.shift() ?? [];
  }
}

/** M7 (task 060) — a scripted fetch tool. */
export class FakeWebFetchPort implements WebFetchPort {
  public calls: string[] = [];
  private queue: WebFetchResult[] = [];

  queueResults(...results: WebFetchResult[]): void {
    this.queue.push(...results);
  }
  async fetch(url: string): Promise<WebFetchResult> {
    this.calls.push(url);
    return this.queue.shift() ?? { url, title: null, text: '' };
  }
}

export class FakeApplicationNoteRepository implements ApplicationNoteRepository {
  public added: { id: string; applicationId: string; noteMd: string; actor: 'user' | 'system' | 'agent' }[] = [];
  async add(note: { id: string; applicationId: string; noteMd: string; actor: 'user' | 'system' | 'agent' }): Promise<void> {
    this.added.push(note);
  }
  async listForApplication(applicationId: string): Promise<ApplicationNote[]> {
    return this.added.filter((n) => n.applicationId === applicationId).map((n) => ({ ...n, createdAt: new Date() }));
  }
}

/**
 * M7 (task 058) — a CONTROLLABLE fake for the adversarial
 * "prepare_application can never reach past awaiting_review" test. Tracks
 * every call it receives; always returns `awaiting_review` regardless of
 * what's passed in, since (by the port's own type signature) there is no
 * parameter that could ask for anything else — this fake exists to prove
 * the CALLER (prepare-application.ts) never attempts to pass one, not to
 * simulate a buggy backend.
 */
export class FakeApplyTaskPort implements ApplyTaskPort {
  public calls: { applicationId: string; userId: string }[] = [];
  async startAndMapToReview(input: { applicationId: string; userId: string }): Promise<Result<PrepareApplicationResult, DomainError>> {
    this.calls.push(input);
    return ok({ applyTaskId: `applytask-${this.calls.length}`, state: 'awaiting_review' });
  }
}

/**
 * Task 046 — in-memory fake mirroring `RedisApprovalTokenAdapter`'s
 * exactly-once contract (tombstone on consume, not delete, so
 * `already_consumed` vs `expired` vs `invalid` stay distinguishable). Used
 * by task 046's own unit tests and by task 053's submit-path unit tests
 * (the property test that no code path reaches `submitting` without a
 * consumed token doesn't need REAL Redis to prove the CALLER discipline —
 * only task 046's own integration test needs real Redis, to prove the
 * concurrency primitive itself).
 */
export class InMemoryApprovalTokenAdapter implements ApprovalTokenPort {
  private tokens = new Map<string, { applyTaskId: string; expiresAtMs: number; status: 'active' | 'consumed' }>();
  private seq = 0;
  public now: () => number = () => Date.now();

  async mint(applyTaskId: string): Promise<{ token: string; expiresAt: Date }> {
    this.seq += 1;
    const token = `fake-token-${this.seq}`;
    const expiresAtMs = this.now() + 5 * 60 * 1000;
    this.tokens.set(token, { applyTaskId, expiresAtMs, status: 'active' });
    return { token, expiresAt: new Date(expiresAtMs) };
  }

  async consume(token: string): Promise<Result<string, ApprovalTokenConsumeError>> {
    const entry = this.tokens.get(token);
    if (!entry) return err('invalid');
    if (entry.status === 'consumed') return err('already_consumed');
    if (this.now() > entry.expiresAtMs) return err('expired');
    entry.status = 'consumed';
    return ok(entry.applyTaskId);
  }
}

export class FakeCostEstimator implements CostEstimator {
  estimateEmbedCostUsd(req: EmbedRequest): number {
    return req.input.length * 0.00001;
  }
  actualEmbedCostUsd(_model: string, promptTokens: number): number {
    return promptTokens * 0.00002;
  }
  estimateCompleteCostUsd(req: CompleteRequest): number {
    return req.prompt.length * 0.00001;
  }
  actualCompleteCostUsd(_model: string, promptTokens: number, completionTokens: number): number {
    return (promptTokens + completionTokens) * 0.00002;
  }
}
