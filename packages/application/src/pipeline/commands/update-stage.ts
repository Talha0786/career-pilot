import { asApplicationId, notFound, type Result, type DomainError, type Stage } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface UpdateStageInput {
  applicationId: string;
  toStage: Stage;
  reason?: string | undefined;
}
export interface UpdateStageOutput {
  applicationId: string;
  stage: Stage;
  updatedAt: string;
}

/**
 * Moves an application to a new stage. Illegal moves (rejected → applied,
 * self-transitions, etc.) are rejected by the domain's state machine
 * (`Application.transitionTo`) — this use case just wires ownership lookup
 * and persistence around that decision.
 */
export function makeUpdateStageUseCase(deps: { uow: UnitOfWork }) {
  return async function updateStage(
    actor: Actor,
    input: UpdateStageInput,
  ): Promise<Result<UpdateStageOutput, DomainError>> {
    const applicationId = asApplicationId(input.applicationId);

    return deps.uow.withTransaction(async (ctx) => {
      const app = await ctx.applications.findByIdForUser(applicationId, actor.userId);
      if (app === null) {
        return { ok: false, error: notFound('Application not found') };
      }

      const transitioned = app.transitionTo({ toStage: input.toStage, actor: 'user', reason: input.reason });
      if (!transitioned.ok) return transitioned;

      await ctx.applications.save(app);

      const events = app.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      return {
        ok: true,
        value: { applicationId: app.id, stage: app.stage, updatedAt: app.updatedAt.toISOString() },
      };
    });
  };
}
