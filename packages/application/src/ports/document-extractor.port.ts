import type { Result } from '@careerpilot/domain';

/** The two upload kinds task 023 supports — resume import is PDF/DOCX only. */
export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ExtractedDocument {
  readonly text: string;
}

export type ExtractionErrorCode = 'unsupported_mime_type' | 'corrupt_file' | 'empty_content';

export interface ExtractionError {
  readonly code: ExtractionErrorCode;
  readonly message: string;
}

/**
 * Text extraction boundary (task 023). Kept as a port, not a direct infra
 * import, for the same reason `LlmPort` is a port — the application layer
 * (`import-resume.ts`, the worker handler) depends on this interface only;
 * `packages/infrastructure/src/parsing/*` is the real implementation
 * (pdf-parse / mammoth), swappable without touching use-case code.
 */
export interface DocumentTextExtractorPort {
  extractText(bytes: Buffer, mimeType: string): Promise<Result<ExtractedDocument, ExtractionError>>;
}
