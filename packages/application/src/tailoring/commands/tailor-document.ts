import { z } from 'zod';
import {
  asCareerProfileId, asJobPostingId, asUserId, compileFactList,
  notFound, validationFailed, type Result, ok, err, type DomainError,
  type SupportedText, type ResumeDocumentContent, type CoverLetterDocumentContent,
} from '@careerpilot/domain';
import type { ProfileRepository, JobPostingRepository, UserRepository, UnitOfWork } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import { makeAddDocumentVersionUseCase } from '../../documents/commands/add-document-version.js';

/** BullMQ queue name — async because tailoring is a `large` model-tier call (docs/06-agent-design.md §3), the most expensive in the system. */
export const TAILOR_DOCUMENT_QUEUE = 'tailoring.document_requested';

export type TailoringKind = 'resume' | 'cover_letter';

export interface TailorDocumentRequestedPayload {
  readonly documentId: string;
  readonly profileId: string;
  readonly jobPostingId: string;
  readonly userId: string;
  readonly kind: TailoringKind;
}

export interface TailorDocumentInput {
  documentId: string;
  profileId: string;
  jobPostingId: string;
  userId: string;
  kind: TailoringKind;
}

export interface TailorDocumentOutput {
  documentId: string;
  versionId: string;
  version: number;
  /** Bullets/paragraphs whose supportingFactIds were empty or referenced a fact id NOT in the input fact list — the cheap structural gate (task 039), separate from task 040's adversarial LLM re-check. Non-empty here does NOT block persistence in this task; task 040 is what turns this into a retry/needs_human decision. */
  structurallyUnsupported: readonly string[];
}

const SupportedTextValidator = z.object({
  text: z.string().min(1).max(4000),
  supportingFactIds: z.array(z.string()),
});

const TailorResumeOutputValidator = z.object({
  summary: z.string().max(4000).nullable(),
  sections: z.array(z.object({
    heading: z.string().min(1).max(200),
    entries: z.array(z.object({
      title: z.string().max(200),
      subtitle: z.string().max(200),
      dateRange: z.string().max(100).nullable(),
      bullets: z.array(SupportedTextValidator).max(50),
    })).max(100),
  })).max(50),
});

const TailorCoverLetterOutputValidator = z.object({
  salutation: z.string().min(1).max(200),
  bodyParagraphs: z.array(SupportedTextValidator).max(20),
  closing: z.string().min(1).max(200),
});

/** Best-effort "Firstname Lastname" from an email local-part — see this file's module doc comment (contact `name` has no real source in the current data model). */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'Candidate';
  const words = local.split(/[._-]+/).filter(Boolean);
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return titled.length > 0 ? titled : 'Candidate';
}

/**
 * The highest-stakes pipeline in the system (docs/06-agent-design.md §3-4):
 * given a profile's fact list (task 037) and a target job posting, produces
 * a tailored `ResumeDocumentContent`/`CoverLetterDocumentContent` (M3's
 * existing structured-doc model, reused verbatim) constrained to rephrase,
 * reorder, emphasize, and quantify-from-given-numbers ONLY — never
 * introduce new entities/employers/dates/titles/credentials/metrics.
 *
 * KNOWN GAP (documented, not silently papered over): `contact.name` has no
 * real source in this data model — neither `User` nor `CareerProfile` has a
 * "display name" field. Derived heuristically from the email local-part
 * rather than left blank (the render/export pipeline requires a non-empty
 * name) or hallucinated by the LLM. A human reviewing the diff (task 041)
 * can correct it; a proper fix is a follow-up task adding a real name field.
 */
export function makeTailorDocumentUseCase(deps: {
  uow: UnitOfWork;
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  users: UserRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
}) {
  const addDocumentVersion = makeAddDocumentVersionUseCase({ uow: deps.uow });

  return async function tailorDocument(
    input: TailorDocumentInput,
  ): Promise<Result<TailorDocumentOutput, DomainError | LlmError>> {
    const profileId = asCareerProfileId(input.profileId);
    const userId = asUserId(input.userId);

    const profile = await deps.profiles.findByIdForUser(profileId, userId);
    if (profile === null) return err(notFound('Career profile not found'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(input.jobPostingId), userId);
    if (job === null) return err(notFound('Job posting not found'));

    const user = await deps.users.findById(userId);
    if (user === null) return err(notFound('User not found'));
    const contact = { name: nameFromEmail(user.email.value), email: user.email.value };

    const facts = compileFactList(profile);
    if (facts.length === 0) {
      return err(validationFailed('Profile has no facts to tailor from yet — add at least one section first'));
    }
    const factIdSet = new Set(facts.map((f) => f.id));
    const factsText = facts.map((f) => `${f.id}: ${f.text}`).join('\n');

    const taskName = input.kind === 'resume' ? 'tailor-resume' : 'tailor-cover-letter';
    const promptResult = await deps.prompts.load(taskName);
    if (!promptResult.ok) {
      return err(validationFailed(`Could not load ${taskName} prompt: ${promptResult.error.message}`));
    }

    const basePrompt = promptResult.value.render({
      profile_facts: factsText,
      job_title: job.title,
      job_company: job.company ?? 'Unknown',
      job_description: job.descriptionMd,
    });

    const validator = input.kind === 'resume' ? TailorResumeOutputValidator : TailorCoverLetterOutputValidator;

    const attempt = async (promptText: string): Promise<Result<unknown, DomainError | LlmError>> => {
      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText },
        { userId: input.userId, refId: job.id, context: 'tailoring' },
      );
      if (!completion.ok) return completion;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        return err({ code: 'invalid_response', message: 'LLM response was not valid JSON' });
      }
      const validated = validator.safeParse(parsedJson);
      if (!validated.success) {
        return err({
          code: 'invalid_response',
          message: `LLM response did not match ${taskName} output schema: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        });
      }
      return ok(validated.data);
    };

    // ADR-006: one repair attempt on validation failure, then a typed
    // failure with the raw output available for triage (same rule 038
    // already applies).
    let result = await attempt(basePrompt);
    if (!result.ok && result.error.code === 'invalid_response') {
      const repairPrompt = `${basePrompt}\n\nYour previous response did not match the required JSON schema exactly. Every bullet/paragraph needs a "supportingFactIds" array (can be empty ONLY for a purely transitional cover-letter paragraph). Return ONLY the corrected JSON object, no other text.`;
      result = await attempt(repairPrompt);
    }
    if (!result.ok) return result;

    const structurallyUnsupported: string[] = [];
    const checkSupportedText = (item: { text: string; supportingFactIds: string[] }, allowEmpty: boolean): SupportedText => {
      const validIds = item.supportingFactIds.filter((id) => factIdSet.has(id));
      const isSupported = allowEmpty
        ? item.supportingFactIds.length === 0 || validIds.length > 0
        : validIds.length > 0;
      if (!isSupported || validIds.length !== item.supportingFactIds.length) {
        structurallyUnsupported.push(item.text);
      }
      return { text: item.text, supportingFactIds: validIds };
    };

    let content: ResumeDocumentContent | CoverLetterDocumentContent;

    if (input.kind === 'resume') {
      const data = result.value as z.infer<typeof TailorResumeOutputValidator>;
      content = {
        schemaVersion: 1,
        kind: 'resume',
        contact,
        summary: data.summary,
        sections: data.sections.map((s) => ({
          heading: s.heading,
          entries: s.entries.map((e) => ({
            title: e.title,
            subtitle: e.subtitle,
            dateRange: e.dateRange,
            bullets: e.bullets.map((b) => b.text),
            bulletFacts: e.bullets.map((b) => checkSupportedText(b, false)),
          })),
        })),
      };
    } else {
      const data = result.value as z.infer<typeof TailorCoverLetterOutputValidator>;
      content = {
        schemaVersion: 1,
        kind: 'cover_letter',
        contact: { name: contact.name, email: contact.email },
        recipient: job.company,
        salutation: data.salutation,
        bodyParagraphs: data.bodyParagraphs.map((p) => p.text),
        paragraphFacts: data.bodyParagraphs.map((p) => checkSupportedText(p, true)),
        closing: data.closing,
      };
    }

    const added = await addDocumentVersion(
      { userId },
      {
        documentId: input.documentId,
        source: 'generated',
        content,
        profileFactsHash: profile.factsHash,
      },
    );
    if (!added.ok) return added;

    return ok({
      documentId: added.value.documentId,
      versionId: added.value.versionId,
      version: added.value.version,
      structurallyUnsupported,
    });
  };
}

/** LLMs sometimes wrap JSON in prose or code fences despite instructions — extract the first `{...}` block defensively. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
