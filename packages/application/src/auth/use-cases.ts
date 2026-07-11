import { User, Email, PasswordHash, invalidCredentials, validationFailed, conflict, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { UserRepository, HasherPort } from '../ports/repositories.js';

export interface RegisterInput {
  email: string;
  password: string;
}
export interface RegisterOutput {
  userId: string;
}

export function makeRegisterUseCase(deps: { users: UserRepository; hasher: HasherPort }) {
  return async function register(input: RegisterInput): Promise<Result<RegisterOutput, DomainError>> {
    const email = Email.create(input.email);
    if (!email.ok) return email;

    if (input.password.length < 8) {
      return err(validationFailed('Password must be at least 8 characters', { password: 'min_length' }));
    }

    const existing = await deps.users.findByEmail(email.value.value);
    if (existing !== null) {
      return err(conflict('An account with this email already exists', { email: 'taken' }));
    }

    const hashed = await deps.hasher.hash(input.password);
    const passwordHash = PasswordHash.fromHashed(hashed);
    if (!passwordHash.ok) return passwordHash; // hasher contract violation — should never happen

    const user = User.register({ email: email.value, passwordHash: passwordHash.value });
    await deps.users.save(user);

    return ok({ userId: user.id });
  };
}

export interface LoginInput {
  email: string;
  password: string;
}
export interface LoginOutput {
  userId: string;
}

export function makeLoginUseCase(deps: { users: UserRepository; hasher: HasherPort }) {
  return async function login(input: LoginInput): Promise<Result<LoginOutput, DomainError>> {
    const email = Email.create(input.email);
    if (!email.ok) return err(invalidCredentials('Invalid email or password'));

    const user = await deps.users.findByEmail(email.value.value);
    if (user === null) {
      // Same error as a wrong password — don't leak whether the email exists.
      return err(invalidCredentials('Invalid email or password'));
    }

    const valid = await deps.hasher.verify(user.passwordHash.value, input.password);
    if (!valid) {
      return err(invalidCredentials('Invalid email or password'));
    }

    return ok({ userId: user.id });
  };
}
