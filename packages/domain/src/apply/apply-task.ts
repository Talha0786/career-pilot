import { AggregateRoot, createEvent } from '../shared/domain-event.js';
import {
  type ApplyTaskId,
  type ApplicationId,
  type JobPostingId,
  type UserId,
  type DocumentVersionId,
  newApplyTaskId,
} from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, invalidTransition } from '../shared/errors.js';
import {
  type ApplyTaskStage,
  isLegalTransition,
  allowedApplyTaskTransitions,
} from './apply-task-stage.js';
import { APPLY_TASK_EVENTS } from './events.js';

export interface ApplyTaskStep {
  readonly fromStage: ApplyTaskStage | null;
  readonly toStage: ApplyTaskStage;
  readonly action: string | null;
  readonly redactedPayload: Record<string, unknown> | null;
  readonly screenshotKey: string | null;
  readonly occurredAt: Date;
}

export interface ApplyTaskSnapshot {
  readonly id: ApplyTaskId;
  readonly userId: UserId;
  readonly applicationId: ApplicationId;
  readonly jobPostingId: JobPostingId;
  readonly documentVersionId: DocumentVersionId;
  readonly stage: ApplyTaskStage;
  readonly atsAdapter: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * ApplyTask — Assisted-Apply context aggregate root (task 045,
 * docs/05-playwright-design.md §2-3). Mirrors `pipeline/application.ts`'s
 * shape: private `#newSteps`/`pullSteps()` for append-only step recording
 * (same pattern as `Application`'s `#newTransitions`/`pullTransitions()`).
 *
 * This is the domain-layer half of ADR-003's "architecturally unreachable"
 * requirement: `transitionTo` is the ONLY way this object's stage ever
 * changes, and it consults `isLegalTransition` (apply-task-stage.ts) on
 * every call — there is no setter, no back door. Combined with that
 * module's `onlyApprovedReachesSubmitting()` fact about the transition
 * table, and task 046/053's single-use token gating the ONE call site
 * (`submit-apply-task.ts`) allowed to invoke `transitionTo('submitting')`,
 * this is what makes "no path reaches submitting without a consumed token"
 * true by construction rather than by convention.
 */
export class ApplyTask extends AggregateRoot {
  #newSteps: ApplyTaskStep[] = [];

  private constructor(
    readonly id: ApplyTaskId,
    readonly userId: UserId,
    readonly applicationId: ApplicationId,
    readonly jobPostingId: JobPostingId,
    readonly documentVersionId: DocumentVersionId,
    private _stage: ApplyTaskStage,
    private _atsAdapter: string | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {
    super();
  }

  static create(args: {
    userId: UserId;
    applicationId: ApplicationId;
    jobPostingId: JobPostingId;
    documentVersionId: DocumentVersionId;
    now?: Date;
  }): ApplyTask {
    const now = args.now ?? new Date();
    const task = new ApplyTask(
      newApplyTaskId(),
      args.userId,
      args.applicationId,
      args.jobPostingId,
      args.documentVersionId,
      'draft',
      null,
      now,
      now,
    );

    task.#newSteps.push({
      fromStage: null,
      toStage: 'draft',
      action: null,
      redactedPayload: null,
      screenshotKey: null,
      occurredAt: now,
    });

    task.record(
      createEvent({
        eventType: APPLY_TASK_EVENTS.CREATED,
        aggregateType: 'ApplyTask',
        aggregateId: task.id,
        payload: { applyTaskId: task.id, applicationId: args.applicationId },
        occurredAt: now,
      }),
    );

    return task;
  }

  static fromSnapshot(s: ApplyTaskSnapshot): ApplyTask {
    return new ApplyTask(
      s.id,
      s.userId,
      s.applicationId,
      s.jobPostingId,
      s.documentVersionId,
      s.stage,
      s.atsAdapter,
      s.createdAt,
      s.updatedAt,
    );
  }

  /**
   * The sole mutator of `_stage`. Illegal transitions (including any
   * attempt to leave a terminal stage, or any no-op self-transition) are
   * rejected here — a domain invariant, not an application-layer check
   * that a careless call site could skip.
   */
  transitionTo(
    toStage: ApplyTaskStage,
    action?: string,
    redactedPayload?: Record<string, unknown>,
    opts?: { screenshotKey?: string; now?: Date },
  ): Result<void, DomainError> {
    const from = this._stage;

    if (!isLegalTransition(from, toStage)) {
      const allowed = allowedApplyTaskTransitions(from);
      return err(
        invalidTransition(
          allowed.length === 0
            ? `'${from}' is terminal; no transitions are permitted`
            : `Cannot move from '${from}' to '${toStage}'. Allowed: ${allowed.join(', ')}`,
          { fromStage: from, toStage },
        ),
      );
    }

    const now = opts?.now ?? new Date();
    this._stage = toStage;
    this._updatedAt = now;

    this.#newSteps.push({
      fromStage: from,
      toStage,
      action: action ?? null,
      redactedPayload: redactedPayload ?? null,
      screenshotKey: opts?.screenshotKey ?? null,
      occurredAt: now,
    });

    this.record(
      createEvent({
        eventType: APPLY_TASK_EVENTS.STAGE_CHANGED,
        aggregateType: 'ApplyTask',
        aggregateId: this.id,
        payload: { applyTaskId: this.id, fromStage: from, toStage },
        occurredAt: now,
      }),
    );

    if (toStage === 'submitted') {
      this.record(
        createEvent({
          eventType: APPLY_TASK_EVENTS.SUBMITTED,
          aggregateType: 'ApplyTask',
          aggregateId: this.id,
          payload: { applyTaskId: this.id, applicationId: this.applicationId },
          occurredAt: now,
        }),
      );
    }

    return ok(undefined);
  }

  /**
   * Task 051 — records a browser ACTION (one field fill, one upload
   * attempt, ...) that happens WITHIN the current stage, not a stage
   * transition. Migration 0007's comment describes `apply_task_steps` as
   * "one row per state transition / browser action" — `transitionTo`
   * covers the first half; this covers the second. `fromStage === toStage
   * === current stage` distinguishes an action row from a real transition
   * row when reading history back (a real transition always has
   * `fromStage !== toStage`, except the very first `null → draft` row).
   */
  recordAction(action: string, redactedPayload?: Record<string, unknown>, opts?: { screenshotKey?: string; now?: Date }): void {
    const now = opts?.now ?? new Date();
    this._updatedAt = now;
    this.#newSteps.push({
      fromStage: this._stage,
      toStage: this._stage,
      action,
      redactedPayload: redactedPayload ?? null,
      screenshotKey: opts?.screenshotKey ?? null,
      occurredAt: now,
    });
  }

  setAtsAdapter(atsAdapter: string, now?: Date): void {
    this._atsAdapter = atsAdapter;
    this._updatedAt = now ?? new Date();
  }

  /** Drains — the repository appends these to `apply_task_steps`. */
  pullSteps(): ApplyTaskStep[] {
    const drained = this.#newSteps;
    this.#newSteps = [];
    return drained;
  }

  get stage(): ApplyTaskStage {
    return this._stage;
  }
  get atsAdapter(): string | null {
    return this._atsAdapter;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  toSnapshot(): ApplyTaskSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      applicationId: this.applicationId,
      jobPostingId: this.jobPostingId,
      documentVersionId: this.documentVersionId,
      stage: this._stage,
      atsAdapter: this._atsAdapter,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
