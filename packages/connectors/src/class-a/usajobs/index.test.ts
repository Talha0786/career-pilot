import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createUsajobsConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/search.json');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/**
 * FIXTURE PROVENANCE (the one exception among the six Class A connectors):
 * `test/fixtures/search.json` is HAND-AUTHORED, not live-recorded. USAJobs
 * requires a registered `Authorization-Key` (free, but an account is needed)
 * that this task does not have. What WAS verified live, from within this
 * task's Docker verification container, against the real
 * https://data.usajobs.gov/api/search endpoint with an invalid key: it
 * returns HTTP 401 with an RFC-9110 problem-details body — which is exactly
 * what this connector's `auth_error` handling below is tested against. The
 * response *shape* for a successful search (SearchResult.SearchResultItems[].
 * MatchedObjectDescriptor.{...}) matches USAJobs' published API reference
 * (https://developer.usajobs.gov/api-reference/get-api-search) as closely as
 * a hand-authored fixture can. This gap is disclosed rather than claiming a
 * live recording that didn't happen.
 */
describeConnectorContract('usajobs', () => ({
  connector: createUsajobsConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { apiKey: 'test-key', userAgentEmail: 'ops@example.com' },
  invalidConfig: { apiKey: '', userAgentEmail: 'not-an-email' },
}));

describe('USAJobs connector — fixture-based normalization', () => {
  it('normalizes title/company/location/salary/descriptionMd/postedAt', async () => {
    const connector = createUsajobsConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ apiKey: 'k', userAgentEmail: 'ops@example.com' }, null)) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);
    const [onsite, remote] = jobs;

    expect(onsite!.externalId).toBe('780000001');
    expect(onsite!.title).toBe('IT Specialist (Infrastructure)');
    expect(onsite!.company).toBe('Department of Example');
    expect(onsite!.url).toBe('https://www.usajobs.gov/job/780000001');
    expect(onsite!.location).toEqual({ raw: 'Washington, DC' });
    expect(onsite!.remote).toBe('unknown');
    expect(onsite!.salary).toEqual({ currency: 'USD', min: 95000, max: 125000, period: 'year' });
    expect(onsite!.descriptionMd).toBe('Support federal infrastructure systems.');
    expect(onsite!.postedAt).toEqual(new Date('2026-06-01'));

    expect(remote!.remote).toBe('remote');
    expect(remote!.location).toEqual({ raw: 'Remote' });
  });

  it('sends the required Authorization-Key/User-Agent headers', async () => {
    let capturedHeaders: RequestInit['headers'] | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(FIXTURE, { status: 200 });
    }) as unknown as typeof fetch;

    const connector = createUsajobsConnector({ fetchImpl: capturingFetch });
    for await (const _ of connector.fetchJobs({ apiKey: 'super-secret', userAgentEmail: 'ops@example.com' }, null)) {
      // draining is enough — the assertion is on the captured request headers
    }
    expect((capturedHeaders as Record<string, string>)['Authorization-Key']).toBe('super-secret');
    expect((capturedHeaders as Record<string, string>)['User-Agent']).toBe('ops@example.com');
  });

  it('surfaces a 401 as a typed, non-retryable auth_error', async () => {
    const connector = createUsajobsConnector({ fetchImpl: fakeFetch('{}', 401) });
    const results = [];
    for await (const item of connector.fetchJobs({ apiKey: 'bad', userAgentEmail: 'ops@example.com' }, null)) {
      results.push(item);
    }
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.error.code).toBe('auth_error');
      expect(results[0]!.error.retryable).toBe(false);
    }
  });

  it('rejects an invalid config (empty apiKey / malformed email) at the schema, not at call time', () => {
    const parsed = usajobsSchema().safeParse({ apiKey: '', userAgentEmail: 'not-an-email' });
    expect(parsed.success).toBe(false);
  });
});

function usajobsSchema() {
  return createUsajobsConnector().configSchema;
}
