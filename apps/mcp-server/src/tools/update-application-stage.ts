import { asUserId } from '@careerpilot/domain';
import { UpdateApplicationStageInputSchema, type UpdateApplicationStageInput } from '@careerpilot/contracts';
import { makeUpdateStageUseCase, type UpdateStageOutput } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export function makeUpdateApplicationStageTool(deps: McpDeps): ToolDef<UpdateApplicationStageInput, UpdateStageOutput> {
  const updateStage = makeUpdateStageUseCase({ uow: deps.uow });
  return {
    name: 'update_application_stage',
    description:
      'Move an application card to a new pipeline stage. Illegal transitions are rejected by the domain state ' +
      "machine. Logged with actor 'agent' -- an MCP-token identity, distinguishable from a human 'user' action " +
      'in the stage-transition history.',
    scope: 'write:pipeline',
    inputSchema: UpdateApplicationStageInputSchema,
    handler: async (input, ctx) =>
      updateStage({ userId: asUserId(ctx.userId) }, {
        applicationId: input.applicationId,
        toStage: input.toStage,
        reason: input.reason,
        actor: 'agent',
      }),
  };
}
