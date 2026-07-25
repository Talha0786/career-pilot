import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { asApplicationId } from '@careerpilot/domain';
import type { ApplicationRepository } from '@careerpilot/application';

export interface ApplyTaskSubmittedPayload {
  applyTaskId: string;
  applicationId: string;
}

/**
 * Task 053 — consumes `apply.task_submitted` (emitted by `ApplyTask`, task
 * 045; drained to the outbox by `DrizzleApplyTaskRepository`, task 053's
 * `submit-apply-task.ts` call site) and calls `Application.transitionTo(
 * 'applied', { actor: 'agent' })` — the `TransitionActor` variant that
 * already existed for exactly this "the system, not a human click, drove
 * this stage change" case (`packages/domain/src/pipeline/application.ts`).
 *
 * IDEMPOTENT by construction (ADR-007's at-least-once delivery is a hard
 * requirement, not a suggestion): if the Application has already moved
 * past `discovered`/`interested` (including already being `applied` — a
 * redelivered event, or the user manually moved it in the meantime), this
 * is a silent no-op, not an error. `Application.transitionTo` rejecting an
 * illegal move (e.g. `applied → applied`) is the domain-layer backstop;
 * this early-return is the intentionally friendly path so a normal
 * redelivery doesn't even log a warning.
 */
export function createApplyTaskSubmittedWorker(deps: {
  connection: Redis;
  applications: ApplicationRepository;
  logger: Logger;
}): Worker<ApplyTaskSubmittedPayload> {
  return new Worker<ApplyTaskSubmittedPayload>(
    'apply.task_submitted',
    async (job: Job<ApplyTaskSubmittedPayload>) => {
      const log = deps.logger.child({ jobId: job.id, applicationId: job.data.applicationId });

      const applicationId = asApplicationId(job.data.applicationId);
      const app = await deps.applications.findByIdAnyOwner(applicationId);
      if (app === null) {
        log.warn('Application not found for apply.task_submitted — nothing to update');
        return;
      }

      if (app.stage !== 'discovered' && app.stage !== 'interested') {
        log.info({ stage: app.stage }, 'Application already past applied (or already applied) — idempotent no-op');
        return;
      }

      const result = app.transitionTo({ toStage: 'applied', actor: 'agent', reason: 'ApplyTask submitted (M6 assisted apply)' });
      if (!result.ok) {
        log.warn({ error: result.error }, 'Application.transitionTo(applied) rejected — leaving as-is');
        return;
      }

      await deps.applications.save(app);
      log.info('Application moved to applied');
    },
    { connection: deps.connection, concurrency: 4 },
  );
}
