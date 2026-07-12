import { z } from 'zod';

export const DocumentKindSchema = z.enum(['resume', 'cover_letter', 'other']);
export type DocumentKindDto = z.infer<typeof DocumentKindSchema>;

export const DocumentVersionSourceSchema = z.enum(['imported', 'generated', 'edited']);

const ContactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  location: z.string().max(200).optional(),
  links: z.array(z.string().url()).max(10).optional(),
});

export const ResumeEntrySchema = z.object({
  title: z.string().max(200),
  subtitle: z.string().max(200),
  dateRange: z.string().max(100).nullable(),
  bullets: z.array(z.string().max(1000)).max(50),
});
export const ResumeSectionSchema = z.object({
  heading: z.string().max(200),
  entries: z.array(ResumeEntrySchema).max(100),
});
export const ResumeDocumentContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('resume'),
  contact: ContactSchema,
  summary: z.string().max(4000).nullable(),
  sections: z.array(ResumeSectionSchema).max(50),
});

export const CoverLetterDocumentContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('cover_letter'),
  contact: ContactSchema.omit({ location: true, links: true }),
  recipient: z.string().max(200).nullable(),
  salutation: z.string().max(200),
  bodyParagraphs: z.array(z.string().max(4000)).max(20),
  closing: z.string().max(200),
});

export const OtherDocumentContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('other'),
  title: z.string().max(200),
  bodyMd: z.string().max(50_000),
});

export const DocumentContentSchema = z.discriminatedUnion('kind', [
  ResumeDocumentContentSchema,
  CoverLetterDocumentContentSchema,
  OtherDocumentContentSchema,
]);
export type DocumentContentDto = z.infer<typeof DocumentContentSchema>;

export const CreateDocumentRequestSchema = z.object({
  kind: DocumentKindSchema,
  title: z.string().min(1).max(200),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const CreateDocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  kind: DocumentKindSchema,
});
export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponseSchema>;

export const AddDocumentVersionRequestSchema = z.object({
  source: DocumentVersionSourceSchema,
  content: DocumentContentSchema,
  generationJobId: z.string().uuid().optional(),
  profileFactsHash: z.string().optional(),
});
export type AddDocumentVersionRequest = z.infer<typeof AddDocumentVersionRequestSchema>;

export const AddDocumentVersionResponseSchema = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  version: z.number().int().min(1),
});
export type AddDocumentVersionResponse = z.infer<typeof AddDocumentVersionResponseSchema>;

export const DocumentVersionDtoSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().min(1),
  source: DocumentVersionSourceSchema,
  content: DocumentContentSchema,
  renderedPdfKey: z.string().nullable(),
  profileFactsHash: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type DocumentVersionDto = z.infer<typeof DocumentVersionDtoSchema>;

export const DocumentDtoSchema = z.object({
  id: z.string().uuid(),
  kind: DocumentKindSchema,
  title: z.string(),
  currentVersionId: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  versions: z.array(DocumentVersionDtoSchema),
});
export type DocumentDto = z.infer<typeof DocumentDtoSchema>;

export const DocumentListItemDtoSchema = z.object({
  id: z.string().uuid(),
  kind: DocumentKindSchema,
  title: z.string(),
  currentVersionId: z.string().uuid().nullable(),
  currentVersion: z.number().int().nullable(),
  isStale: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type DocumentListItemDto = z.infer<typeof DocumentListItemDtoSchema>;

export const ListDocumentsResponseSchema = z.object({
  items: z.array(DocumentListItemDtoSchema),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;
