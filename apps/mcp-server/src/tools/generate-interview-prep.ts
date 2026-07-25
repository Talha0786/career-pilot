import { validationFailed } from '@careerpilot/domain';
import { asUserId } from '@careerpilot/domain';
import { GenerateInterviewPrepInputSchema, type GenerateInterviewPrepInput } from '@careerpilot/contracts';
import {
  makeGenerateQuestionsUseCase,
  makeResearchCompanyUseCase,
  makeRunMockInterviewTurnUseCase,
} from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

/**
 * Task 060/061's single `generate_interview_prep` tool (§3: `{
 * applicationId, kind }`), dispatching to three distinct pipelines by
 * `kind`. `kind: 'mock_interview'` is SESSION-based (task 061's design
 * note: "a reasonable design is generate_interview_prep({kind:
 * 'mock_interview'}) starts a session, subsequent turns go through a
 * lighter-weight continuation path since MCP tool calls are typically
 * request/response, not a persistent stream") — implemented here as: a
 * call with no `sessionId` starts a new session (the interviewer opens);
 * a call WITH `sessionId` (+ optional `message`, the candidate's reply)
 * continues that same session. Both are the same tool call shape, just
 * with/without the two optional fields — no separate start/continue/end
 * tool triplet, since request/response MCP calls compose fine here
 * without one.
 */
export function makeGenerateInterviewPrepTool(deps: McpDeps): ToolDef<GenerateInterviewPrepInput, unknown> {
  const generateQuestions = makeGenerateQuestionsUseCase({
    applications: deps.applications, jobPostings: deps.jobPostings, profiles: deps.profiles,
    interviewPreps: deps.interviewPreps, llm: deps.guardedLlm, prompts: deps.prompts, model: deps.llmModel,
  });
  const researchCompany = makeResearchCompanyUseCase({
    applications: deps.applications, jobPostings: deps.jobPostings, interviewPreps: deps.interviewPreps,
    llm: deps.guardedLlm, prompts: deps.prompts, search: deps.search, fetcher: deps.fetcher, model: deps.llmModel,
  });
  const runMockInterviewTurn = makeRunMockInterviewTurnUseCase({
    applications: deps.applications, jobPostings: deps.jobPostings, profiles: deps.profiles,
    interviewPreps: deps.interviewPreps, llm: deps.guardedLlm, prompts: deps.prompts, model: deps.llmModel,
  });

  return {
    name: 'generate_interview_prep',
    description:
      "Generate interview prep material for an application. kind: 'questions' (a bounded, budget-guarded " +
      "practice question set) | 'company_research' (a bounded 8-tool-call research brief, uncited claims " +
      "always dropped) | 'mock_interview' (a turn-capped chat-loop mock interview session -- omit sessionId " +
      'to start a new one, pass sessionId + message to continue).',
    scope: 'write:documents',
    inputSchema: GenerateInterviewPrepInputSchema,
    handler: async (input, ctx) => {
      const actor = { userId: asUserId(ctx.userId) };
      switch (input.kind) {
        case 'questions':
          return generateQuestions(actor, { applicationId: input.applicationId });
        case 'company_research':
          return researchCompany(actor, { applicationId: input.applicationId });
        case 'mock_interview':
          return runMockInterviewTurn(actor, {
            applicationId: input.applicationId,
            sessionId: input.sessionId,
            candidateMessage: input.message,
          });
        default:
          return { ok: false, error: validationFailed(`Unknown kind`) };
      }
    },
  };
}
