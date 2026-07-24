import { z } from 'zod';
import { type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';

export interface VerifiedClaim {
  readonly text: string;
  /** null = UNSUPPORTED — the auditor could not independently re-derive a fact mapping. */
  readonly factId: string | null;
  readonly confidence: number;
}
export interface VerifyClaimsOutput {
  readonly claims: readonly VerifiedClaim[];
}

const VerifiedClaimValidator = z.object({
  text: z.string().min(1),
  factId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
const ClaimAuditValidator = z.object({ claims: z.array(VerifiedClaimValidator) });

export interface VerifyClaimsInput {
  /** Numbered fact-list text, e.g. "F1: ...\nF2: ...". */
  factsText: string;
  /** Claim texts to audit, WITHOUT the draft's own supportingFactIds annotations — see this module's doc comment. */
  draftText: string;
  userId: string;
  refId: string;
}

/**
 * Task 040 — the adversarial claim-verification pass
 * (docs/06-agent-design.md §4 point 2): "a SEPARATE call, DIFFERENT
 * prompt, adversarial framing" from tailoring itself. Loads
 * `prompts/verify-claims/v1.md` (a distinct prompt file from
 * `tailor-resume`/`tailor-cover-letter`) and re-derives each claim's fact
 * mapping independently.
 *
 * CRITICAL: the caller MUST pass `draftText` with the draft's OWN
 * `supportingFactIds` citations stripped out (plain claim text only) — see
 * `tailor-document.ts`'s `extractClaimTexts`. Passing the draft's citations
 * through to this prompt would let the auditor simply echo them back
 * instead of independently verifying, making this pass a no-op rubber
 * stamp rather than the adversarial check the anti-hallucination contract
 * depends on.
 */
export function makeVerifyClaimsUseCase(deps: { llm: GuardedLlmPort; prompts: PromptStore; model: string }) {
  return async function verifyClaims(
    input: VerifyClaimsInput,
  ): Promise<Result<VerifyClaimsOutput, DomainError | LlmError>> {
    const promptResult = await deps.prompts.load('verify-claims');
    if (!promptResult.ok) {
      return err({ code: 'invalid_response', message: `Could not load verify-claims prompt: ${promptResult.error.message}` });
    }

    const basePrompt = promptResult.value.render({ fact_list: input.factsText, draft_text: input.draftText });

    const attempt = async (promptText: string): Promise<Result<VerifyClaimsOutput, DomainError | LlmError>> => {
      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText },
        { userId: input.userId, refId: input.refId, context: 'tailoring' },
      );
      if (!completion.ok) return completion;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        return err({ code: 'invalid_response', message: 'LLM response was not valid JSON' });
      }
      const validated = ClaimAuditValidator.safeParse(parsedJson);
      if (!validated.success) {
        return err({
          code: 'invalid_response',
          message: `LLM response did not match ClaimAuditSchema: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        });
      }
      return ok(validated.data);
    };

    // Same ADR-006 one-repair-attempt rule as every other structured-output call.
    let result = await attempt(basePrompt);
    if (!result.ok && result.error.code === 'invalid_response') {
      const repairPrompt = `${basePrompt}\n\nYour previous response did not match the required JSON schema exactly. Return ONLY the corrected JSON object, no other text.`;
      result = await attempt(repairPrompt);
    }
    return result;
  };
}

/** LLMs sometimes wrap JSON in prose or code fences despite instructions — extract the first `{...}` block defensively. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
