import {
  ApplyTask, asUserId, asApplicationId, asDocumentId, asDocumentVersionId,
  notFound, validationFailed, type Result, ok, err, type DomainError,
} from '@careerpilot/domain';
import type { ApplicationRepository, DocumentRepository, ApplyTaskRepository } from '../../ports/repositories.js';

export interface StartApplyTaskInput {
  readonly userId: string;
  readonly applicationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
}

/**
 * Task 051 — creates the `ApplyTask` in `draft`. This is THE gate that
 * keeps M6 from silently reintroducing the hallucination risk M5's task
 * 040 was built to close: a `DocumentVersion` that failed claim
 * verification (`needsHumanReview: true`, i.e. `isExportable() === false`)
 * is rejected HERE, before an ApplyTask row (and therefore any path to
 * `mapping`/`filling`) can ever exist for it — not a check bolted onto a
 * later stage that a future call site could forget to make.
 */
export function makeStartApplyTaskUseCase(deps: {
  applications: ApplicationRepository;
  documents: DocumentRepository;
  applyTasks: ApplyTaskRepository;
}) {
  return async function startApplyTask(input: StartApplyTaskInput): Promise<Result<ApplyTask, DomainError>> {
    const userId = asUserId(input.userId);

    const application = await deps.applications.findByIdForUser(asApplicationId(input.applicationId), userId);
    if (application === null) {
      return err(notFound('Application not found'));
    }

    const document = await deps.documents.findByIdForUser(asDocumentId(input.documentId), userId);
    if (document === null) {
      return err(notFound('Document not found'));
    }

    const versionId = asDocumentVersionId(input.documentVersionId);
    const version = document.versions.find((v) => v.id === versionId);
    if (version === undefined) {
      return err(notFound('Document version not found'));
    }

    // THE gate (task 051's own acceptance criterion — tested explicitly).
    if (!version.isExportable()) {
      return err(
        validationFailed(
          'This document version has not passed claim verification and needs human review before it can be used in an application',
          { documentVersionId: versionId, needsHumanReview: 'true' },
        ),
      );
    }

    const task = ApplyTask.create({
      userId,
      applicationId: application.id,
      jobPostingId: application.jobPostingId,
      documentVersionId: versionId,
    });
    await deps.applyTasks.save(task);

    return ok(task);
  };
}
