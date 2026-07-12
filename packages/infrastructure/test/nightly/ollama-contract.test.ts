import { describe, it, expect } from 'vitest';
import { OpenAiCompatibleLlmAdapter } from '../../src/llm/openai-compat.adapter.js';
import { isOk } from '@careerpilot/domain';

/**
 * Task 014's nightly gate: proves OpenAiCompatibleLlmAdapter works against a
 * REAL Ollama model, not just the wire-protocol-shaped fake HTTP server that
 * packages/infrastructure/test/integration/llm-adapter.test.ts uses. That
 * integration test is deliberately fast and dependency-free; this one is
 * deliberately slow and dependency-heavy (needs a real model loaded) — which
 * is exactly why it's nightly, not PR-blocking (task 014 acceptance).
 *
 * OLLAMA_BASE_URL defaults to the standard local Ollama endpoint. If nothing
 * is listening there (any dev machine without Ollama running, any PR runner)
 * the test is skipped rather than failed — it's an environment precondition,
 * not a code defect, and failing loudly here would make this file unsafe to
 * accidentally include outside the nightly workflow.
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
const MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text';
const EXPECTED_DIMENSIONS = Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS ?? 768);

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(OLLAMA_BASE_URL.replace(/\/v1$/, '/api/tags'), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('OpenAiCompatibleLlmAdapter against a REAL Ollama instance (nightly only)', () => {
  it('embeds real text and returns a real vector of the expected dimensionality', async () => {
    if (!(await ollamaReachable())) {
      console.warn(`Skipping: no Ollama reachable at ${OLLAMA_BASE_URL}. This test only runs meaningfully in the nightly workflow.`);
      return;
    }

    const adapter = new OpenAiCompatibleLlmAdapter(OLLAMA_BASE_URL, null);
    const result = await adapter.embed({
      input: 'Senior Backend Engineer — TypeScript, Postgres, distributed systems.',
      model: MODEL,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.vector).toHaveLength(EXPECTED_DIMENSIONS);
    expect(result.value.vector.every((n) => typeof n === 'number' && Number.isFinite(n))).toBe(true);
    // A real model burns real tokens — this is the one assertion the fake
    // HTTP server in llm-adapter.test.ts cannot make honestly.
    expect(result.value.promptTokens).toBeGreaterThan(0);

    // Same input should embed identically on a second call — proves the
    // adapter isn't accidentally introducing nondeterminism of its own
    // (the model itself may not guarantee this in general, but for a
    // deterministic embedding model like nomic-embed-text it should hold).
    const second = await adapter.embed({ input: 'Senior Backend Engineer — TypeScript, Postgres, distributed systems.', model: MODEL });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.vector).toEqual(result.value.vector);
    }
  });
});
