import type { TaxonomyFieldKey } from '@careerpilot/domain';

/**
 * Plain-TS shape (this package's own copy — see
 * `packages/domain/src/apply/field-taxonomy.ts`'s doc comment for why
 * `packages/application` does not import `@careerpilot/contracts`).
 * Field-for-field identical to `packages/contracts/src/field-mapping.ts`'s
 * `SerializedFormFieldSchema`.
 */
export interface SerializedFormField {
  readonly selector: string;
  readonly tagName: 'input' | 'select' | 'textarea';
  readonly type: string | null;
  readonly name: string | null;
  readonly id: string | null;
  readonly autocomplete: string | null;
  readonly ariaLabel: string | null;
  readonly labelText: string | null;
  readonly placeholder: string | null;
}

/**
 * Task 050/051 — abstracts stages 1+2 of the mapping pipeline (048's
 * known-ATS detect, 049's heuristic scorer) behind a port, the same
 * Ports & Adapters pattern every other cross-process capability in this
 * codebase uses (`LlmPort`, `DocumentRendererPort`, `ObjectStoragePort`,
 * ...). Necessary here specifically because 048/049's real implementations
 * need a live Playwright `Page`, which only exists inside
 * `apps/browser-runner` — `packages/application` stays framework-agnostic
 * and depends on this INTERFACE only; `apps/browser-runner` is the
 * adapter that implements it (task 051), which is the correct dependency
 * direction (apps depend on application, never the reverse). See
 * `packages/contracts/src/field-mapping.ts`'s doc comment for the full
 * boundary-rule reasoning this resolves.
 */
export interface DetectedField {
  readonly selector: string;
  readonly taxonomyKey: TaxonomyFieldKey;
  readonly confidence: number;
  readonly neverAutoFill: boolean;
  /**
   * Task 052 — which pipeline stage (048/049/050) actually resolved this
   * field, threaded through explicitly from each stage rather than
   * inferred later from a confidence-score heuristic (which would be
   * ambiguous — an LLM match and a heuristic match can land in the same
   * confidence band). This is what the review-queue's field diff shows
   * the user as "how was this value decided."
   */
  readonly source: 'known_ats' | 'heuristic' | 'llm';
}

export interface FieldDetectionResult {
  /** Known-ATS adapter key (048) if one matched, else null (falls through to heuristics only). */
  readonly atsAdapter: string | null;
  readonly atsAdapterVersion: string | null;
  /** Every field 048 (if matched) + 049 could resolve, confident or not. */
  readonly detected: readonly DetectedField[];
  /** The full serialized form (048/049's leftovers included) — what 050's LLM stage classifies. */
  readonly allFields: readonly SerializedFormField[];
}

export interface FieldDetectionPort {
  detectAndScore(applyTaskId: string): Promise<FieldDetectionResult>;
}
