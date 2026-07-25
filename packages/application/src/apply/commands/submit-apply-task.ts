import { asUserId, asApplyTaskId, notFound, forbidden, invalidTransition, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ApplyTaskRepository } from '../../ports/repositories.js';
import type { ApprovalTokenPort } from '../../ports/approval-token.port.js';
import type { BrowserSubmitPort } from '../../ports/browser-submit.port.js';

export interface SubmitApplyTaskInput {
  readonly userId: string;
  readonly applyTaskId: string;
  readonly token: string;
}

export interface SubmitApplyTaskOutput {
  readonly stage: 'submitted' | 'failed';
}

/**
 * Task 053 — ADR-003's core invariant, implemented. THIS FUNCTION IS THE
 * ONLY CODE PATH IN THE ENTIRE APPLICATION ALLOWED TO DRIVE
 * `approved → submitting`. That is not a comment-only promise:
 *
 *   1. `apply-task-stage.ts`'s transition table (045) makes `submitting`
 *      reachable from `approved` ONLY — no other stage has a legal edge
 *      into it (`onlyApprovedReachesSubmitting()`, unit-tested exhaustively
 *      in `apply-task.test.ts`).
 *   2. This is the only file under `packages/application/src/apply/` that
 *      ever calls `.transitionTo('submitting', ...)` — enforced by a
 *      static-scan test (`submit-apply-task.test.ts`'s "architectural
 *      property" describe block), not just code review discipline.
 *   3. The token is consumed BEFORE any lookup, branch, or side effect —
 *      an invalid/expired/already-consumed token means this function does
 *      NOTHING else, not even read the ApplyTask.
 *
 * Together: "no path reaches `submitting` without a consumed, previously-
 * valid, now-invalid token" is an architectural fact, not a runtime hope.
 */
export function makeSubmitApplyTaskUseCase(deps: {
  applyTasks: ApplyTaskRepository;
  approvalTokens: ApprovalTokenPort;
  browserSubmit: BrowserSubmitPort;
}) {
  return async function submitApplyTask(input: SubmitApplyTaskInput): Promise<Result<SubmitApplyTaskOutput, DomainError>> {
    const userId = asUserId(input.userId);
    const applyTaskId = asApplyTaskId(input.applyTaskId);

    // Gate #1 — the token. Nothing below this line runs on a bad token.
    const consumed = await deps.approvalTokens.consume(input.token);
    if (!consumed.ok) {
      return err(forbidden(`Approval token rejected: ${consumed.error}`, { tokenError: consumed.error }));
    }
    // Defense in depth: even a validly-consumed token must have been
    // minted FOR THIS ApplyTask — a token scoped to a different task can
    // never be laundered into approving this one.
    if (consumed.value !== applyTaskId) {
      return err(forbidden('Approval token was not minted for this ApplyTask'));
    }

    const task = await deps.applyTasks.findByIdForUser(applyTaskId, userId);
    if (task === null) return err(notFound('ApplyTask not found'));
    if (task.stage !== 'approved') {
      return err(invalidTransition(`ApplyTask is in stage '${task.stage}', not 'approved' — cannot submit`));
    }

    // Persisted BEFORE the actual browser action — if the process crashes
    // between here and the browser-runner call returning, the task is
    // correctly left in 'submitting' (a known in-flight state needing
    // operator reconciliation, not silently retryable — the token is
    // ALREADY consumed at this point, so no automatic retry can ever
    // acquire a fresh one; this is the intended failure mode per this
    // task's own acceptance criterion: "never silently retry a submit —
    // a second attempt without a fresh token must be impossible by
    // construction").
    const entering = task.transitionTo('submitting', 'submit-started');
    if (!entering.ok) return err(entering.error);
    await deps.applyTasks.save(task);

    const submitResult = await deps.browserSubmit.submit(applyTaskId);
    if (!submitResult.ok) {
      task.transitionTo('failed', 'submit-error', { code: submitResult.error.code, message: submitResult.error.message.slice(0, 500) });
      await deps.applyTasks.save(task);
      return ok({ stage: 'failed' }); // a failed submit is a valid, visible OUTCOME, not a thrown exception
    }

    const completed = task.transitionTo('submitted', 'submit-confirmed');
    if (!completed.ok) return err(completed.error); // structurally unreachable (submitting→submitted is always legal) — kept for exhaustiveness
    await deps.applyTasks.save(task); // drains the apply.task_submitted event (045) into the outbox — task 053's Application→applied wire consumes it

    return ok({ stage: 'submitted' });
  };
}
