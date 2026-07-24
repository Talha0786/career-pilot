import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createLeverConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/postings.json');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

/**
 * FIXTURE PROVENANCE: `test/fixtures/postings.json` is a REAL, live-recorded
 * response — `GET https://api.lever.co/v0/postings/palantir?mode=json`,
 * captured 2026-07-12 from within this task's Docker verification container.
 * Trimmed to 2 of 273 returned postings, `description`/`descriptionPlain`
 * truncated to ~300 chars for fixture size — every remaining field value is
 * copied verbatim from the live response.
 */
function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describeConnectorContract('lever', () => ({
  connector: createLeverConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { company: 'palantir' },
  invalidConfig: { company: '' },
}));

describe('Lever connector — fixture-based normalization (real recorded Palantir board data)', () => {
  it('normalizes title/company/location/remote/salary/descriptionMd/postedAt', async () => {
    const connector = createLeverConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ company: 'palantir' }, null)) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);
    const [remote, hybrid] = jobs;

    expect(remote!.externalId).toBe('b88cd6e1-22b7-49d6-b215-1ca262a05728');
    expect(remote!.title).toBe('American Tech Fellowship for Veterans');
    expect(remote!.company).toBe('palantir');
    expect(remote!.location).toEqual({ raw: 'North America' });
    expect(remote!.remote).toBe('remote');
    expect(remote!.salary).toBeNull();
    expect(remote!.descriptionMd).toContain('A World-Changing Company');
    expect(remote!.descriptionMd).toContain('Palantir builds the world');
    expect(remote!.postedAt).toEqual(new Date(1767745616606));

    expect(hybrid!.remote).toBe('hybrid');
    expect(hybrid!.location).toEqual({ raw: 'Palo Alto, CA' });
  });

  it('falls back to stripped HTML when descriptionPlain is absent', async () => {
    const noPlain = JSON.stringify([
      { id: 'x', text: 'T', hostedUrl: 'https://jobs.lever.co/acme/x', description: '<p>Rich <em>text</em>.</p>' },
    ]);
    const connector = createLeverConnector({ fetchImpl: fakeFetch(noPlain) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ company: 'acme' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs[0]!.descriptionMd).toBe('Rich text.');
  });

  it('surfaces a 404 as config_error, not a throw', async () => {
    const connector = createLeverConnector({ fetchImpl: fakeFetch('[]', 404) });
    const results = [];
    for await (const item of connector.fetchJobs({ company: 'ghost' }, null)) results.push(item);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error.code).toBe('config_error');
  });
});
