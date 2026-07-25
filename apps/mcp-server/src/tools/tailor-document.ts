import { asUserId, uuidv7, validationFailed, err } from '@careerpilot/domain';
import { TailorDocumentInputSchema, type TailorDocumentInput } from '@careerpilot/contracts';
import { makeRequestDocumentTailoringUseCase } from '@careerpilot/application';
import type { ToolDef } from '../registry.js';
import type { McpDeps } from '../di.js';

export interface TailorDocumentToolOutput {
  queued: true;
  generationJobId: string;
}

/**
 * `baseDocumentId` (§3's input shape) is optional -- when omitted, this
 * picks the caller's most recently created non-deleted document of the
 * requested `kind` (uuidv7 ids sort by creation time, per
 * packages/domain/src/shared/ids.ts's doc comment, so a plain string-max
 * over ids is a valid "most recent" query with no extra timestamp read).
 * `request-document-tailoring.ts`'s existing ownership/kind/deleted
 * validation still runs on whichever id is resolved here -- this tool
 * adds a resolution step in FRONT of that use case, it does not
 * duplicate its checks.
 */
export function makeTailorDocumentTool(deps: McpDeps): ToolDef<TailorDocumentInput, TailorDocumentToolOutput> {
  const requestTailoring = makeRequestDocumentTailoringUseCase({
    documents: deps.documents,
    profiles: deps.profiles,
    jobPostings: deps.jobPostings,
    queue: deps.queue,
  });

  return {
    name: 'tailor_document',
    description:
      'Enqueue resume/cover-letter tailoring against a job posting (task 039 pipeline, async -- the ' +
      "returned generationJobId is polled via get_generation_status). Never auto-approves or exports the " +
      'result; the mandatory human-review gate (docs/06-agent-design.md §4) still applies.',
    scope: 'write:documents',
    inputSchema: TailorDocumentInputSchema,
    handler: async (input, ctx) => {
      const userId = asUserId(ctx.userId);

      let documentId = input.baseDocumentId;
      if (!documentId) {
        const docs = await deps.documents.listForUser(userId);
        const candidates = docs.filter((d) => d.kind === input.kind);
        if (candidates.length === 0) {
          return err(validationFailed(`No existing "${input.kind}" document found -- supply baseDocumentId or create one first`));
        }
        documentId = candidates.reduce((latest, d) => (d.id > latest.id ? d : latest), candidates[0]!).id;
      }

      const generationJobId = uuidv7();
      const result = await requestTailoring(
        { userId },
        { documentId, jobPostingId: input.jobPostingId, generationJobId },
      );
      if (!result.ok) return result;

      return { ok: true, value: { queued: true, generationJobId } };
    },
  };
}
