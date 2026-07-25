import type { WebFetchPort, WebFetchResult } from '@careerpilot/application';

const MAX_TEXT_LENGTH = 20_000;

/** Crude but dependency-free HTML->text: strips script/style blocks, then all remaining tags, then collapses whitespace. Good enough for feeding a research LLM prompt; not a rendering engine. */
function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  return withoutTags.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match?.[1]?.trim() || null;
}

/**
 * Real (not mocked) HTTP fetch + naive HTML-to-text extraction. Read-only
 * by construction (a GET with no body); scoped to task 060's research
 * loop only, not exported as a general capability elsewhere in DI.
 */
export class HttpWebFetchAdapter implements WebFetchPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  async fetch(url: string): Promise<WebFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'CareerPilotResearchBot/1.0 (+read-only company research)' },
      });
      if (!response.ok) {
        return { url, title: null, text: `(fetch failed: HTTP ${response.status})` };
      }
      const html = await response.text();
      return { url, title: extractTitle(html), text: stripHtml(html).slice(0, MAX_TEXT_LENGTH) };
    } catch (cause) {
      return { url, title: null, text: `(fetch failed: ${cause instanceof Error ? cause.message : String(cause)})` };
    } finally {
      clearTimeout(timer);
    }
  }
}
