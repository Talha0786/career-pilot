import { z } from 'zod';

export const CreateManualJobRequestSchema = z.object({
  title: z.string().min(1).max(300),
  descriptionMd: z.string().min(1).max(100_000),
  company: z.string().max(200).optional(),
  url: z.string().url().max(2048).optional(),
});
export type CreateManualJobRequest = z.infer<typeof CreateManualJobRequestSchema>;

export const EmbeddingStatusSchema = z.enum(['pending', 'ready', 'failed']);

export const CreateManualJobResponseSchema = z.object({
  jobId: z.string().uuid(),
  embeddingStatus: EmbeddingStatusSchema,
});
export type CreateManualJobResponse = z.infer<typeof CreateManualJobResponseSchema>;

export const JobPostingDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  company: z.string().nullable(),
  url: z.string().nullable(),
  descriptionMd: z.string(),
  sourceConnectorKey: z.string(),
  embeddingStatus: EmbeddingStatusSchema,
  ingestedAt: z.string().datetime(),
});
export type JobPostingDto = z.infer<typeof JobPostingDtoSchema>;

export const ListJobsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

export const ListJobsResponseSchema = z.object({
  items: z.array(JobPostingDtoSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

/** Server → client push when a worker finishes (or fails) an embedding. */
export const JobEmbeddedEventSchema = z.object({
  type: z.literal('job.embedded'),
  jobId: z.string().uuid(),
  status: EmbeddingStatusSchema,
});
export type JobEmbeddedEvent = z.infer<typeof JobEmbeddedEventSchema>;
