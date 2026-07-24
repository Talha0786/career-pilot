import { z } from 'zod';
import { ResumeDocumentContentSchema, CoverLetterDocumentContentSchema } from './documents.js';

/**
 * Task 039. `kind` determines which structured-content schema the generated
 * version must validate against — reusing task 022's existing document
 * content schemas verbatim (`ResumeDocumentContentSchema`/
 * `CoverLetterDocumentContentSchema`), not forking a new structured-doc
 * model, per the task's explicit instruction.
 */
export const TailoringRequestSchema = z.object({
  jobPostingId: z.string().uuid(),
});
export type TailoringRequest = z.infer<typeof TailoringRequestSchema>;

/**
 * The tailored content, wrapping the existing document-content schemas —
 * the per-bullet `supportingFactIds` citation (task 039) is threaded
 * THROUGH those schemas directly (`ResumeEntrySchema.bulletFacts`,
 * `CoverLetterDocumentContentSchema.paragraphFacts` — both additive
 * optional fields, see `packages/domain/src/documents/document-content.ts`),
 * rather than a separate parallel structure, so this is a plain
 * discriminated union of the two, not a new wrapper shape.
 */
export const TailoringResultSchema = z.discriminatedUnion('kind', [
  ResumeDocumentContentSchema,
  CoverLetterDocumentContentSchema,
]);
export type TailoringResult = z.infer<typeof TailoringResultSchema>;

export const TailorDocumentResponseSchema = z.object({ queued: z.literal(true) });
export type TailorDocumentResponse = z.infer<typeof TailorDocumentResponseSchema>;

/** Server -> client push when the tailoring worker finishes (or fails) — same WS pattern as JobEmbeddedEvent (jobs.ts). */
export const DocumentTailoredEventSchema = z.object({
  type: z.literal('document.tailored'),
  documentId: z.string().uuid(),
  status: z.enum(['ready', 'failed']),
});
export type DocumentTailoredEvent = z.infer<typeof DocumentTailoredEventSchema>;

/** Task 040 — the adversarial claim-verification pass's output shape. */
export const ClaimAuditClaimSchema = z.object({
  text: z.string().min(1),
  /** null = UNSUPPORTED — no fact independently re-derives this claim. */
  factId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export const ClaimAuditSchema = z.object({
  claims: z.array(ClaimAuditClaimSchema),
});
export type ClaimAudit = z.infer<typeof ClaimAuditSchema>;
