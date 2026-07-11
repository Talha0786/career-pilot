import { AggregateRoot } from '../shared/domain-event.js';
import { type UserId, newUserId } from '../shared/ids.js';
import { type Result, ok, err } from '../shared/result.js';
import { type DomainError, forbidden } from '../shared/errors.js';
import { Email, PasswordHash } from '../discovery/value-objects.js';

export type UserRole = 'owner' | 'member';

export interface UserSnapshot {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: Date;
}

/**
 * User — Shared Kernel identity.
 *
 * Hashing itself is infrastructure (argon2 is a native dep); the domain only
 * accepts an already-hashed value via PasswordHash, so a raw password can
 * never be persisted by accident.
 */
export class User extends AggregateRoot {
  private constructor(
    readonly id: UserId,
    readonly email: Email,
    readonly passwordHash: PasswordHash,
    readonly role: UserRole,
    readonly createdAt: Date,
  ) {
    super();
  }

  static register(args: {
    email: Email;
    passwordHash: PasswordHash;
    role?: UserRole;
    now?: Date;
  }): User {
    return new User(
      newUserId(),
      args.email,
      args.passwordHash,
      args.role ?? 'owner',
      args.now ?? new Date(),
    );
  }

  static fromSnapshot(s: UserSnapshot): Result<User, DomainError> {
    const email = Email.create(s.email);
    if (!email.ok) return email;
    const hash = PasswordHash.fromHashed(s.passwordHash);
    if (!hash.ok) return hash;
    return ok(new User(s.id, email.value, hash.value, s.role, s.createdAt));
  }

  /** The Actor identity every use case checks against. */
  assertIs(actorId: UserId): Result<void, DomainError> {
    return this.id === actorId ? ok(undefined) : err(forbidden('Not permitted'));
  }

  toSnapshot(): UserSnapshot {
    return {
      id: this.id,
      email: this.email.value,
      passwordHash: this.passwordHash.value,
      role: this.role,
      createdAt: this.createdAt,
    };
  }
}
