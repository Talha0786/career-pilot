import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Task 047/051 — "one fresh browser context per ApplyTask" (design doc §2).
 * Deliberately in-memory, not persisted: this is the ONE piece of runtime
 * state the browser-runner legitimately holds outside Postgres (a live OS
 * process/socket can't be serialized to a database row) — everything about
 * the TASK itself (stage, field map, steps) still lives in
 * `apply_tasks`/`apply_task_steps` per the design doc's statelessness
 * requirement, so a crash loses only the in-flight browser session (the
 * task safely resumes from `draft`/`mapping` on restart, or is aborted by
 * the 30-min `awaiting_review` timeout), never task history or an
 * inconsistent DB state.
 */
export class ApplyTaskBrowserContextManager {
  private sessions = new Map<string, { browser: Browser; context: BrowserContext; page: Page }>();

  async open(applyTaskId: string, url: string): Promise<Page> {
    const existing = this.sessions.get(applyTaskId);
    if (existing) return existing.page;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: false }); // §6: downloads disabled
    const page = await context.newPage();
    await page.goto(url);

    this.sessions.set(applyTaskId, { browser, context, page });
    return page;
  }

  get(applyTaskId: string): Page | undefined {
    return this.sessions.get(applyTaskId)?.page;
  }

  async close(applyTaskId: string): Promise<void> {
    const existing = this.sessions.get(applyTaskId);
    if (!existing) return;
    this.sessions.delete(applyTaskId);
    await existing.context.close();
    await existing.browser.close();
  }

  /** Task 052's 30-min awaiting_review timeout / general cleanup sweep. */
  activeTaskIds(): readonly string[] {
    return [...this.sessions.keys()];
  }
}
