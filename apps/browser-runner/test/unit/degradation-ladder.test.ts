import { describe, it, expect, vi } from 'vitest';
import { AtsAdapterHealthRegistry } from '../../src/ats-adapter-health.js';
import { recordMappingFailure, buildFormSignature } from '../../src/mapping-failure-telemetry.js';

describe('AtsAdapterHealthRegistry (task 055)', () => {
  it('defaults every adapter to healthy', () => {
    const reg = new AtsAdapterHealthRegistry();
    expect(reg.get('greenhouse')).toBe('healthy');
    expect(reg.isHealthy('greenhouse')).toBe(true);
  });

  it('markDegraded flips health, and only for that one adapter — avoids repeatedly trying a known-broken adapter', () => {
    const reg = new AtsAdapterHealthRegistry();
    reg.markDegraded('lever');
    expect(reg.get('lever')).toBe('degraded');
    expect(reg.isHealthy('lever')).toBe(false);
    expect(reg.isHealthy('greenhouse')).toBe(true); // unaffected
  });

  it('markHealthy recovers a degraded adapter', () => {
    const reg = new AtsAdapterHealthRegistry();
    reg.markDegraded('workday');
    reg.markHealthy('workday');
    expect(reg.isHealthy('workday')).toBe(true);
  });
});

describe('MappingFailure telemetry (task 055)', () => {
  it('buildFormSignature never carries raw field values — only counts', () => {
    const sig = buildFormSignature([{ tagName: 'input' }, { tagName: 'input' }, { tagName: 'select' }]);
    expect(sig.fieldCount).toBe(3);
    expect(sig.tagCounts).toEqual({ input: 2, select: 1 });
  });

  it('recordMappingFailure logs a structured, greppable event with a stable filter key', () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Parameters<typeof recordMappingFailure>[0];
    recordMappingFailure(logger, {
      applyTaskId: 'task-1', stage: 'heuristic', atsAdapter: null, taxonomyField: 'email',
      formSignature: { fieldCount: 5, tagCounts: { input: 5 } }, reason: 'no confident match',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, message] = warn.mock.calls[0]!;
    expect(payload).toMatchObject({ event: 'mapping_failure', stage: 'heuristic', applyTaskId: 'task-1' });
    expect(message).toContain("stage 'heuristic'");
  });
});
