import { asUserId } from '@careerpilot/domain';
import { makeGetProfileUseCase } from '@careerpilot/application';
import type { ResourceDef } from '../registry.js';
import type { McpDeps } from '../di.js';

/**
 * `careerpilot://profile/{id}` (§4). `{id}` is accepted for URI-template
 * shape parity with `job`/`application` but not used to disambiguate --
 * same reasoning as `get_profile`'s tool doc comment (057): the
 * underlying query has only ever supported the caller's single active
 * profile. A thin read projection over 057's query, no duplicate logic.
 */
export function makeProfileResource(deps: McpDeps): ResourceDef {
  const getProfile = makeGetProfileUseCase({ profiles: deps.profiles });
  return {
    uriTemplate: 'careerpilot://profile/{id}',
    description: "The caller's structured career profile.",
    resolve: async (_params, ctx) => getProfile({ userId: asUserId(ctx.userId) }),
  };
}
