import { ok, type Result } from '@careerpilot/domain';
import type { LlmPort, EmbedRequest, EmbedResponse, LlmError } from '../src/ports/llm.port.js';
import type { BudgetStore, CostEstimator } from '../src/ports/budget-guard.js';
import type { AiInvocationRecord } from '../src/ports/llm.port.js';

/** Deterministic fake — no network, ever. The default in all unit tests. */
export class FakeLlmPort implements LlmPort {
  public callCount = 0;
  public lastRequest: EmbedRequest | null = null;

  async embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>> {
    this.callCount += 1;
    this.lastRequest = req;
    // Deterministic 8-dim vector derived from input length — good enough to
    // assert "something was returned" without pretending to be a real model.
    const vector = Array.from({ length: 8 }, (_, i) => (req.input.length + i) / 100);
    return ok({ vector, model: req.model, promptTokens: Math.ceil(req.input.length / 4) });
  }
}

export class InMemoryBudgetStore implements BudgetStore {
  public records: AiInvocationRecord[] = [];
  private spend = new Map<string, number>();

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
}

export class FakeCostEstimator implements CostEstimator {
  estimateEmbedCostUsd(req: EmbedRequest): number {
    return req.input.length * 0.00001;
  }
  actualEmbedCostUsd(_model: string, promptTokens: number): number {
    return promptTokens * 0.00002;
  }
}
