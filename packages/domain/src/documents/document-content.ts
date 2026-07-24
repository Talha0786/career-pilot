/**
 * Structured document model — the thing `DocumentVersion.content` holds and
 * `packages/infrastructure/src/documents/render/*` (task 024) turns into
 * PDF/DOCX bytes. Deliberately a plain, renderer-agnostic shape: no styling,
 * no layout — that's the renderer's job, constrained to exactly 2 templates
 * (task 024 scope guard).
 */
export interface ResumeEntry {
  readonly title: string;
  readonly subtitle: string;
  readonly dateRange: string | null;
  readonly bullets: readonly string[];
  /**
   * Task 039 — additive, NOT a replacement for `bullets`. Parallel array
   * (same length, same order, same text as `bullets[i]`) carrying which
   * fact IDs (task 037's `compileFactList`) support each bullet, populated
   * only for tailoring-generated content. Kept separate from `bullets`
   * rather than changing `bullets` to `{text, supportingFactIds}[]`
   * specifically so the existing renderer (task 024, golden-file tested)
   * and every `imported`/`edited` DocumentVersion keep working against
   * plain strings, unchanged. Absent for anything that isn't a tailoring
   * output. This is what claim verification (task 040) and the diff-review
   * UI (task 041) read the claim→fact mapping from.
   */
  readonly bulletFacts?: readonly SupportedText[] | undefined;
}

export interface ResumeSection {
  readonly heading: string;
  readonly entries: readonly ResumeEntry[];
}

export interface ResumeDocumentContent {
  readonly schemaVersion: 1;
  readonly kind: 'resume';
  readonly contact: {
    readonly name: string;
    readonly email: string;
    readonly phone?: string | undefined;
    readonly location?: string | undefined;
    readonly links?: readonly string[] | undefined;
  };
  readonly summary: string | null;
  readonly sections: readonly ResumeSection[];
}

/** Task 039's per-bullet/per-paragraph fact citation (see `ResumeEntry.bulletFacts`'s doc comment). */
export interface SupportedText {
  readonly text: string;
  readonly supportingFactIds: readonly string[];
}

export interface CoverLetterDocumentContent {
  readonly schemaVersion: 1;
  readonly kind: 'cover_letter';
  readonly contact: {
    readonly name: string;
    readonly email: string;
    readonly phone?: string | undefined;
  };
  readonly recipient: string | null;
  readonly salutation: string;
  readonly bodyParagraphs: readonly string[];
  /** Task 039 — additive parallel array, same shape/reasoning as `ResumeEntry.bulletFacts`. */
  readonly paragraphFacts?: readonly SupportedText[] | undefined;
  readonly closing: string;
}

export interface OtherDocumentContent {
  readonly schemaVersion: 1;
  readonly kind: 'other';
  readonly title: string;
  readonly bodyMd: string;
}

export type DocumentContent =
  | ResumeDocumentContent
  | CoverLetterDocumentContent
  | OtherDocumentContent;
