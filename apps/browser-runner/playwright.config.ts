import { defineConfig } from '@playwright/test';

/**
 * Task 047/048 — Playwright test config for browser-runner's own test
 * suite: fixture-based tests only (recorded/sanitized HTML snapshots, task
 * 048's ats-maps.spec.ts, this task's browser-smoke.spec.ts). Never hits a
 * real third-party site — same anti-flake posture M4's connector fixture
 * tests established (docs/05-playwright-design.md §7).
 */
export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    headless: true,
  },
});
