/**
 * M7 (task 060). Minimal, READ-ONLY tool surface for the company-research
 * bounded tool loop (`docs/06-agent-design.md` §5: "web search/fetch ->
 * synthesize brief with citations. No write tools."). No adapter for
 * either of these existed anywhere in the codebase before this task —
 * built minimal and scoped to exactly this pipeline, not a general web-
 * access capability wired into DI for anything else to reach.
 */
export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}
export interface WebSearchPort {
  search(query: string): Promise<WebSearchResult[]>;
}

export interface WebFetchResult {
  readonly url: string;
  readonly title: string | null;
  /** Plain text, HTML tags stripped -- never raw HTML forwarded into a prompt (avoids markup noise, not a security boundary by itself; the untrusted-content envelope pattern is the security boundary). */
  readonly text: string;
}
export interface WebFetchPort {
  fetch(url: string): Promise<WebFetchResult>;
}
