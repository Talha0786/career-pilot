import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createSerpapiGoogleJobsConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/search.json');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/**
 * FIXTURE PROVENANCE (task 031's disclosed Known gap, same posture as task
 * 028's USAJobs connector): `test/fixtures/search.json` is HAND-AUTHORED,
 * not live-recorded — SerpApi requires a paid API key this task does not
 * have. What WAS verified live, from within this task's Docker verification
 * container, against the real https://serpapi.com/search.json endpoint with
 * a deliberately invalid key: it returns HTTP 401 with body
 * `{"error": "Invalid API key. ..."}` — exactly what this connector's
 * `auth_error` handling is tested against below. The success-path fixture
 * matches SerpApi's published Google Jobs API documentation
 * (https://serpapi.com/google-jobs-api) as closely as a hand-authored
 * fixture can; does NOT require a real key to pass in default CI (task 031
 * acceptance criterion).
 */
describeConnectorContract('serpapi-google-jobs', () => ({
  connector: createSerpapiGoogleJobsConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { apiKey: 'test-key', query: 'software engineer' },
  invalidConfig: { apiKey: '', query: '' },
}));

describe('SerpApi Google Jobs connector — fixture-based normalization', () => {
  it('normalizes title/company/location/remote/salary/descriptionMd', async () => {
    const connector = createSerpapiGoogleJobsConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ apiKey: 'k', query: 'software engineer' }, null)) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);
    const [remote, onsite] = jobs;

    expect(remote!.externalId).toBe('eyJqb2JfdGl0bGUiOiJTZW5pb3IgU29mdHdhcmUgRW5naW5lZXIsIEJhY2tlbmQifQ==');
    expect(remote!.title).toBe('Senior Software Engineer, Backend');
    expect(remote!.company).toBe('Acme Corp');
    expect(remote!.url).toBe('https://www.linkedin.com/jobs/view/1111111111');
    expect(remote!.location).toEqual({ raw: 'Remote' });
    expect(remote!.remote).toBe('remote');
    expect(remote!.salary).toEqual({ min: 150000, max: 190000, currency: 'USD', period: 'year' });
    expect(remote!.descriptionMd).toContain('Senior Software Engineer');

    expect(onsite!.location).toEqual({ raw: 'Austin, TX' });
    expect(onsite!.remote).toBe('unknown');
    expect(onsite!.salary).toBeNull(); // no detected_extensions.salary in the fixture for this job
    expect(onsite!.url).toBe('https://www.indeed.com/viewjob?jk=2222222222');
  });

  it('missing/invalid API key surfaces as a typed config error at connector-enable time, not a runtime crash (task 031 acceptance)', () => {
    // "Connector-enable time" = configSchema validation, BEFORE fetchJobs is
    // ever called — the invalid config never reaches the network call at all.
    const parsed = createSerpapiGoogleJobsConnector().configSchema.safeParse({ apiKey: '', query: 'x' });
    expect(parsed.success).toBe(false);
  });

  it('surfaces a real, live-confirmed 401 shape as a typed auth_error, not a throw', async () => {
    // Response body shape ({"error": "..."}) matches what the live endpoint
    // actually returned when probed with an invalid key from this session's
    // Docker container — see file header.
    const connector = createSerpapiGoogleJobsConnector({
      fetchImpl: fakeFetch('{"error": "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}', 401),
    });
    const results = [];
    for await (const item of connector.fetchJobs({ apiKey: 'invalid', query: 'x' }, null)) results.push(item);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) {
      expect(results[0]!.error.code).toBe('auth_error');
      expect(results[0]!.error.retryable).toBe(false);
    }
  });

  it('surfaces a 429 (quota exceeded) as a typed, retryable rate_limited error', async () => {
    const connector = createSerpapiGoogleJobsConnector({ fetchImpl: fakeFetch('{}', 429) });
    const results = [];
    for await (const item of connector.fetchJobs({ apiKey: 'k', query: 'x' }, null)) results.push(item);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error.code).toBe('rate_limited');
  });

  it('parses relative posted_at text into an approximate Date, and returns null for unrecognized text', async () => {
    const withPostedAt = JSON.stringify({
      jobs_results: [
        { title: 'A', company_name: 'C', job_id: 'x1', detected_extensions: { posted_at: '2 days ago' }, apply_options: [{ link: 'https://x.com/1' }] },
        { title: 'B', company_name: 'C', job_id: 'x2', detected_extensions: { posted_at: 'sometime last quarter' }, apply_options: [{ link: 'https://x.com/2' }] },
      ],
    });
    const connector = createSerpapiGoogleJobsConnector({ fetchImpl: fakeFetch(withPostedAt) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ apiKey: 'k', query: 'x' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs[0]!.postedAt).toBeInstanceOf(Date);
    expect(jobs[1]!.postedAt).toBeNull();
  });
});
