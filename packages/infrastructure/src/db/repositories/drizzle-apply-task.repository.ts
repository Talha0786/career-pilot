import { eq, and, desc } from 'drizzle-orm';
import {
  ApplyTask,
  asUserId,
  asApplyTaskId,
  asApplicationId,
  asJobPostingId,
  asDocumentVersionId,
  uuidv7,
} from '@careerpilot/domain';
import type { ApplyTaskRepository, ApplyTaskStepRecord, OutboxPort } from '@careerpilot/application';
import type { Db } from '../client.js';
import { applyTasks, applyTaskSteps } from '../schema/index.js';

/**
 * Task 045. Mirrors `DrizzleApplicationRepository`: `save` upserts the
 * current-stage row on `apply_tasks` AND drains+appends
 * `task.pullSteps()` to the append-only `apply_task_steps` table in the
 * same call — never a separate "update steps" path, so a caller can't
 * accidentally persist a stage change without its step record (or vice
 * versa).
 *
 * KNOWN LIMITATION (documented, not silently dropped — flagged for
 * follow-up): `outbox` is drained here as a SEPARATE call after the row
 * writes commit, not inside the SAME Postgres transaction the way
 * `DrizzleUnitOfWork`'s `TransactionContext` guarantees for every other
 * aggregate in this codebase (ADR-007's actual point — "the aggregate
 * write and its outbox row land together or not at all"). `ApplyTask`
 * isn't wired into `TransactionContext` (that interface, and every command
 * that uses it, would need extending — out of scope for the time this
 * milestone had). Practically: a crash in the narrow window between the
 * `apply_tasks`/`apply_task_steps` INSERT/UPDATE committing and the
 * `outbox` INSERT committing could lose a `SUBMITTED` event (and therefore
 * the `Application → applied` wiring, task 053) without losing the
 * ApplyTask's own state — the ApplyTask row itself is never at risk, only
 * that one downstream side effect. Worth closing before this ships past
 * this milestone; not closed here given time constraints.
 */
export class DrizzleApplyTaskRepository implements ApplyTaskRepository {
  constructor(
    private readonly db: Db,
    private readonly outbox?: OutboxPort,
  ) {}

  async findByIdForUser(
    id: ReturnType<typeof asApplyTaskId>,
    userId: ReturnType<typeof asUserId>,
  ): Promise<ApplyTask | null> {
    const rows = await this.db
      .select()
      .from(applyTasks)
      .where(and(eq(applyTasks.id, id), eq(applyTasks.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  /** Unscoped lookup — the browser-runner's internal task API acts on behalf of a task, not a logged-in user. */
  async findByIdAnyOwner(id: ReturnType<typeof asApplyTaskId>): Promise<ApplyTask | null> {
    const rows = await this.db.select().from(applyTasks).where(eq(applyTasks.id, id)).limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listForUser(
    userId: ReturnType<typeof asUserId>,
    opts?: { stage?: string },
  ): Promise<ApplyTask[]> {
    const conditions = [eq(applyTasks.userId, userId)];
    if (opts?.stage) conditions.push(eq(applyTasks.stage, opts.stage as (typeof applyTasks.$inferSelect)['stage']));
    const rows = await this.db
      .select()
      .from(applyTasks)
      .where(and(...conditions))
      .orderBy(desc(applyTasks.updatedAt));
    return rows.map((r) => this.toDomain(r));
  }

  async save(task: ApplyTask): Promise<void> {
    const snap = task.toSnapshot();
    await this.db
      .insert(applyTasks)
      .values({
        id: snap.id,
        userId: snap.userId,
        applicationId: snap.applicationId,
        jobPostingId: snap.jobPostingId,
        documentVersionId: snap.documentVersionId,
        stage: snap.stage,
        atsAdapter: snap.atsAdapter,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
      })
      .onConflictDoUpdate({
        target: applyTasks.id,
        set: { stage: snap.stage, atsAdapter: snap.atsAdapter, updatedAt: snap.updatedAt },
      });

    // Append-only — INSERT only, never UPDATE/DELETE (migration 0007's invariant).
    const steps = task.pullSteps();
    for (const s of steps) {
      await this.db.insert(applyTaskSteps).values({
        id: uuidv7(),
        applyTaskId: snap.id,
        fromStage: s.fromStage,
        toStage: s.toStage,
        action: s.action,
        redactedPayload: s.redactedPayload,
        screenshotKey: s.screenshotKey,
        createdAt: s.occurredAt,
      });
    }

    if (this.outbox) {
      const events = task.pullEvents();
      if (events.length > 0) await this.outbox.enqueue(events);
    }
  }

  /** Task 052 — the review-diff endpoint's read source, oldest first (append-only table, migration 0007). */
  async listSteps(id: ReturnType<typeof asApplyTaskId>): Promise<ApplyTaskStepRecord[]> {
    const rows = await this.db
      .select()
      .from(applyTaskSteps)
      .where(eq(applyTaskSteps.applyTaskId, id))
      .orderBy(applyTaskSteps.createdAt);
    return rows.map((r) => ({
      fromStage: r.fromStage,
      toStage: r.toStage,
      action: r.action,
      redactedPayload: r.redactedPayload as Record<string, unknown> | null,
      screenshotKey: r.screenshotKey,
      createdAt: r.createdAt,
    }));
  }

  private toDomain(row: typeof applyTasks.$inferSelect): ApplyTask {
    return ApplyTask.fromSnapshot({
      id: asApplyTaskId(row.id),
      userId: asUserId(row.userId),
      applicationId: asApplicationId(row.applicationId),
      jobPostingId: asJobPostingId(row.jobPostingId),
      documentVersionId: asDocumentVersionId(row.documentVersionId),
      stage: row.stage,
      atsAdapter: row.atsAdapter,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
