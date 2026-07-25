import { defineConfig } from '@playwright/test';

/**
 * Task 054 — config for `apply-flow.spec.ts` ONLY (the chaos specs are
 * vitest, `vitest.e2e.config.ts`, scoped to `e2e/chaos/**` specifically so
 * the two runners never collide over the same files).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/apply-flow.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    headless: true,
  },
  webServer: {
    command: 'pnpm --filter @careerpilot/mock-ats start',
    port: Number(process.env.MOCK_ATS_PORT ?? 4100),
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
