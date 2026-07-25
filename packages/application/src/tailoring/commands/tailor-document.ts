import { z } from 'zod';
import {
  asCareerProfileId, asJobPostingId, asUserId, compileFactList,
  notFound, validationFailed, type Result, ok, err, type DomainError,
  type SupportedText, type ResumeDocumentContent, type CoverLetterDocumentContent,
  type FlaggedClaim,
} from '@careerpilot/domain';
import type { ProfileRepository, JobPostingRepository, UserRepository, UnitOfWork } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import { makeAddDocumentVersionUseCase } from '../../documents/commands/add-document-version.js';
import { makeVerifyClaimsUseCase, type VerifiedClaim } from './verify-claims.js';

/** BullMQ queue name — async because tailoring is a `large` model-tier call (docs/06-agent-design.md §3), the most expensive in the system. */
export const TAILOR_DOCUMENT_QUEUE = 'tailoring.document_requested';

export type TailoringKind = 'resume' | 'cover_letter';

export interface TailorDocumentRequestedPayload {
  readonly documentId: string;
  readonly profileId: string;
  readonly jobPostingId: string;
  readonly userId: string;
  readonly kind: TailoringKind;
  /** Task 058 — the MCP `tailor_document`/`get_generation_status` polling pair. Threaded onto the resulting DocumentVersion (see `DocumentVersion.generationJobId`, plumbed since task 022 but never previously populated by any producer) so a caller with only this id can find out when generation finishes without needing a live WS connection. Undefined for the pre-existing synchronous-enqueue API route (apps/api/src/routes/documents.ts), which still relies on the WS push — fully backward compatible. */
  readonly generationJobId?: string | undefined;
}

export interface TailorDocumentInput {
  documentId: string;
  profileId: string;
  jobPostingId: string;
  userId: string;
  kind: TailoringKind;
  generationJobId?: string | undefined;
}

export interface TailorDocumentOutput {
  documentId: string;
  versionId: string;
  version: number;
  /** Bullets/paragraphs whose supportingFactIds were empty or referenced a fact id NOT in the input fact list — task 039's cheap structural gate, evaluated on whichever attempt was ultimately persisted. */
  structurallyUnsupported: readonly string[];
  /** Task 040: true when 2 regeneration retries were exhausted and the adversarial claim-verification pass STILL found unsupported claims. */
  needsHumanReview: boolean;
  /** Non-empty only when `needsHumanReview` is true. */
  flaggedClaims: readonly FlaggedClaim[];
}

/** Task 040: unsupported-claim retries, per docs/06-agent-design.md §4 point 3 ("≤2 retries"). 0 = initial attempt only, 1 = one retry, 2 = two retries — this is the exact cap the retry-termination test proves. */
const MAX_REGENERATION_RETRIES = 2;

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

/** The claim-checkable text units of a draft — bullets (resume) or body paragraphs (cover letter) — WITHOUT any fact-id citation, for task 040's adversarial re-derivation. Deliberately reads the plain `bullets`/`bodyParagraphs` string arrays, never `bulletFacts`/`paragraphFacts`, so there is no way for a citation to leak into what the auditor sees. */
function extractClaimTexts(content: ResumeDocumentContent | CoverLetterDocumentContent): string[] {
  if (content.kind === 'resume') {
    return content.sections.flatMap((s) => s.entries.flatMap((e) => e.bullets));
  }
  return [...content.bodyParagraphs];
}

/**
 * The highest-stakes pipeline in the system (docs/06-agent-design.md §3-4):
 * given a profile's fact list (task 037) and a target job posting, produces
 * a tailored `ResumeDocumentContent`/`CoverLetterDocumentContent` (M3's
 * existing structured-doc model, reused verbatim) constrained to rephrase,
 * reorder, emphasize, and quantify-from-given-numbers ONLY — never
 * introduce new entities/employers/dates/titles/credentials/metrics.
 *
 * Task 040 wraps generation with the mandatory adversarial claim-
 * verification loop: generate → verify (separate call, separate prompt,
 * task 040) → if any claim is UNSUPPORTED, regenerate with those claims fed
 * back as "avoid this" hints (≤2 retries) → if still unresolved, persist
 * with `needsHumanReview: true` and the flagged claims attached, rather
 * than either silently shipping a hallucination or looping forever.
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
  const verifyClaims = makeVerifyClaimsUseCase({ llm: deps.llm, prompts: deps.prompts, model: deps.model });

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

    /** One generation attempt: LLM call (+ one malformed-JSON repair retry, ADR-006) → structural fact-citation gate → constructed DocumentContent. */
    const generateOnce = async (
      avoidHint: string,
    ): Promise<Result<{ content: ResumeDocumentContent | CoverLetterDocumentContent; structurallyUnsupported: string[] }, DomainError | LlmError>> => {
      const promptText = avoidHint ? `${basePrompt}${avoidHint}` : basePrompt;

      const attempt = async (text: string): Promise<Result<unknown, DomainError | LlmError>> => {
        const completion = await deps.llm.complete(
          // See score-match.ts's identical comment (task 042 finding):
          // `jsonSchema` presence toggles `response_format: json_object` on
          // the OpenAI-compatible adapter — was missing here too.
          { model: deps.model, prompt: text, jsonSchema: { type: 'object' }, temperature: promptResult.value.frontmatter.temperature },
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

      let result = await attempt(promptText);
      if (!result.ok && result.error.code === 'invalid_response') {
        const repairPrompt = `${promptText}\n\nYour previous response did not match the required JSON schema exactly. Every bullet/paragraph needs a "supportingFactIds" array (can be empty ONLY for a purely transitional cover-letter paragraph). Return ONLY the corrected JSON object, no other text.`;
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

      return ok({ content, structurallyUnsupported });
    };

    // Task 040's mandatory generate -> adversarial-verify -> retry loop.
    // Bounded at exactly MAX_REGENERATION_RETRIES (0-indexed loop runs
    // 1 + MAX_REGENERATION_RETRIES times total) — this IS the "terminate
    // after 2 retries, not loop forever" guarantee, structurally (a fixed
    // `for` bound, not a while-true with a break that could be missed).
    let avoidHint = '';
    let finalContent: ResumeDocumentContent | CoverLetterDocumentContent | null = null;
    let finalStructurallyUnsupported: string[] = [];
    let finalFlaggedClaims: FlaggedClaim[] = [];
    let needsHumanReview = false;

    for (let attemptNum = 0; attemptNum <= MAX_REGENERATION_RETRIES; attemptNum++) {
      const generated = await generateOnce(avoidHint);
      if (!generated.ok) return generated;

      const { content, structurallyUnsupported } = generated.value;
      const claimTexts = extractClaimTexts(content);
      const draftText = claimTexts.length > 0
        ? claimTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
        : '(no factual claims in this draft)';

      // Nothing to verify (e.g. an all-transitional cover letter) — skip
      // the adversarial call rather than spending budget on an empty audit.
      if (claimTexts.length === 0) {
        finalContent = content;
        finalStructurallyUnsupported = structurallyUnsupported;
        break;
      }

      const audit = await verifyClaims({ factsText, draftText, userId: input.userId, refId: job.id });
      if (!audit.ok) return audit; // a genuine LLM/budget error — surface it, don't swallow it into a false "clean" result

      const unsupported: VerifiedClaim[] = audit.value.claims.filter(
        (c) => c.factId === null || !factIdSet.has(c.factId),
      );

      if (unsupported.length === 0) {
        finalContent = content;
        finalStructurallyUnsupported = structurallyUnsupported;
        break;
      }

      if (attemptNum === MAX_REGENERATION_RETRIES) {
        // Retries exhausted — flag for mandatory human review rather than
        // silently shipping (or endlessly retrying).
        finalContent = content;
        finalStructurallyUnsupported = structurallyUnsupported;
        finalFlaggedClaims = unsupported.map((c) => ({ text: c.text, confidence: c.confidence }));
        needsHumanReview = true;
        break;
      }

      avoidHint = `\n\nIMPORTANT: an independent audit could NOT verify these claims from your previous draft against the fact list — do not repeat them; remove them or rephrase to only assert what the facts directly support:\n${unsupported.map((c) => `- "${c.text}"`).join('\n')}`;
    }

    const added = await addDocumentVersion(
      { userId },
      {
        documentId: input.documentId,
        source: 'generated',
        content: finalContent!,
        profileFactsHash: profile.factsHash,
        needsHumanReview,
        flaggedClaims: needsHumanReview ? finalFlaggedClaims : null,
        generationJobId: input.generationJobId,
      },
    );
    if (!added.ok) return added;

    return ok({
      documentId: added.value.documentId,
      versionId: added.value.versionId,
      version: added.value.version,
      structurallyUnsupported: finalStructurallyUnsupported,
      needsHumanReview,
      flaggedClaims: finalFlaggedClaims,
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
