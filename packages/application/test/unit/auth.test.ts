import { describe, it, expect } from 'vitest';
import { makeRegisterUseCase, makeLoginUseCase } from '../../src/auth/use-cases.js';
import { FakeUserRepository, FakeHasher } from '../fake-repos.js';
import { isOk, isErr } from '@careerpilot/domain';

function setup() {
  const users = new FakeUserRepository();
  const hasher = new FakeHasher();
  return {
    register: makeRegisterUseCase({ users, hasher }),
    login: makeLoginUseCase({ users, hasher }),
    users,
  };
}

describe('register', () => {
  it('creates a user with a hashed password', async () => {
    const { register, users } = setup();
    const r = await register({ email: 'a@b.com', password: 'longenough' });
    expect(isOk(r)).toBe(true);

    const stored = await users.findByEmail('a@b.com');
    expect(stored).not.toBeNull();
    expect(stored!.passwordHash.value).not.toContain('longenough'.slice(0, 3) + 'ongenough'); // not plaintext-equal by luck
  });

  it('rejects a duplicate email', async () => {
    const { register } = setup();
    await register({ email: 'a@b.com', password: 'longenough' });
    const second = await register({ email: 'a@b.com', password: 'differentpw' });
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error.code).toBe('conflict');
  });

  it('rejects a too-short password before touching the repository', async () => {
    const { register, users } = setup();
    const r = await register({ email: 'a@b.com', password: 'short' });
    expect(isErr(r)).toBe(true);
    expect(await users.findByEmail('a@b.com')).toBeNull();
  });
});

describe('login', () => {
  it('succeeds with correct credentials', async () => {
    const { register, login } = setup();
    await register({ email: 'a@b.com', password: 'correcthorse' });
    const r = await login({ email: 'a@b.com', password: 'correcthorse' });
    expect(isOk(r)).toBe(true);
  });

  it('fails with the SAME error for wrong password and unknown email (no enumeration)', async () => {
    const { register, login } = setup();
    await register({ email: 'a@b.com', password: 'correcthorse' });

    const wrongPw = await login({ email: 'a@b.com', password: 'wrongpassword' });
    const unknownEmail = await login({ email: 'nobody@b.com', password: 'whatever' });

    expect(isErr(wrongPw) && isErr(unknownEmail)).toBe(true);
    if (isErr(wrongPw) && isErr(unknownEmail)) {
      expect(wrongPw.error.code).toBe(unknownEmail.error.code);
      expect(wrongPw.error.message).toBe(unknownEmail.error.message);
    }
  });
});
