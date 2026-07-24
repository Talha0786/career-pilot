import { describe, it, expect } from 'vitest';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createManualConnector } from './index.js';

describeConnectorContract('manual', () => ({
  connector: createManualConnector(),
  validConfig: {},
  invalidConfig: { unexpected: 'field' },
}));

describe('Manual connector', () => {
  it('has compliance class A and key "manual", matching job_postings.source_connector_key default', async () => {
    const connector = createManualConnector();
    expect(connector.metadata.key).toBe('manual');
    expect(connector.metadata.complianceClass).toBe('A');
  });

  it('fetchJobs always yields zero jobs — manual postings are pushed, never pulled', async () => {
    const connector = createManualConnector();
    const results = [];
    for await (const item of connector.fetchJobs({}, null)) results.push(item);
    expect(results).toHaveLength(0);
  });

  it('healthCheck always succeeds — no external dependency', async () => {
    const connector = createManualConnector();
    const result = await connector.healthCheck({});
    expect(result.ok).toBe(true);
  });
});
