import { createDb, DrizzleApplyTaskRepository, DrizzleOutboxPort } from '@careerpilot/infrastructure';
import { buildTaskApi } from './task-api.js';
import { ApplyTaskBrowserContextManager } from './context-manager.js';

/**
 * Task 047 — entrypoint. Per docs/05-playwright-design.md §2, the runner is
 * "stateless: all task state in Postgres (apply_tasks, apply_task_steps)".
 * `ApplyTaskBrowserContextManager` is the one piece of legitimate in-memory
 * runtime state (see its own doc comment for why that doesn't violate
 * statelessness) — everything about the ApplyTask ITSELF still lives in
 * Postgres, read fresh on every request via `DrizzleApplyTaskRepository`.
 */
const PORT = Number(process.env.BROWSER_RUNNER_PORT ?? 7300);
const SERVICE_TOKEN = process.env.BROWSER_RUNNER_SERVICE_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot';

if (!SERVICE_TOKEN) {
  throw new Error('BROWSER_RUNNER_SERVICE_TOKEN is required — the internal task API has no other auth mechanism.');
}

const { db } = createDb(DATABASE_URL);
const applyTasks = new DrizzleApplyTaskRepository(db, new DrizzleOutboxPort(db));
const contexts = new ApplyTaskBrowserContextManager();

const app = buildTaskApi({ serviceToken: SERVICE_TOKEN, applyTasks, contexts });

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`browser-runner internal task API listening on :${PORT}`))
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
