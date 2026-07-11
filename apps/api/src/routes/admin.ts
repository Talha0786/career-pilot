import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { OutboxRelay, PostgresBudgetStore } from '@careerpilot/infrastructure';
import { requireAuth } from '../plugins/auth.js';

/**
 * Ops surface (M2 design §3.5). Queue depth and outbox backlog are
 * platform-wide signals; LLM spend is scoped to the requesting actor —
 * there is no site-admin role yet (schema's `owner`/`member` is per-account,
 * not a superuser concept), so "your own spend" is the only spend a
 * logged-in actor should see without a broader authz model.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { jobQueue: Queue; outboxRelay: OutboxRelay; budgetStore: PostgresBudgetStore },
): void {
  app.get('/admin/status', { preHandler: requireAuth }, async (request, reply) => {
    const [counts, outboxBacklog, llmSpendMtd] = await Promise.all([
      deps.jobQueue.getJobCounts('waiting', 'active', 'delayed'),
      deps.outboxRelay.getBacklogCount(),
      deps.budgetStore.getMonthlySpend(request.actor!.userId),
    ]);

    const queueDepth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);

    return reply.send({ queueDepth, outboxBacklog, llmSpendMtd });
  });
}
