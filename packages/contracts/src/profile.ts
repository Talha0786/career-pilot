import { z } from 'zod';

export const ProfileSectionKindSchema = z.enum([
  'experience',
  'education',
  'project',
  'skill_group',
  'certification',
  'summary',
]);
export type ProfileSectionKindDto = z.infer<typeof ProfileSectionKindSchema>;

export const ExperienceContentSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(200),
  organization: z.string().min(1).max(200),
  startDate: z.string().min(1).max(20),
  endDate: z.string().max(20).nullable(),
  location: z.string().max(200).optional(),
  bullets: z.array(z.string().max(1000)).max(50),
});

export const EducationContentSchema = z.object({
  schemaVersion: z.literal(1),
  institution: z.string().min(1).max(200),
  credential: z.string().min(1).max(200),
  startDate: z.string().min(1).max(20),
  endDate: z.string().max(20).nullable(),
  details: z.array(z.string().max(1000)).max(50).optional(),
});

export const ProjectContentSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  url: z.string().url().max(2048).optional(),
  bullets: z.array(z.string().max(1000)).max(50),
});

export const SkillGroupContentSchema = z.object({
  schemaVersion: z.literal(1),
  groupName: z.string().min(1).max(200),
  skills: z.array(z.string().min(1).max(100)).min(1).max(100),
});

export const CertificationContentSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(200),
  issuer: z.string().min(1).max(200),
  issuedDate: z.string().max(20).optional(),
});

export const SummaryContentSchema = z.object({
  schemaVersion: z.literal(1),
  text: z.string().min(1).max(4000),
});

/** kind + content shaped as a discriminated union so a malformed pair is rejected at the edge. */
export const AddSectionRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('experience'), content: ExperienceContentSchema, sort: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('education'), content: EducationContentSchema, sort: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('project'), content: ProjectContentSchema, sort: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('skill_group'), content: SkillGroupContentSchema, sort: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('certification'), content: CertificationContentSchema, sort: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('summary'), content: SummaryContentSchema, sort: z.number().int().min(0).optional() }),
]);
export type AddSectionRequest = z.infer<typeof AddSectionRequestSchema>;

export const AddSectionResponseSchema = z.object({
  profileId: z.string().uuid(),
  sectionId: z.string().uuid(),
});
export type AddSectionResponse = z.infer<typeof AddSectionResponseSchema>;

/** PUT /api/profile — upsert semantics (create if absent, else update). */
export const PutProfileRequestSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).nullable().optional(),
});
export type PutProfileRequest = z.infer<typeof PutProfileRequestSchema>;

export const ProfileSectionDtoSchema = z.object({
  id: z.string().uuid(),
  kind: ProfileSectionKindSchema,
  sort: z.number().int(),
  content: z.union([
    ExperienceContentSchema,
    EducationContentSchema,
    ProjectContentSchema,
    SkillGroupContentSchema,
    CertificationContentSchema,
    SummaryContentSchema,
  ]),
});
export type ProfileSectionDto = z.infer<typeof ProfileSectionDtoSchema>;

export const ProfileEmbeddingStatusSchema = z.enum(['pending', 'ready', 'failed']);

export const CareerProfileDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string().nullable(),
  isActive: z.boolean(),
  embeddingStatus: ProfileEmbeddingStatusSchema,
  factsHash: z.string(),
  isEmbeddingStale: z.boolean(),
  sections: z.array(ProfileSectionDtoSchema),
  createdAt: z.string().datetime(),
});
export type CareerProfileDto = z.infer<typeof CareerProfileDtoSchema>;

// --- Resume import (task 023) ---
// Deliberately hardcoded mime-type literals, not imported from
// @careerpilot/application/domain — contracts has zero deps beyond zod
// (existing convention, packages/contracts/package.json).
export const RESUME_IMPORT_PDF_MIME = 'application/pdf';
export const RESUME_IMPORT_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** JSON+base64 body, not true multipart — see task 022's deliberate-deviation note for why. */
export const ImportResumeRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum([RESUME_IMPORT_PDF_MIME, RESUME_IMPORT_DOCX_MIME]),
  fileBase64: z.string().min(1),
});
export type ImportResumeRequest = z.infer<typeof ImportResumeRequestSchema>;

export const ImportResumeResponseSchema = z.object({ draftId: z.string().uuid() });
export type ImportResumeResponse = z.infer<typeof ImportResumeResponseSchema>;

const DraftField = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ value: inner, confidence: z.number().min(0).max(1) });

export const ResumeImportDraftSectionSchema = z.object({
  kind: ProfileSectionKindSchema,
  content: ProfileSectionDtoSchema.shape.content,
  confidence: z.number().min(0).max(1),
});

export const ResumeImportDraftContentSchema = z.object({
  contact: z.object({
    name: DraftField(z.string().nullable()),
    email: DraftField(z.string().nullable()),
    phone: DraftField(z.string().nullable()),
  }),
  summary: DraftField(z.string().nullable()),
  sections: z.array(ResumeImportDraftSectionSchema),
});

export const ResumeImportDraftStatusSchema = z.enum(['processing', 'ready', 'failed']);

export const GetResumeImportDraftResponseSchema = z.object({
  draftId: z.string().uuid(),
  filename: z.string(),
  status: ResumeImportDraftStatusSchema,
  draft: ResumeImportDraftContentSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type GetResumeImportDraftResponse = z.infer<typeof GetResumeImportDraftResponseSchema>;

/** The reviewed/edited section list from the confirm screen — reuses AddSectionRequestSchema's kind+content shape (its `sort` is optional and simply unused here). */
export const ConfirmResumeImportRequestSchema = z.object({
  sections: z.array(AddSectionRequestSchema).min(1),
  profileTitle: z.string().min(1).max(200).optional(),
});
export type ConfirmResumeImportRequest = z.infer<typeof ConfirmResumeImportRequestSchema>;

export const ConfirmResumeImportResponseSchema = z.object({
  profileId: z.string().uuid(),
  sectionsAdded: z.number().int().min(0),
});
export type ConfirmResumeImportResponse = z.infer<typeof ConfirmResumeImportResponseSchema>;
