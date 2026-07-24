import type Redis from 'ioredis';
import type { DraftStorePort } from '@careerpilot/application';

const KEY_PREFIX = 'draft:';

/** `DraftStorePort` over Redis — see the port's docstring for why a draft doesn't live in Postgres. */
export class RedisDraftStore implements DraftStorePort {
  constructor(private readonly redis: Redis) {}

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(KEY_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(KEY_PREFIX + key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }
}
