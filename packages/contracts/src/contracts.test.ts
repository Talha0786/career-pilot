import { describe, it, expect } from 'vitest';
import {
  RegisterRequestSchema, LoginRequestSchema,
  CreateManualJobRequestSchema, ListJobsQuerySchema, JobEmbeddedEventSchema,
  UpdateStageRequestSchema, ProblemSchema,
} from './index.js';

describe('contracts — parse/reject fixtures', () => {
  it('RegisterRequest accepts a valid payload and rejects a short password', () => {
    expect(RegisterRequestSchema.safeParse({ email: 'a@b.com', password: 'longenough' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(false);
    expect(RegisterRequestSchema.safeParse({ email: 'not-an-email', password: 'longenough' }).success).toBe(false);
  });

  it('LoginRequest requires both fields', () => {
    expect(LoginRequestSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ email: 'a@b.com' }).success).toBe(false);
  });

  it('CreateManualJobRequest enforces length bounds', () => {
    expect(CreateManualJobRequestSchema.safeParse({ title: 'Eng', descriptionMd: 'desc' }).success).toBe(true);
    expect(CreateManualJobRequestSchema.safeParse({ title: '', descriptionMd: 'desc' }).success).toBe(false);
    expect(CreateManualJobRequestSchema.safeParse({ title: 'x'.repeat(301), descriptionMd: 'd' }).success).toBe(false);
  });

  it('ListJobsQuery applies the default limit and coerces the querystring', () => {
    const r = ListJobsQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(20);

    const coerced = ListJobsQuerySchema.safeParse({ limit: '50' });
    expect(coerced.success).toBe(true);
    if (coerced.success) expect(coerced.data.limit).toBe(50);

    expect(ListJobsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('JobEmbeddedEvent is a discriminated literal', () => {
    expect(
      JobEmbeddedEventSchema.safeParse({ type: 'job.embedded', jobId: crypto.randomUUID(), status: 'ready' }).success,
    ).toBe(true);
    expect(
      JobEmbeddedEventSchema.safeParse({ type: 'wrong.type', jobId: crypto.randomUUID(), status: 'ready' }).success,
    ).toBe(false);
  });

  it('UpdateStageRequest rejects an unknown stage', () => {
    expect(UpdateStageRequestSchema.safeParse({ toStage: 'applied' }).success).toBe(true);
    expect(UpdateStageRequestSchema.safeParse({ toStage: 'ghosted' }).success).toBe(false);
  });

  it('Problem requires a known error code', () => {
    expect(ProblemSchema.safeParse({ code: 'not_found', message: 'x' }).success).toBe(true);
    expect(ProblemSchema.safeParse({ code: 'made_up_code', message: 'x' }).success).toBe(false);
  });
});
