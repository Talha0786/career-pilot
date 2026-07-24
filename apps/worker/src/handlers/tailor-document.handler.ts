import { Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { makeTailorDocumentUseCase, TAILOR_DOCUMENT_QUEUE, type TailorDocumentRequestedPayload } from '@careerpilot/application';
import type {
  ProfileRepository, JobPostingRepository, UserRepository, UnitOfWork, GuardedLlmPort, PromptStore,
} from '@careerpilot/application';

/**
 * Consumes `tailoring.document_requested` (task 039) — async because
 * tailoring is a `large` model-tier call (docs/06-agent-design.md §3), the
 * most expensive and slowest pipeline in this system; never something an
 * HTTP request should block on (same reasoning `score-match.handler.ts`
 * already applies one tier down).
 */
export function createTailorDocumentWorker(deps: {
  connection: Redis;
  uow: UnitOfWork;
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  users: UserRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
  logger: Logger;
  /** Worker -> Redis pub/sub -> api -> browser, same channel shape as job.embedded (M2 design §2). */
  publishWsEvent?: (event: { userId: string; documentId: string; status: 'ready' | 'failed' }) => Promise<void>;
}): Worker<TailorDocumentRequestedPayload> {
  const tailorDocument = makeTailorDocumentUseCase({
    uow: deps.uow,
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    users: deps.users,
    llm: deps.llm,
    prompts: deps.prompts,
    model: deps.model,
  });

  return new Worker<TailorDocumentRequestedPayload>(
    TAILOR_DOCUMENT_QUEUE,
    async (job: Job<TailorDocumentRequestedPayload>) => {
      const log = deps.logger.child({ jobId: job.id, documentId: job.data.documentId });
      log.info('tailoring document');

      const result = await tailorDocument({
        documentId: job.data.documentId,
        profileId: job.data.profileId,
        jobPostingId: job.data.jobPostingId,
        userId: job.data.userId,
        kind: job.data.kind,
      });

      if (!result.ok) {
        await deps.publishWsEvent?.({ userId: job.data.userId, documentId: job.data.documentId, status: 'failed' });
        // not_found/validation_failed/budget_exceeded won't resolve by
        // BullMQ retrying — same posture as every other handler here.
        if (result.error.code !== 'provider_unavailable' && result.error.code !== 'rate_limited' && result.error.code !== 'invalid_response') {
          log.warn({ code: result.error.code }, 'tailoring not retried');
          return;
        }
        log.error({ error: result.error }, 'tailoring failed, will retry');
        throw new Error(result.error.message);
      }

      if (result.value.structurallyUnsupported.length > 0) {
        log.warn(
          { count: result.value.structurallyUnsupported.length },
          'tailored draft has bullets/paragraphs that failed the structural fact-citation gate (task 040 will adjudicate)',
        );
      }

      log.info({ versionId: result.value.versionId }, 'tailoring complete');
      await deps.publishWsEvent?.({ userId: job.data.userId, documentId: job.data.documentId, status: 'ready' });
    },
    { connection: deps.connection, concurrency: 2 },
  );
}
