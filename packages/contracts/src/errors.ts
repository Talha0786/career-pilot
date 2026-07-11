import { z } from 'zod';

/**
 * application/problem+json shape (RFC 9457-ish). Every API error uses this —
 * stable machine-readable `code`, human `message`, optional field `details`.
 * The `code` union is intentionally the same set as DomainErrorCode in
 * @careerpilot/domain so mapping is a passthrough, not a translation table.
 */
export const ProblemSchema = z.object({
  code: z.enum([
    'validation_failed',
    'not_found',
    'forbidden',
    'conflict',
    'invalid_credentials',
    'invalid_transition',
    'budget_exceeded',
    'internal_error',
  ]),
  message: z.string(),
  details: z.record(z.string(), z.string()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
