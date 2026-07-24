import type { ResumeImportDraft } from './resume-field-mapper.js';

export type ResumeImportDraftStatus = 'processing' | 'ready' | 'failed';

/**
 * What actually lives in `DraftStorePort` under `resume-import:{draftId}` —
 * the mapper's output (`resume-field-mapper.ts`) plus the bookkeeping
 * needed to serve `GET /profile/import/:draftId` while parsing is still in
 * flight, and to reject a `confirm` call against a draft that failed to
 * parse (task 023: "Unsupported/corrupt file input fails with a typed
 * error, not a crash" — this is where that error surfaces to the client).
 */
export interface ResumeImportDraftRecord {
  readonly draftId: string;
  readonly userId: string;
  readonly filename: string;
  readonly status: ResumeImportDraftStatus;
  readonly draft: ResumeImportDraft | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export const RESUME_IMPORT_QUEUE = 'profile.resume_import_requested';
export const RESUME_IMPORT_DRAFT_TTL_SECONDS = 24 * 60 * 60; // 24h — HITL review shouldn't be rushed, but also isn't forever

export interface ResumeImportJobPayload {
  readonly draftId: string;
  readonly userId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileBase64: string;
}
