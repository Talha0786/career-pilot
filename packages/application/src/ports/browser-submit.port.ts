import type { Result } from '@careerpilot/domain';

export interface BrowserSubmitError {
  readonly code: string;
  readonly message: string;
}

/**
 * Task 053 — abstracts the actual "click submit on the real ATS form"
 * action, which only `apps/browser-runner` can perform (it holds the live
 * Playwright page — `apps/browser-runner/src/submit-runner.ts` is the real
 * implementation, exposed over the internal task API, task 047). The
 * adapter that calls it from `apps/api` is a thin HTTP client — see
 * `apps/api/src/lib/browser-runner-client.ts`.
 *
 * `submit()` is called EXACTLY ONCE per successful token consumption by
 * `submit-apply-task.ts` — never retried automatically by this port or its
 * caller. A second attempt requires a brand new approval cycle (a new
 * `awaiting_review` → `approve` → new token), by construction: there is no
 * code path that calls this twice for the same consumed token.
 */
export interface BrowserSubmitPort {
  submit(applyTaskId: string): Promise<Result<void, BrowserSubmitError>>;
}
