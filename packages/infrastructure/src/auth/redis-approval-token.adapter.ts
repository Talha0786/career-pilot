import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ApprovalTokenPort, ApprovalTokenConsumeError } from '@careerpilot/application';

const KEY_PREFIX = 'apptoken:';

/**
 * Task 046 — Redis-backed single-use approval token (ADR-003).
 *
 * DEVIATION FROM THE TASK FILE'S LITERAL SUGGESTION (documented, not
 * silent): the task file suggests `GETDEL` (Redis 6.2+, available on the
 * pinned `redis:7-alpine` image) for atomic single-use consume. Tried that
 * first; it cannot satisfy this task's own acceptance criteria on its own.
 * `GETDEL` (or a plain `DEL`-after-`GET`) makes the key simply GONE after
 * either a successful consume OR a natural TTL expiry — there is no way to
 * tell those two cases apart from a second caller's perspective, so a
 * concurrent-race loser and a too-late caller would both just see "key not
 * found", indistinguishable from a token that was never minted at all. The
 * acceptance criteria require THREE distinct outcomes (`already_consumed`
 * vs `expired` vs `invalid`), each independently tested. That needs a
 * tombstone, not a deletion — so this adapter keeps the key around past
 * logical expiry (see `GRACE_SECONDS` below) with an explicit `status`
 * field, and does the whole check-then-mark sequence in one Lua script so
 * it's still exactly-once atomic (a single Redis command, not a
 * GET-then-SET round trip, which would reopen the same TOCTOU race this
 * primitive exists to close).
 *
 * Mint is still the simple case the task file describes: `SET key value NX
 * EX ttl` — NX guarantees no collision with an existing (unexpired) token
 * under this key, which can only happen from an astronomically unlikely
 * `randomBytes(32)` collision (same entropy standard as the existing
 * session token, `apps/api/src/plugins/session.ts`).
 */
export class RedisApprovalTokenAdapter implements ApprovalTokenPort {
  /** Grace window past logical expiry the tombstone survives, so a late
   *  `consume()` call can report `expired` instead of `invalid` — after
   *  this window elapses too, Redis evicts the key and the two become
   *  indistinguishable (documented scope limit, not a correctness gap in
   *  the exactly-once property itself, which only depends on the atomic
   *  script below). */
  private readonly graceSeconds: number;

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = 300, // 5-minute TTL, design doc §3
    graceSeconds?: number,
  ) {
    this.graceSeconds = graceSeconds ?? Math.max(60, Math.floor(ttlSeconds));
  }

  async mint(applyTaskId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = Date.now();
    const expiresAtMs = now + this.ttlSeconds * 1000;
    const physicalTtlSeconds = this.ttlSeconds + this.graceSeconds;

    // NX collision is practically impossible (32 random bytes) but retried
    // defensively rather than assumed away.
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = randomBytes(32).toString('hex');
      const value = JSON.stringify({ applyTaskId, expiresAtMs, status: 'active' });
      const set = await this.redis.set(KEY_PREFIX + token, value, 'EX', physicalTtlSeconds, 'NX');
      if (set === 'OK') {
        return { token, expiresAt: new Date(expiresAtMs) };
      }
    }
    throw new Error('RedisApprovalTokenAdapter.mint: failed to allocate a unique token after 5 attempts');
  }

  async consume(token: string): Promise<Result<string, ApprovalTokenConsumeError>> {
    // Atomic: GET, decide, and (on success) rewrite the SAME key with
    // status:'consumed' — all inside one Lua script, so two concurrent
    // `consume()` calls for the same token can never both see 'active'.
    // KEEPTTL preserves the original physical expiry (no TTL reset).
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then
        return {'invalid'}
      end
      local data = cjson.decode(raw)
      if data.status == 'consumed' then
        return {'already_consumed'}
      end
      if tonumber(ARGV[1]) > data.expiresAtMs then
        return {'expired'}
      end
      data.status = 'consumed'
      redis.call('SET', KEYS[1], cjson.encode(data), 'KEEPTTL')
      return {'ok', data.applyTaskId}
    `;

    const raw = (await this.redis.eval(script, 1, KEY_PREFIX + token, Date.now())) as [string, string?];
    const [status, applyTaskId] = raw;

    if (status === 'ok') return ok(applyTaskId as string);
    return err(status as ApprovalTokenConsumeError);
  }
}
