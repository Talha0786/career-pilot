import type { Result } from '@careerpilot/domain';

export type ApprovalTokenConsumeError = 'invalid' | 'expired' | 'already_consumed';

/**
 * Task 046 — ADR-003's "approval is a single-use, short-TTL token" primitive.
 *
 * No existing primitive fits: `SessionStore` (`apps/api/src/plugins/session.ts`)
 * is a long-lived opaque cookie with a plain `get`/`del` pair — reusing that
 * for single-use consumption would have the exact TOCTOU race `consume()`
 * below is built specifically to close (get-then-del is two round trips;
 * two concurrent callers can both `get` a still-present token before either
 * `del`s it).
 *
 * `consume` MUST be atomic — a single round trip against the store, never a
 * separate check-then-delete — that's what makes "exactly one concurrent
 * consumer wins" true under real concurrency rather than true "usually".
 */
export interface ApprovalTokenPort {
  /** Mints a fresh single-use token scoped to one ApplyTask. 5-minute TTL (design doc §3). */
  mint(applyTaskId: string): Promise<{ token: string; expiresAt: Date }>;

  /**
   * Atomically consumes a token: on success, the token can never be
   * consumed again (by this or any other caller) — expired or already the
   * `err` variants of `consume`, not a resurrected `ok`. Returns the
   * `applyTaskId` the token was minted for on success.
   */
  consume(token: string): Promise<Result<string, ApprovalTokenConsumeError>>;
}
