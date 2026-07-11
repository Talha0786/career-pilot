import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const KEY_PREFIX = 'session:';

export interface SessionData {
  userId: string;
}

/**
 * Sessions live in Redis only (M2 design §4 — "DB table only for
 * revocation list", and no revocation list exists yet, so this is the
 * whole store). A session id is an opaque random token, never a JWT — this
 * is what makes `destroy()` an actual revocation rather than a wish.
 */
export class SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(data: SessionData): Promise<string> {
    const sessionId = randomBytes(32).toString('hex');
    await this.redis.set(KEY_PREFIX + sessionId, JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
    return sessionId;
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(KEY_PREFIX + sessionId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + sessionId);
  }
}

export const SESSION_COOKIE_NAME = 'cp_session';
