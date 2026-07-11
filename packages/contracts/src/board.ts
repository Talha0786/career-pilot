import { z } from 'zod';

export const StageSchema = z.enum([
  'discovered', 'interested', 'applied', 'screening',
  'interview', 'offer', 'rejected', 'withdrawn',
]);
export type StageDto = z.infer<typeof StageSchema>;

export const CreateApplicationRequestSchema = z.object({
  jobPostingId: z.string().uuid(),
});
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequestSchema>;

export const CreateApplicationResponseSchema = z.object({ applicationId: z.string().uuid() });
export type CreateApplicationResponse = z.infer<typeof CreateApplicationResponseSchema>;

export const UpdateStageRequestSchema = z.object({
  toStage: StageSchema,
  reason: z.string().max(500).optional(),
});
export type UpdateStageRequest = z.infer<typeof UpdateStageRequestSchema>;

export const ApplicationCardSchema = z.object({
  applicationId: z.string().uuid(),
  jobPostingId: z.string().uuid(),
  title: z.string(),
  company: z.string().nullable(),
  stage: StageSchema,
  embeddingStatus: z.enum(['pending', 'ready', 'failed']),
  updatedAt: z.string().datetime(),
});
export type ApplicationCard = z.infer<typeof ApplicationCardSchema>;

export const BoardResponseSchema = z.object({
  columns: z.record(StageSchema, z.array(ApplicationCardSchema)),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;
