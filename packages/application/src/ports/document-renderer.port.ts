import type { DocumentContent } from '@careerpilot/domain';

export type RenderFormat = 'pdf' | 'docx';
/** Exactly 2 templates (task 024 scope guard: "no speculative template system"). */
export type RenderTemplate = 'classic' | 'modern';

/**
 * Structured content → rendered bytes (task 024). Implemented in
 * `packages/infrastructure/src/documents/render/*` (pdfkit for PDF, `docx`
 * for DOCX). Kept as a port so `render-document.ts` never imports a
 * rendering library directly — same boundary reasoning as every other
 * infra capability in this codebase.
 */
export interface DocumentRendererPort {
  render(content: DocumentContent, format: RenderFormat, template: RenderTemplate): Promise<Buffer>;
}
