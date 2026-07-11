import type { LlmPort, EmbedRequest, EmbedResponse, LlmError, AiInvocationRecord } from './llm.port.js';
import type { Result } from '@careerpilot/domain';
import { ok, err, budgetExceeded, type DomainError } from '@careerpilot/domain';

/**
 * Wraps ANY LlmPort so every call is budget-checked before dispatch and
 * recorded after — success or failure. This is the ONLY way the application
 * layer is allowed to reach an LlmPort; the raw port is never exported from
 * the infrastructure barrel (task 009 acceptance criteria).
 */
export interface BudgetStore {
  /** Current month-to-date spend in USD for this user. */
  getMonthlySpend(userId: string): Promise<number>;
  recordInvocation(record: AiInvocationRecord): Promise<void>;
}

export interface CostEstimator {
  /** Estimate cost BEFORE the call, so we can refuse before any network I/O. */
  estimateEmbedCostUsd(req: EmbedRequest): number;
  /** Actual cost after the call, from real token counts. */
  actualEmbedCostUsd(model: string, promptTokens: number): number;
}

export class GuardedLlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly store: BudgetStore,
    private readonly estimator: CostEstimator,
    private readonly monthlyBudgetUsd: number,
    private readonly provider: string,
    private readonly clock: () => number = Date.now,
  ) {}

  async embed(
    req: EmbedRequest,
    ctx: { userId: string; refId: string; context: AiInvocationRecord['context'] },
  ): Promise<Result<EmbedResponse, LlmError | DomainError>> {
    const estimatedCost = this.estimator.estimateEmbedCostUsd(req);
    const spent = await this.store.getMonthlySpend(ctx.userId);

    if (spent + estimatedCost > this.monthlyBudgetUsd) {
      // Refused BEFORE any network call — the inner port is never touched.
      return err(
        budgetExceeded(
          `Monthly LLM budget of $${this.monthlyBudgetUsd.toFixed(2)} would be exceeded`,
          { spentUsd: spent.toFixed(4), estimatedUsd: estimatedCost.toFixed(4) },
        ),
      );
    }

    const start = this.clock();
    const result = await this.inner.embed(req);
    const latencyMs = this.clock() - start;

    if (result.ok) {
      await this.store.recordInvocation({
        userId: ctx.userId,
        context: ctx.context,
        refId: ctx.refId,
        provider: this.provider,
        model: result.value.model,
        promptTokens: result.value.promptTokens,
        completionTokens: 0,
        costUsd: this.estimator.actualEmbedCostUsd(result.value.model, result.value.promptTokens),
        latencyMs,
        status: 'ok',
        error: null,
      });
      return result;
    }

    // Failures are recorded too — cost accounting must reflect reality,
    // and a string of failures is itself a signal worth having in the data.
    await this.store.recordInvocation({
      userId: ctx.userId,
      context: ctx.context,
      refId: ctx.refId,
      provider: this.provider,
      model: req.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs,
      status: 'error',
      error: result.error.message,
    });
    return result;
  }
}
