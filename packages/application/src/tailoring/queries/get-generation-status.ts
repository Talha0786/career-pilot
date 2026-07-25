import { asUserId, notFound, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { DocumentRepository, Actor } from '../../ports/repositories.js';

export interface GetGenerationStatusInput {
  generationJobId: string;
}
export type GenerationStatus = 'pending' | 'ready' | 'needs_human_review' | 'failed';
export interface GetGenerationStatusOutput {
  generationJobId: string;
  status: GenerationStatus;
  documentId: string | null;
  versionId: string | null;
  version: number | null;
}

/**
 * Task 058's `get_generation_status` MCP tool — polls for the
 * `DocumentVersion` stamped with this `generationJobId` (task 058 also
 * wires `tailor_document`/the worker to actually populate that field,
 * previously plumbed through the schema since task 022 but never
 * populated by any producer). `pending` (not `not_found`) is the correct
 * response for a job id that's real but hasn't produced a version yet —
 * this tool never distinguishes "still running" from "doesn't exist" via
 * an error, since a client polling immediately after `tailor_document`
 * returns is the expected, common case, not an error condition.
 */
export function makeGetGenerationStatusUseCase(deps: { documents: DocumentRepository }) {
  return async function getGenerationStatus(
    actor: Actor,
    input: GetGenerationStatusInput,
  ): Promise<Result<GetGenerationStatusOutput, DomainError>> {
    const doc = await deps.documents.findByGenerationJobId(input.generationJobId, asUserId(actor.userId));
    if (doc === null) {
      return ok({ generationJobId: input.generationJobId, status: 'pending', documentId: null, versionId: null, version: null });
    }

    const version = doc.versions.find((v) => v.generationJobId === input.generationJobId);
    if (!version) {
      return err(notFound('Generation job not found')); // defensive — findByGenerationJobId guarantees this shouldn't happen
    }

    const status: GenerationStatus = version.needsHumanReview ? 'needs_human_review' : 'ready';

    return ok({
      generationJobId: input.generationJobId,
      status,
      documentId: doc.id,
      versionId: version.id,
      version: version.version,
    });
  };
}
