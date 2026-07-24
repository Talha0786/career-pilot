import { uuidv7, validationFailed, type Result, type DomainError } from '@careerpilot/domain';
import { PDF_MIME_TYPE, DOCX_MIME_TYPE } from '../../ports/document-extractor.port.js';
import type { QueuePort } from '../../ports/queue.port.js';
import type { DraftStorePort } from '../../ports/draft-store.port.js';
import type { Actor } from '../../ports/repositories.js';
import {
  RESUME_IMPORT_QUEUE,
  RESUME_IMPORT_DRAFT_TTL_SECONDS,
  type ResumeImportJobPayload,
  type ResumeImportDraftRecord,
} from '../parsing/resume-import-draft.js';

export interface ImportResumeInput {
  filename: string;
  mimeType: string;
  /** Base64-encoded file bytes. See task 022's routes doc comment for why this is JSON+base64 rather than true multipart for M3. */
  fileBase64: string;
}
export interface ImportResumeOutput {
  draftId: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — a resume is a few hundred KB at most; this is a generous ceiling, not a target.

/**
 * Enqueues a parse job and returns immediately — mirrors `embed-job-
 * posting.ts`'s producer/consumer split (task 010), except there's no
 * aggregate write to make atomic with an outbox event here (see
 * `QueuePort`'s docstring for why this bypasses the outbox rather than
 * routing through it). The worker (`apps/worker/src/handlers/parse-resume.
 * handler.ts`) does the actual parsing and writes the draft.
 */
export function makeImportResumeUseCase(deps: { queue: QueuePort; drafts: DraftStorePort }) {
  return async function importResume(
    actor: Actor,
    input: ImportResumeInput,
  ): Promise<Result<ImportResumeOutput, DomainError>> {
    if (input.mimeType !== PDF_MIME_TYPE && input.mimeType !== DOCX_MIME_TYPE) {
      return {
        ok: false,
        error: validationFailed('Unsupported file type — only PDF and DOCX are supported', {
          mimeType: input.mimeType,
        }),
      };
    }
    if (!input.fileBase64 || input.fileBase64.trim().length === 0) {
      return { ok: false, error: validationFailed('File content is required', { fileBase64: 'required' }) };
    }

    const approxBytes = (input.fileBase64.length * 3) / 4;
    if (approxBytes > MAX_FILE_BYTES) {
      return { ok: false, error: validationFailed('File is too large (max 10MB)', { file: 'max_size' }) };
    }

    const draftId = uuidv7();

    // Written synchronously, BEFORE enqueueing, so GET /profile/import/:id
    // never has a window where the draft looks "not found" instead of
    // "processing" — the record exists the instant this call returns.
    const initial: ResumeImportDraftRecord = {
      draftId,
      userId: actor.userId,
      filename: input.filename,
      status: 'processing',
      draft: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    await deps.drafts.set(`resume-import:${draftId}`, initial, RESUME_IMPORT_DRAFT_TTL_SECONDS);

    const payload: ResumeImportJobPayload = {
      draftId,
      userId: actor.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      fileBase64: input.fileBase64,
    };
    await deps.queue.enqueue(RESUME_IMPORT_QUEUE, payload as unknown as Record<string, unknown>);

    return { ok: true, value: { draftId } };
  };
}
