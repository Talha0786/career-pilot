import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createRssConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/feed.xml');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status, headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch;
}

/**
 * FIXTURE PROVENANCE: `test/fixtures/feed.xml` is a REAL, live-recorded feed
 * — `GET https://weworkremotely.com/categories/remote-programming-jobs.rss`,
 * captured 2026-07-12 from within this task's Docker verification container.
 * Trimmed to 2 of ~30 returned items, `<description>` truncated for fixture
 * size — every remaining field value is copied verbatim, including the fact
 * that WWR (like Greenhouse) HTML-escapes its description markup and embeds
 * the company name INSIDE the title ("Company: Role") since RSS 2.0 has no
 * dedicated company field — this connector deliberately does not try to
 * parse that convention back out (feeds vary too much to rely on any one
 * format), which is why `companyName` is a connector config option.
 */
describeConnectorContract('rss', () => ({
  connector: createRssConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { feedUrl: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' },
  invalidConfig: { feedUrl: 'not-a-url' },
}));

describe('RSS connector — fixture-based normalization (real recorded We Work Remotely feed)', () => {
  it('normalizes title/url/descriptionMd/postedAt from a real RSS 2.0 feed', async () => {
    const connector = createRssConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs(
      { feedUrl: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', companyName: 'We Work Remotely' },
      null,
    )) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);
    const [first, second] = jobs;

    expect(first!.title).toBe('Coin Market Cap: Technical AI Product Manager');
    expect(first!.url).toBe('https://weworkremotely.com/remote-jobs/coin-market-cap-technical-ai-product-manager');
    expect(first!.externalId).toBe(first!.url); // WWR's <guid> is the same URL, not a separate opaque id
    expect(first!.company).toBe('We Work Remotely');
    // The live feed HTML-escapes its <description> the same way Greenhouse
    // does — this assertion is the direct proof htmlToText handles both.
    expect(first!.descriptionMd).toContain('Headquarters:');
    expect(first!.descriptionMd).toContain('CoinMarketCap is building AI products');
    expect(first!.descriptionMd).not.toContain('<p>');
    expect(first!.descriptionMd).not.toContain('&lt;');
    expect(first!.postedAt).toEqual(new Date('Tue, 30 Jun 2026 20:30:55 +0000'));

    expect(second!.title).toBe('Lemon.io: Senior React Native Developer');
  });

  it('defaults company to "Unknown" when companyName is not configured', async () => {
    const connector = createRssConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ feedUrl: 'https://acme.example.com/careers.rss' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs[0]!.company).toBe('Unknown');
  });

  it('surfaces a 404 as config_error, not a throw', async () => {
    const connector = createRssConnector({ fetchImpl: fakeFetch('', 404) });
    const results = [];
    for await (const item of connector.fetchJobs({ feedUrl: 'https://acme.example.com/gone.rss' }, null)) results.push(item);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error.code).toBe('config_error');
  });

  it('skips an item missing title/link rather than yielding a malformed RawJob', async () => {
    const brokenFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><description>No title or link here</description></item>
      <item><title>Valid</title><link>https://acme.example.com/valid</link><guid>g1</guid></item>
    </channel></rss>`;
    const connector = createRssConnector({ fetchImpl: fakeFetch(brokenFeed) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ feedUrl: 'https://acme.example.com/broken.rss' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe('Valid');
  });
});
