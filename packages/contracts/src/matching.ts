import { z } from 'zod';

/**
 * Mirrors `packages/domain/src/matching/match-score.ts`'s `ScoreComponents`
 * and `prompts/match-score/v1.md`'s output shape EXACTLY (task 038) — this
 * is what `score-match.ts` validates the LLM's raw JSON response against.
 * See that domain file's doc comment for why these 5 dimensions
 * (skills/experience/seniority/domain/location) rather than
 * `docs/02-database-design.md`'s original `{skills, seniority, domain,
 * location, compensation}` set.
 */
export const ScoreComponentsSchema = z.object({
  skills: z.number().min(0).max(1),
  experience: z.number().min(0).max(1),
  seniority: z.number().min(0).max(1),
  domain: z.number().min(0).max(1),
  location: z.number().min(0).max(1),
  overall: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});
export type ScoreComponentsDto = z.infer<typeof ScoreComponentsSchema>;

export const MatchScoreDtoSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  jobPostingId: z.string(),
  components: ScoreComponentsSchema,
  computedAt: z.string(),
  factsHash: z.string(),
  embeddingModel: z.string(),
});
export type MatchScoreDto = z.infer<typeof MatchScoreDtoSchema>;

export const RescanResponseSchema = z.object({ queued: z.literal(true) });
export type RescanResponse = z.infer<typeof RescanResponseSchema>;
