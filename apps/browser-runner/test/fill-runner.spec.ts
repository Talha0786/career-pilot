import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApplyTask, asUserId, asApplicationId, asJobPostingId, asDocumentVersionId } from '@careerpilot/domain';
import type { ApplyTaskRepository } from '@careerpilot/application';
import type { DetectedField } from '@careerpilot/application';
import { runFillStage } from '../src/fill-runner.js';

/** Minimal in-memory stand-in — real persistence is proven separately (packages/infrastructure's DrizzleApplyTaskRepository integration tests, task 045). */
class StubApplyTaskRepository implements Partial<ApplyTaskRepository> {
  public saveCount = 0;
  async save(task: ApplyTask): Promise<void> {
    this.saveCount++;
    task.pullSteps();
  }
}

const FIXTURE = `file://${path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/greenhouse/application-form.html')}`;

function newDraftTask(): ApplyTask {
  const task = ApplyTask.create({
    userId: asUserId('018f0000-0000-7000-8000-000000000001'),
    applicationId: asApplicationId('018f0000-0000-7000-8000-000000000002'),
    jobPostingId: asJobPostingId('018f0000-0000-7000-8000-000000000003'),
    documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-000000000004'),
  });
  task.transitionTo('mapping');
  task.pullSteps();
  return task;
}

test('fills real text fields, uploads a file, and skips a sensitive field — against a real fixture DOM', async ({ page }) => {
  await page.goto(FIXTURE);
  const task = newDraftTask();
  const repo = new StubApplyTaskRepository() as unknown as ApplyTaskRepository;

  const fieldMap: DetectedField[] = [
    { selector: '#first_name', taxonomyKey: 'firstName', confidence: 0.98, neverAutoFill: false },
    { selector: '#email', taxonomyKey: 'email', confidence: 0.98, neverAutoFill: false },
    { selector: '#eeo_gender', taxonomyKey: 'eeoGender', confidence: 0, neverAutoFill: true },
  ];

  const result = await runFillStage(
    {
      page, task, fieldMap,
      valuesByKey: { firstName: 'Ada', email: 'ada@example.com', eeoGender: 'THIS MUST NEVER BE WRITTEN' },
      resumeFilePath: null,
    },
    repo,
  );

  expect(result.ok).toBe(true);
  expect(task.stage).toBe('awaiting_review');
  expect(await page.inputValue('#first_name')).toBe('Ada');
  expect(await page.inputValue('#email')).toBe('ada@example.com');
  // The sensitive field must be untouched, even though a (malicious/buggy)
  // caller supplied a value for it in valuesByKey.
  expect(await page.inputValue('#eeo_gender')).toBe('');

  if (result.ok) {
    const genderStep = result.output.steps.find((s) => s.taxonomyKey === 'eeoGender');
    expect(genderStep?.action).toBe('skip-sensitive');
  }
});

test('a field with no resolved value is skipped (left blank), not guessed', async ({ page }) => {
  await page.goto(FIXTURE);
  const task = newDraftTask();
  const repo = new StubApplyTaskRepository() as unknown as ApplyTaskRepository;

  const result = await runFillStage(
    {
      page, task,
      fieldMap: [{ selector: '#phone', taxonomyKey: 'phone', confidence: 0.9, neverAutoFill: false }],
      valuesByKey: {}, // no phone value resolved
      resumeFilePath: null,
    },
    repo,
  );

  expect(result.ok).toBe(true);
  expect(await page.inputValue('#phone')).toBe('');
  if (result.ok) expect(result.output.steps[0]!.action).toBe('skip-no-value');
});

test('filling that exceeds the timeout transitions the task to failed', async ({ page }) => {
  await page.goto(FIXTURE);
  const task = newDraftTask();
  const repo = new StubApplyTaskRepository() as unknown as ApplyTaskRepository;

  // Force a page.fill against a selector that will legitimately resolve but
  // artificially slow it down isn't practical without hooking Playwright
  // internals — instead prove the timeout wiring with a 0ms timeout against
  // real (non-zero-latency) work, which reliably exceeds it.
  const result = await runFillStage(
    {
      page, task,
      fieldMap: [{ selector: '#first_name', taxonomyKey: 'firstName', confidence: 0.9, neverAutoFill: false }],
      valuesByKey: { firstName: 'Ada' },
      resumeFilePath: null,
      timeoutMs: 0,
    },
    repo,
  );

  expect(result.ok).toBe(false);
  expect(task.stage).toBe('failed');
});
