import { notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface UpdateProfileInput {
  title?: string | undefined;
  summary?: string | null | undefined;
}
export interface UpdateProfileOutput {
  profileId: string;
}

export function makeUpdateProfileUseCase(deps: { uow: UnitOfWork }) {
  return async function updateProfile(
    actor: Actor,
    input: UpdateProfileInput,
  ): Promise<Result<UpdateProfileOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const profile = await ctx.profiles.findActiveForUser(actor.userId);
      if (profile === null) {
        return { ok: false, error: notFound('No career profile exists yet') };
      }

      const updated = profile.updateDetails({ title: input.title, summary: input.summary });
      if (!updated.ok) return updated;

      await ctx.profiles.save(profile);
      return { ok: true, value: { profileId: profile.id } };
    });
  };
}
