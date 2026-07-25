import { asUserId, notFound } from '@careerpilot/domain';
import { makeGetApplicationUseCase } from '@careerpilot/application';
import type { ResourceDef } from '../registry.js';
import type { McpDeps } from '../di.js';

/** `careerpilot://application/{id}` (§4) -- thin read projection, no mutation path. */
export function makeApplicationResource(deps: McpDeps): ResourceDef {
  const getApplication = makeGetApplicationUseCase({ applications: deps.applications, jobPostings: deps.jobPostings });
  return {
    uriTemplate: 'careerpilot://application/{id}',
    description: 'A single pipeline application by id.',
    resolve: async (params, ctx) => {
      const id = params.id;
      if (!id) return { ok: false, error: notFound('Missing application id') };
      return getApplication({ userId: asUserId(ctx.userId) }, id);
    },
  };
}
