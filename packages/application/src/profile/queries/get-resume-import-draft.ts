import { notFound, type Result, type DomainError } from '@careerpilot/domain';
import type { Actor } from '../../ports/repositories.js';
import type { DraftStorePort } from '../../ports/draft-store.port.js';
import type { ResumeImportDraftRecord } from '../parsing/resume-import-draft.js';

/** Backs the import-review screen (task 025): poll until status leaves 'processing'. */
export function makeGetResumeImportDraftUseCase(deps: { drafts: DraftStorePort }) {
  return async function getResumeImportDraft(
    actor: Actor,
    draftId: string,
  ): Promise<Result<ResumeImportDraftRecord, DomainError>> {
    const draft = await deps.drafts.get<ResumeImportDraftRecord>(`resume-import:${draftId}`);
    if (draft === null || draft.userId !== actor.userId) {
      return { ok: false, error: notFound('Import draft not found or expired') };
    }
    return { ok: true, value: draft };
  };
}
