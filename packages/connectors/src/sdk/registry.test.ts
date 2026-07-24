import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok } from '@careerpilot/domain';
import type { ConnectorPort } from '@careerpilot/application';
import { ConnectorRegistry } from './registry.js';

function fakeConnector(key: string): ConnectorPort<Record<string, never>> {
  return {
    metadata: { key, displayName: key, complianceClass: 'A' },
    configSchema: z.object({}),
    async *fetchJobs() {},
    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

describe('ConnectorRegistry', () => {
  it('registers and retrieves a connector by key', () => {
    const registry = new ConnectorRegistry();
    const connector = fakeConnector('greenhouse');
    registry.register(connector);
    expect(registry.get('greenhouse')).toBe(connector);
    expect(registry.has('greenhouse')).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects two connectors registering the same key', () => {
    const registry = new ConnectorRegistry();
    registry.register(fakeConnector('lever'));
    expect(() => registry.register(fakeConnector('lever'))).toThrow(/already registered/);
  });

  it('returns undefined for an unregistered key', () => {
    const registry = new ConnectorRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
  });
});
