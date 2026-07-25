/**
 * Task 045. Mirrors `pipeline/events.ts`'s shape. `SUBMITTED` is the
 * cross-aggregate wire: task 053's submit command emits it after a
 * successful `submitting → submitted` transition, and a worker handler
 * (task 053) consumes it to call `Application.transitionTo('applied', {
 * actor: 'agent' })` — the same "domain events are the only channel between
 * bounded contexts" rule task 035 established for profile→matching.
 */
export const APPLY_TASK_EVENTS = {
  CREATED: 'apply.task_created',
  STAGE_CHANGED: 'apply.stage_changed',
  SUBMITTED: 'apply.task_submitted',
} as const;

export type ApplyTaskEventType = (typeof APPLY_TASK_EVENTS)[keyof typeof APPLY_TASK_EVENTS];

export interface ApplyTaskSubmittedPayload {
  readonly applyTaskId: string;
  readonly applicationId: string;
}
