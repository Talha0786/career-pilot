import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, validationFailed } from '../shared/errors.js';

/**
 * Value objects validate at construction. An `Email` instance is, by
 * existence, a valid email — so no downstream code needs to re-check.
 * Construction returns a Result rather than throwing (see result.ts).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Email {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<Email, DomainError> {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) {
      return err(validationFailed('Email is required', { email: 'required' }));
    }
    if (normalized.length > 254) {
      return err(validationFailed('Email is too long', { email: 'max_length' }));
    }
    if (!EMAIL_RE.test(normalized)) {
      return err(validationFailed('Email is not valid', { email: 'format' }));
    }
    return ok(new Email(normalized));
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

export class JobUrl {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<JobUrl, DomainError> {
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      return err(validationFailed('URL is not valid', { url: 'format' }));
    }
    // Only http(s). Blocks javascript:, file:, data: — see security model §1 (SSRF/XSS).
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return err(validationFailed('URL must be http or https', { url: 'protocol' }));
    }
    return ok(new JobUrl(parsed.toString()));
  }

  /**
   * Stable dedup key. Strips the fragment and common tracking params so the
   * same posting shared from different sources collapses to one hash.
   */
  canonical(): string {
    const u = new URL(this.value);
    u.hash = '';
    const TRACKING = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'ref', 'refId', 'trackingId',
    ];
    for (const p of TRACKING) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  }

  toString(): string {
    return this.value;
  }
}

/** Opaque wrapper so a raw password can never be mistaken for a hashed one. */
export class PasswordHash {
  private constructor(readonly value: string) {}

  static fromHashed(hashed: string): Result<PasswordHash, DomainError> {
    if (!hashed.startsWith('$argon2')) {
      return err(validationFailed('Not an argon2 hash', { hash: 'format' }));
    }
    return ok(new PasswordHash(hashed));
  }

  toString(): string {
    return '[redacted]';
  }

  /** Guards against a hash leaking into logs or JSON responses. */
  toJSON(): string {
    return '[redacted]';
  }
}
