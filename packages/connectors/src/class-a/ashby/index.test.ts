import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createAshbyConnector } from './index.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fixtures/job-board.json');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describeConnectorContract('ashby', () => ({
  connector: createAshbyConnector({ fetchImpl: fakeFetch(FIXTURE) }),
  validConfig: { boardName: 'notion' },
  invalidConfig: { boardName: '' },
}));

/**
 * FIXTURE PROVENANCE: `test/fixtures/job-board.json` is a REAL, live-recorded
 * response — `GET https://api.ashbyhq.com/posting-api/job-board/notion`,
 * captured 2026-07-12 from within this task's Docker verification container.
 * Trimmed to 2 of 141 returned jobs, `descriptionHtml`/`descriptionPlain`
 * truncated for fixture size — every remaining field value (including the
 * real `isRemote: null` on the second job — Ashby's field is nullable, not
 * strictly boolean, confirmed only by capturing a live response) is copied
 * verbatim. No live board observed with a populated `compensation` field
 * (Notion/Ramp/Linear/OpenAI/Substack all had `compensation: null`
 * everywhere); `mapCompensation` remains best-effort against Ashby's
 * documented shape and is covered by a synthetic case below.
 */
describe('Ashby connector — fixture-based normalization (real recorded Notion board data)', () => {
  it('normalizes title/company/location/remote/descriptionMd/postedAt', async () => {
    const connector = createAshbyConnector({ fetchImpl: fakeFetch(FIXTURE) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ boardName: 'notion' }, null)) {
      if (item.ok) jobs.push(item.value);
    }

    expect(jobs).toHaveLength(2);
    const [remote, unspecified] = jobs;

    expect(remote!.externalId).toBe('05e14247-17c4-4e98-9a13-53828a4e2f13');
    expect(remote!.title).toBe('Outbound Business Development Representative, AMER');
    expect(remote!.company).toBe('notion');
    expect(remote!.remote).toBe('remote');
    expect(remote!.location).toEqual({ raw: 'New York, New York' });
    expect(remote!.salary).toBeNull();
    expect(remote!.descriptionMd).toContain('WHO WE ARE');
    expect(remote!.descriptionMd).not.toContain('<h1>');
    expect(remote!.postedAt).toEqual(new Date('2026-04-02T21:00:55.755+00:00'));

    // isRemote: null in the real response — falls back to "has a location,
    // so onsite" rather than crashing on a non-boolean value.
    expect(unspecified!.remote).toBe('onsite');
    expect(unspecified!.location).toEqual({ raw: 'Dublin, Ireland' });
  });

  it('maps a populated compensation block when present (synthetic — no live board observed one)', async () => {
    const withComp = JSON.stringify({
      jobs: [
        {
          id: 'x',
          title: 'T',
          jobUrl: 'https://jobs.ashbyhq.com/acme/x',
          isRemote: true,
          compensation: { min: 150000, max: 190000, currency: 'USD', interval: 'year' },
        },
      ],
    });
    const connector = createAshbyConnector({ fetchImpl: fakeFetch(withComp) });
    const jobs = [];
    for await (const item of connector.fetchJobs({ boardName: 'acme' }, null)) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs[0]!.salary).toEqual({ min: 150000, max: 190000, currency: 'USD', period: 'year' });
  });

  it('surfaces a 429 as typed rate_limited error', async () => {
    const connector = createAshbyConnector({ fetchImpl: fakeFetch('{}', 429) });
    const results = [];
    for await (const item of connector.fetchJobs({ boardName: 'notion' }, null)) results.push(item);
    expect(results[0]!.ok).toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error.code).toBe('rate_limited');
  });
});
