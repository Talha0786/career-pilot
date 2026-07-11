import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 — time-ordered. Sorting ids sorts by creation time, which keeps
 * B-tree inserts sequential (no random-UUID index fragmentation) and gives
 * every table a free chronological ordering.
 *
 * Layout (RFC 9562): 48-bit big-endian ms timestamp | version (7) | 12 random
 * bits | variant (0b10) | 62 random bits.
 *
 * node:crypto is a Node builtin, not a package — the zero-dependency rule holds.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

/** Branded ids — a UserId can never be passed where a JobPostingId is expected. */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, 'UserId'>;
export type JobPostingId = Branded<string, 'JobPostingId'>;
export type ApplicationId = Branded<string, 'ApplicationId'>;

export const newUserId = (): UserId => uuidv7() as UserId;
export const newJobPostingId = (): JobPostingId => uuidv7() as JobPostingId;
export const newApplicationId = (): ApplicationId => uuidv7() as ApplicationId;

export const asUserId = (v: string): UserId => v as UserId;
export const asJobPostingId = (v: string): JobPostingId => v as JobPostingId;
export const asApplicationId = (v: string): ApplicationId => v as ApplicationId;
