import { defineConfig } from 'vitest/config';

/**
 * End-to-end / chaos tests: real spawned processes (the actual worker
 * binary via tsx, not an in-process function call), real kill signals, real
 * Postgres + Redis. Slower and noisier than integration tests on purpose —
 * kept in its own CI job (task 014) so a flaky timing assertion here never
 * blocks the fast unit/integration gates.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    // Scoped to chaos/ specifically (not 'e2e/**/*.spec.ts') — task 054 adds
    // e2e/apply-flow.spec.ts, a PLAYWRIGHT spec (imports from
    // '@playwright/test', run via `playwright test`, its own config at
    // e2e/playwright.config.ts) that vitest must never try to collect; a
    // broader glob here would silently attempt to run it as a vitest file
    // and fail on the mismatched test API.
    include: ['e2e/chaos/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
