import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAiCompatibleLlmAdapter, TieredCostEstimator, FilePromptStore } from '@careerpilot/infrastructure';
import { GuardedLlmPort } from '@careerpilot/application';
import { InMemoryBudgetStore } from './fake-infra.js';
import { PINNED_CHAT_MODEL, LLM_BASE_URL, LLM_API_KEY, EVAL_MONTHLY_BUDGET_USD } from './pinned-models.js';

// packages/intelligence-evals/src -> ../../../prompts is the repo root's
// prompts/ dir — same relative-from-this-file's-own-location resolution
// posture as apps/worker/src/main.ts's PROMPTS_DIR (never process.cwd()).
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');

/**
 * Wires the REAL production pipeline components (task 038/039/040's
 * unmodified use cases, the real `OpenAiCompatibleLlmAdapter` hitting a real
 * OpenAI-compatible endpoint, the real `TieredCostEstimator`, the real
 * `FilePromptStore` reading the actual `prompts/` tree) around an in-memory
 * `BudgetStore` (this package's own `fake-infra.ts` — see that file's doc
 * comment for why it's not `packages/application/test/fake-repos.ts`).
 *
 * DELIBERATELY NOT a scripted/fake LLM for the matching and tailoring
 * runners — task 042's whole point is to catch REAL unsupported-claim
 * leakage and REAL scoring-quality regressions; a canned LLM response would
 * make the trap-prompt gate untestable (it would only ever prove the
 * harness's own fixture data, not the pipeline's actual behavior against a
 * live model). `run-resume-import-eval.ts` has no LLM in its path at all
 * (pure heuristic mapper) and is unaffected by any of this.
 */
export function buildLlmHarness() {
  const inner = new OpenAiCompatibleLlmAdapter(LLM_BASE_URL, LLM_API_KEY);
  const budgetStore = new InMemoryBudgetStore();
  const estimator = new TieredCostEstimator();
  const llm = new GuardedLlmPort(inner, budgetStore, estimator, EVAL_MONTHLY_BUDGET_USD, 'ollama-eval');
  const prompts = new FilePromptStore(PROMPTS_DIR);
  return { llm, prompts, budgetStore, model: PINNED_CHAT_MODEL, rawLlm: inner };
}

/**
 * Fails loudly and early with a clear, actionable message rather than
 * letting every fixture in the run fail one-by-one with a generic
 * `provider_unavailable` — this is the harness's own "is the gate even
 * running for real" check, distinct from what it's evaluating.
 */
export async function assertLlmReachable(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${LLM_BASE_URL.replace(/\/v1\/?$/, '')}/api/tags`);
  } catch (cause) {
    throw new Error(
      `Cannot reach an LLM provider at ${LLM_BASE_URL} (${cause instanceof Error ? cause.message : String(cause)}). ` +
      `The matching/tailoring evals need a real chat-completion-capable endpoint — start Ollama ` +
      `(\`docker run -d -p 11434:11434 ollama/ollama\`, then \`ollama pull ${PINNED_CHAT_MODEL}\` and ` +
      `\`ollama pull nomic-embed-text\`) or set EVAL_LLM_BASE_URL/EVAL_LLM_API_KEY to a BYO-cloud-key ` +
      `OpenAI-compatible endpoint. See packages/intelligence-evals/README.md.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(`LLM provider at ${LLM_BASE_URL} responded with HTTP ${response.status} — is it actually Ollama/OpenAI-compatible?`);
  }
}
