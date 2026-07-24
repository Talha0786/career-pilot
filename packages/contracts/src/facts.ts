import { z } from 'zod';

/**
 * DTO mirror of `packages/domain/src/profile/fact-list.ts`'s `Fact` (task
 * 037) — the anti-hallucination contract's fact base. Consumed by the
 * tailoring (039) and claim-verification (040) prompts/schemas.
 */
export const FactSchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1),
  text: z.string().min(1),
});
export type FactDto = z.infer<typeof FactSchema>;
