import { err, type Result } from '@careerpilot/domain';
import {
  PDF_MIME_TYPE,
  DOCX_MIME_TYPE,
  type DocumentTextExtractorPort,
  type ExtractedDocument,
  type ExtractionError,
} from '@careerpilot/application';
import { extractPdfText } from './pdf-extractor.js';
import { extractDocxText } from './docx-extractor.js';

/**
 * Composite `DocumentTextExtractorPort` — dispatches to the pdf-parse or
 * mammoth adapter by mime type. Anything else fails as `unsupported_mime_type`
 * (task 023 acceptance: "Unsupported/corrupt file input fails with a typed
 * error, not a crash").
 */
export class DocumentTextExtractor implements DocumentTextExtractorPort {
  async extractText(bytes: Buffer, mimeType: string): Promise<Result<ExtractedDocument, ExtractionError>> {
    let textResult: Result<string, ExtractionError>;
    switch (mimeType) {
      case PDF_MIME_TYPE:
        textResult = await extractPdfText(bytes);
        break;
      case DOCX_MIME_TYPE:
        textResult = await extractDocxText(bytes);
        break;
      default:
        return err({
          code: 'unsupported_mime_type',
          message: `Unsupported file type "${mimeType}" — only PDF and DOCX are supported`,
        });
    }

    if (!textResult.ok) return textResult;
    return { ok: true, value: { text: textResult.value } };
  }
}
