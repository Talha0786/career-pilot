/**
 * Static per-model pricing table (task 033). Rates are USD per 1,000 tokens
 * (input/output completion tokens) or per 1,000 embedding tokens, mirroring
 * each provider's own published-rate granularity so the numbers here are
 * directly auditable against a pricing page rather than pre-divided into
 * some internal unit.
 *
 * Local/Ollama entries are priced at $0 — ADR-006's key-free default must
 * stay free in the budget guard's accounting, not just in reality.
 *
 * This table is intentionally small and hand-maintained (not fetched from a
 * live pricing API — that's out of scope and a needless runtime dependency
 * for a monthly-budget guard). Update it when a routed model's price changes
 * or a new model is added to config.
 */
export interface ModelPricing {
  readonly inputPer1kUsd: number;
  readonly outputPer1kUsd: number;
  readonly embedPer1kUsd: number;
}

export const PRICING_TABLE: Readonly<Record<string, ModelPricing>> = {
  // Local, key-free default (ADR-006) — always $0.
  'nomic-embed-text': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },
  'llama3.1': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },
  'llama3.1:8b': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },
  'llama3.1:70b': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },
  qwen2: { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },
  mistral: { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0 },

  // OpenAI (BYO key, published rates as of ADR-006's writing — update on drift).
  'gpt-4o': { inputPer1kUsd: 0.0025, outputPer1kUsd: 0.01, embedPer1kUsd: 0 },
  'gpt-4o-mini': { inputPer1kUsd: 0.00015, outputPer1kUsd: 0.0006, embedPer1kUsd: 0 },
  'text-embedding-3-small': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0.00002 },
  'text-embedding-3-large': { inputPer1kUsd: 0, outputPer1kUsd: 0, embedPer1kUsd: 0.00013 },

  // Anthropic (BYO key).
  'claude-3-5-sonnet': { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015, embedPer1kUsd: 0 },
  'claude-3-5-haiku': { inputPer1kUsd: 0.0008, outputPer1kUsd: 0.004, embedPer1kUsd: 0 },
} as const;

/**
 * Conservative non-zero fallback for a model id the table doesn't know
 * about. Deliberately priced at the higher end of the known table (roughly
 * `gpt-4o`'s rate) rather than $0 or the cheapest known rate: an unpriced
 * model must never look artificially free to the budget guard — the
 * failure mode we're protecting against is silent overspend, so the
 * unknown-model default errs toward refusing dispatch too early, not too
 * late (task 033 acceptance criterion).
 */
export const FALLBACK_PRICING: ModelPricing = {
  inputPer1kUsd: 0.0025,
  outputPer1kUsd: 0.01,
  embedPer1kUsd: 0.0001,
};
