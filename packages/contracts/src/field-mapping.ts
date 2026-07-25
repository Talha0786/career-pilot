import { z } from 'zod';

/**
 * Task 050 — zod mirror of `packages/domain/src/apply/field-taxonomy.ts`'s
 * `TAXONOMY_FIELD_KEYS`. Independently maintained, NOT imported from
 * domain — `@careerpilot/contracts` has zero cross-package dependencies by
 * design (its `package.json` declares only `zod`), same posture as
 * `matching.ts`'s `ScoreComponentsSchema` mirroring
 * `packages/domain/src/matching/match-score.ts`'s `ScoreComponents`. Keep
 * this list in sync with domain's if the taxonomy ever changes.
 */
export const TAXONOMY_FIELD_KEYS_DTO = [
  'firstName', 'lastName', 'email', 'phone', 'resumeUpload', 'coverLetterUpload',
  'linkedinUrl', 'portfolioUrl', 'workAuthorization', 'sponsorshipRequired',
  'howDidYouHear', 'eeoGender', 'eeoRace', 'eeoVeteranStatus', 'eeoDisabilityStatus',
] as const;

/**
 * The plain-data (Playwright-free) shape of one form field, as it crosses
 * any HTTP/service boundary this pipeline has (e.g. the browser-runner
 * internal task API, task 047). `packages/application`'s
 * `FieldDetectionPort` (task 050) defines its OWN plain-TS interface for
 * the same shape used purely in-process — this schema is for the DTO
 * boundary specifically.
 */
export const SerializedFormFieldSchema = z.object({
  selector: z.string().min(1),
  tagName: z.enum(['input', 'select', 'textarea']),
  type: z.string().nullable(),
  name: z.string().nullable(),
  id: z.string().nullable(),
  autocomplete: z.string().nullable(),
  ariaLabel: z.string().nullable(),
  labelText: z.string().nullable(),
  placeholder: z.string().nullable(),
});
export type SerializedFormFieldDto = z.infer<typeof SerializedFormFieldSchema>;

/**
 * The LLM field-mapper's raw classification output shape
 * (`prompts/field-map/v1.md`'s documented response contract). `draftAnswer`
 * populated only when the task opted in to essay-question drafting (§4).
 */
export const FieldMapEntrySchema = z.object({
  selector: z.string().min(1),
  taxonomyKey: z.enum(TAXONOMY_FIELD_KEYS_DTO).nullable(),
  confidence: z.number().min(0).max(1),
  draftAnswer: z.string().max(4000).nullable().optional(),
});
export type FieldMapEntryDto = z.infer<typeof FieldMapEntrySchema>;

export const FieldMapSchema = z.object({
  fields: z.array(FieldMapEntrySchema),
});
export type FieldMapDto = z.infer<typeof FieldMapSchema>;

/** task 052's review-diff DTO: what field-value diff view + the batch review queue API read. */
export const ApplyTaskFieldDiffEntrySchema = z.object({
  taxonomyKey: z.enum(TAXONOMY_FIELD_KEYS_DTO),
  label: z.string(),
  selector: z.string(),
  mappedValue: z.string().nullable(),
  neverAutoFill: z.boolean(),
  confidence: z.number().min(0).max(1),
  source: z.enum(['known_ats', 'heuristic', 'llm']),
});
export type ApplyTaskFieldDiffEntryDto = z.infer<typeof ApplyTaskFieldDiffEntrySchema>;
