import { describe, it, expect } from 'vitest';
import { Application } from './application.js';
import { STAGES, canTransition, isTerminal, isStage, allowedTransitions, type Stage } from './stage.js';
import { asUserId, asJobPostingId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');
const JOB = asJobPostingId('018f0000-0000-7000-8000-0000000000aa');

const newApp = (stage?: Stage) =>
  Application.create({ userId: USER, jobPostingId: JOB, ...(stage ? { stage } : {}) });

describe('stage machine — exhaustive over all pairs', () => {
  // The table is the spec. Every one of the 8×8 pairs is asserted, so adding a
  // stage without updating the transition map fails loudly rather than silently
  // permitting a nonsense move.
  const LEGAL = new Set<string>([
    'discovered>interested', 'discovered>applied', 'discovered>rejected', 'discovered>withdrawn',
    'interested>applied', 'interested>discovered', 'interested>rejected', 'interested>withdrawn',
    'applied>screening', 'applied>interview', 'applied>offer', 'applied>rejected', 'applied>withdrawn',
    'screening>interview', 'screening>offer', 'screening>rejected', 'screening>withdrawn',
    'interview>offer', 'interview>screening', 'interview>rejected', 'interview>withdrawn',
    'offer>rejected', 'offer>withdrawn',
  ]);

  for (const from of STAGES) {
    for (const to of STAGES) {
      const key = `${from}>${to}`;
      const expected = LEGAL.has(key);
      it(`${from} → ${to} is ${expected ? 'legal' : 'ILLEGAL'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('treats self-transitions as illegal (a no-op move signals a UI bug)', () => {
    for (const s of STAGES) expect(canTransition(s, s)).toBe(false);
  });

  it('lets nothing escape a terminal stage', () => {
    for (const s of STAGES.filter(isTerminal)) {
      expect(allowedTransitions(s)).toHaveLength(0);
    }
  });

  it('allows rejection and withdrawal from every non-terminal stage', () => {
    for (const s of STAGES.filter((x) => !isTerminal(x))) {
      expect(canTransition(s, 'rejected')).toBe(true);
      expect(canTransition(s, 'withdrawn')).toBe(true);
    }
  });
});

describe('Application.create', () => {
  it('starts at discovered and records the opening transition', () => {
    const app = newApp();
    expect(app.stage).toBe('discovered');

    const transitions = app.pullTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.fromStage).toBeNull();
    expect(transitions[0]!.toStage).toBe('discovered');
    expect(transitions[0]!.actor).toBe('system');
  });

  it('emits an application_created event', () => {
    const events = newApp().pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('pipeline.application_created');
  });
});

describe('Application.transitionTo', () => {
  it('performs a legal move and appends to history', () => {
    const app = newApp();
    app.pullTransitions(); // drain the opening one

    const r = app.transitionTo({ toStage: 'applied', actor: 'user', reason: 'sent it' });
    expect(isOk(r)).toBe(true);
    expect(app.stage).toBe('applied');

    const t = app.pullTransitions();
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      fromStage: 'discovered',
      toStage: 'applied',
      actor: 'user',
      reason: 'sent it',
    });
  });

  it('rejects an illegal move and leaves state untouched', () => {
    const app = newApp('rejected');
    app.pullTransitions();

    const r = app.transitionTo({ toStage: 'applied', actor: 'user' });

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('invalid_transition');
    expect(app.stage).toBe('rejected'); // unchanged
    expect(app.pullTransitions()).toHaveLength(0); // no phantom history
  });

  it('names the allowed moves in the error message', () => {
    const app = newApp();
    const r = app.transitionTo({ toStage: 'offer', actor: 'user' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.message).toContain('interested');
  });

  it('emits a stage_changed event on success only', () => {
    const app = newApp();
    app.pullEvents();

    app.transitionTo({ toStage: 'interested', actor: 'user' });
    expect(app.pullEvents()).toHaveLength(1);

    app.transitionTo({ toStage: 'discovered', actor: 'user' }); // legal
    app.pullEvents();

    app.transitionTo({ toStage: 'offer', actor: 'user' }); // ILLEGAL
    expect(app.pullEvents()).toHaveLength(0);
  });
});

describe('Application.assertOwnedBy', () => {
  it('forbids a non-owner', () => {
    const app = newApp();
    expect(isOk(app.assertOwnedBy(USER))).toBe(true);

    const denied = app.assertOwnedBy(OTHER);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe('forbidden');
  });
});

describe('Application snapshot round-trip', () => {
  it('preserves state and emits no events on rehydration', () => {
    const app = newApp();
    app.transitionTo({ toStage: 'applied', actor: 'user' });

    const restored = Application.fromSnapshot(app.toSnapshot());

    expect(restored.toSnapshot()).toEqual(app.toSnapshot());
    expect(restored.pullEvents()).toHaveLength(0);
    expect(restored.pullTransitions()).toHaveLength(0);
  });
});

describe('isStage guard', () => {
  it('accepts known stages and rejects unknown strings', () => {
    for (const s of STAGES) expect(isStage(s)).toBe(true);
    expect(isStage('ghosted')).toBe(false);
    expect(isStage('')).toBe(false);
  });
});

describe('Application accessors', () => {
  it('exposes stage and updatedAt', () => {
    const app = newApp();
    const before = app.updatedAt;
    app.transitionTo({ toStage: 'applied', actor: 'user', now: new Date(Date.now() + 1000) });
    expect(app.stage).toBe('applied');
    expect(app.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});
