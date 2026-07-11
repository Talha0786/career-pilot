import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against REAL Postgres + Redis via Testcontainers.
 * Never SQLite, never mocks (ADR-002 amendment): a suite that doesn't run the
 * real engine passes in CI and fails in prod on exactly the pgvector/JSONB
 * behavior that matters.
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['packages/*/test/integration/**/*.test.ts', 'apps/*/test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000, // first run pulls container images
    hookTimeout: 120_000,
    fileParallelism: false, // share one PG container across files
  },
});
