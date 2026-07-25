import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplyTask, asUserId, asApplicationId, asJobPostingId, asDocumentVersionId, isOk, isErr, ok, err, type Result } from '@careerpilot/domain';
import { makeSubmitApplyTaskUseCase } from '../../src/apply/commands/submit-apply-task.js';
import type { BrowserSubmitPort, BrowserSubmitError } from '../../src/ports/browser-submit.port.js';
import { FakeApplyTaskRepository } from '../fake-repos.js';
import { InMemoryApprovalTokenAdapter } from '../fakes.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER_USER = asUserId('018f0000-0000-7000-8000-000000000009');

class ScriptedBrowserSubmitPort implements BrowserSubmitPort {
  public calls: string[] = [];
  public nextResult: Result<void, BrowserSubmitError> = ok(undefined);
  async submit(applyTaskId: string): Promise<Result<void, BrowserSubmitError>> {
    this.calls.push(applyTaskId);
    return this.nextResult;
  }
}

async function seedApprovedTask(applyTasks: FakeApplyTaskRepository) {
  const task = ApplyTask.create({
    userId: USER, applicationId: asApplicationId('018f0000-0000-7000-8000-0000000000a1'),
    jobPostingId: asJobPostingId('018f0000-0000-7000-8000-0000000000a2'),
    documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-0000000000a3'),
  });
  for (const stage of ['mapping', 'filling', 'awaiting_review', 'approved'] as const) task.transitionTo(stage);
  await applyTasks.save(task);
  return task;
}

function setup() {
  const applyTasks = new FakeApplyTaskRepository();
  const approvalTokens = new InMemoryApprovalTokenAdapter();
  const browserSubmit = new ScriptedBrowserSubmitPort();
  const useCase = makeSubmitApplyTaskUseCase({ applyTasks, approvalTokens, browserSubmit });
  return { applyTasks, approvalTokens, browserSubmit, useCase };
}

describe('submitApplyTask — the exactly-once submit gate (task 053)', () => {
  it('happy path: valid token + approved task → submitted, browser-runner called exactly once', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint(task.id);

    const result = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.stage).toBe('submitted');
    expect(browserSubmit.calls).toEqual([task.id]);

    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('submitted');
  });

  it('a successful submit emits apply.task_submitted, drained to the outbox — the Application→applied wire', async () => {
    const { applyTasks, approvalTokens, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    applyTasks.emittedEvents = []; // clear prior CREATED/STAGE_CHANGED noise from setup
    const { token } = await approvalTokens.mint(task.id);

    await useCase({ userId: USER, applyTaskId: task.id, token });

    const submitted = applyTasks.emittedEvents.filter((e) => e.eventType === 'apply.task_submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.payload).toMatchObject({ applyTaskId: task.id, applicationId: task.applicationId });
  });

  it('an invalid token is rejected — the ApplyTask is never even looked up, browser-runner never called', async () => {
    const { applyTasks, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);

    const result = await useCase({ userId: USER, applyTaskId: task.id, token: 'never-minted' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('forbidden');
    expect(browserSubmit.calls).toHaveLength(0);
    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('approved'); // unchanged
  });

  it('an already-consumed token is rejected on the second attempt — no double submit', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint(task.id);

    const first = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isOk(first)).toBe(true);

    const second = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error.message).toContain('already_consumed');
    expect(browserSubmit.calls).toHaveLength(1); // NOT 2
  });

  it('an expired token is rejected, never silently accepted', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    let clock = 1_000_000;
    approvalTokens.now = () => clock;
    const { token } = await approvalTokens.mint(task.id);
    clock += 5 * 60 * 1000 + 1;

    const result = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isErr(result)).toBe(true);
    expect(browserSubmit.calls).toHaveLength(0);
  });

  it('a token minted for a DIFFERENT ApplyTask is rejected (no cross-task token laundering)', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint('some-other-apply-task-id');

    const result = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toContain('not minted for this ApplyTask');
    expect(browserSubmit.calls).toHaveLength(0);
  });

  it('rejects for another user (ownership-scoped) even with a technically-valid token', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint(task.id);

    const result = await useCase({ userId: OTHER_USER, applyTaskId: task.id, token });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('not_found');
    expect(browserSubmit.calls).toHaveLength(0);
  });

  it('a task NOT in approved (e.g. still awaiting_review) is rejected even with a technically-valid token for it', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = ApplyTask.create({
      userId: USER, applicationId: asApplicationId('018f0000-0000-7000-8000-0000000000b1'),
      jobPostingId: asJobPostingId('018f0000-0000-7000-8000-0000000000b2'),
      documentVersionId: asDocumentVersionId('018f0000-0000-7000-8000-0000000000b3'),
    });
    for (const stage of ['mapping', 'filling', 'awaiting_review'] as const) task.transitionTo(stage);
    await applyTasks.save(task);
    const { token } = await approvalTokens.mint(task.id);

    const result = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isErr(result)).toBe(true);
    expect(browserSubmit.calls).toHaveLength(0);
  });

  it('a failed browser-runner submit transitions the task to failed — visible, not silently stuck', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint(task.id);
    browserSubmit.nextResult = err({ code: 'ats_error', message: 'ATS returned a 500' });

    const result = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isOk(result)).toBe(true); // a typed "failed" outcome, not a thrown exception
    if (isOk(result)) expect(result.value.stage).toBe('failed');

    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('failed');

    // The token was still consumed — even a failed attempt can never be retried with the same token.
    const retry = await useCase({ userId: USER, applyTaskId: task.id, token });
    expect(isErr(retry)).toBe(true);
  });
});

describe('submitApplyTask — exactly-once under REAL concurrency (task 053, same rigor as 046)', () => {
  it('EXACTLY ONE of N concurrent submitApplyTask calls with the SAME token results in a submit; the rest are rejected', async () => {
    const { applyTasks, approvalTokens, browserSubmit, useCase } = setup();
    const task = await seedApprovedTask(applyTasks);
    const { token } = await approvalTokens.mint(task.id);

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, () => useCase({ userId: USER, applyTaskId: task.id, token })),
    );

    const successes = results.filter(isOk).filter((r) => r.value.stage === 'submitted');
    expect(successes).toHaveLength(1);
    expect(browserSubmit.calls).toHaveLength(1); // the real ATS click happened EXACTLY once

    const reloaded = await applyTasks.findByIdForUser(task.id, USER);
    expect(reloaded!.stage).toBe('submitted');
  });
});

/**
 * The literal §7 test: "State machine | Property tests: no path reaches
 * `submitting` without unconsumed token." `apply-task.test.ts` proves the
 * STATE MACHINE only has one legal edge into `submitting` (from
 * `approved`). This proves the second half: this file is the ONLY call
 * site under `packages/application/src/apply/` that ever attempts that
 * transition — a static source scan, not a runtime behavior assertion, so
 * it catches a future command file that tries to add a second path even
 * before any test of that new file would run.
 */
describe('ARCHITECTURAL property: submit-apply-task.ts is the sole caller of transitionTo(\'submitting\')', () => {
  it('no other file under packages/application/src/apply/commands calls transitionTo(\'submitting\'...)', () => {
    const commandsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/apply/commands');
    const files = readdirSync(commandsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const full = path.join(commandsDir, file);
      if (!statSync(full).isFile()) continue;
      const source = readFileSync(full, 'utf-8');
      const callsSubmittingTransition = /transitionTo\(\s*['"]submitting['"]/.test(source);
      if (callsSubmittingTransition && file !== 'submit-apply-task.ts') {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
    // Sanity check the scan itself actually works (would false-pass if the regex were broken).
    const submitFileSource = readFileSync(path.join(commandsDir, 'submit-apply-task.ts'), 'utf-8');
    expect(/transitionTo\(\s*['"]submitting['"]/.test(submitFileSource)).toBe(true);
  });
});
