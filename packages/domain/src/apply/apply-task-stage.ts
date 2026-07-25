/**
 * ApplyTask stage state machine (docs/05-playwright-design.md §3):
 *
 *   draft → mapping → filling → awaiting_review → approved → submitting → submitted
 *                        │              │                          │
 *                        └──────────────┴──────→ failed / aborted ─┘
 *
 * Same "explicit adjacency map, exhaustively testable" pattern as
 * `pipeline/stage.ts` — this is ADR-003's "architecturally unreachable"
 * property in its purest form: `submitting` is reachable ONLY from
 * `approved`, and `submitted` ONLY from `submitting`. There is no entry in
 * this table that skips `approved → submitting`, which is what makes "no
 * path reaches submitting without going through approved" a fact about the
 * table, not a runtime check someone could forget to call.
 *
 * JUDGMENT CALL (documented, not silent): the design doc's diagram draws
 * failed/aborted branches from `filling`, `awaiting_review`, and
 * `submitting` only; this task's own file (045) prose says
 * "mapping/filling/awaiting_review". Reconciled by including ALL FOUR
 * (`mapping`, `filling`, `awaiting_review`, `submitting`) — task 053's
 * acceptance criterion explicitly requires "a failed submit... reaches
 * `failed`", which needs `submitting → failed` to exist. Additionally added
 * `draft → aborted` and `approved → aborted` so every non-terminal stage has
 * at least one safe exit (a user can cancel a task that hasn't started
 * mapping yet, or one whose review approval they want to rescind before the
 * runner dequeues the submit job) — this only ever ADDS a way to reach a
 * terminal dead-end state, never a new way to reach `submitting`/
 * `submitted`, so it cannot weaken the ADR-003 property. `submitting` does
 * NOT get an `aborted` exit: once a submit attempt is in flight the only
 * two honest outcomes are "it happened" (`submitted`) or "it didn't"
 * (`failed`) — declaring it "aborted" while a real HTTP request to a real
 * ATS may already be in flight would be a lie the state machine shouldn't
 * be able to tell.
 */

export const APPLY_TASK_STAGES = [
  'draft',
  'mapping',
  'filling',
  'awaiting_review',
  'approved',
  'submitting',
  'submitted',
  'failed',
  'aborted',
] as const;

export type ApplyTaskStage = (typeof APPLY_TASK_STAGES)[number];

export const isApplyTaskStage = (v: string): v is ApplyTaskStage =>
  (APPLY_TASK_STAGES as readonly string[]).includes(v);

/** Terminal: nothing leaves them. A new attempt means a new ApplyTask. */
export const APPLY_TASK_TERMINAL_STAGES: readonly ApplyTaskStage[] = [
  'submitted',
  'failed',
  'aborted',
];

const APPLY_TASK_TRANSITIONS: Readonly<Record<ApplyTaskStage, readonly ApplyTaskStage[]>> = {
  draft: ['mapping', 'aborted'],
  mapping: ['filling', 'failed', 'aborted'],
  filling: ['awaiting_review', 'failed', 'aborted'],
  awaiting_review: ['approved', 'failed', 'aborted'],
  approved: ['submitting', 'aborted'],
  submitting: ['submitted', 'failed'],
  // Terminal.
  submitted: [],
  failed: [],
  aborted: [],
};

export function isLegalTransition(from: ApplyTaskStage, to: ApplyTaskStage): boolean {
  if (from === to) return false; // no-op moves are rejected, not silently allowed
  return APPLY_TASK_TRANSITIONS[from].includes(to);
}

export function allowedApplyTaskTransitions(from: ApplyTaskStage): readonly ApplyTaskStage[] {
  return APPLY_TASK_TRANSITIONS[from];
}

export const isApplyTaskTerminal = (s: ApplyTaskStage): boolean =>
  APPLY_TASK_TERMINAL_STAGES.includes(s);

/**
 * The literal ADR-003 property, expressed as a pure function so task 053's
 * property test (and this task's own unit test) can assert it directly
 * against the table rather than against runtime behavior alone: is there
 * ANY legal transition into `submitting` from anywhere other than
 * `approved`?
 */
export function onlyApprovedReachesSubmitting(): boolean {
  return APPLY_TASK_STAGES.filter((s) => s !== 'approved').every(
    (s) => !isLegalTransition(s, 'submitting'),
  );
}
