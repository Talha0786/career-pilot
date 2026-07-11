import { describe, it, expect } from 'vitest';
import { User } from './user.js';
import { Email, PasswordHash } from '../discovery/value-objects.js';
import { asUserId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';

const ARGON = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash';

const email = () => {
  const r = Email.create('user@example.com');
  if (!isOk(r)) throw new Error('setup failed');
  return r.value;
};

const hash = () => {
  const r = PasswordHash.fromHashed(ARGON);
  if (!isOk(r)) throw new Error('setup failed');
  return r.value;
};

describe('User.register', () => {
  it('creates an owner by default with a generated id', () => {
    const user = User.register({ email: email(), passwordHash: hash() });
    expect(user.role).toBe('owner');
    expect(user.email.value).toBe('user@example.com');
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts an explicit member role', () => {
    const user = User.register({ email: email(), passwordHash: hash(), role: 'member' });
    expect(user.role).toBe('member');
  });

  it('never exposes the password hash through toString or JSON', () => {
    const user = User.register({ email: email(), passwordHash: hash() });
    expect(String(user.passwordHash)).toBe('[redacted]');
    expect(JSON.stringify(user.passwordHash)).toBe('"[redacted]"');
  });
});

describe('User.fromSnapshot', () => {
  it('rehydrates a valid snapshot', () => {
    const user = User.register({ email: email(), passwordHash: hash() });
    const restored = User.fromSnapshot(user.toSnapshot());

    expect(isOk(restored)).toBe(true);
    if (isOk(restored)) {
      expect(restored.value.toSnapshot()).toEqual(user.toSnapshot());
    }
  });

  it('rejects a snapshot with a corrupt email', () => {
    const r = User.fromSnapshot({
      id: asUserId('018f0000-0000-7000-8000-000000000001'),
      email: 'not-an-email',
      passwordHash: ARGON,
      role: 'owner',
      createdAt: new Date(),
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe('validation_failed');
  });

  it('rejects a snapshot whose password is not an argon2 hash', () => {
    // Catches a plaintext password having been persisted — a serious bug we
    // want to fail loudly on read rather than silently accept.
    const r = User.fromSnapshot({
      id: asUserId('018f0000-0000-7000-8000-000000000001'),
      email: 'user@example.com',
      passwordHash: 'plaintext-oops',
      role: 'owner',
      createdAt: new Date(),
    });
    expect(isErr(r)).toBe(true);
  });
});

describe('User.assertIs', () => {
  it('permits self and forbids others', () => {
    const user = User.register({ email: email(), passwordHash: hash() });
    expect(isOk(user.assertIs(user.id))).toBe(true);

    const denied = user.assertIs(asUserId('018f0000-0000-7000-8000-0000000000ff'));
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe('forbidden');
  });
});
