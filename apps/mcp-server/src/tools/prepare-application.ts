import { asUserId } from '@careerpilot/domain';
import { PrepareApplicationInputSchema, type PrepareApplicationInput } from '@careerpilot/contracts';
import { makePrepareApplicationUseCase } from '@careerpilot/application';
import type { PrepareApplicationResult } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

/**
 * §2 rule 1 / ADR-003: creates an ApplyTask and stages it up to
 * `awaiting_review` -- NEVER further. See
 * `packages/application/src/ports/apply-task.port.ts`'s module doc
 * comment for exactly why that's structurally true here, not just an
 * intent: this tool's only capability is `ApplyTaskPort.
 * startAndMapToReview`, whose return type (`PrepareApplicationReachableState`)
 * doesn't even include `approved`/`submitting`/`submitted` as possible
 * values, and the input schema is `.strict()` with a single field
 * (`applicationId`) -- there is no parameter here that could ask for more.
 * Final approval/submit happens exclusively in the web UI (M6 tasks
 * 052/053), which holds a SEPARATE capability this process never imports.
 */
export function makePrepareApplicationTool(deps: McpDeps): ToolDef<PrepareApplicationInput, PrepareApplicationResult> {
  const prepareApplication = makePrepareApplicationUseCase({ applications: deps.applications, applyTasks: deps.applyTasks });
  return {
    name: 'prepare_application',
    description:
      'Create an ApplyTask and run form mapping, stopping at awaiting_review. This tool can NEVER submit an ' +
      'application, approve a task, or advance it past awaiting_review under any input -- final approval and ' +
      'submission only ever happen through the web UI.',
    scope: 'write:pipeline',
    inputSchema: PrepareApplicationInputSchema,
    handler: async (input, ctx) => prepareApplication({ userId: asUserId(ctx.userId) }, input),
  };
}
