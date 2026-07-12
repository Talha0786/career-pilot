import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError } from '@careerpilot/application';
import { htmlToText } from '../../sdk/html-to-text.js';

/**
 * Generic RSS/Atom job-feed connector (Class A — public feed, zero legal
 * risk). Many ATS/job-board platforms without a first-class API (and many
 * company career pages) publish an RSS feed; this connector covers all of
 * them with one implementation rather than one-per-platform. No auth, no
 * pagination — a feed is fetched and consumed in full each run.
 */
export const rssConfigSchema = z.object({
  feedUrl: z.string().url(),
  /** Every RSS feed structures postings differently; there's no reliable "company" field to parse out. */
  companyName: z.string().min(1).optional(),
});

export type RssConfig = z.infer<typeof rssConfigSchema>;

interface RssItem {
  title?: string;
  link?: string;
  guid?: string | { '#text'?: string };
  description?: string;
  pubDate?: string;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

// Default entity-expansion caps (fast-xml-parser's XXE/billion-laughs
// mitigation) are tuned for small documents and reject real-world job feeds
// with many items and heavily-escaped descriptions (confirmed live against
// weworkremotely.com's RSS feed, which trips the default 1000-expansion cap
// well within its first ~30 items). Raised, not disabled — still bounded,
// just sized for "a job feed with up to a few hundred richly-formatted
// items" instead of "an arbitrary small XML snippet."
const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: { maxTotalExpansions: 50_000, maxExpandedLength: 5_000_000 },
});

export function createRssConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<RssConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'rss', displayName: 'RSS/Atom Job Feed', complianceClass: 'A' },
    configSchema: rssConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      let res: Response;
      try {
        res = await fetchImpl(config.feedUrl);
      } catch (e) {
        yield err(upstreamError(`Network error fetching RSS feed: ${String(e)}`));
        return;
      }

      if (res.status === 404) {
        yield err({ code: 'config_error', message: `RSS feed not found: ${config.feedUrl}`, retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'RSS feed rate limit hit', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`RSS feed returned ${res.status}`));
        return;
      }

      const xml = await res.text();
      let items: RssItem[];
      try {
        items = parseFeedItems(xml);
      } catch (e) {
        yield err({ code: 'invalid_response', message: `RSS feed is not valid XML: ${String(e)}`, retryable: false });
        return;
      }

      for (const item of items) {
        const title = item.title?.trim();
        const link = item.link?.trim();
        if (!title || !link) continue; // an item missing the two fields we can't function without is skipped, not fatal

        const guid = typeof item.guid === 'string' ? item.guid : item.guid?.['#text'];
        yield ok<RawJob>({
          externalId: guid?.trim() || link,
          url: link,
          title,
          company: config.companyName ?? 'Unknown',
          location: null,
          remote: 'unknown',
          salary: null,
          descriptionMd: htmlToText(item.description ?? ''),
          postedAt: item.pubDate ? safeDate(item.pubDate) : null,
        });
      }
    },

    async healthCheck(config) {
      try {
        const res = await fetchImpl(config.feedUrl);
        if (res.status === 404) {
          return err({ code: 'config_error', message: `RSS feed not found: ${config.feedUrl}`, retryable: false });
        }
        if (!res.ok) return err(upstreamError(`RSS healthcheck returned ${res.status}`));
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during RSS healthcheck: ${String(e)}`));
      }
    },
  };
}

function parseFeedItems(xml: string): RssItem[] {
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: RssItem | RssItem[] } };
    feed?: { entry?: RssItem | RssItem[] };
  };

  // RSS 2.0
  const rssItems = parsed.rss?.channel?.item;
  if (rssItems) return Array.isArray(rssItems) ? rssItems : [rssItems];

  // Atom (minimal support: entry/title/link/id/summary/updated)
  const atomEntries = parsed.feed?.entry;
  if (atomEntries) {
    const list = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return list.map((e: any) => ({
      title: e.title,
      link: typeof e.link === 'object' ? e.link?.['@_href'] : e.link,
      guid: e.id,
      description: e.summary ?? e.content,
      pubDate: e.updated ?? e.published,
    }));
  }

  return [];
}

function safeDate(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
