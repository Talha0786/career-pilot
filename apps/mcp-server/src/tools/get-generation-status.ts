import { asUserId } from '@careerpilot/domain';
import { GetGenerationStatusInputSchema, type GetGenerationStatusInput } from '@careerpilot/contracts';
import { makeGetGenerationStatusUseCase, type GetGenerationStatusOutput } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export function makeGetGenerationStatusTool(deps: McpDeps): ToolDef<GetGenerationStatusInput, GetGenerationStatusOutput> {
  const getStatus = makeGetGenerationStatusUseCase({ documents: deps.documents });
  return {
    name: 'get_generation_status',
    description:
      "Poll the status of a document-generation job started by tailor_document. 'pending' covers both " +
      '"still running" and "unknown id" -- this tool never distinguishes them via an error.',
    scope: 'read',
    inputSchema: GetGenerationStatusInputSchema,
    handler: async (input, ctx) => getStatus({ userId: asUserId(ctx.userId) }, input),
  };
}
