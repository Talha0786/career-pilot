import { describe, it, expect, afterAll } from 'vitest';
import { buildTaskApi } from '../../src/task-api.js';
import { ApplyTask, asUserId, asApplicationId, asJobPostingId, asDocumentVersionId } from '@careerpilot/domain';
import type { ApplyTaskRepository, ApplyTaskStepRecord } from '@careerpilot/application';

/** Minimal in-memory fake — real Postgres round-trip for apply_task_steps is proven separately (task 045's own repository integration test). */
class FakeApplyTaskRepository implements Partial<ApplyTaskRepository> {
  public tasks = new Map<string, ApplyTask>();
  public steps = new Map<string, ApplyTaskStepRecord[]>();
  async findByIdAnyOwner(id: string): Promise<ApplyTask | null> {
    return this.tasks.get(id) ?? null;
  }
  async listSteps(id: string): Promise<ApplyTaskStepRecord[]> {
    return this.steps.get(id) ?? [];
  }
}

/**
 * Task 047 — auth behavior of the internal task API, via Fastify's
 * `inject()` (no real socket bind needed). Deliberately does NOT exercise
 * `/internal/smoke/browser` here — that route launches a real Chromium
 * process, which requires Playwright's browser binaries to be installed
 * (`npx playwright install --with-deps chromium`); this generic vitest
 * integration container doesn't have them, and installing them just for
 * this one assertion would be redundant with the REAL proof (task 047's
 * other acceptance criterion): building `apps/browser-runner/Dockerfile`
 * and hitting the running container's `/internal/smoke/browser` over the
 * compose network, which is what "Docker: docker compose up -d --build,
 * confirm browser-runner healthy" in this task's Status note actually
 * verifies. `browser-smoke.spec.ts` (Playwright, same package) is the
 * dedicated Chromium-launch proof, run against the built image or any
 * environment with the binaries installed.
 */
describe('browser-runner internal task API — auth (task 047)', () => {
  const app = buildTaskApi({ serviceToken: 'test-service-token' });
  afterAll(async () => app.close());

  it('GET /healthz requires no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /internal/ping without a token is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/ping' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /internal/ping with the WRONG token is rejected', async () => {
    const res = await app.inject({
      method: 'GET', url: '/internal/ping',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /internal/ping with the correct service token succeeds', async () => {
    const res = await app.inject({
      method: 'GET', url: '/internal/ping',
      headers: { authorization: 'Bearer test-service-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });
});

/**
 * Task 052 — GET /internal/tasks/:id/fields. No live page/contexts here
 * (would need real Playwright + a real open page, exercised for real by
 * `e2e/apply-flow.spec.ts`, task 054); this proves the route's own logic —
 * reconstructing the field list from `apply_task_steps` and the sensitive
 * field invariant — with a fake repository standing in for Postgres.
 */
describe('browser-runner internal task API — GET /internal/tasks/:id/fields (task 052)', () => {
  const applyTasks = new FakeApplyTaskRepository();
  const app = buildTaskApi({ serviceToken: 'test-service-token', applyTasks: applyTasks as unknown as ApplyTaskRepository });
  afterAll(async () => app.close());

  const AUTH = { authorization: 'Bearer test-service-token' };

  it('404s for an unknown ApplyTask', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal/tasks/does-not-exist/fields', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('reconstructs the field list from apply_task_steps, never populating a sensitive field value (no live page — always null for those anyway, but the invariant must hold structurally too)', async () => {
    const task = ApplyTask.create({
      userId: asUserId('018f0000-0000-7000-8000-000000000001'),
      applicationId: asApplicationId('018f0000-0000-7000-8000-000000000002'),
      jobPostingId: asJobPostingId('018f0000-0000-7000-8000-000000000003'),
      documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-000000000004'),
    });
    applyTasks.tasks.set(task.id, task);
    applyTasks.steps.set(task.id, [
      {
        fromStage: 'filling', toStage: 'filling', action: 'fill', createdAt: new Date(),
        screenshotKey: null,
        redactedPayload: { taxonomyKey: 'firstName', selector: '#first_name', detail: 'ok', confidence: 0.98, source: 'known_ats', neverAutoFill: false },
      },
      {
        fromStage: 'filling', toStage: 'filling', action: 'skip-sensitive', createdAt: new Date(),
        screenshotKey: null,
        redactedPayload: { taxonomyKey: 'eeoGender', selector: '#eeo_gender', detail: null, confidence: 0, source: 'known_ats', neverAutoFill: true },
      },
      // A stage-transition step (no taxonomyKey) must be ignored, not crash the route.
      { fromStage: 'mapping', toStage: 'filling', action: 'fill-started', createdAt: new Date(), screenshotKey: null, redactedPayload: null },
    ]);

    const res = await app.inject({ method: 'GET', url: `/internal/tasks/${task.id}/fields`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const fields = res.json().fields as { taxonomyKey: string; mappedValue: string | null; neverAutoFill: boolean }[];
    expect(fields).toHaveLength(2);
    const sensitive = fields.find((f) => f.taxonomyKey === 'eeoGender');
    expect(sensitive?.neverAutoFill).toBe(true);
    expect(sensitive?.mappedValue).toBeNull(); // no live page in this test — but the invariant holds either way, see task-api.ts's own doc comment
  });

  it('last write wins when the same selector appears in multiple steps', async () => {
    const task = ApplyTask.create({
      userId: asUserId('018f0000-0000-7000-8000-000000000001'),
      applicationId: asApplicationId('018f0000-0000-7000-8000-000000000005'),
      jobPostingId: asJobPostingId('018f0000-0000-7000-8000-000000000006'),
      documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-000000000007'),
    });
    applyTasks.tasks.set(task.id, task);
    applyTasks.steps.set(task.id, [
      { fromStage: 'filling', toStage: 'filling', action: 'error', createdAt: new Date(0), screenshotKey: null, redactedPayload: { taxonomyKey: 'email', selector: '#email', detail: 'TimeoutError', confidence: 0.5, source: 'heuristic', neverAutoFill: false } },
      { fromStage: 'filling', toStage: 'filling', action: 'fill', createdAt: new Date(1), screenshotKey: null, redactedPayload: { taxonomyKey: 'email', selector: '#email', detail: 'ok', confidence: 0.9, source: 'llm', neverAutoFill: false } },
    ]);

    const res = await app.inject({ method: 'GET', url: `/internal/tasks/${task.id}/fields`, headers: AUTH });
    const fields = res.json().fields as { source: string }[];
    expect(fields).toHaveLength(1);
    expect(fields[0]!.source).toBe('llm'); // the later step, not the earlier error
  });

  it('501s cleanly when the route is configured without an applyTasks dep', async () => {
    const bareApp = buildTaskApi({ serviceToken: 'test-service-token' });
    const res = await bareApp.inject({ method: 'GET', url: '/internal/tasks/x/fields', headers: AUTH });
    expect(res.statusCode).toBe(501);
    await bareApp.close();
  });
});
