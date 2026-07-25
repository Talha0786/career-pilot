import { asUserId } from '@careerpilot/domain';
import { AddApplicationNoteInputSchema, type AddApplicationNoteInput } from '@careerpilot/contracts';
import { makeAddApplicationNoteUseCase, type AddApplicationNoteOutput } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export function makeAddApplicationNoteTool(deps: McpDeps): ToolDef<AddApplicationNoteInput, AddApplicationNoteOutput> {
  const addNote = makeAddApplicationNoteUseCase({ applications: deps.applications, notes: deps.applicationNotes });
  return {
    name: 'add_application_note',
    description: 'Append a markdown note to an application, attributed to the calling MCP token (actor: agent).',
    scope: 'write:pipeline',
    inputSchema: AddApplicationNoteInputSchema,
    handler: async (input, ctx) =>
      addNote({ userId: asUserId(ctx.userId) }, { applicationId: input.applicationId, noteMd: input.noteMd, actor: 'agent' }),
  };
}
