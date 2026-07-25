import { z } from 'zod';

/**
 * Task 060 — `docs/06-agent-design.md` §3 "Interview Q&A generation |
 * pipeline | mid | QuestionSet schema". One deterministic LLM pass over
 * (JD + compiled profile facts) → a bounded list of practice questions,
 * each tagged with a category so the UI can group them.
 */
export const InterviewQuestionSchema = z.object({
  question: z.string().min(1).max(1000),
  category: z.enum(['behavioral', 'technical', 'role_specific', 'company_culture']),
  /** Why this question is likely given the JD/profile — not shown as a "correct answer," just prep context. */
  rationale: z.string().max(1000).optional(),
});
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

export const QuestionSetSchema = z.object({
  questions: z.array(InterviewQuestionSchema).min(1).max(20),
});
export type QuestionSet = z.infer<typeof QuestionSetSchema>;

/**
 * Task 060 — company research brief. `docs/06-agent-design.md` §5: "bounded
 * tool loop (max 8 tool calls)... synthesize brief with citations. Output
 * schema-validated; uncited claims dropped."
 *
 * Two schemas, deliberately: `RawCompanyResearchBriefSchema` is what the
 * LLM's raw JSON is validated against FIRST (citations may legally be an
 * empty array here — that's exactly the "uncited claim" case the pipeline
 * must detect); `CompanyResearchBriefSchema` (citations `min(1)`) is what
 * the pipeline's own claim-stripping step produces and what callers of
 * the finished brief should expect — an uncited claim structurally cannot
 * exist in a value that type-checks against this schema.
 */
export const CitationSchema = z.object({
  url: z.string().url(),
  title: z.string().max(300).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const RawCompanyResearchClaimSchema = z.object({
  claim: z.string().min(1).max(1000),
  citations: z.array(CitationSchema).max(5),
});
export const RawCompanyResearchBriefSchema = z.object({
  companyName: z.string().min(1).max(300),
  summary: z.string().max(2000),
  claims: z.array(RawCompanyResearchClaimSchema).max(30),
});
export type RawCompanyResearchBrief = z.infer<typeof RawCompanyResearchBriefSchema>;

export const CompanyResearchClaimSchema = z.object({
  claim: z.string().min(1).max(1000),
  citations: z.array(CitationSchema).min(1).max(5),
});
export const CompanyResearchBriefSchema = z.object({
  companyName: z.string().min(1).max(300),
  summary: z.string().max(2000),
  claims: z.array(CompanyResearchClaimSchema),
  droppedUncitedClaimCount: z.number().int().nonnegative(),
  toolCallsUsed: z.number().int().min(0).max(8),
});
export type CompanyResearchBrief = z.infer<typeof CompanyResearchBriefSchema>;

/** Task 061 — one turn of the mock-interviewer transcript, persisted under `interview_preps` (kind: mock_interview_transcript). */
export const MockInterviewTurnSchema = z.object({
  role: z.enum(['interviewer', 'candidate']),
  content: z.string().min(1).max(5000),
  at: z.string().datetime(),
});
export type MockInterviewTurn = z.infer<typeof MockInterviewTurnSchema>;

export const MockInterviewTranscriptSchema = z.object({
  applicationId: z.string().uuid(),
  turns: z.array(MockInterviewTurnSchema).max(40),
  status: z.enum(['in_progress', 'completed_turn_cap', 'completed_ended', 'ended_budget_exhausted']),
});
export type MockInterviewTranscript = z.infer<typeof MockInterviewTranscriptSchema>;
