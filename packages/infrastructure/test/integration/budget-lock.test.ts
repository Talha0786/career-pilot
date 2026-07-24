import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { PostgresBudgetStore } from '../../src/llm/postgres-budget-store.js';
import { createDb } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { GuardedLlmPort } from '@careerpilot/application';
import type { LlmPort } from '@careerpilot/application';
import { isOk } from '@careerpilot/domain';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const USER_ID = '018f0000-0000-7000-8000-000000000009';

describe('PostgresBudgetStore.withUserBudgetLock — closes task 015 for real', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
    await withTestDb(async (db) => {
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash) VALUES
        (${USER_ID}, 'budget-test@example.com', '$argon2id$v=19$m=65536,t=3,p=4$x$y')
      `);
    });
  });

  it('WITHOUT the lock: naive read-then-write overspends under concurrency (proves the bug is real)', async () => {
    const connections = await Promise.all(Array.from({ length: 20 }, () => createDb(TEST_URL)));
    const BUDGET = 0.0003; // exactly 3 calls' worth at 0.0001 each

    async function naiveCheckAndSpend(db: (typeof connections)[number]['db']): Promise<boolean> {
      const spend = await db.execute(sql`
        SELECT COALESCE(SUM(cost_usd),0)::numeric AS s FROM ai_invocations WHERE user_id = ${USER_ID}
      `);
      const current = Number((spend as unknown as { s: string }[])[0]!.s);
      if (current + 0.0001 > BUDGET) return false;
      // Deliberate gap: read, THEN write, with no lock — the race window this test proves exists.
      await new Promise((r) => setTimeout(r, 5));
      await db.execute(sql`
        INSERT INTO ai_invocations (id, user_id, context, ref_id, provider, model, cost_usd, status)
        VALUES (gen_random_uuid(), ${USER_ID}, 'matching', 'x', 'fake', 'm', 0.0001, 'ok')
      `);
      return true;
    }

    const results = await Promise.all(connections.map((c) => naiveCheckAndSpend(c.db)));
    await Promise.all(connections.map((c) => c.close()));

    const succeeded = results.filter(Boolean).length;
    // This is the bug, demonstrated: more than 3 succeed because every
    // caller reads spend=0 before anyone has committed a write.
    expect(succeeded).toBeGreaterThan(3);
  });

  it('WITH pg_advisory_xact_lock: exactly 3 of 20 concurrent requests succeed, never more', async () => {
    const connections = await Promise.all(Array.from({ length: 20 }, () => createDb(TEST_URL)));
    const stores = connections.map((c) => new PostgresBudgetStore(c.db));
    // Budget with slack past the 3rd call's exact cost, not razor-thin.
    // IEEE 754: 0.0001 * 3 !== 0.0003 exactly (classic 0.1+0.2 problem) — a
    // boundary set to the mathematically "exact" limit is itself a bug
    // waiting to reject a legitimate call by a few epsilons. Real budget
    // code should compare in SQL NUMERIC (as PostgresBudgetStore already
    // does for storage) rather than JS floats end-to-end; this test found
    // that even the TEST needs the same discipline.
    const BUDGET = 0.00035;

    async function guardedCheckAndSpend(store: PostgresBudgetStore, db: (typeof connections)[number]['db']): Promise<boolean> {
      return store.withUserBudgetLock(USER_ID, async () => {
        const current = await store.getMonthlySpend(USER_ID);
        if (current + 0.0001 > BUDGET) return false;
        await new Promise((r) => setTimeout(r, 5)); // same artificial window as the naive test
        await db.execute(sql`
          INSERT INTO ai_invocations (id, user_id, context, ref_id, provider, model, cost_usd, status)
          VALUES (gen_random_uuid(), ${USER_ID}, 'matching', 'x', 'fake', 'm', 0.0001, 'ok')
        `);
        return true;
      });
    }

    const results = await Promise.all(stores.map((s, i) => guardedCheckAndSpend(s, connections[i]!.db)));
    await Promise.all(connections.map((c) => c.close()));

    const succeeded = results.filter(Boolean).length;
    // THE fix, proven: the advisory lock serializes the check-then-write per
    // user, so exactly floor(budget/cost) = 3 succeed, every run, not on average.
    expect(succeeded).toBe(3);
  });
});

describe('GuardedLlmPort.embed() — task 016, the same proof one layer up through the actual guard', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
    await withTestDb(async (db) => {
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash) VALUES
        (${USER_ID}, 'guard-lock-test@example.com', '$argon2id$v=19$m=65536,t=3,p=4$x$y')
      `);
    });
  });

  it('exactly 3 of 20 concurrent guard.embed() calls succeed against a real PostgresBudgetStore', async () => {
    const connections = await Promise.all(Array.from({ length: 20 }, () => createDb(TEST_URL)));
    const stubLlm: LlmPort = {
      async embed(req) {
        return { ok: true, value: { vector: [0.1, 0.2, 0.3], model: req.model, promptTokens: 1 } };
      },
      async complete(req) {
        return { ok: true, value: { text: '{}', model: req.model, promptTokens: 1, completionTokens: 1 } };
      },
    };
    const estimator = {
      estimateEmbedCostUsd: () => 0.0001, actualEmbedCostUsd: () => 0.0001,
      estimateCompleteCostUsd: () => 0.0001, actualCompleteCostUsd: () => 0.0001,
    };
    const BUDGET = 0.00035; // same reasoning as the store-level test above: floor(0.00035/0.0001) = 3

    const guards = connections.map(
      (c) => new GuardedLlmPort(stubLlm, new PostgresBudgetStore(c.db), estimator, BUDGET, 'test'),
    );

    const results = await Promise.all(
      guards.map((g) => g.embed({ input: 'x', model: 'm' }, { userId: USER_ID, refId: 'r', context: 'matching' })),
    );
    await Promise.all(connections.map((c) => c.close()));

    const succeeded = results.filter(isOk).length;
    expect(succeeded).toBe(3);
  });
});
