import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { ApplyTaskRepository } from '@careerpilot/application';
import { asApplyTaskId, TAXONOMY, isTaxonomyFieldKey, type TaxonomyFieldKey } from '@careerpilot/domain';
import type { ApplyTaskBrowserContextManager } from './context-manager.js';
import { runSubmitStage } from './submit-runner.js';

const PER_FIELD_ACTIONS = new Set(['fill', 'select', 'upload', 'skip-no-value', 'skip-sensitive', 'error']);

export interface FieldDiffEntry {
  readonly taxonomyKey: TaxonomyFieldKey;
  readonly label: string;
  readonly selector: string;
  readonly mappedValue: string | null;
  readonly neverAutoFill: boolean;
  readonly confidence: number;
  readonly source: 'known_ats' | 'heuristic' | 'llm';
}

/**
 * Task 047 — internal task API (docs/05-playwright-design.md §2): "Internal
 * task API bound to the compose network only; authenticated with a service
 * token; never internet-exposed." This is NOT the user-session auth system
 * (`apps/api/src/plugins/session.ts`) — the browser-runner has no concept
 * of a logged-in human, only requests from `apps/api`/`apps/worker` acting
 * on behalf of one. A single shared-secret bearer token (env var, rotated
 * out-of-band) is the whole auth model, deliberately simple: this service
 * is unreachable from the host (no `ports:` entry in docker-compose.yml —
 * task 047's other acceptance criterion) and only ever called from inside
 * the compose network by services that already went through real user auth
 * upstream.
 */
export interface BrowserRunnerDeps {
  serviceToken: string;
  /** Optional — the smoke/ping routes work without these; the real /internal/tasks/:id/submit route (task 053) needs both. */
  applyTasks?: ApplyTaskRepository;
  contexts?: ApplyTaskBrowserContextManager;
}

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/smoke.html',
);

export function buildTaskApi(deps: BrowserRunnerDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  // Unauthenticated — this is what docker-compose's healthcheck hits, same
  // posture as apps/api's /readyz (task 013).
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (!token || token !== deps.serviceToken) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/internal/ping', async () => ({ pong: true }));

  /**
   * Proves the Docker image actually has working Chromium binaries — the
   * single most common Playwright-in-Docker failure mode (per this task's
   * own acceptance criteria). Launches a real headless browser, navigates
   * to a bundled local fixture page (never the network — this is an
   * infra smoke check, not a real ApplyTask run), and returns its title.
   */
  app.get('/internal/smoke/browser', async () => {
    const html = await readFile(FIXTURE_PATH, 'utf-8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const title = await page.title();
      return { title };
    } finally {
      await browser.close();
    }
  });

  /**
   * Task 053 — the ONLY HTTP entry point that can trigger an actual
   * `submit-runner.ts` click. Note what's NOT here: no token, no
   * stage-legality check, no consent logic — all of that already happened
   * in `submit-apply-task.ts` (packages/application) BEFORE this endpoint
   * is ever called (the `BrowserSubmitPort` HTTP client,
   * `apps/api/src/lib/browser-runner-client.ts`). This route trusts the
   * caller because the caller is `apps/api`'s own submit command, reached
   * only via the service-token-gated network boundary above — it does not
   * re-implement the approval gate, it assumes it already happened, same
   * as `fill-runner.ts`/`field-detection.adapter.ts` assume a page is
   * already open for this task.
   */
  app.post<{ Params: { id: string } }>('/internal/tasks/:id/submit', async (req, reply) => {
    if (!deps.applyTasks || !deps.contexts) {
      return reply.code(501).send({ error: 'not_configured', message: 'submit route requires applyTasks + contexts deps' });
    }
    const applyTaskId = asApplyTaskId(req.params.id);
    const task = await deps.applyTasks.findByIdAnyOwner(applyTaskId);
    if (!task) return reply.code(404).send({ error: 'not_found' });

    const page = deps.contexts.get(req.params.id);
    if (!page) return reply.code(409).send({ error: 'no_open_page', message: 'no live browser session for this task' });

    const result = await runSubmitStage(page, task.atsAdapter);
    if (!result.ok) return reply.code(502).send({ error: result.code, message: result.message });
    return reply.send({ status: 'submitted' });
  });

  /**
   * Task 052 — ADR-003's field-level review diff: "a human must review a
   * field-level diff... before every submission." Reconstructs the field
   * map from `apply_task_steps` (task 044/051 already record one row per
   * field action, extended in this task to carry `confidence`/`source`/
   * `neverAutoFill` — never the raw value, per §6) and, for every
   * non-sensitive field that was actually filled, reads the CURRENT value
   * back from the LIVE DOM. This is deliberate: the audit-log rows are
   * intentionally redacted, but the review step's whole point is showing
   * the user what will actually be submitted — the only honest source for
   * that is the live page, not a second copy of the value stored
   * somewhere else. Sensitive fields always report `mappedValue: null`,
   * unconditionally — never read from the DOM at all, so there's no path
   * by which one could leak into this response even by a future bug
   * upstream.
   */
  app.get<{ Params: { id: string } }>('/internal/tasks/:id/fields', async (req, reply) => {
    if (!deps.applyTasks) {
      return reply.code(501).send({ error: 'not_configured', message: 'fields route requires applyTasks dep' });
    }
    const applyTaskId = asApplyTaskId(req.params.id);
    const task = await deps.applyTasks.findByIdAnyOwner(applyTaskId);
    if (!task) return reply.code(404).send({ error: 'not_found' });

    const steps = await deps.applyTasks.listSteps(applyTaskId);
    const byS = new Map<string, FieldDiffEntry>();
    const page = deps.contexts?.get(req.params.id);

    for (const step of steps) {
      const payload = step.redactedPayload;
      const action = step.action;
      if (!action || !PER_FIELD_ACTIONS.has(action) || !payload) continue;
      const taxonomyKey = payload.taxonomyKey;
      const selector = payload.selector;
      if (typeof taxonomyKey !== 'string' || !isTaxonomyFieldKey(taxonomyKey) || typeof selector !== 'string') continue;

      const neverAutoFill = payload.neverAutoFill === true;
      let mappedValue: string | null = null;
      if (!neverAutoFill && (action === 'fill' || action === 'select') && page) {
        try {
          mappedValue = await page.inputValue(selector);
        } catch {
          mappedValue = null; // page/selector no longer valid — honest null, not a guess
        }
      } else if (!neverAutoFill && action === 'upload') {
        mappedValue = '(file uploaded)';
      }

      // Last write wins — later steps for the same selector (a retry, in
      // principle) supersede earlier ones, same as the audit trail's own
      // append-only-but-latest-state-matters posture.
      byS.set(selector, {
        taxonomyKey,
        label: TAXONOMY[taxonomyKey].label,
        selector,
        mappedValue,
        neverAutoFill,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : 0,
        source: (payload.source as FieldDiffEntry['source']) ?? 'heuristic',
      });
    }

    return reply.send({ fields: [...byS.values()] });
  });

  return app;
}
