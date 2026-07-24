import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createGreenhouseConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/jobs.json');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

/**
 * No live network calls in the default test run (task 028 acceptance) — this
 * fake serves the recorded fixture body for every request, regardless of
 * URL, which is all a single-page connector like Greenhouse needs.
 *
 * FIXTURE PROVENANCE: `test/fixtures/jobs.json` is a REAL, live-recorded
 * response — `GET https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true`,
 * captured 2026-07-12 from within this task's Docker verification container
 * (which has outbound network access even though the Bash tool's own
 * sandbox does not). Trimmed to 2 of 511 returned jobs and each `content`
 * field truncated to ~400 chars for fixture size — every remaining field
 * value is copied verbatim from the live response, not synthesized.
 */
function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describeConnectorContract('greenhouse', () => ({
  connector: createGreenhouseConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { boardToken: 'stripe' },
  invalidConfig: { boardToken: '' },
}));

describe('Greenhouse connector — fixture-based normalization (real recorded Stripe board data)', () => {
  it('normalizes title/company/location/remote/descriptionMd/postedAt from a real board response', async () => {
    const connector = createGreenhouseConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ boardToken: 'stripe' }, null)) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);

    const [sf, japan] = jobs;
    expect(sf!.externalId).toBe('7954688');
    expect(sf!.title).toBe('Account Executive, AI Sales (Grower)');
    expect(sf!.company).toBe('stripe');
    expect(sf!.url).toBe('https://stripe.com/jobs/search?gh_jid=7954688');
    expect(sf!.location).toEqual({ raw: 'San Francisco, CA' });
    expect(sf!.remote).toBe('unknown'); // "San Francisco, CA" has no "remote" signal
    // The live response HTML-escapes its `content` field (&lt;h2&gt; not <h2>);
    // this assertion is the direct proof htmlToText decodes-then-strips correctly.
    expect(sf!.descriptionMd).toContain('Who we are');
    expect(sf!.descriptionMd).toContain('Stripe is a financial infrastructure platform');
    expect(sf!.descriptionMd).not.toContain('<h2>');
    expect(sf!.descriptionMd).not.toContain('&lt;');
    expect(sf!.postedAt).toEqual(new Date('2026-06-26T17:05:44-04:00'));

    expect(japan!.location).toEqual({ raw: 'Japan' });
    expect(japan!.remote).toBe('unknown');
  });

  it('uses companyName override when provided', async () => {
    const connector = createGreenhouseConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ boardToken: 'acme', companyName: 'Acme Corp' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs[0]!.company).toBe('Acme Corp');
  });

  it('surfaces a 404 as a typed config_error, not a throw', async () => {
    const connector = createGreenhouseConnector({ fetchImpl: fakeFetch('{}', 404) });
    const results = [];
    for await (const item of connector.fetchJobs({ boardToken: 'ghost-board' }, null)) results.push(item);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error.code).toBe('config_error');
  });

  it('surfaces a 429 as a typed, retryable rate_limited error', async () => {
    const connector = createGreenhouseConnector({ fetchImpl: fakeFetch('{}', 429) });
    const results = [];
    for await (const item of connector.fetchJobs({ boardToken: 'acme' }, null)) results.push(item);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.error.code).toBe('rate_limited');
      expect(results[0]!.error.retryable).toBe(true);
    }
  });

  it('healthCheck reports ok for a reachable board and config_error for a missing one', async () => {
    const good = createGreenhouseConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const goodResult = await good.healthCheck({ boardToken: 'acme' });
    expect(goodResult.ok).toBe(true);

    const bad = createGreenhouseConnector({ fetchImpl: fakeFetch('{}', 404) });
    const badResult = await bad.healthCheck({ boardToken: 'ghost' });
    expect(badResult.ok).toBe(false);
  });
});
