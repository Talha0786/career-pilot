import { AggregateRoot, createEvent } from '../shared/domain-event.js';
import {
  type ApplicationId,
  type JobPostingId,
  type UserId,
  newApplicationId,
} from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, forbidden, invalidTransition } from '../shared/errors.js';
import { type Stage, canTransition, allowedTransitions } from './stage.js';

export type TransitionActor = 'user' | 'system' | 'agent';

export interface StageTransition {
  readonly fromStage: Stage | null;
  readonly toStage: Stage;
  readonly actor: TransitionActor;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface ApplicationSnapshot {
  readonly id: ApplicationId;
  readonly userId: UserId;
  readonly jobPostingId: JobPostingId;
  readonly stage: Stage;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Application — Pipeline context aggregate root.
 *
 * Stage history is append-only (database design §2). We never mutate or delete
 * a transition; the log is the audit trail. `newTransitions` are drained by the
 * repository on save, like domain events.
 */
export class Application extends AggregateRoot {
  #newTransitions: StageTransition[] = [];

  private constructor(
    readonly id: ApplicationId,
    readonly userId: UserId,
    readonly jobPostingId: JobPostingId,
    private _stage: Stage,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {
    super();
  }

  static create(args: {
    userId: UserId;
    jobPostingId: JobPostingId;
    stage?: Stage;
    now?: Date;
  }): Application {
    const now = args.now ?? new Date();
    const stage = args.stage ?? 'discovered';

    const app = new Application(
      newApplicationId(),
      args.userId,
      args.jobPostingId,
      stage,
      now,
      now,
    );

    // The opening transition (null → initial stage) is recorded so the history
    // is complete from creation, not just from the first user-driven move.
    app.#newTransitions.push({
      fromStage: null,
      toStage: stage,
      actor: 'system',
      reason: 'application created',
      occurredAt: now,
    });

    app.record(
      createEvent({
        eventType: 'pipeline.application_created',
        aggregateType: 'Application',
        aggregateId: app.id,
        payload: { applicationId: app.id, jobPostingId: args.jobPostingId },
        occurredAt: now,
      }),
    );

    return app;
  }

  static fromSnapshot(s: ApplicationSnapshot): Application {
    return new Application(
      s.id,
      s.userId,
      s.jobPostingId,
      s.stage,
      s.createdAt,
      s.updatedAt,
    );
  }

  /**
   * Move to a new stage. Rejects illegal moves per the state machine —
   * including no-op self-transitions, which usually indicate a UI bug.
   */
  transitionTo(args: {
    toStage: Stage;
    actor: TransitionActor;
    reason?: string | undefined;
    now?: Date;
  }): Result<void, DomainError> {
    const from = this._stage;
    const to = args.toStage;

    if (!canTransition(from, to)) {
      const allowed = allowedTransitions(from);
      return err(
        invalidTransition(
          allowed.length === 0
            ? `'${from}' is terminal; no transitions are permitted`
            : `Cannot move from '${from}' to '${to}'. Allowed: ${allowed.join(', ')}`,
          { fromStage: from, toStage: to },
        ),
      );
    }

    const now = args.now ?? new Date();
    this._stage = to;
    this._updatedAt = now;

    this.#newTransitions.push({
      fromStage: from,
      toStage: to,
      actor: args.actor,
      reason: args.reason ?? null,
      occurredAt: now,
    });

    this.record(
      createEvent({
        eventType: 'pipeline.stage_changed',
        aggregateType: 'Application',
        aggregateId: this.id,
        payload: { applicationId: this.id, fromStage: from, toStage: to },
        occurredAt: now,
      }),
    );

    return ok(undefined);
  }

  assertOwnedBy(actorId: UserId): Result<void, DomainError> {
    return this.userId === actorId
      ? ok(undefined)
      : err(forbidden('You do not have access to this application'));
  }

  /** Drains — the repository appends these to `stage_transitions`. */
  pullTransitions(): StageTransition[] {
    const drained = this.#newTransitions;
    this.#newTransitions = [];
    return drained;
  }

  get stage(): Stage {
    return this._stage;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  toSnapshot(): ApplicationSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      jobPostingId: this.jobPostingId,
      stage: this._stage,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
