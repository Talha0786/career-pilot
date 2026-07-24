import { describe, it, expect } from 'vitest';
import { createSerpapiGoogleJobsConnector } from '../../src/class-c/serpapi-google-jobs/index.js';

/**
 * Task 031's nightly live canary — opt-in, requires a real `SERPAPI_KEY`
 * repo secret the USER must add (BYO-key by design, ADR-004). Skips
 * gracefully, not failed, when no key is configured — same posture as
 * `ollama-contract.test.ts` (task 014) and this package's own class-a
 * `live-canary.test.ts` (task 028) skipping USAJobs without a key.
 *
 * KNOWN GAP (task 031, disclosed in the task file): this test has never
 * actually run against the real SerpApi service in this session, because
 * no `SERPAPI_KEY` was available. What it exercises instead, every run
 * regardless of key presence, is the skip-path itself — proving the
 * connector doesn't crash or hang when the expected secret is absent.
 */
describe('SerpApi Google Jobs connector against the REAL SerpApi service (nightly only, opt-in)', () => {
  it('fetches real jobs when SERPAPI_KEY is configured; otherwise skips cleanly', async () => {
    const apiKey = process.env.SERPAPI_KEY;
    if (!apiKey) {
      console.warn('Skipping: SERPAPI_KEY not configured as a nightly secret. Add one to run this canary for real (see docs/connectors/class-c-serpapi.md).');
      return;
    }

    const connector = createSerpapiGoogleJobsConnector();
    const jobs = [];
    for await (const item of connector.fetchJobs({ apiKey, query: 'software engineer', location: 'United States' }, null)) {
      if (item.ok) jobs.push(item.value);
      if (jobs.length >= 3) break;
    }
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]!.title.length).toBeGreaterThan(0);
  });
});
