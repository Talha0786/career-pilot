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
    include: ['e2e/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
