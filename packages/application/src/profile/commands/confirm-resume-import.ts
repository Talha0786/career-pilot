import {
  CareerProfile,
  notFound,
  conflict,
  type ProfileSectionKind,
  type ProfileSectionContent,
  type Result,
  type DomainError,
} from '@careerpilot/domain';
import type { UnitOfWork, Actor } from '../../ports/repositories.js';
import type { DraftStorePort } from '../../ports/draft-store.port.js';
import type { ResumeImportDraftRecord } from '../parsing/resume-import-draft.js';

export interface ConfirmResumeImportInput {
  draftId: string;
  /**
   * The reviewed/edited section list from the HITL confirm screen (task
   * 025) — sent back in full rather than as a diff against the draft, so
   * there's no index-drift ambiguity between what the worker proposed and
   * what the user actually approved. ADR-003's posture, applied to import:
   * nothing from the draft is committed that the user didn't explicitly
   * pass back here.
   */
  sections: readonly { kind: ProfileSectionKind; content: ProfileSectionContent }[];
  /** Only used if the user has no active profile yet. */
  profileTitle?: string | undefined;
}
export interface ConfirmResumeImportOutput {
  profileId: string;
  sectionsAdded: number;
}

export function makeConfirmResumeImportUseCase(deps: { uow: UnitOfWork; drafts: DraftStorePort }) {
  return async function confirmResumeImport(
    actor: Actor,
    input: ConfirmResumeImportInput,
  ): Promise<Result<ConfirmResumeImportOutput, DomainError>> {
    const draft = await deps.drafts.get<ResumeImportDraftRecord>(`resume-import:${input.draftId}`);
    // Same non-leaking posture as every other ownership check in this
    // codebase (task 011): a draft that doesn't exist and a draft owned by
    // someone else look identical from the outside — both 404.
    if (draft === null || draft.userId !== actor.userId) {
      return { ok: false, error: notFound('Import draft not found or expired') };
    }
    if (draft.status !== 'ready') {
      return {
        ok: false,
        error: conflict(`Draft is not ready for confirmation (status: ${draft.status})`, { status: draft.status }),
      };
    }

    return deps.uow.withTransaction(async (ctx) => {
      let profile = await ctx.profiles.findActiveForUser(actor.userId);
      if (profile === null) {
        const created = CareerProfile.create({
          userId: actor.userId,
          title: input.profileTitle ?? 'My Career',
        });
        if (!created.ok) return created;
        profile = created.value;
      }

      for (const section of input.sections) {
        const added = profile.addSection({ kind: section.kind, content: section.content });
        if (!added.ok) return added;
      }

      await ctx.profiles.save(profile);

      const events = profile.pullEvents();
      if (events.length > 0) await ctx.outbox.enqueue(events);

      await deps.drafts.delete(`resume-import:${input.draftId}`);

      return { ok: true, value: { profileId: profile.id, sectionsAdded: input.sections.length } };
    });
  };
}
