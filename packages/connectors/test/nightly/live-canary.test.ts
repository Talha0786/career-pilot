import { describe, it, expect } from 'vitest';
import { createGreenhouseConnector } from '../../src/class-a/greenhouse/index.js';
import { createLeverConnector } from '../../src/class-a/lever/index.js';
import { createAshbyConnector } from '../../src/class-a/ashby/index.js';
import { createUsajobsConnector } from '../../src/class-a/usajobs/index.js';
import { createRssConnector } from '../../src/class-a/rss/index.js';

/**
 * Task 028's nightly live canary (mirrors task 014's Ollama nightly
 * pattern): exercises each Class A connector against a REAL public
 * board/feed, not a fixture. Non-blocking and report-only — third-party
 * board tokens/companies used here are real public examples (recorded as
 * reachable when this file was written, 2026-07-12), but a board going
 * private/renamed is an external-service fact, not a code defect, so a
 * failure here logs and returns rather than failing CI (same "skip/warn
 * rather than fail" posture as `ollama-contract.test.ts`).
 *
 * USAJobs is the one exception: it requires a registered `Authorization-Key`
 * this repo does not have as a secret yet, so it always reports "skipped:
 * no key configured" rather than attempting an unauthenticated call that
 * would always 401 (that failure mode is already covered by the fixture
 * test's `auth_error` assertion, not usefully re-proven nightly).
 */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

describe('Class A connectors against REAL public endpoints (nightly only)', () => {
  it('greenhouse: fetches real jobs from a real public board', async () => {
    const connector = createGreenhouseConnector();
    const config = { boardToken: 'stripe' };
    if (!(await reachable('https://boards-api.greenhouse.io/v1/boards/stripe/jobs'))) {
      console.warn('Skipping: Greenhouse board unreachable — network-restricted environment or board renamed.');
      return;
    }
    const jobs = [];
    for await (const item of connector.fetchJobs(config, null)) {
      if (item.ok) jobs.push(item.value);
      if (jobs.length >= 3) break;
    }
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]!.title.length).toBeGreaterThan(0);
  });

  it('lever: fetches real postings from a real public board', async () => {
    const connector = createLeverConnector();
    const config = { company: 'palantir' };
    if (!(await reachable('https://api.lever.co/v0/postings/palantir?mode=json'))) {
      console.warn('Skipping: Lever board unreachable.');
      return;
    }
    const jobs = [];
    for await (const item of connector.fetchJobs(config, null)) {
      if (item.ok) jobs.push(item.value);
      if (jobs.length >= 3) break;
    }
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('ashby: fetches real jobs from a real public board', async () => {
    const connector = createAshbyConnector();
    const config = { boardName: 'notion' };
    if (!(await reachable('https://api.ashbyhq.com/posting-api/job-board/notion'))) {
      console.warn('Skipping: Ashby board unreachable.');
      return;
    }
    const jobs = [];
    for await (const item of connector.fetchJobs(config, null)) {
      if (item.ok) jobs.push(item.value);
      if (jobs.length >= 3) break;
    }
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('usajobs: skips gracefully — no registered API key configured', async () => {
    if (!process.env.USAJOBS_API_KEY || !process.env.USAJOBS_USER_AGENT_EMAIL) {
      console.warn('Skipping: USAJOBS_API_KEY/USAJOBS_USER_AGENT_EMAIL not configured as a nightly secret.');
      return;
    }
    const connector = createUsajobsConnector();
    const jobs = [];
    for await (const item of connector.fetchJobs(
      { apiKey: process.env.USAJOBS_API_KEY, userAgentEmail: process.env.USAJOBS_USER_AGENT_EMAIL, resultsPerPage: 5 },
      null,
    )) {
      if (item.ok) jobs.push(item.value);
    }
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('rss: fetches real items from a real public feed', async () => {
    const connector = createRssConnector();
    const config = { feedUrl: 'https://weworkremotely.com/categories/remote-programming-jobs.rss' };
    if (!(await reachable(config.feedUrl))) {
      console.warn('Skipping: RSS feed unreachable.');
      return;
    }
    const jobs = [];
    for await (const item of connector.fetchJobs(config, null)) {
      if (item.ok) jobs.push(item.value);
      if (jobs.length >= 3) break;
    }
    expect(jobs.length).toBeGreaterThan(0);
  });
});
