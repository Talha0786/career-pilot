import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, map, flatMap, mapErr, unwrapOr, all } from './result.js';
import { uuidv7, isUuid } from './ids.js';
import { createEvent, AggregateRoot, type DomainEvent } from './domain-event.js';

describe('Result', () => {
  it('constructs and narrows ok/err', () => {
    const good = ok(42);
    const bad = err('boom');
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    if (isOk(good)) expect(good.value).toBe(42);
    if (isErr(bad)) expect(bad.error).toBe('boom');
  });

  it('map transforms ok and passes err through untouched', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err<string>('e'), (n: number) => n * 2)).toEqual(err('e'));
  });

  it('flatMap chains and short-circuits on the first error', () => {
    const half = (n: number) =>
      n % 2 === 0 ? ok(n / 2) : err('odd');
    expect(flatMap(ok(8), half)).toEqual(ok(4));
    expect(flatMap(ok(7), half)).toEqual(err('odd'));
    expect(flatMap(err<string>('prior'), half)).toEqual(err('prior'));
  });

  it('mapErr transforms only the error channel', () => {
    expect(mapErr(err('e'), (e) => `${e}!`)).toEqual(err('e!'));
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('unwrapOr returns the fallback on err', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err<string>('e'), 9)).toBe(9);
  });

  it('all collects values, short-circuiting on the first error', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(all([ok(1), err('bad'), ok(3)])).toEqual(err('bad'));
  });
});

describe('uuidv7', () => {
  it('produces a well-formed v7 uuid', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(id[19]); // RFC 4122 variant
  });

  it('is time-ordered — lexical sort equals chronological sort', () => {
    // The whole point of v7 over v4: sequential B-tree inserts.
    const t0 = Date.parse('2020-01-01T00:00:00Z');
    const ids = [0, 1000, 2000, 3000, 4000].map((offset) => uuidv7(t0 + offset));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('does not collide across 10k generations at the same timestamp', () => {
    const fixed = Date.now();
    const set = new Set(Array.from({ length: 10_000 }, () => uuidv7(fixed)));
    expect(set.size).toBe(10_000);
  });
});

describe('AggregateRoot events', () => {
  class Thing extends AggregateRoot {
    doSomething(): void {
      this.record(
        createEvent({
          eventType: 'test.happened',
          aggregateType: 'Thing',
          aggregateId: 'abc',
          payload: { n: 1 },
        }),
      );
    }
  }

  it('records events and drains them exactly once', () => {
    const t = new Thing();
    t.doSomething();
    expect(t.pendingEvents).toHaveLength(1);

    const drained: DomainEvent[] = t.pullEvents();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.eventType).toBe('test.happened');

    // Draining twice must not re-emit — otherwise the outbox double-writes.
    expect(t.pullEvents()).toHaveLength(0);
    expect(t.pendingEvents).toHaveLength(0);
  });
});
