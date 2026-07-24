/**
 * The exact model identifiers the M5 intelligence evals (matching/tailoring)
 * are pinned to. "Pinned" here means: this is the one model version the
 * quality gates in this package are calibrated against — same posture as
 * pinning a dependency version, just for a model instead of an npm package.
 * Bumping a pin is a deliberate, reviewed change (re-run the evals, look at
 * whether the trap-prompt/0-unsupported-claims gate and the matching
 * correlation number move), not something that happens silently because
 * Ollama's `latest` tag moved.
 *
 * Matches `apps/worker/src/main.ts`'s own defaults exactly
 * (`LLM_MATCH_MODEL`/`LLM_TAILOR_MODEL` both default to `llama3.1`,
 * `LLM_EMBEDDING_MODEL` defaults to `nomic-embed-text`) — this package
 * evaluates the SAME models production boots with key-free (ADR-006), not a
 * different "eval-only" model that could pass while production quality
 * regresses unnoticed. Overridable via env vars for a BYO-cloud-key eval
 * run against a stronger model (ADR-006's "quality-critical tasks" path).
 */
export const PINNED_CHAT_MODEL = process.env.EVAL_CHAT_MODEL ?? 'llama3.1';
export const PINNED_EMBEDDING_MODEL = process.env.EVAL_EMBEDDING_MODEL ?? 'nomic-embed-text';

/** OpenAI-compatible base URL — same shape `OpenAiCompatibleLlmAdapter` (ADR-006) expects, default points at a local, key-free Ollama. */
export const LLM_BASE_URL = process.env.EVAL_LLM_BASE_URL ?? process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
export const LLM_API_KEY = process.env.EVAL_LLM_API_KEY ?? process.env.LLM_API_KEY ?? null;

/**
 * A high per-run budget — this harness measures OUTPUT QUALITY (does the
 * matching score correlate with human judgment, does 0 unsupported claims
 * survive verification on a trap prompt), not the budget-hard-stop gate
 * (already proven for real, against real Postgres, by task 043). A low
 * budget here would just make eval runs flaky for a reason unrelated to
 * what this package is checking.
 */
export const EVAL_MONTHLY_BUDGET_USD = 1000;
