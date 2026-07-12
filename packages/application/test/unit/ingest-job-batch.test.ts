import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeIngestJobBatchUseCase } from '../../src/discovery/commands/ingest-job-batch.js';
import type { RawJob } from '../../src/ports/connector.port.js';
import { FakeUnitOfWork } from '../fake-repos.js';
import { asUserId } from '@careerpilot/domain';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

const CROSS_SOURCE_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/discovery/test/fixtures/cross-source-duplicate-pair.json',
);
const crossSourcePair = JSON.parse(readFileSync(CROSS_SOURCE_FIXTURE_PATH, 'utf8')) as {
  classA: { sourceConnectorKey: string; externalId: string; title: string; company: string; url: string; descriptionMd: string; remote: 'remote' };
  classB: { sourceConnectorKey: string; externalId: string; title: string; company: string; url: string; descriptionMd: string; remote: 'remote' };
};

function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    externalId: 'ext-1',
    url: 'https://boards.example.com/jobs/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: { raw: 'Remote' },
    remote: 'remote',
    salary: null,
    descriptionMd: 'Build things.',
    postedAt: null,
    ...overrides,
  };
}

describe('ingestJobBatch', () => {
  it('inserts new jobs and writes exactly one outbox event per inserted job (reuses ADR-007 outbox, no new mechanism)', async () => {
    const uow = new FakeUnitOfWork();
    const ingest = makeIngestJobBatchUseCase({ uow });

    const result = await ingest({
      userId: USER,
      sourceConnectorKey: 'greenhouse',
      rawJobs: [
        rawJob({ externalId: 'gh-1', url: 'https://boards.example.com/jobs/1' }),
        rawJob({ externalId: 'gh-2', title: 'Frontend Engineer', url: 'https://boards.example.com/jobs/2' }),
      ],
    });

    expect(result).toEqual({ fetched: 2, deduped: 0, inserted: 2, skippedInvalid: 0 });
    expect(uow.outbox.enqueued).toHaveLength(2);
    expect(uow.outbox.enqueued.every((e) => e.eventType === 'discovery.job_posted')).toBe(true);
  });

  it('is idempotent: re-ingesting the same (source, externalId) is a no-op, not a duplicate row', async () => {
    const uow = new FakeUnitOfWork();
    const ingest = makeIngestJobBatchUseCase({ uow });

    await ingest({ userId: USER, sourceConnectorKey: 'greenhouse', rawJobs: [rawJob({ externalId: 'gh-1' })] });
    const second = await ingest({ userId: USER, sourceConnectorKey: 'greenhouse', rawJobs: [rawJob({ externalId: 'gh-1' })] });

    expect(second).toEqual({ fetched: 1, deduped: 0, inserted: 0, skippedInvalid: 0 });
    expect(uow.outbox.enqueued).toHaveLength(1); // still just the first
  });

  it('dedups a job against an existing posting from a DIFFERENT source (Class B/C against Class A — task 029 acceptance)', async () => {
    const uow = new FakeUnitOfWork();
    const ingest = makeIngestJobBatchUseCase({ uow });

    // Class A: Greenhouse ingests the "original" posting (fixture: known
    // real-world duplicate pair, cross-source-duplicate-pair.json).
    await ingest({
      userId: USER,
      sourceConnectorKey: crossSourcePair.classA.sourceConnectorKey,
      rawJobs: [rawJob({ ...crossSourcePair.classA })],
    });

    // Class B: a captured posting for the SAME real-world job — no shared
    // external id with Greenhouse, slightly reformatted title, different URL.
    const result = await ingest({
      userId: USER,
      sourceConnectorKey: crossSourcePair.classB.sourceConnectorKey,
      rawJobs: [rawJob({ ...crossSourcePair.classB })],
    });

    expect(result.inserted).toBe(1);
    expect(result.deduped).toBe(1);

    const all = await uow.jobPostings.listForUser(USER, { limit: 10 });
    expect(all.items).toHaveLength(2);
    const [a, b] = all.items;
    expect(a!.dedupGroupId).not.toBeNull();
    expect(a!.dedupGroupId).toBe(b!.dedupGroupId); // same group across two different sources
    expect(a!.sourceConnectorKey).not.toBe(b!.sourceConnectorKey); // genuinely cross-source, not a same-connector coincidence
  });

  it('does NOT dedup two different jobs at the same company', async () => {
    const uow = new FakeUnitOfWork();
    const ingest = makeIngestJobBatchUseCase({ uow });

    await ingest({
      userId: USER,
      sourceConnectorKey: 'greenhouse',
      rawJobs: [rawJob({ externalId: 'gh-1', title: 'Backend Engineer', company: 'Acme', url: 'https://boards.example.com/backend' })],
    });
    const result = await ingest({
      userId: USER,
      sourceConnectorKey: 'lever',
      rawJobs: [rawJob({ externalId: 'lv-1', title: 'Frontend Engineer', company: 'Acme', url: 'https://jobs.example.com/frontend' })],
    });

    expect(result.deduped).toBe(0);
    expect(result.inserted).toBe(1);
  });

  it('skips (does not throw) an invalid RawJob and still processes the rest of the batch', async () => {
    const uow = new FakeUnitOfWork();
    const ingest = makeIngestJobBatchUseCase({ uow });

    const result = await ingest({
      userId: USER,
      sourceConnectorKey: 'rss',
      rawJobs: [rawJob({ externalId: 'rss-1', title: '' /* invalid: empty title */ }), rawJob({ externalId: 'rss-2', title: 'Valid Title' })],
    });

    expect(result.skippedInvalid).toBe(1);
    expect(result.inserted).toBe(1);
  });
});
