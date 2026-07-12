import { z } from 'zod';

/**
 * Class B capture payload (task 030, ADR-004): exactly what the user's
 * already-authenticated browser rendered — a bookmarklet/extension reads
 * this off the DOM of a job page the user is looking at and posts it here.
 * No platform credentials, no server-side fetch of the source page. At
 * least one of `descriptionHtml`/`descriptionText` is required; both may be
 * present (the extension prefers to send both when it can).
 */
export const CapturePayloadSchema = z
  .object({
    url: z.string().url().max(2048),
    title: z.string().min(1).max(300),
    company: z.string().min(1).max(200),
    descriptionHtml: z.string().min(1).max(200_000).optional(),
    descriptionText: z.string().min(1).max(200_000).optional(),
    location: z.string().max(300).optional(),
    postedAt: z.string().datetime().optional(),
  })
  .refine((data) => Boolean(data.descriptionHtml) || Boolean(data.descriptionText), {
    message: 'Either descriptionHtml or descriptionText is required',
    path: ['descriptionHtml'],
  });
export type CapturePayload = z.infer<typeof CapturePayloadSchema>;

export const CaptureResponseSchema = z.object({
  status: z.enum(['inserted', 'duplicate', 'already_captured']),
});
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;
