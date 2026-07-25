import { describe, it, expect } from 'vitest';
import { StageSchema, UpdateStageRequestSchema } from './board.js';
import { UpdateApplicationStageInputSchema, TailorDocumentInputSchema, GetJobInputSchema } from './mcp.js';
import { CreateManualJobRequestSchema, JobPostingDtoSchema } from './jobs.js';
import { TailoringRequestSchema } from './tailoring.js';

/**
 * Task 062 — `docs/04-mcp-design.md` §6's "Tool schema drift vs API |
 * Shared zod contracts package; CI schema-diff check". This is that
 * check: a plain unit test (so it runs in CI's existing `unit` job, no
 * new workflow needed) asserting that fields the MCP tool contracts
 * (mcp.ts) and the HTTP API contracts (board.ts/jobs.ts/tailoring.ts)
 * BOTH describe for the same underlying concept stay structurally
 * identical. If a future change edits one side's enum/shape without the
 * other, this test fails loudly instead of the two contracts silently
 * diverging.
 */
describe('MCP <-> HTTP API contract schema-diff (task 062)', () => {
  it('update_application_stage.toStage and the board API\'s toStage share the exact same Stage enum', () => {
    const mcpStageValues = UpdateApplicationStageInputSchema.shape.toStage.options;
    const apiStageValues = UpdateStageRequestSchema.shape.toStage.options;
    expect(mcpStageValues).toEqual(apiStageValues);
    expect(mcpStageValues).toEqual(StageSchema.options);
  });

  it('update_application_stage.reason has the same max-length constraint as the API\'s UpdateStageRequestSchema.reason', () => {
    const mcpMax = UpdateApplicationStageInputSchema.shape.reason.unwrap().maxLength;
    const apiMax = UpdateStageRequestSchema.shape.reason.unwrap().maxLength;
    expect(mcpMax).toBe(apiMax);
  });

  it('tailor_document.jobPostingId and the tailoring API\'s jobPostingId are both bare uuid fields (no extra constraints silently added on one side)', () => {
    expect(TailorDocumentInputSchema.shape.jobPostingId._def.typeName).toBe(TailoringRequestSchema.shape.jobPostingId._def.typeName);
  });

  it('get_job.jobId and get-job\'s underlying JobPostingDto.id are both uuid-typed', () => {
    expect(GetJobInputSchema.shape.jobId._def.typeName).toBe(JobPostingDtoSchema.shape.id._def.typeName);
  });

  it('CreateManualJobRequestSchema.title and JobPostingDtoSchema.title stay consistent in type (both plain strings, MCP never silently loosens/tightens a shared field)', () => {
    expect(CreateManualJobRequestSchema.shape.title._def.typeName).toBe('ZodString');
    expect(JobPostingDtoSchema.shape.title._def.typeName).toBe('ZodString');
  });
});
