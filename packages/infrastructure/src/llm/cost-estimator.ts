import type { CostEstimator, EmbedRequest, CompleteRequest } from '@careerpilot/application';
import { PRICING_TABLE, FALLBACK_PRICING, type ModelPricing } from './pricing-table.js';

/** Minimal logging shape — matches the subset of pino's API every caller already has. */
export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

const consoleWarnLogger: WarnLogger = {
  warn: (obj, msg) => console.warn(msg ?? 'cost-estimator warning', obj),
};

/**
 * Real per-model CostEstimator (task 033), replacing the M2 stub in
 * `apps/worker/src/main.ts` (ADR-006: "real per-provider pricing tables are
 * an M5 concern"). Estimates are token/char-count-proportional and keyed by
 * the request's model id via `pricing-table.ts`.
 *
 * Token counting: the real adapters (`OpenAiCompatibleLlmAdapter`) return
 * actual token counts post-call, which is what `actual*CostUsd` uses. The
 * PRE-call estimate has no token count yet — same coarse `chars / 4`
 * approximation the M2 stub used (a reasonable heuristic for English text
 * across common tokenizers), just now multiplied by a real per-model rate
 * instead of one hardcoded constant.
 */
export class TieredCostEstimator implements CostEstimator {
  constructor(
    private readonly pricingTable: Readonly<Record<string, ModelPricing>> = PRICING_TABLE,
    private readonly logger: WarnLogger = consoleWarnLogger,
  ) {}

  private rateFor(model: string): ModelPricing {
    const pricing = this.pricingTable[model];
    if (pricing) return pricing;
    // Unknown model: never throw (an unpriced model must never crash a
    // request) and never silently treat it as free (task 033 acceptance
    // criterion) — log once per call and fall back to a conservative,
    // non-zero rate.
    this.logger.warn(
      { model },
      `TieredCostEstimator: no pricing entry for model "${model}" — using conservative fallback rate`,
    );
    return FALLBACK_PRICING;
  }

  private static estimateTokens(text: string): number {
    if (text.length === 0) return 0;
    // ~4 chars/token, same heuristic as the M2 stub — rounded up so a
    // nonzero-but-short input never estimates to a free $0 call.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  estimateEmbedCostUsd(req: EmbedRequest): number {
    if (req.input.length === 0) return 0;
    const rate = this.rateFor(req.model);
    const tokens = TieredCostEstimator.estimateTokens(req.input);
    return (tokens / 1000) * rate.embedPer1kUsd;
  }

  actualEmbedCostUsd(model: string, promptTokens: number): number {
    if (promptTokens <= 0) return 0;
    const rate = this.rateFor(model);
    return (promptTokens / 1000) * rate.embedPer1kUsd;
  }

  estimateCompleteCostUsd(req: CompleteRequest): number {
    const promptChars = (req.system?.length ?? 0) + req.prompt.length;
    if (promptChars === 0) return 0;
    const rate = this.rateFor(req.model);
    const promptTokens = TieredCostEstimator.estimateTokens(
      (req.system ?? '') + req.prompt,
    );
    // Pre-call: we don't know completion length yet. `maxTokens` (when the
    // caller set one) is the honest upper bound to estimate against — a
    // guard that under-estimates completion cost before dispatch defeats
    // the whole point of a pre-check. Default to a conservative assumption
    // that completion length roughly matches prompt length when no cap is
    // given (better to over-estimate and occasionally refuse early than to
    // under-estimate and blow the budget).
    const estimatedCompletionTokens = req.maxTokens ?? promptTokens;
    return (
      (promptTokens / 1000) * rate.inputPer1kUsd +
      (estimatedCompletionTokens / 1000) * rate.outputPer1kUsd
    );
  }

  actualCompleteCostUsd(model: string, promptTokens: number, completionTokens: number): number {
    if (promptTokens <= 0 && completionTokens <= 0) return 0;
    const rate = this.rateFor(model);
    return (
      (Math.max(promptTokens, 0) / 1000) * rate.inputPer1kUsd +
      (Math.max(completionTokens, 0) / 1000) * rate.outputPer1kUsd
    );
  }
}
