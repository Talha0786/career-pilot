import { asUserId, notFound, type Result, type DomainError } from '@careerpilot/domain';
import { makeGetJobUseCase } from '@careerpilot/application';
import type { ResourceDef } from '../registry.js';
import type { McpDeps } from '../di.js';
import { wrapUntrustedContent, type UntrustedContentEnvelope } from '../untrusted-envelope.js';

export interface JobResourceValue {
  id: string;
  title: string;
  company: string | null;
  url: string | null;
  description: UntrustedContentEnvelope;
  embeddingStatus: string;
}

/** `careerpilot://job/{id}` (§4) -- thin read projection over 057's `get_job` query, same untrusted-content envelope on the JD text. */
export function makeJobResource(deps: McpDeps): ResourceDef {
  const getJob = makeGetJobUseCase({ jobPostings: deps.jobPostings });
  return {
    uriTemplate: 'careerpilot://job/{id}',
    description: 'A single job posting by id.',
    resolve: async (params, ctx): Promise<Result<JobResourceValue, DomainError>> => {
      const id = params.id;
      if (!id) return { ok: false, error: notFound('Missing job id') };
      const result = await getJob({ userId: asUserId(ctx.userId) }, id);
      if (!result.ok) return result;
      const job = result.value;
      return {
        ok: true,
        value: {
          id: job.id,
          title: job.title,
          company: job.company,
          url: job.url,
          description: wrapUntrustedContent(job.descriptionMd),
          embeddingStatus: job.embeddingStatus,
        },
      };
    },
  };
}
