import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import {
  mapResumeTextToDraft,
  RESUME_IMPORT_QUEUE,
  RESUME_IMPORT_DRAFT_TTL_SECONDS,
  type ResumeImportJobPayload,
  type ResumeImportDraftRecord,
} from '@careerpilot/application';
import type { DocumentTextExtractorPort, DraftStorePort } from '@careerpilot/application';

/**
 * Consumes `profile.resume_import_requested` (enqueued by `import-resume`'s
 * use case). MUST be idempotent — same at-least-once-delivery reasoning as
 * `job-posted.handler.ts` (task 010): re-running this for the same draftId
 * just overwrites the same Redis key with the same result, which is a safe
 * no-op in effect, not a special case to guard.
 *
 * Deliberately does NOT call any LLM — see `resume-field-mapper.ts`'s
 * file-level comment. `mapResumeTextToDraft` is pure, deterministic,
 * network-free heuristic extraction.
 */
export function createParseResumeWorker(deps: {
  connection: Redis;
  extractor: DocumentTextExtractorPort;
  drafts: DraftStorePort;
  logger: Logger;
}): Worker<ResumeImportJobPayload> {
  return new Worker<ResumeImportJobPayload>(
    RESUME_IMPORT_QUEUE,
    async (job: Job<ResumeImportJobPayload>) => {
      const log = deps.logger.child({ jobId: job.id, draftId: job.data.draftId });
      log.info('parsing resume import');

      const key = `resume-import:${job.data.draftId}`;
      const base = {
        draftId: job.data.draftId,
        userId: job.data.userId,
        filename: job.data.filename,
        createdAt: new Date().toISOString(),
      };

      let bytes: Buffer;
      try {
        bytes = Buffer.from(job.data.fileBase64, 'base64');
      } catch (cause) {
        // Malformed base64 — task 023 acceptance: "fails with a typed
        // error, not a crash." Recorded on the draft, not thrown, since
        // there is no legitimate retry outcome for corrupt input.
        const record: ResumeImportDraftRecord = {
          ...base,
          status: 'failed',
          draft: null,
          error: `Could not decode uploaded file: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
        await deps.drafts.set(key, record, RESUME_IMPORT_DRAFT_TTL_SECONDS);
        log.warn({ error: record.error }, 'resume import failed: bad encoding');
        return;
      }

      const extracted = await deps.extractor.extractText(bytes, job.data.mimeType);
      if (!extracted.ok) {
        const record: ResumeImportDraftRecord = {
          ...base,
          status: 'failed',
          draft: null,
          error: extracted.error.message,
        };
        await deps.drafts.set(key, record, RESUME_IMPORT_DRAFT_TTL_SECONDS);
        log.warn({ code: extracted.error.code, error: extracted.error.message }, 'resume import failed: extraction');
        return;
      }

      const draft = mapResumeTextToDraft(extracted.value.text);
      const record: ResumeImportDraftRecord = { ...base, status: 'ready', draft, error: null };
      await deps.drafts.set(key, record, RESUME_IMPORT_DRAFT_TTL_SECONDS);
      log.info({ sectionCount: draft.sections.length }, 'resume import parsed');
    },
    { connection: deps.connection, concurrency: 2 },
  );
}
