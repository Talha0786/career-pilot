import type { FastifyInstance } from 'fastify';
import { CapturePayloadSchema } from '@careerpilot/contracts';
import { makeIngestJobBatchUseCase } from '@careerpilot/application';
import type { UnitOfWork } from '@careerpilot/application';
import { normalizeCapturePayload } from '@careerpilot/connectors';
import { sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * ADR-004's "one-job-at-a-time" posture, enforced as a real rate limit, not
 * a client-side convention: a bookmarklet/extension captures one job the
 * user is looking at, one click at a time. This is generous enough for
 * genuine human-paced usage across a job search and tight enough to reject
 * bulk/scripted abuse of the endpoint as a de-facto scraper proxy.
 */
const CAPTURE_RATE_LIMIT = { max: 30, timeWindow: '1 hour' };

export function registerCaptureRoutes(app: FastifyInstance, deps: { uow: UnitOfWork }): void {
  const ingestJobBatch = makeIngestJobBatchUseCase({ uow: deps.uow });

  app.post(
    '/capture',
    {
      preHandler: requireAuth,
      config: {
        rateLimit: {
          ...CAPTURE_RATE_LIMIT,
          // Per-USER, not per-IP — the ADR-004 posture is about one person's
          // pace of manual captures, not the network address they're on
          // (which may be shared, e.g. behind a corporate NAT).
          keyGenerator: (request) => request.actor?.userId ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = CapturePayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, 400, {
          code: 'validation_failed',
          message: parsed.error.issues[0]?.message ?? 'Invalid capture payload',
        });
      }

      // Normalization happens BEFORE any DB write — a malformed-but-schema-
      // valid payload (e.g. no usable description text) still comes back as
      // a typed 400, never a 500, never a partial write (task 030 acceptance).
      const normalized = normalizeCapturePayload(parsed.data);
      if (!normalized.ok) {
        return sendProblem(reply, 400, { code: 'validation_failed', message: normalized.error.message });
      }

      // Same pipeline every connector uses (task 029) — capture is not a
      // parallel/bespoke write path. This is also where cross-source dedup
      // against an equivalent Class A posting happens, satisfying task 030's
      // "feeds the same dedup path" acceptance criterion.
      const result = await ingestJobBatch({
        userId: request.actor!.userId,
        sourceConnectorKey: 'capture',
        rawJobs: [normalized.value],
      });

      const status = result.inserted > 0 ? (result.deduped > 0 ? 'duplicate' : 'inserted') : 'already_captured';
      return reply.code(202).send({ status });
    },
  );
}
