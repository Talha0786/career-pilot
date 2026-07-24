import { describe, it, expect } from 'vitest';
import {
  makeUpdateConnectorHealthUseCase, DEGRADED_AFTER_CONSECUTIVE_FAILURES, DISABLED_AFTER_CONSECUTIVE_FAILURES,
} from '../../src/discovery/commands/update-connector-health.js';
import { FakeConnectorConfigRepository } from '../fake-repos.js';
import { asUserId } from '@careerpilot/domain';
import type { ConnectorConfig } from '../../src/ports/repositories.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');

function seedConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'cfg-1',
    userId: USER,
    connectorKey: 'greenhouse',
    displayName: 'Test',
    enabled: true,
    scheduleCron: null,
    config: {},
    credentialsRef: null,
    health: 'healthy',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('updateConnectorHealth', () => {
  it('resets consecutiveFailures and stamps lastSuccessAt on an ok run', async () => {
    const configs = new FakeConnectorConfigRepository();
    await configs.save(seedConfig({ consecutiveFailures: 2, health: 'degraded' }));
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });

    const now = new Date('2026-02-01T00:00:00.000Z');
    await update({ connectorConfigId: 'cfg-1', runStatus: 'ok', now });

    const found = await configs.findById('cfg-1');
    expect(found!.consecutiveFailures).toBe(0);
    expect(found!.health).toBe('healthy');
    expect(found!.lastSuccessAt).toEqual(now);
  });

  it('a partial run does NOT count as a failure', async () => {
    const configs = new FakeConnectorConfigRepository();
    await configs.save(seedConfig({ consecutiveFailures: 1 }));
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });

    await update({ connectorConfigId: 'cfg-1', runStatus: 'partial', now: new Date() });

    const found = await configs.findById('cfg-1');
    expect(found!.consecutiveFailures).toBe(0);
    expect(found!.health).toBe('healthy');
  });

  it(`flips to degraded at exactly ${DEGRADED_AFTER_CONSECUTIVE_FAILURES} consecutive failures`, async () => {
    const configs = new FakeConnectorConfigRepository();
    await configs.save(seedConfig());
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });

    for (let i = 1; i < DEGRADED_AFTER_CONSECUTIVE_FAILURES; i++) {
      await update({ connectorConfigId: 'cfg-1', runStatus: 'failed', now: new Date() });
      expect((await configs.findById('cfg-1'))!.health).toBe('healthy'); // not yet
    }
    await update({ connectorConfigId: 'cfg-1', runStatus: 'failed', now: new Date() });
    const found = await configs.findById('cfg-1');
    expect(found!.consecutiveFailures).toBe(DEGRADED_AFTER_CONSECUTIVE_FAILURES);
    expect(found!.health).toBe('degraded');
  });

  it(`flips to disabled at ${DISABLED_AFTER_CONSECUTIVE_FAILURES} consecutive failures`, async () => {
    const configs = new FakeConnectorConfigRepository();
    await configs.save(seedConfig());
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });

    for (let i = 0; i < DISABLED_AFTER_CONSECUTIVE_FAILURES; i++) {
      await update({ connectorConfigId: 'cfg-1', runStatus: 'failed', now: new Date() });
    }
    const found = await configs.findById('cfg-1');
    expect(found!.health).toBe('disabled');
  });

  it('flips back to healthy after a subsequent success, from degraded', async () => {
    const configs = new FakeConnectorConfigRepository();
    await configs.save(seedConfig({ consecutiveFailures: DEGRADED_AFTER_CONSECUTIVE_FAILURES, health: 'degraded' }));
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });

    await update({ connectorConfigId: 'cfg-1', runStatus: 'ok', now: new Date() });

    const found = await configs.findById('cfg-1');
    expect(found!.health).toBe('healthy');
    expect(found!.consecutiveFailures).toBe(0);
  });

  it('is a no-op for a connector config that no longer exists', async () => {
    const configs = new FakeConnectorConfigRepository();
    const update = makeUpdateConnectorHealthUseCase({ connectorConfigs: configs });
    await expect(update({ connectorConfigId: 'does-not-exist', runStatus: 'failed', now: new Date() })).resolves.toBeUndefined();
  });
});
