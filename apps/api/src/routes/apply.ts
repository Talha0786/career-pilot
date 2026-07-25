import type { FastifyInstance } from 'fastify';
import {
  makeStartApplyTaskUseCase, makeSubmitApplyTaskUseCase,
} from '@careerpilot/application';
import type { ApplyTaskRepository, ApplicationRepository, DocumentRepository, ApprovalTokenPort, BrowserSubmitPort } from '@careerpilot/application';
import { sendDomainError } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';
import type { BrowserRunnerFieldsPort } from '../lib/browser-runner-client.js';

/**
 * Tasks 052/053 — the batch review queue's API surface (ADR-003: "the UI
 * supports a review queue where the user inspects N pre-filled
 * applications and approves them in a batch... each approval still mints
 * its own single-use token and each submission is still individually
 * consented to").
 *
 * `POST /apply-tasks/:id/approve` is the ONLY place `approvalTokens.mint`
 * is ever called from — batching the review UI never means batching
 * consent: a user reviewing 10 tasks in one sitting still triggers 10
 * separate approve calls (one per card, task 052's UI), each minting its
 * own token, each independently required by `submit`.
 */
export function registerApplyRoutes(
  app: FastifyInstance,
  deps: {
    applyTasks: ApplyTaskRepository;
    applications: ApplicationRepository;
    documents: DocumentRepository;
    approvalTokens: ApprovalTokenPort;
    browserSubmit: BrowserSubmitPort;
    browserRunnerFields: BrowserRunnerFieldsPort;
  },
): void {
  const startApplyTask = makeStartApplyTaskUseCase({
    applications: deps.applications, documents: deps.documents, applyTasks: deps.applyTasks,
  });
  const submitApplyTask = makeSubmitApplyTaskUseCase({
    applyTasks: deps.applyTasks, approvalTokens: deps.approvalTokens, browserSubmit: deps.browserSubmit,
  });

  app.post<{ Body: { applicationId: string; documentId: string; documentVersionId: string } }>(
    '/apply-tasks',
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await startApplyTask({
        userId: request.actor!.userId,
        applicationId: request.body.applicationId,
        documentId: request.body.documentId,
        documentVersionId: request.body.documentVersionId,
      });
      if (!result.ok) return sendDomainError(reply, result.error);
      return reply.code(201).send({ applyTaskId: result.value.id, stage: result.value.stage });
    },
  );

  app.get<{ Querystring: { stage?: string } }>('/apply-tasks', { preHandler: requireAuth }, async (request, reply) => {
    const tasks = await deps.applyTasks.listForUser(
      request.actor!.userId,
      request.query.stage ? { stage: request.query.stage } : {},
    );
    return reply.send({
      tasks: tasks.map((t) => ({
        id: t.id, applicationId: t.applicationId, jobPostingId: t.jobPostingId,
        stage: t.stage, atsAdapter: t.atsAdapter, updatedAt: t.updatedAt.toISOString(),
      })),
    });
  });

  /**
   * Task 052 — the field-level review diff ADR-003 requires ("a human
   * must review a field-level diff... before every submission"). Without
   * this route the review-queue UI has field metadata (from `GET
   * /apply-tasks`) but nothing to actually show the user for review — this
   * closes that gap. Available for a task in `awaiting_review` OR
   * `approved` (a user re-checking what they just approved, before the
   * submit click, is a legitimate read too — this route never mutates
   * anything and never touches the approval token).
   */
  app.get<{ Params: { id: string } }>('/apply-tasks/:id/fields', { preHandler: requireAuth }, async (request, reply) => {
    const task = await deps.applyTasks.findByIdForUser(request.params.id as never, request.actor!.userId);
    if (!task) return reply.code(404).send({ error: 'not_found' });
    if (task.stage !== 'awaiting_review' && task.stage !== 'approved') {
      return reply.code(409).send({ error: 'conflict', message: `ApplyTask is in stage '${task.stage}' — no field diff to review` });
    }

    const result = await deps.browserRunnerFields.getFields(task.id);
    if (!result.ok) {
      request.log.warn({ err: result.error }, 'failed to fetch field diff from browser-runner');
      return reply.code(502).send({ error: 'browser_runner_unavailable', message: result.error.message });
    }
    return reply.send({ fields: result.value });
  });

  app.post<{ Params: { id: string } }>('/apply-tasks/:id/approve', { preHandler: requireAuth }, async (request, reply) => {
    const task = await deps.applyTasks.findByIdForUser(request.params.id as never, request.actor!.userId);
    if (!task) return reply.code(404).send({ error: 'not_found' });

    const transition = task.transitionTo('approved', 'user-approved');
    if (!transition.ok) return sendDomainError(reply, transition.error);
    await deps.applyTasks.save(task);

    // Task 046/ADR-003: a FRESH, single-use token minted for THIS approval,
    // never shared/batched across multiple tasks even when approved in the
    // same review-queue sitting.
    const { token, expiresAt } = await deps.approvalTokens.mint(task.id);
    return reply.send({ stage: task.stage, token, expiresAt: expiresAt.toISOString() });
  });

  app.post<{ Params: { id: string } }>('/apply-tasks/:id/reject', { preHandler: requireAuth }, async (request, reply) => {
    const task = await deps.applyTasks.findByIdForUser(request.params.id as never, request.actor!.userId);
    if (!task) return reply.code(404).send({ error: 'not_found' });

    const transition = task.transitionTo('aborted', 'user-rejected');
    if (!transition.ok) return sendDomainError(reply, transition.error);
    await deps.applyTasks.save(task);
    return reply.send({ stage: task.stage });
  });

  app.post<{ Params: { id: string }; Body: { token: string } }>(
    '/apply-tasks/:id/submit',
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await submitApplyTask({
        userId: request.actor!.userId,
        applyTaskId: request.params.id,
        token: request.body.token,
      });
      if (!result.ok) return sendDomainError(reply, result.error);
      return reply.send({ stage: result.value.stage });
    },
  );
}
