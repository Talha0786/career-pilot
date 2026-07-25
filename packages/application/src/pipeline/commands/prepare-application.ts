import { asApplicationId, notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { ApplicationRepository, Actor } from '../../ports/repositories.js';
import type { ApplyTaskPort, PrepareApplicationResult } from '../../ports/apply-task.port.js';

export interface PrepareApplicationInput {
  applicationId: string;
}

/**
 * Task 058's `prepare_application` MCP tool logic. Note the input type
 * has EXACTLY one field — there is no `autoApprove`/`confirm`/`submit`
 * parameter to even attempt to honor, and this function never reads any
 * property off `input` beyond `applicationId` even if a caller forces
 * extra keys past TypeScript with an `as` cast (proven by
 * `prepare-application.adversarial.test.ts`). The actual "cannot reach
 * past awaiting_review" guarantee lives one layer down, in
 * `ApplyTaskPort`'s type signature (see that file's doc comment) — this
 * function is just ownership-checking plumbing around it.
 */
export function makePrepareApplicationUseCase(deps: {
  applications: ApplicationRepository;
  applyTasks: ApplyTaskPort;
}) {
  return async function prepareApplication(
    actor: Actor,
    input: PrepareApplicationInput,
  ): Promise<Result<PrepareApplicationResult, DomainError>> {
    const applicationId = asApplicationId(input.applicationId);
    const app = await deps.applications.findByIdForUser(applicationId, actor.userId);
    if (app === null) return { ok: false, error: notFound('Application not found') };

    return deps.applyTasks.startAndMapToReview({ applicationId: input.applicationId, userId: actor.userId });
  };
}
