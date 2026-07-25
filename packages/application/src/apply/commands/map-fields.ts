import { z } from 'zod';
import { ok, err, type Result, type DomainError, validationFailed, TAXONOMY, isNeverAutoFill, type TaxonomyFieldKey } from '@careerpilot/domain';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { LlmError } from '../../ports/llm.port.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import type { DetectedField, SerializedFormField } from '../../ports/field-detection.port.js';

/**
 * Task 050 — Stage 3 (LLM fallback) of the field-mapping pipeline. ONLY
 * ever invoked by the caller (task 051's `run-mapping.ts`) for fields
 * stages 1 (048) and 2 (049) left unmapped or low-confidence — this
 * function has no way to reach a field stages 1/2 already resolved
 * confidently, since it's never given them; "cheapest-first" is enforced
 * by the CALLER never passing already-confident fields in, not by a check
 * inside this function (task 050's acceptance criterion: "enforced with a
 * test, not just documented" — see map-fields.test.ts's invocation-count
 * assertion for the caller-side proof).
 */

const ZodFieldMapEntry = z.object({
  selector: z.string().min(1),
  taxonomyKey: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  draftAnswer: z.string().max(4000).nullable().optional(),
});
const ZodFieldMap = z.object({ fields: z.array(ZodFieldMapEntry) });

export interface MapFieldsWithLlmInput {
  readonly userId: string;
  readonly applyTaskId: string;
  /** Only the fields stages 1+2 left unresolved/low-confidence — see doc comment above. */
  readonly lowConfidenceFields: readonly SerializedFormField[];
  readonly profileFactsText: string;
  /** §4: "it can draft answers to essay questions only when the user opts in per-task". */
  readonly allowEssayDrafting: boolean;
}

const LOW_CONFIDENCE_FLOOR = 0.35; // mirrors heuristic-mapper.ts's own floor (task 049) — documented, kept in sync manually

export function makeMapFieldsWithLlmUseCase(deps: { llm: GuardedLlmPort; prompts: PromptStore; model: string }) {
  return async function mapFieldsWithLlm(
    input: MapFieldsWithLlmInput,
  ): Promise<Result<DetectedField[], DomainError | LlmError>> {
    if (input.lowConfidenceFields.length === 0) {
      return ok([]); // nothing left for the LLM to do — the whole point of cheapest-first
    }

    const promptResult = await deps.prompts.load('field-map');
    if (!promptResult.ok) {
      return err(validationFailed(`Could not load field-map prompt: ${promptResult.error.message}`));
    }
    const prompt = promptResult.value;

    const vars = {
      allow_essay_drafting: input.allowEssayDrafting ? 'yes' : 'no',
      profile_facts: input.profileFactsText,
      form_fields_json: JSON.stringify(input.lowConfidenceFields),
    };
    const basePrompt = prompt.render(vars);

    const attempt = async (promptText: string) => {
      const completion = await deps.llm.complete(
        { model: deps.model, prompt: promptText, jsonSchema: { type: 'object' }, temperature: prompt.frontmatter.temperature },
        { userId: input.userId, refId: input.applyTaskId, context: 'agent' },
      );
      if (!completion.ok) return completion;

      let parsed: unknown;
      try {
        parsed = JSON.parse(extractJsonObject(completion.value.text));
      } catch {
        return err({ code: 'invalid_response' as const, message: 'LLM response was not valid JSON' });
      }
      const validated = ZodFieldMap.safeParse(parsed);
      if (!validated.success) {
        return err({
          code: 'invalid_response' as const,
          message: `LLM response did not match FieldMapSchema: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        });
      }
      return ok(validated.data);
    };

    // ADR-006: zod-validate, one repair attempt, then typed failure.
    let result = await attempt(basePrompt);
    if (!result.ok && result.error.code === 'invalid_response') {
      const repair = `${basePrompt}\n\nYour previous response did not match the required JSON schema exactly. Return ONLY the corrected JSON object, no other text.`;
      result = await attempt(repair);
    }
    if (!result.ok) return result;

    // Defense in depth (task 050's acceptance criterion): the neverAutoFill
    // flag is enforced HERE too, not just in the prompt — never trust the
    // model to always honor an instruction. A response naming a sensitive
    // taxonomy key gets its confidence force-zeroed and its draftAnswer
    // stripped, same posture as heuristic-mapper.ts's own scoreFieldConfidence.
    const knownSelectors = new Set(input.lowConfidenceFields.map((f) => f.selector));
    const mapped: DetectedField[] = [];
    for (const entry of result.value.fields) {
      if (!knownSelectors.has(entry.selector)) continue; // hallucinated selector — ignore, don't trust
      if (entry.taxonomyKey === null || !(entry.taxonomyKey in TAXONOMY)) continue;
      const key = entry.taxonomyKey as TaxonomyFieldKey;
      const sensitive = isNeverAutoFill(key);
      if (entry.confidence < LOW_CONFIDENCE_FLOOR && !sensitive) continue; // low confidence → left unmapped (§4: "blank + flag")
      mapped.push({
        selector: entry.selector,
        taxonomyKey: key,
        confidence: sensitive ? 0 : entry.confidence,
        neverAutoFill: sensitive,
      });
    }

    return ok(mapped);
  };
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}
