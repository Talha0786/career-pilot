import { describe, it, expect } from 'vitest';
import { InMemoryApprovalTokenAdapter } from '../fakes.js';
import { isOk, isErr } from '@careerpilot/domain';

describe('ApprovalTokenPort — single-use semantics (task 046, fake adapter)', () => {
  it('mints a token that consumes successfully exactly once', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    const { token } = await port.mint('task-1');

    const first = await port.consume(token);
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value).toBe('task-1');
  });

  it('a second consume of the SAME token fails with already_consumed, never silently re-succeeds', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    const { token } = await port.mint('task-1');

    await port.consume(token);
    const second = await port.consume(token);
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error).toBe('already_consumed');
  });

  it('an unknown/never-minted token fails with invalid', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    const result = await port.consume('never-minted-token');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('invalid');
  });

  it('a token past its TTL fails with expired, never silently succeeds', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    let clock = 1_000_000;
    port.now = () => clock;

    const { token, expiresAt } = await port.mint('task-1');
    expect(expiresAt.getTime()).toBe(clock + 5 * 60 * 1000);

    clock += 5 * 60 * 1000 + 1; // one ms past expiry
    const result = await port.consume(token);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('expired');
  });

  it('tokens minted for different ApplyTasks are independent — consuming one never affects the other', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    const a = await port.mint('task-a');
    const b = await port.mint('task-b');

    const consumedA = await port.consume(a.token);
    expect(isOk(consumedA)).toBe(true);

    const consumedB = await port.consume(b.token);
    expect(isOk(consumedB)).toBe(true);
    if (isOk(consumedB)) expect(consumedB.value).toBe('task-b');
  });

  it('exactly one winner among N concurrent consume attempts on the same token (Promise.all)', async () => {
    const port = new InMemoryApprovalTokenAdapter();
    const { token } = await port.mint('task-1');

    const results = await Promise.all(Array.from({ length: 25 }, () => port.consume(token)));
    const successes = results.filter(isOk);
    expect(successes).toHaveLength(1);
    expect(results.filter(isErr).every((r) => r.error === 'already_consumed')).toBe(true);
  });
});
