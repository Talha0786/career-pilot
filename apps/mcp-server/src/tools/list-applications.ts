import { ok, asUserId } from '@careerpilot/domain';
import { ListApplicationsInputSchema, type ListApplicationsInput } from '@careerpilot/contracts';
import { makeListApplicationsUseCase, type ListApplicationsItem } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export function makeListApplicationsTool(deps: McpDeps): ToolDef<ListApplicationsInput, { items: ListApplicationsItem[] }> {
  const listApplications = makeListApplicationsUseCase({ applications: deps.applications, jobPostings: deps.jobPostings });
  return {
    name: 'list_applications',
    description: 'List the pipeline applications, optionally filtered by stage or minimum staleness (days since last update).',
    scope: 'read',
    inputSchema: ListApplicationsInputSchema,
    handler: async (input, ctx) => {
      const items = await listApplications({ userId: asUserId(ctx.userId) }, input);
      return ok({ items });
    },
  };
}
