import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import IORedis from 'ioredis';
import { RedisApprovalTokenAdapter } from '../../src/auth/redis-approval-token.adapter.js';
import { isOk, isErr } from '@careerpilot/domain';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/4';

/**
 * Task 046 — the real proof: single-use consumption under actual
 * concurrency against real Redis, same rigor as `budget-lock.test.ts`
 * (task 015/016) and M5 task 043's budget hard-stop proof. This is the ONE
 * test in this track whose result is trusted for the "exactly one winner"
 * claim — the unit test (approval-token.test.ts, application package) only
 * proves the fake's LOGIC is right, not that real Redis enforces it under
 * genuine concurrent network round trips.
 */
describe('RedisApprovalTokenAdapter — REAL Redis (task 046)', () => {
  let redis: IORedis;

  beforeAll(() => {
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('mints an opaque, sufficiently-long random token', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const { token, expiresAt } = await adapter.mint('task-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32).toString('hex')
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('consumes a valid token exactly once — a second consume gets already_consumed', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const { token } = await adapter.mint('task-1');

    const first = await adapter.consume(token);
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value).toBe('task-1');

    const second = await adapter.consume(token);
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error).toBe('already_consumed');
  });

  it('an unknown token fails with invalid', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const result = await adapter.consume('0'.repeat(64));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('invalid');
  });

  it('a token past its TTL fails with expired (short TTL override, no real 5-minute wait)', async () => {
    // 1-second logical TTL + the adapter's own grace window keeps the
    // tombstone around long enough for THIS test to observe 'expired'
    // rather than 'invalid'.
    const adapter = new RedisApprovalTokenAdapter(redis, 1, 10);
    const { token } = await adapter.mint('task-1');

    await new Promise((r) => setTimeout(r, 1100));

    const result = await adapter.consume(token);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('expired');
  });

  it('EXACTLY ONE of N concurrent consume attempts on the same token succeeds — real Redis, real Promise.all', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const { token } = await adapter.mint('task-concurrent');

    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, () => adapter.consume(token)));

    const successes = results.filter(isOk);
    const failures = results.filter(isErr);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.value).toBe('task-concurrent');
    expect(failures).toHaveLength(N - 1);
    expect(failures.every((f) => f.error === 'already_consumed')).toBe(true);
  });

  it('re-run: exactly-once holds again on a fresh token (not a fluke of the first run)', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const { token } = await adapter.mint('task-concurrent-2');

    const results = await Promise.all(Array.from({ length: 30 }, () => adapter.consume(token)));
    expect(results.filter(isOk)).toHaveLength(1);
  });

  it('two DIFFERENT tokens for two different ApplyTasks each get their own independent winner under concurrency', async () => {
    const adapter = new RedisApprovalTokenAdapter(redis, 300);
    const a = await adapter.mint('task-a');
    const b = await adapter.mint('task-b');

    const [resultsA, resultsB] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => adapter.consume(a.token))),
      Promise.all(Array.from({ length: 10 }, () => adapter.consume(b.token))),
    ]);

    expect(resultsA.filter(isOk)).toHaveLength(1);
    expect(resultsB.filter(isOk)).toHaveLength(1);
    expect((resultsA.filter(isOk)[0] as { value: string }).value).toBe('task-a');
    expect((resultsB.filter(isOk)[0] as { value: string }).value).toBe('task-b');
  });
});
