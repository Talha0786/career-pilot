import { ok, type Result, type DocumentContent } from '@careerpilot/domain';
import type {
  LlmPort, EmbedRequest, EmbedResponse, CompleteRequest, CompleteResponse, LlmError,
} from '../src/ports/llm.port.js';
import type { BudgetStore, CostEstimator } from '../src/ports/budget-guard.js';
import type { AiInvocationRecord } from '../src/ports/llm.port.js';
import type { DocumentRendererPort, RenderFormat, RenderTemplate } from '../src/ports/document-renderer.port.js';
import type { ObjectStoragePort } from '../src/ports/object-storage.port.js';

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
