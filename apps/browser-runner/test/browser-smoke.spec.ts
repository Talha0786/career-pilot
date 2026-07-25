import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Task 047's acceptance criterion, run directly (not only via the HTTP
 * route in task-api.ts): "Playwright launches a real headless Chromium
 * inside the container (smoke test: navigate to a local fixture page, read
 * its title) — proves the Docker image actually has working browser
 * binaries."
 */
test('headless Chromium launches and reads a local fixture page title', async ({ page }) => {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/smoke.html');
  await page.goto(`file://${fixturePath}`);
  await expect(page).toHaveTitle('browser-runner smoke fixture');
  await expect(page.locator('h1')).toHaveText('OK');
});
