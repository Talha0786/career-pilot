import type { FastifyInstance } from 'fastify';
import { makeRequestMatchScanUseCase, makeListMatchesUseCase } from '@careerpilot/application';
import type { ProfileRepository, JobPostingRepository, MatchScoreRepository, QueuePort } from '@careerpilot/application';
import { sendDomainError } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Task 038's on-demand rescan surface. Route naming: `docs/01-system-design.md`
 * has no prior convention for a matching-specific route (only the generic
 * `/board`, `/jobs`, `/applications`); following task 022's already-established
 * precedent instead — every profile-scoped route in this codebase is
 * unprefixed `/profile/...` with NO id in the URL (career profile is a
 * per-user singleton, task 022's note) — so this is `/profile/rescan` and
 * `/profile/matches`, not `/profiles/:id/rescan` as the task file's literal
 * suggestion read.
 *
 * DESIGN NOTE: this route enqueues (`matching.score_requested`, consumed by
 * `apps/worker`'s `createScoreMatchWorker`) rather than running
 * `score-match` synchronously in-process. `GuardedLlmPort` is deliberately
 * NOT part of this app's `AppDeps` — every other LLM-dispatching pipeline in
 * this codebase (job/profile embedding) already keeps the LLM boundary in
 * the worker process exclusively; adding a second LLM-calling composition
 * root in the API for just this one route would fork that boundary for no
 * real benefit, and a rescan may run 10-20+ sequential mid-tier completions
 * — not something an HTTP request should block on. `MatchScoreRepository` IS
 * wired here (a real, used dependency — `GET /profile/matches` reads through
 * it directly, no LLM involved).
 */
export function registerMatchingRoutes(
  app: FastifyInstance,
  deps: { profiles: ProfileRepository; jobPostings: JobPostingRepository; matchScores: MatchScoreRepository; queue: QueuePort },
): void {
  const requestMatchScan = makeRequestMatchScanUseCase({ profiles: deps.profiles, queue: deps.queue });
  const listMatches = makeListMatchesUseCase({
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    matchScores: deps.matchScores,
  });

  app.post('/profile/rescan', { preHandler: requireAuth }, async (request, reply) => {
    const result = await requestMatchScan(request.actor!);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.code(202).send(result.value);
  });

  app.get('/profile/matches', { preHandler: requireAuth }, async (request, reply) => {
    const result = await listMatches(request.actor!);
    if (!result.ok) return sendDomainError(reply, result.error);
    return reply.send({ matches: result.value });
  });
}
