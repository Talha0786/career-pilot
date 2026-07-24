import type { DocumentContent } from '@careerpilot/domain';
import type { DocumentRendererPort, RenderFormat, RenderTemplate } from '@careerpilot/application';
import { renderPdf } from './pdf-renderer.js';
import { renderDocx } from './docx-renderer.js';

/** Dispatches by format — the ONLY thing `render-document.ts` (application) depends on. */
export class DocumentRenderer implements DocumentRendererPort {
  async render(content: DocumentContent, format: RenderFormat, template: RenderTemplate): Promise<Buffer> {
    switch (format) {
      case 'pdf':
        return renderPdf(content, template);
      case 'docx':
        return renderDocx(content, template);
    }
  }
}
