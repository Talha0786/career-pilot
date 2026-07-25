import type Redis from 'ioredis';

/**
 * Per-token rate limiting (task 056/058, `docs/04-mcp-design.md` §5: "Rate
 * limits per token (Redis sliding window)"). Implemented as a fixed
 * 60-second window counter (INCR + EXPIRE NX) rather than a true sliding
 * log — a deliberate simplification: a fixed window can admit up to 2x the
 * nominal rate at a window boundary, which is an acceptable trade for this
 * use case (protecting against runaway/looping MCP clients, not billing-
 * grade precision — the LLM budget guard, not this limiter, is what
 * actually bounds cost). Documented here rather than silently diverging
 * from the design doc's "sliding window" phrasing.
 */
export interface RateLimiter {
  /** Returns true if the call is allowed (and counts it), false if the limit is already hit. */
  consume(tokenId: string, toolName: string): Promise<boolean>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limitPerMinute: number = 60,
  ) {}

  async consume(tokenId: string, toolName: string): Promise<boolean> {
    const windowBucket = Math.floor(Date.now() / 60_000);
    const key = `mcp:ratelimit:${tokenId}:${toolName}:${windowBucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 60);
    }
    return count <= this.limitPerMinute;
  }
}

/** In-memory fallback for unit tests — no Redis required. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limitPerMinute: number = 60) {}

  async consume(tokenId: string, toolName: string): Promise<boolean> {
    const windowBucket = Math.floor(Date.now() / 60_000);
    const key = `${tokenId}:${toolName}:${windowBucket}`;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve(next <= this.limitPerMinute);
  }
}
