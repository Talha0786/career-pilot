import { describe, it, expect } from 'vitest';
import { GuardedLlmPort } from '../../src/ports/budget-guard.js';
import { FakeLlmPort, InMemoryBudgetStore, FakeCostEstimator } from '../fakes.js';
import { isOk, isErr } from '@careerpilot/domain';

const ctx = { userId: 'u1', refId: 'job1', context: 'matching' as const };

describe('GuardedLlmPort — the raw port must never be reachable without this', () => {
  it('allows a call within budget and records the invocation', async () => {
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    const guard = new GuardedLlmPort(inner, store, new FakeCostEstimator(), 10, 'fake-provider');

    const r = await guard.embed({ input: 'a job description', model: 'test-model' }, ctx);

    expect(isOk(r)).toBe(true);
    expect(inner.callCount).toBe(1);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]!.status).toBe('ok');
  });

  it('BLOCKS dispatch before any network call once the budget is exceeded', async () => {
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    store.setSpend('u1', 9.999); // right at the edge of a $10 budget
    const guard = new GuardedLlmPort(inner, store, new FakeCostEstimator(), 10, 'fake-provider');

    const r = await guard.embed({ input: 'x'.repeat(200), model: 'test-model' }, ctx);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('budget_exceeded');

    // This is the assertion that actually matters: the inner port was NEVER
    // touched. A budget check that runs after dispatch is not a budget guard.
    expect(inner.callCount).toBe(0);
  });

  it('blocks entirely at a $0 budget regardless of input size', async () => {
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    const guard = new GuardedLlmPort(inner, store, new FakeCostEstimator(), 0, 'fake-provider');

    const r = await guard.embed({ input: 'a', model: 'm' }, ctx);

    expect(isErr(r)).toBe(true);
    expect(inner.callCount).toBe(0);
  });

  it('records a failed invocation too, with zero cost', async () => {
    const failing: import('../src/ports/llm.port.js').LlmPort = {
      async embed() {
        return { ok: false, error: { code: 'provider_unavailable', message: 'connection refused' } };
      },
    };
    const store = new InMemoryBudgetStore();
    const guard = new GuardedLlmPort(failing, store, new FakeCostEstimator(), 10, 'fake-provider');

    const r = await guard.embed({ input: 'x', model: 'm' }, ctx);

    expect(isErr(r)).toBe(true);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ status: 'error', costUsd: 0 });
    expect(store.records[0]!.error).toContain('connection refused');
  });

  it('tracks spend across sequential calls and eventually blocks', async () => {
    const inner = new FakeLlmPort();
    const store = new InMemoryBudgetStore();
    // FakeCostEstimator's pre-check estimate (input.length * 1e-5 = 0.00016
    // for this input) is roughly double its actual cost (promptTokens * 2e-5
    // = 0.00008), so the budget must be sized against the ESTIMATE, not a
    // rough multiple of the actual — otherwise 5 calls never cross it.
    // Two calls' worth of estimate (0.00032) plus a small margin: 0.0003
    // lets exactly 2 through before the 3rd is blocked.
    const guard = new GuardedLlmPort(inner, store, new FakeCostEstimator(), 0.0003, 'fake-provider');

    // Sequential, not Promise.all: the pre-dispatch check reads current spend,
    // so it only serializes correctly when calls don't race. Concurrent
    // requests against the SAME user's budget in the same instant are a real
    // gap — the Postgres-backed BudgetStore (task 009 full impl, tracked as
    // task 015) must close it with an atomic increment or a row lock, not a
    // plain read-then-write like this in-memory fake.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await guard.embed({ input: 'short text here', model: 'm' }, ctx));
    }

    const oks = results.filter(isOk).length;
    const blocked = results.filter(isErr).length;
    expect(oks).toBe(2);
    expect(blocked).toBe(3);
    expect(inner.callCount).toBe(2); // blocked calls never reach the inner port
  });
});
