import type { Page } from 'playwright';
import { KNOWN_ATS_MAPS } from './ats-maps/index.js';

const FALLBACK_SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';

export interface SubmitRunnerResult {
  ok: boolean;
  code: string;
  message: string;
}

/**
 * Task 053 — `apps/browser-runner`'s half of the exactly-once submit path:
 * the actual click. Reachable ONLY via
 * `POST /internal/tasks/:id/submit` (task-api.ts), which is itself
 * reachable ONLY from `submit-apply-task.ts`'s `BrowserSubmitPort` call —
 * by the time this function runs, a single-use approval token has ALREADY
 * been consumed and the `ApplyTask` is ALREADY persisted in `submitting`.
 * This function's job is narrow and mechanical: click the one button, and
 * report what happened — it has no authority to decide whether a submit
 * is allowed, only to attempt the one it's told to.
 *
 * Never retried internally (docs/05-playwright-design.md §3 / task 053's
 * acceptance criterion: "never silently retry a submit") — one call,
 * one attempt, one outcome.
 */
export async function runSubmitStage(page: Page, atsAdapter: string | null): Promise<SubmitRunnerResult> {
  const known = atsAdapter ? KNOWN_ATS_MAPS.find((m) => m.atsKey === atsAdapter) : undefined;
  const selector = known?.submitSelector ?? FALLBACK_SUBMIT_SELECTOR;

  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    await locator.click();
    // Best-effort settle — real ATS forms navigate or show a confirmation
    // panel after submit; this is a generous, non-blocking wait, not a
    // correctness gate (task 054's mock-ATS e2e is what actually asserts a
    // real confirmation state was reached).
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    return { ok: true, code: 'submitted', message: 'submit button clicked' };
  } catch (e) {
    return { ok: false, code: 'submit_click_failed', message: e instanceof Error ? e.message : String(e) };
  }
}
