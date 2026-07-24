import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok } from '@careerpilot/domain';
import type { ConnectorPort, RawJob } from '@careerpilot/application';
import { runConnectorContractChecks } from './contract-test-kit.js';

const configSchema = z.object({ apiKey: z.string().min(1) });

function makeGoodConnector(): ConnectorPort<{ apiKey: string }> {
  return {
    metadata: { key: 'fake-good', displayName: 'Fake Good', complianceClass: 'A' },
    configSchema,
    async *fetchJobs() {
      const job: RawJob = {
        externalId: 'job-1',
        url: 'https://example.com/jobs/1',
        title: 'Software Engineer',
        company: 'Acme',
        location: { raw: 'Remote' },
        remote: 'remote',
        salary: null,
        descriptionMd: 'Do engineering things.',
        postedAt: null,
      };
      yield ok(job);
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

/** Deliberately non-compliant: throws instead of yielding a typed ConnectorError. */
function makeThrowingConnector(): ConnectorPort<{ apiKey: string }> {
  return {
    metadata: { key: 'fake-throws', displayName: 'Fake Throws', complianceClass: 'A' },
    configSchema,
    // eslint-disable-next-line require-yield -- deliberately throws before ever yielding
    async *fetchJobs() {
      throw new Error('upstream is on fire');
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

/** Deliberately non-compliant: yields a RawJob missing required fields. */
function makeMalformedConnector(): ConnectorPort<{ apiKey: string }> {
  return {
    metadata: { key: 'fake-malformed', displayName: 'Fake Malformed', complianceClass: 'A' },
    configSchema,
    async *fetchJobs() {
      const job: RawJob = {
        externalId: '',
        url: 'https://example.com/jobs/2',
        title: '',
        company: 'Acme',
        location: null,
        remote: 'onsite',
        salary: null,
        descriptionMd: 'desc',
        postedAt: null,
      };
      yield ok(job);
    },
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

/** Deliberately non-compliant: accepts any config, even one the fixture calls invalid. */
function makePermissiveSchemaConnector(): ConnectorPort<{ apiKey: string }> {
  return {
    metadata: { key: 'fake-permissive', displayName: 'Fake Permissive', complianceClass: 'A' },
    configSchema: z.any() as unknown as typeof configSchema,
    async *fetchJobs() {},
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

describe('contract test-kit self-test (proves the kit catches a broken connector)', () => {
  it('passes a correct fake connector with zero failures', async () => {
    const result = await runConnectorContractChecks(() => ({
      connector: makeGoodConnector(),
      validConfig: { apiKey: 'secret' },
      invalidConfig: { apiKey: '' },
    }));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails a connector that throws synchronously instead of returning a typed error', async () => {
    const result = await runConnectorContractChecks(() => ({
      connector: makeThrowingConnector(),
      validConfig: { apiKey: 'secret' },
      invalidConfig: { apiKey: '' },
    }));
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('threw synchronously'))).toBe(true);
  });

  it('fails a connector that yields a non-canonical RawJob', async () => {
    const result = await runConnectorContractChecks(() => ({
      connector: makeMalformedConnector(),
      validConfig: { apiKey: 'secret' },
      invalidConfig: { apiKey: '' },
    }));
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('externalId'))).toBe(true);
    expect(result.failures.some((f) => f.includes('title'))).toBe(true);
  });

  it('fails a connector whose configSchema accepts a config the fixture declares invalid', async () => {
    const result = await runConnectorContractChecks(() => ({
      connector: makePermissiveSchemaConnector(),
      validConfig: { apiKey: 'secret' },
      invalidConfig: { apiKey: '' },
    }));
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('configSchema'))).toBe(true);
  });
});
