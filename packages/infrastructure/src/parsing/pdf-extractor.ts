import { ok, err, type Result } from '@careerpilot/domain';
import type { ExtractionError } from '@careerpilot/application';

/**
 * PDF text extraction (task 023). Library choice, and why it changed
 * mid-task: `pdf-parse` was the initial pick (thin, popular wrapper) but
 * real testing against the extractor test's REAL generated PDF fixtures
 * (not just hand-picked samples) found it bundles a long-abandoned pdf.js
 * build (v1.10.100, from 2017) that fails on structurally valid, modern
 * PDF-writer output — "bad XRef entry" / "Illegal character" errors against
 * files produced by both `pdf-lib` and `pdfkit`. That's not an edge case;
 * it means `pdf-parse` would fail on a meaningful slice of real resumes
 * exported by current tools. Switched to `pdfjs-dist` directly — Mozilla's
 * own actively-maintained package, run in its Node ("legacy") build — which
 * parses the exact same fixtures cleanly. More code than `pdf-parse`'s
 * one-liner (we do our own per-page text-item join), but it's the only one
 * of the two that actually works against real-world PDFs at the time of
 * writing.
 */
export async function extractPdfText(bytes: Buffer): Promise<Result<string, ExtractionError>> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let pdf: Awaited<ReturnType<typeof getDocument>['promise']>;
  try {
    // `data` needs its own copy — pdfjs-dist may detach/transfer the buffer.
    // `useSystemFonts` avoids a benign-but-noisy "standardFontDataUrl not
    // provided" warning — we only need text positions, not font rendering.
    const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    pdf = await loadingTask.promise;
  } catch (cause) {
    return err({
      code: 'corrupt_file',
      message: `Could not parse PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pageTexts.push(reconstructLines(content.items));
    }

    const text = pageTexts.join('\n').trim();
    if (text.length === 0) {
      return err({ code: 'empty_content', message: 'PDF contained no extractable text' });
    }
    return ok(text);
  } catch (cause) {
    return err({
      code: 'corrupt_file',
      message: `Could not read PDF page content: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

interface PdfTextItem {
  readonly str: string;
  /** PDF.js text-position matrix: [scaleX, skewX, skewY, scaleY, translateX, translateY]. Index 5 is the y-coordinate. */
  readonly transform: readonly number[];
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof (item as { str: unknown }).str === 'string' &&
    'transform' in item &&
    Array.isArray((item as { transform: unknown }).transform)
  );
}

/**
 * `page.getTextContent()` returns text items with NO line-break information
 * — joining them with a plain space (the naive approach, and what the first
 * version of this function did) flattens the whole page into one line,
 * which silently breaks `resume-field-mapper.ts`'s line-based section
 * detection. Reconstructs lines the standard way: items are grouped by
 * their y-coordinate (`transform[5]`), since PDF text on the same visual
 * line shares (approximately) the same baseline; a new y-coordinate beyond
 * a small tolerance starts a new line. Found by
 * `apps/worker/test/integration/resume-import.test.ts`'s real-PDF
 * end-to-end test — the flattened-text bug didn't show up against the
 * benchmark's plain-text fixtures (docs/eval/resume-import-benchmark),
 * only against an actual PDF round-trip.
 */
function reconstructLines(items: unknown[]): string {
  const textItems = items.filter(isPdfTextItem);
  if (textItems.length === 0) return '';

  const Y_TOLERANCE = 2;
  const lines: string[][] = [];
  let currentY: number | null = null;

  for (const item of textItems) {
    const y = item.transform[5] ?? 0;
    if (currentY === null || Math.abs(y - currentY) > Y_TOLERANCE) {
      lines.push([]);
      currentY = y;
    }
    lines[lines.length - 1]!.push(item.str);
  }

  // Joined with a space and then collapsed: pdf.js sometimes represents an
  // inter-word gap as its own item (already-spaced) and sometimes bakes the
  // space into a glyph run's str — joining with ' ' and collapsing runs of
  // whitespace handles both without doubling or dropping spaces.
  return lines.map((line) => line.join(' ').replace(/\s+/g, ' ').trim()).join('\n');
}
