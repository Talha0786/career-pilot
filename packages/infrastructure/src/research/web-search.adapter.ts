import type { WebSearchPort, WebSearchResult } from '@careerpilot/application';

/**
 * Real (not mocked), key-free web search via DuckDuckGo's HTML endpoint --
 * no API key required, matching ADR-006's "boots key-free by default"
 * posture for non-critical tasks. Best-effort: a network failure or a
 * change to DuckDuckGo's HTML structure returns an EMPTY result list
 * rather than throwing, so the research loop degrades to "no search
 * results this call" (a normal, handled case for the LLM to react to --
 * see research-company.ts) rather than crashing the whole pipeline.
 * Documented here as a deliberate, honest limitation: this is screen-
 * scraping a public HTML page, not a supported search API, and is the
 * first thing to swap for a real search API key if/when one is
 * configured.
 */
export class DuckDuckGoWebSearchAdapter implements WebSearchPort {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  async search(query: string): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { signal: controller.signal, headers: { 'user-agent': 'CareerPilotResearchBot/1.0 (+read-only company research)' } },
      );
      if (!response.ok) return [];
      const html = await response.text();
      return parseResults(html).slice(0, 5);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(sMatch[1] ?? ''));
  }

  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = linkRe.exec(html)) !== null) {
    const rawUrl = match[1] ?? '';
    const title = stripTags(match[2] ?? '');
    const url = decodeDuckDuckGoRedirect(rawUrl);
    if (url) results.push({ title, url, snippet: snippets[i] ?? '' });
    i += 1;
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
}

/** DuckDuckGo's HTML results wrap the real URL in a redirect link (`//duckduckgo.com/l/?uddg=<encoded>`). */
function decodeDuckDuckGoRedirect(href: string): string | null {
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href);
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href.startsWith('http') ? href : null;
  }
}
