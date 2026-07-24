import { describe, it, expect } from 'vitest';
import type { ConnectorPort, RawJob } from '@careerpilot/application';

export interface ConnectorContractFixture<TConfig> {
  readonly connector: ConnectorPort<TConfig>;
  /** A config that must pass `configSchema` and yield at least zero jobs without throwing. */
  readonly validConfig: TConfig;
  /** A config that must FAIL `configSchema.safeParse` — proves config errors are typed, not thrown. */
  readonly invalidConfig: unknown;
}

export interface ContractCheckResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/**
 * The actual assertions, factored out of vitest's `describe`/`it` so this
 * function can be called directly by the self-test (contract-test-kit.test.ts)
 * against a deliberately broken fake connector and inspected for a clean
 * pass/fail report — "break it once" verification (task 026 acceptance
 * criteria, matching task 014's boundary-check pattern).
 */
export async function runConnectorContractChecks<TConfig>(
  makeFixture: () => ConnectorContractFixture<TConfig> | Promise<ConnectorContractFixture<TConfig>>,
): Promise<ContractCheckResult> {
  const failures: string[] = [];

  const { connector, validConfig, invalidConfig } = await makeFixture();

  if (!connector.metadata.key) {
    failures.push('metadata.key must be a non-empty string');
  }
  if (!(['A', 'B', 'C'] as const).includes(connector.metadata.complianceClass)) {
    failures.push(`metadata.complianceClass must be one of A|B|C, got ${String(connector.metadata.complianceClass)}`);
  }
  if (!connector.metadata.displayName) {
    failures.push('metadata.displayName must be a non-empty string');
  }

  const invalidParse = connector.configSchema.safeParse(invalidConfig);
  if (invalidParse.success) {
    failures.push('configSchema.safeParse accepted a config that the fixture declared invalid');
  }

  const firstPassJobs: RawJob[] = [];
  try {
    for await (const item of connector.fetchJobs(validConfig, null)) {
      if (item.ok) {
        firstPassJobs.push(item.value);
      }
      // A typed error mid-stream is legitimate (upstream flake) — not a
      // contract failure by itself. Auth/config errors ARE expected to
      // surface here rather than throw; that's exactly what we're checking
      // by not wrapping this loop in a try/catch around individual items.
    }
  } catch (e) {
    failures.push(`fetchJobs threw synchronously instead of yielding a typed ConnectorError result: ${String(e)}`);
  }

  for (const [i, job] of firstPassJobs.entries()) {
    for (const f of canonicalRawJobFailures(job)) failures.push(`fetchJobs()[${i}]: ${f}`);
  }

  try {
    const health = await connector.healthCheck(validConfig);
    if (typeof health.ok !== 'boolean') {
      failures.push('healthCheck must resolve to a Result ({ ok: boolean, ... })');
    }
  } catch (e) {
    failures.push(`healthCheck threw synchronously instead of returning a typed Result: ${String(e)}`);
  }

  // Idempotent re-fetch: a fresh fixture + a fresh full pass from cursor
  // null must yield the same set of externalIds as the first pass.
  try {
    const second = await makeFixture();
    const secondIds: string[] = [];
    for await (const item of second.connector.fetchJobs(second.validConfig, null)) {
      if (item.ok) secondIds.push(item.value.externalId);
    }
    const firstIds = [...firstPassJobs.map((j) => j.externalId)].sort();
    secondIds.sort();
    if (JSON.stringify(firstIds) !== JSON.stringify(secondIds)) {
      failures.push(
        `fetchJobs is not idempotent across two full passes: first=[${firstIds.join(',')}] second=[${secondIds.join(',')}]`,
      );
    }
  } catch (e) {
    failures.push(`second fetchJobs pass threw: ${String(e)}`);
  }

  return { passed: failures.length === 0, failures };
}

function canonicalRawJobFailures(job: RawJob): string[] {
  const f: string[] = [];
  if (typeof job.externalId !== 'string' || job.externalId.length === 0) f.push('externalId must be a non-empty string');
  if (typeof job.url !== 'string' || job.url.length === 0) f.push('url must be a non-empty string');
  if (typeof job.title !== 'string' || job.title.length === 0) f.push('title must be a non-empty string');
  if (typeof job.company !== 'string' || job.company.length === 0) f.push('company must be a non-empty string');
  if (!(['remote', 'hybrid', 'onsite', 'unknown'] as const).includes(job.remote)) {
    f.push('remote must be one of remote|hybrid|onsite|unknown');
  }
  if (typeof job.descriptionMd !== 'string') f.push('descriptionMd must be a string');
  if (job.postedAt !== null && !(job.postedAt instanceof Date)) f.push('postedAt must be a Date or null');
  return f;
}

/**
 * Registers a vitest suite that runs every contract check and fails with the
 * full list of violations on first failure. Every connector in
 * `packages/connectors/src/class-{a,b,c}` calls this from its own test file
 * against its fixture-backed factory (task 028/030/031).
 */
export function describeConnectorContract<TConfig>(
  name: string,
  makeFixture: () => ConnectorContractFixture<TConfig> | Promise<ConnectorContractFixture<TConfig>>,
): void {
  describe(`ConnectorPort contract: ${name}`, () => {
    it('satisfies every ConnectorPort contract check', async () => {
      const result = await runConnectorContractChecks(makeFixture);
      expect(result.failures, `Contract violations:\n${result.failures.join('\n')}`).toEqual([]);
      expect(result.passed).toBe(true);
    });
  });
}
