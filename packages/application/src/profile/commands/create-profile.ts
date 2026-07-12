import { CareerProfile, conflict, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface CreateProfileInput {
  title: string;
  summary?: string | null | undefined;
}
export interface CreateProfileOutput {
  profileId: string;
}

/**
 * The API treats a career profile as a per-user singleton (task 022:
 * `GET/PUT /api/profile`, no id in the URL) — so creating a second ACTIVE
 * profile for a user who already has one is a conflict, not silently
 * allowed. This is the invariant-violation path task 020's test plan asks
 * for; the domain doesn't know about "one active profile per user" (that's
 * an application-level policy, not a CareerProfile invariant), so it's
 * enforced here, before construction.
 */
export function makeCreateProfileUseCase(deps: { uow: UnitOfWork }) {
  return async function createProfile(
    actor: Actor,
    input: CreateProfileInput,
  ): Promise<Result<CreateProfileOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const existing = await ctx.profiles.findActiveForUser(actor.userId);
      if (existing !== null) {
        return { ok: false, error: conflict('An active career profile already exists for this user') };
      }

      const created = CareerProfile.create({
        userId: actor.userId,
        title: input.title,
        summary: input.summary,
      });
      if (!created.ok) return created;

      const profile = created.value;
      await ctx.profiles.save(profile);

      const events = profile.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      return { ok: true, value: { profileId: profile.id } };
    });
  };
}
