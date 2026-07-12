/**
 * Minimal HTML → plain-text/markdown-ish converter shared by every
 * connector that receives an HTML description field (Greenhouse, Lever,
 * Ashby, and — via the rendered-page payload — the Class B capture
 * connector, task 030). Deliberately NOT a full HTML→Markdown library:
 * connectors only need a readable, safe text rendition for
 * `RawJob.descriptionMd`, not pixel-perfect formatting. No new heavy
 * dependency for what's fundamentally "strip tags, keep paragraph breaks."
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  // Decode entities FIRST: some source APIs (Greenhouse's job board API,
  // confirmed against a real live board) return the `content` field as
  // HTML-escaped markup — literal `&lt;p&gt;` rather than `<p>` — so tags
  // only become visible as tags after entity decoding runs.
  const decoded = decodeHtmlEntities(html);

  const text = decoded
    // Strip script/style blocks entirely — never surface their contents.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Block-level and break tags become paragraph/line breaks.
    .replace(/<\s*(br|br\/|br \/)\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    // Every remaining tag is dropped.
    .replace(/<[^>]+>/g, '');

  // Collapse excess whitespace without losing paragraph structure.
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;|&mdash;|&ndash;|&rsquo;|&lsquo;|&rdquo;|&ldquo;/g, (m) => ENTITIES[m] ?? m);
}
