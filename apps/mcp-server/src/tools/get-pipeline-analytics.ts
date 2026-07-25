import { ok, asUserId } from '@careerpilot/domain';
import { GetPipelineAnalyticsInputSchema, type GetPipelineAnalyticsInput } from '@careerpilot/contracts';
import { makeGetPipelineAnalyticsUseCase, type PipelineAnalytics } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export function makeGetPipelineAnalyticsTool(deps: McpDeps): ToolDef<GetPipelineAnalyticsInput, PipelineAnalytics> {
  const getPipelineAnalytics = makeGetPipelineAnalyticsUseCase({
    applications: deps.applications,
    matchScores: deps.matchScores,
    profiles: deps.profiles,
  });
  return {
    name: 'get_pipeline_analytics',
    description:
      'Minimal funnel stats for the pipeline over a range (7d/30d/90d/all): totals by stage, stale-application ' +
      'count, average match score. Not the full M8 analytics dashboard -- a bounded, in-memory computation.',
    scope: 'read',
    inputSchema: GetPipelineAnalyticsInputSchema,
    handler: async (input, ctx) => ok(await getPipelineAnalytics({ userId: asUserId(ctx.userId) }, input)),
  };
}
