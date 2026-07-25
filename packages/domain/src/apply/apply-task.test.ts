import { describe, it, expect } from 'vitest';
import { ApplyTask } from './apply-task.js';
import {
  APPLY_TASK_STAGES,
  isLegalTransition,
  allowedApplyTaskTransitions,
  isApplyTaskTerminal,
  onlyApprovedReachesSubmitting,
  type ApplyTaskStage,
} from './apply-task-stage.js';
import { asUserId, asApplicationId, asJobPostingId, asDocumentVersionId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const APP = asApplicationId('018f0000-0000-7000-8000-000000000002');
const JOB = asJobPostingId('018f0000-0000-7000-8000-000000000003');
const DOC_VERSION = asDocumentVersionId('018f0000-0000-7000-8000-000000000004');

const newTask = () =>
  ApplyTask.create({ userId: USER, applicationId: APP, jobPostingId: JOB, documentVersionId: DOC_VERSION });

describe('ApplyTask stage machine — exhaustive over all 9×9 pairs (task 045)', () => {
  // The table IS the spec (docs/05-playwright-design.md §3, reconciled per
  // apply-task-stage.ts's doc comment). Every pair is asserted so adding a
  // stage without updating the transition map fails loudly.
  const LEGAL = new Set<string>([
    'draft>mapping', 'draft>aborted',
    'mapping>filling', 'mapping>failed', 'mapping>aborted',
    'filling>awaiting_review', 'filling>failed', 'filling>aborted',
    'awaiting_review>approved', 'awaiting_review>failed', 'awaiting_review>aborted',
    'approved>submitting', 'approved>aborted',
    'submitting>submitted', 'submitting>failed',
  ]);

  for (const from of APPLY_TASK_STAGES) {
    for (const to of APPLY_TASK_STAGES) {
      const key = `${from}>${to}`;
      const expected = LEGAL.has(key);
      it(`${from} → ${to} is ${expected ? 'legal' : 'ILLEGAL'}`, () => {
        expect(isLegalTransition(from, to)).toBe(expected);
      });
    }
  }

  it('treats self-transitions as illegal', () => {
    for (const s of APPLY_TASK_STAGES) expect(isLegalTransition(s, s)).toBe(false);
  });

  it('draft → submitted directly is illegal (cannot skip the pipeline)', () => {
    expect(isLegalTransition('draft', 'submitted')).toBe(false);
  });

  it('lets nothing escape submitted/failed/aborted — the terminal set', () => {
    for (const s of (['submitted', 'failed', 'aborted'] as const)) {
      expect(isApplyTaskTerminal(s)).toBe(true);
      expect(allowedApplyTaskTransitions(s)).toHaveLength(0);
    }
  });

  it('ADR-003 property: submitting is reachable ONLY from approved', () => {
    expect(onlyApprovedReachesSubmitting()).toBe(true);
    for (const s of APPLY_TASK_STAGES) {
      if (s === 'approved') continue;
      expect(isLegalTransition(s, 'submitting')).toBe(false);
    }
  });

  it('submitting has no aborted exit — only submitted or failed are honest outcomes', () => {
    expect(allowedApplyTaskTransitions('submitting')).toEqual(['submitted', 'failed']);
  });
});

describe('ApplyTask aggregate (task 045)', () => {
  it('creates in draft with one recorded step (null → draft) and one CREATED event', () => {
    const task = newTask();
    expect(task.stage).toBe('draft');
    const steps = task.pullSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.fromStage).toBeNull();
    expect(steps[0]!.toStage).toBe('draft');
    const events = task.pullEvents();
    expect(events.map((e) => e.eventType)).toEqual(['apply.task_created']);
  });

  it('pullSteps/pullEvents drain — a second call returns empty', () => {
    const task = newTask();
    task.pullSteps();
    task.pullEvents();
    expect(task.pullSteps()).toHaveLength(0);
    expect(task.pullEvents()).toHaveLength(0);
  });

  it('accepts a legal transition, records exactly one step and one STAGE_CHANGED event', () => {
    const task = newTask();
    task.pullSteps();
    task.pullEvents();

    const result = task.transitionTo('mapping', 'detect-ats', { atsAdapter: 'greenhouse' });
    expect(isOk(result)).toBe(true);
    expect(task.stage).toBe('mapping');

    const steps = task.pullSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ fromStage: 'draft', toStage: 'mapping', action: 'detect-ats' });

    const events = task.pullEvents();
    expect(events.map((e) => e.eventType)).toEqual(['apply.stage_changed']);
  });

  it('rejects an illegal transition as a domain error, not a thrown exception, and does not mutate state', () => {
    const task = newTask();
    const result = task.transitionTo('submitted');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('invalid_transition');
    }
    expect(task.stage).toBe('draft'); // unchanged
    expect(task.pullSteps()).toHaveLength(1); // only the creation step, no bogus step recorded
  });

  it('submitted is terminal — no further transitions possible, including re-submitting', () => {
    const task = newTask();
    for (const stage of ['mapping', 'filling', 'awaiting_review', 'approved', 'submitting', 'submitted'] as const) {
      const r = task.transitionTo(stage);
      expect(isOk(r)).toBe(true);
    }
    expect(task.stage).toBe('submitted');

    for (const to of APPLY_TASK_STAGES as readonly ApplyTaskStage[]) {
      const r = task.transitionTo(to);
      expect(isErr(r)).toBe(true);
    }
  });

  it('emits an apply.task_submitted event exactly when reaching submitted (for the cross-aggregate Application.applied wire)', () => {
    const task = newTask();
    for (const stage of ['mapping', 'filling', 'awaiting_review', 'approved', 'submitting'] as const) {
      task.transitionTo(stage);
    }
    task.pullEvents();
    task.transitionTo('submitted');
    const events = task.pullEvents();
    expect(events.map((e) => e.eventType)).toEqual(['apply.stage_changed', 'apply.task_submitted']);
    expect(events[1]!.payload).toMatchObject({ applyTaskId: task.id, applicationId: task.applicationId });
  });

  it('fromSnapshot/toSnapshot round-trip preserves stage and atsAdapter', () => {
    const task = newTask();
    task.transitionTo('mapping');
    task.setAtsAdapter('lever');
    const snap = task.toSnapshot();
    const reloaded = ApplyTask.fromSnapshot(snap);
    expect(reloaded.stage).toBe('mapping');
    expect(reloaded.atsAdapter).toBe('lever');
    expect(reloaded.toSnapshot()).toEqual(snap);
  });
});
