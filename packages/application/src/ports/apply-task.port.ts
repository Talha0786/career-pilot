/**
 * M7 (task 058) / M6 integration seam. `docs/05-playwright-design.md` §3's
 * ApplyTask state machine: `draft -> mapping -> filling -> awaiting_review
 * -> approved -> submitting -> submitted` (or `failed`/`aborted` off the
 * first three states). M6 (tasks 044/045/047/050/051, a separate parallel
 * worktree at the time this port was written) owns the REAL
 * implementation: a Postgres-backed ApplyTask aggregate + a Playwright
 * runner that actually drives `mapping`/`filling`.
 *
 * THIS PORT IS THE SAFETY BOUNDARY, BY DESIGN: it exposes exactly one
 * method, and that method's own contract promises to stop at
 * `awaiting_review` (or `failed`) — there is no `approve`/`submit` method
 * on this interface AT ALL. `approved -> submitting -> submitted` is a
 * SEPARATE capability (a hypothetical `ApplyTaskApprovalPort` or direct
 * web-UI-only code path) that `apps/mcp-server` never imports, never
 * receives via DI, and has no reference to anywhere in its dependency
 * graph. This is what makes task 058's "prepare_application cannot, through
 * any parameter combination, drive an ApplyTask past awaiting_review" true
 * structurally, not just by convention: the MCP process has no callable
 * that could do it even if a handler were compromised or a schema
 * validation bug let extra input through.
 *
 * Until M6 lands, `packages/infrastructure` has no real adapter for this
 * port — `apps/mcp-server/src/di.ts` wires a `NotYetImplementedApplyTaskPort`
 * stub (below) that always returns a typed failure. Whoever merges M6 and
 * M7 swaps that stub for the real Drizzle/Playwright-backed adapter; no
 * change to `prepare-application.ts` (the application-layer command) or
 * the MCP tool should be needed — only a DI wiring change in
 * `apps/mcp-server/src/di.ts`.
 */
import type { Result, DomainError } from '@careerpilot/domain';

export type ApplyTaskState =
  | 'draft' | 'mapping' | 'filling' | 'awaiting_review'
  | 'approved' | 'submitting' | 'submitted' | 'failed' | 'aborted';

/** Every state this port's one method can ever return. Notably: `approved`, `submitting`, `submitted` are NOT reachable return values — they're declared in `ApplyTaskState` only because the UI/M6 layers report on the full lifecycle; this port's return type is intentionally narrower. */
export type PrepareApplicationReachableState = 'awaiting_review' | 'failed' | 'aborted';

export interface PrepareApplicationResult {
  readonly applyTaskId: string;
  readonly state: PrepareApplicationReachableState;
  readonly flaggedFields?: readonly string[] | undefined;
}

export interface ApplyTaskPort {
  /**
   * Creates a new ApplyTask and runs it through `mapping` -> `filling`
   * internally, stopping at `awaiting_review` (or `failed`/`aborted` on
   * error) — never further. There is deliberately no parameter on this
   * method (autoApprove, confirm, submit, etc.) that could change that;
   * adding one would be the actual security regression task 058 tests for.
   */
  startAndMapToReview(input: { applicationId: string; userId: string }): Promise<Result<PrepareApplicationResult, DomainError>>;
}

/**
 * Placeholder adapter used until M6's real ApplyTask machinery lands
 * (task 058's documented integration seam — see this file's module doc
 * comment). Always returns a typed `conflict` failure rather than
 * throwing or pretending to succeed, so `prepare_application` behaves
 * predictably (a clear, typed error, no crash) in any environment where
 * M6 hasn't been wired in yet.
 */
export class NotYetImplementedApplyTaskPort implements ApplyTaskPort {
  async startAndMapToReview(): Promise<Result<PrepareApplicationResult, DomainError>> {
    return {
      ok: false,
      error: {
        code: 'conflict',
        message: 'ApplyTask backend is not yet available in this environment (M6 integration pending).',
      },
    };
  }
}
