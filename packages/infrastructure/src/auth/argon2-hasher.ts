import * as argon2 from 'argon2';
import type { HasherPort } from '@careerpilot/application';

/**
 * Argon2id — the OWASP-recommended variant (resistant to both GPU-cracking
 * and side-channel attacks, unlike argon2i/argon2d alone). Defaults are the
 * library's, which already track OWASP's current minimums.
 */
export class Argon2Hasher implements HasherPort {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed/foreign hash string throws rather than returning false —
      // normalize to "not a match" so callers never need a try/catch.
      return false;
    }
  }
}
