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
