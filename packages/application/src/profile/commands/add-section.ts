import { notFound, type ProfileSectionContent, type ProfileSectionKind, type Result, type DomainError } from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';

export interface AddSectionInput {
  kind: ProfileSectionKind;
  content: ProfileSectionContent;
  sort?: number | undefined;
}
export interface AddSectionOutput {
  profileId: string;
  sectionId: string;
}

export function makeAddSectionUseCase(deps: { uow: UnitOfWork }) {
  return async function addSection(
    actor: Actor,
    input: AddSectionInput,
  ): Promise<Result<AddSectionOutput, DomainError>> {
    return deps.uow.withTransaction(async (ctx) => {
      const profile = await ctx.profiles.findActiveForUser(actor.userId);
      if (profile === null) {
        return { ok: false, error: notFound('No career profile exists yet') };
      }

      const added = profile.addSection({ kind: input.kind, content: input.content, sort: input.sort });
      if (!added.ok) return added;

      await ctx.profiles.save(profile);

      const events = profile.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      return { ok: true, value: { profileId: profile.id, sectionId: added.value.id } };
    });
  };
}
