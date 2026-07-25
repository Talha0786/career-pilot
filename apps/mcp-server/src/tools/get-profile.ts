import { asUserId } from '@careerpilot/domain';
import { GetProfileInputSchema, type GetProfileInput } from '@careerpilot/contracts';
import { makeGetProfileUseCase, type CareerProfileSummary } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

/**
 * `profileId` is accepted in the input schema (§3) but not yet used to
 * disambiguate — `ProfileRepository.findActiveForUser` is the only lookup
 * `get-profile.ts` (task 022/application layer) has ever exposed, since
 * M3 treats "career profile" as a per-user singleton everywhere else in
 * the codebase (see that query's own doc comment). Matches existing HTTP
 * API behavior exactly rather than inventing new multi-profile semantics
 * here.
 */
export function makeGetProfileTool(deps: McpDeps): ToolDef<GetProfileInput, CareerProfileSummary> {
  const getProfile = makeGetProfileUseCase({ profiles: deps.profiles });
  return {
    name: 'get_profile',
    description: 'Fetch the caller\'s structured career profile (sections, facts hash, embedding status).',
    scope: 'read',
    inputSchema: GetProfileInputSchema,
    handler: async (_input, ctx) => getProfile({ userId: asUserId(ctx.userId) }),
  };
}
