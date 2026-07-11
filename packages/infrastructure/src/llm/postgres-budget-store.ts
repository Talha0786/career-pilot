import { sql } from 'drizzle-orm';
import { uuidv7 } from '@careerpilot/domain';
import type { BudgetStore } from '@careerpilot/application';
import type { AiInvocationRecord } from '@careerpilot/application';
import type { Db } from '../db/client.js';

/**
 * Closes task 015's concurrency gap. getMonthlySpend/recordInvocation on
 * their own are still read-then-write from the CALLER's perspective — the
 * atomicity has to live in how the budget check and the spend commit relate.
 * Real fix: the guard's "read spend, decide, dispatch, then record" flow
 * can't be made atomic without changing the guard's shape (a bigger change
 * than this task). What THIS store does concretely:
 *  - reads spend with the invocations table as the single source of truth
 *    (no separate counter to drift out of sync)
 *  - records failures too, so a crash-after-dispatch still counts against
 *    the budget rather than disappearing
 * The remaining true race (two concurrent requests both reading spend before
 * either commits) requires a serializable transaction or an advisory lock
 * per user around the whole guard.embed() call — noted here, not silently
 * fixed, because pretending this file alone closes it would be dishonest.
 */
export class PostgresBudgetStore implements BudgetStore {
  constructor(private readonly db: Db) {}

  async getMonthlySpend(userId: string): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::numeric AS spend
      FROM ai_invocations
      WHERE user_id = ${userId}
        AND created_at >= date_trunc('month', now())
    `);
    return Number((rows as unknown as { spend: string }[])[0]?.spend ?? 0);
  }

  /**
   * Serializes concurrent spend checks FOR ONE USER using a Postgres advisory
   * lock keyed on the user id. This is the actual fix for task 015: it makes
   * "read spend, decide, commit" atomic across concurrent callers without
   * requiring every caller to share one transaction.
   */
  async withUserBudgetLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // hashtext() collapses the uuid to a 32-bit lock key; collisions are
      // acceptable (they only cause extra serialization, never incorrect budgets).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
      return fn();
    });
  }

  async recordInvocation(record: AiInvocationRecord): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ai_invocations
        (id, user_id, context, ref_id, provider, model, prompt_tokens, completion_tokens, cost_usd, latency_ms, status, error)
      VALUES
        (${uuidv7()}, ${record.userId}, ${record.context}, ${record.refId}, ${record.provider}, ${record.model},
         ${record.promptTokens}, ${record.completionTokens}, ${record.costUsd}, ${record.latencyMs}, ${record.status}, ${record.error})
    `);
  }
}
