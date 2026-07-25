import { asUserId } from '@careerpilot/domain';
import { MatchJobInputSchema, type MatchJobInput } from '@careerpilot/contracts';
import { makeMatchSingleJobUseCase, type MatchSingleJobOutput } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

const DESCRIPTION =
  "Read the caller's active-profile rubric match score for a job (method 'embedding', the default, is a " +
  "pure read of whatever score already exists) or force a live recompute (method 'rubric' -- a budget-guarded " +
  'LLM call, persisted on success).';

export function makeMatchJobTool(deps: McpDeps): ToolDef<MatchJobInput, MatchSingleJobOutput> {
  const matchSingleJob = makeMatchSingleJobUseCase({
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    matchScores: deps.matchScores,
    llm: deps.guardedLlm,
    prompts: deps.prompts,
    model: deps.llmModel,
  });
  return {
    name: 'match_job',
    description: DESCRIPTION,
    scope: 'read',
    inputSchema: MatchJobInputSchema,
    handler: async (input, ctx) => matchSingleJob({ userId: asUserId(ctx.userId) }, input),
  };
}
