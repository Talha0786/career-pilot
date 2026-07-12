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
