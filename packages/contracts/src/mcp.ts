import { z } from 'zod';
import { StageSchema } from './board.js';
import { ScoreComponentsSchema } from './matching.js';

/**
 * Task 057/058. Input contracts for the MCP tool catalog
 * (`docs/04-mcp-design.md` §3) that don't already have a matching HTTP-API
 * DTO to reuse. Kept separate from board.ts/jobs.ts/tailoring.ts (which
 * describe apps/api's HTTP surface) since the MCP tool inputs are a
 * distinct, if overlapping, contract — task 062's schema-diff check is
 * what keeps the overlapping fields (e.g. `toStage`, `jobPostingId`) from
 * silently diverging between the two surfaces.
 */

export const SearchJobsFiltersSchema = z.object({
  remote: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  location: z.string().max(200).optional(),
  minSalary: z.number().nonnegative().optional(),
  postedAfter: z.string().datetime().optional(),
});
export const SearchJobsInputSchema = z.object({
  query: z.string().max(500).optional(),
  filters: SearchJobsFiltersSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type SearchJobsInput = z.infer<typeof SearchJobsInputSchema>;

export const GetJobInputSchema = z.object({ jobId: z.string().uuid() });
export type GetJobInput = z.infer<typeof GetJobInputSchema>;

export const GetProfileInputSchema = z.object({ profileId: z.string().uuid().optional() });
export type GetProfileInput = z.infer<typeof GetProfileInputSchema>;

export const MatchJobInputSchema = z.object({
  jobId: z.string().uuid(),
  method: z.enum(['embedding', 'rubric']).optional(),
});
export type MatchJobInput = z.infer<typeof MatchJobInputSchema>;

export const ListApplicationsInputSchema = z.object({
  stage: StageSchema.optional(),
  staleDays: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListApplicationsInput = z.infer<typeof ListApplicationsInputSchema>;

/**
 * `toStage`/`reason` deliberately reuse `UpdateStageRequestSchema`'s exact
 * field names/types (board.ts) plus `applicationId` — this IS the
 * schema-overlap task 062's CI schema-diff check exists to protect, so the
 * two are composed rather than redeclared field-by-field.
 */
export const UpdateApplicationStageInputSchema = z.object({
  applicationId: z.string().uuid(),
  toStage: StageSchema,
  reason: z.string().max(500).optional(),
});
export type UpdateApplicationStageInput = z.infer<typeof UpdateApplicationStageInputSchema>;

export const AddApplicationNoteInputSchema = z.object({
  applicationId: z.string().uuid(),
  noteMd: z.string().min(1).max(10_000),
});
export type AddApplicationNoteInput = z.infer<typeof AddApplicationNoteInputSchema>;

export const TailorDocumentInputSchema = z.object({
  jobPostingId: z.string().uuid(),
  kind: z.enum(['resume', 'cover_letter']),
  baseDocumentId: z.string().uuid().optional(),
});
export type TailorDocumentInput = z.infer<typeof TailorDocumentInputSchema>;

export const GetGenerationStatusInputSchema = z.object({ generationJobId: z.string().min(1) });
export type GetGenerationStatusInput = z.infer<typeof GetGenerationStatusInputSchema>;

/**
 * §2 rule 1 / §3's "Deliberately absent" list, made structural: this
 * schema has NO field that could force an ApplyTask past `awaiting_review`
 * (no `autoApprove`, no `submit`, no `confirm`) — `.strict()` additionally
 * rejects any unrecognized extra key outright, so even an MCP client that
 * somehow injects an out-of-schema field gets a validation_failed error at
 * the registry layer, never a silent pass-through to the handler (task
 * 058's adversarial test exercises exactly this).
 */
export const PrepareApplicationInputSchema = z.object({
  applicationId: z.string().uuid(),
}).strict();
export type PrepareApplicationInput = z.infer<typeof PrepareApplicationInputSchema>;

export const GenerateInterviewPrepInputSchema = z.object({
  applicationId: z.string().uuid(),
  kind: z.enum(['questions', 'company_research', 'mock_interview']),
  /** Only meaningful for kind: 'mock_interview' continuations (task 061) — the running session id. Omitted starts a new session. */
  sessionId: z.string().uuid().optional(),
  /** Only meaningful for kind: 'mock_interview' continuations — the candidate's reply to the interviewer's last question. */
  message: z.string().max(5000).optional(),
});
export type GenerateInterviewPrepInput = z.infer<typeof GenerateInterviewPrepInputSchema>;

export const GetPipelineAnalyticsInputSchema = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
});
export type GetPipelineAnalyticsInput = z.infer<typeof GetPipelineAnalyticsInputSchema>;

export const PipelineAnalyticsSchema = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']),
  totalApplications: z.number().int().nonnegative(),
  byStage: z.record(StageSchema, z.number().int().nonnegative()),
  staleApplications: z.number().int().nonnegative(),
  averageMatchScore: z.number().min(0).max(1).nullable(),
});
export type PipelineAnalytics = z.infer<typeof PipelineAnalyticsSchema>;

/** Re-exported for tool files that only need the shared rubric shape. */
export { ScoreComponentsSchema };

/**
 * Task 056's `apps/api/src/routes/mcp-tokens.ts` -- the user-facing way
 * to mint/revoke MCP bearer tokens (§2 rule 4: "default token is
 * read-only").
 */
export const McpScopeSchema = z.enum(['read', 'write:pipeline', 'write:documents']);

export const MintMcpTokenRequestSchema = z.object({
  label: z.string().min(1).max(200),
  scopes: z.array(McpScopeSchema).min(1).default(['read']),
});
export type MintMcpTokenRequest = z.infer<typeof MintMcpTokenRequestSchema>;

/** The plaintext token appears ONLY in this one response, at mint time -- never again. */
export const MintMcpTokenResponseSchema = z.object({
  id: z.string().uuid(),
  token: z.string(),
  label: z.string(),
  scopes: z.array(McpScopeSchema),
});
export type MintMcpTokenResponse = z.infer<typeof MintMcpTokenResponseSchema>;

export const McpTokenDtoSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  scopes: z.array(McpScopeSchema),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type McpTokenDto = z.infer<typeof McpTokenDtoSchema>;

export const ListMcpTokensResponseSchema = z.object({ items: z.array(McpTokenDtoSchema) });
export type ListMcpTokensResponse = z.infer<typeof ListMcpTokensResponseSchema>;
