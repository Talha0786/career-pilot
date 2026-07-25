/**
 * Task 055 — docs/05-playwright-design.md §5: "Selector maps versioned;
 * nightly canary tasks run against ATS sandbox/demo forms; failures flip
 * the ATS adapter to DEGRADED and fall back to heuristic+LLM mapping" /
 * "avoid repeatedly trying a known-broken adapter."
 *
 * SCOPE NOTE: in-memory only (a `Map`, reset on process restart) — a
 * cross-restart/cross-instance-shared version would need a Postgres table
 * (same "documented simplification, not silently skipped" posture as
 * `mapping-failure-telemetry.ts`'s logging-only choice). Adequate for a
 * single browser-runner instance; multi-instance deployments would want
 * the DB-backed version as a follow-up.
 */
export type AtsAdapterHealth = 'healthy' | 'degraded';

export class AtsAdapterHealthRegistry {
  private health = new Map<string, AtsAdapterHealth>();

  get(atsKey: string): AtsAdapterHealth {
    return this.health.get(atsKey) ?? 'healthy';
  }

  markDegraded(atsKey: string): void {
    this.health.set(atsKey, 'degraded');
  }

  markHealthy(atsKey: string): void {
    this.health.set(atsKey, 'healthy');
  }

  isHealthy(atsKey: string): boolean {
    return this.get(atsKey) === 'healthy';
  }
}
