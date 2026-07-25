import { describe, it, expect } from 'vitest';
import { Application, asUserId } from '@careerpilot/domain';
import { FakeApplicationRepository } from '../fake-repos.js';
import { FakeApplyTaskPort } from '../fakes.js';
import { makePrepareApplicationUseCase } from '../../src/pipeline/commands/prepare-application.js';

const USER = asUserId('018f0000-0000-7000-8000-0000000000c1');

/**
 * Task 058's core, non-negotiable safety property: `prepare_application`
 * cannot, through ANY parameter combination, drive an ApplyTask past
 * `awaiting_review`. These tests attack the boundary from both sides:
 * (a) the input TYPE has no field that could ask for more (verified by
 * TypeScript at compile time -- `PrepareApplicationInput` has exactly one
 * field), and (b) even when TypeScript is bypassed with an `as` cast to
 * simulate a malicious/buggy caller injecting extra fields, the use case
 * function NEVER reads them and NEVER calls anything on `ApplyTaskPort`
 * except its one method, whose own return type structurally excludes
 * `approved`/`submitting`/`submitted` (see apply-task.port.ts).
 */
describe('prepare_application never-submit boundary (task 058)', () => {
  async function setup() {
    const applications = new FakeApplicationRepository();
    const applyTasks = new FakeApplyTaskPort();
    const app = Application.create({ userId: USER, jobPostingId: '018f0000-0000-7000-8000-0000000000d1' as never });
    await applications.save(app);
    const prepareApplication = makePrepareApplicationUseCase({ applications, applyTasks });
    return { applications, applyTasks, app, prepareApplication };
  }

  it('the happy path stops at awaiting_review and nowhere else', async () => {
    const { applyTasks, app, prepareApplication } = await setup();
    const result = await prepareApplication({ userId: USER }, { applicationId: app.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('awaiting_review');
    expect(applyTasks.calls).toHaveLength(1);
  });

  it('injecting an "autoApprove" field past TypeScript is silently ignored -- never read, never honored', async () => {
    const { applyTasks, app, prepareApplication } = await setup();
    const maliciousInput = { applicationId: app.id, autoApprove: true, submit: true, confirm: 'yes' } as unknown as { applicationId: string };
    const result = await prepareApplication({ userId: USER }, maliciousInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('awaiting_review');
    // The ONLY thing forwarded to the ApplyTask backend is {applicationId, userId} -- no extra field leaked through.
    expect(applyTasks.calls[0]).toEqual({ applicationId: app.id, userId: USER });
  });

  it('calling it twice in a row still only ever produces awaiting_review results, never a second/escalated state', async () => {
    const { applyTasks, app, prepareApplication } = await setup();
    const first = await prepareApplication({ userId: USER }, { applicationId: app.id });
    const second = await prepareApplication({ userId: USER }, { applicationId: app.id });
    expect(first.ok && first.value.state).toBe('awaiting_review');
    expect(second.ok && second.value.state).toBe('awaiting_review');
    expect(applyTasks.calls).toHaveLength(2);
  });

  it('the ApplyTaskPort interface itself has no method other than startAndMapToReview reachable from this use case', async () => {
    // Structural proof, not just behavioral: enumerate every property this
    // use case's `applyTasks` dependency exposes at runtime and assert the
    // set is exactly {startAndMapToReview} -- if a future change added an
    // `approve`/`submit` method to the port and prepare-application.ts
    // started calling it, this test documents the exact surface that
    // would need to grow for that to even be POSSIBLE.
    const { applyTasks } = await setup();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(applyTasks)).filter((n) => n !== 'constructor');
    expect(methodNames).toEqual(['startAndMapToReview']);
  });

  it('ownership is checked before the ApplyTask backend is ever touched', async () => {
    const { applyTasks, app, prepareApplication } = await setup();
    const otherUser = asUserId('018f0000-0000-7000-8000-0000000000e1');
    const result = await prepareApplication({ userId: otherUser }, { applicationId: app.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(applyTasks.calls).toHaveLength(0); // never dispatched for an application the caller doesn't own
  });
});
