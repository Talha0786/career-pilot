import { defineConfig } from 'vitest/config';

/**
 * Real-Ollama contract test (task 014). Deliberately its OWN vitest project,
 * excluded from both `pnpm test` and `pnpm test:int` — it needs a real model
 * server reachable at OLLAMA_BASE_URL, which most dev machines and every PR
 * runner don't have. Run nightly instead (.github/workflows/nightly.yml),
 * where the model is actually installed.
 */
export default defineConfig({
  test: {
    name: 'nightly',
    include: ['packages/*/test/nightly/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
