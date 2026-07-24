import mammoth from 'mammoth';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ExtractionError } from '@careerpilot/application';

/**
 * DOCX text extraction (task 023). Library choice: `mammoth` — purpose-
 * built for DOCX → plain-text/HTML conversion, actively maintained, MIT
 * licensed, and (unlike generic zip+XML parsing) already handles the
 * annoying parts of the OOXML format (split runs, smart quotes, embedded
 * hyperlinks) that a hand-rolled `docx4js`/raw-XML approach would need to
 * reimplement. `extractRawText` specifically (not `convertToHtml`) is used
 * — task 023's consumer (`resume-field-mapper.ts`) works on flattened text
 * with paragraph breaks, not markup.
 */
export async function extractDocxText(bytes: Buffer): Promise<Result<string, ExtractionError>> {
  let result: { value: string };
  try {
    result = await mammoth.extractRawText({ buffer: bytes });
  } catch (cause) {
    return err({
      code: 'corrupt_file',
      message: `Could not parse DOCX: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const text = result.value.trim();
  if (text.length === 0) {
    return err({ code: 'empty_content', message: 'DOCX contained no extractable text' });
  }
  return ok(text);
}
