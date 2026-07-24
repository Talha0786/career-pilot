import type { ConnectorConfigRepository } from '../../ports/repositories.js';

export interface UpdateConnectorHealthInput {
  readonly connectorConfigId: string;
  /** The just-finished run's terminal status (task 029's `ingestion_runs.status`). */
  readonly runStatus: 'ok' | 'partial' | 'failed';
  readonly now: Date;
}

/**
 * Consecutive-failure-count-driven health transitions (task 032), closing
 * the loop design §2 opened with `connector_configs.health`. Driven by REAL
 * `ingestion_runs` outcomes passed in by the scheduler after every run
 * (`run-connector-ingestion.handler.ts`) — not a mocked signal (task 032
 * acceptance criterion).
 *
 * `'partial'` (some jobs landed, some errors) does NOT count as a failure —
 * a connector that's mostly working shouldn't get flagged unhealthy over
 * one flaky page. Only `'failed'` (zero jobs, hard error) increments the
 * counter.
 *
 * Delegates the actual increment/reset to
 * `ConnectorConfigRepository.recordRunOutcome`, which does it as ONE atomic
 * database operation — not a `findById` here followed by a `save` here.
 * That split was tried first and is exactly what caused a real, observed
 * lost-update bug in this task's own chaos test: two connector runs
 * completing close together both read `consecutiveFailures`, both computed
 * `+1` from the same stale value, and the counter under-counted (3 real
 * failures recorded in `ingestion_runs`, only 2 reflected in
 * `consecutive_failures`) — see task 032's evidence section for the actual
 * numbers observed. The threshold CONSTANTS live here (single source of
 * truth for the class boundary); the repository's SQL mirrors them.
 */
export const DEGRADED_AFTER_CONSECUTIVE_FAILURES = 3;
export const DISABLED_AFTER_CONSECUTIVE_FAILURES = 10;

export function makeUpdateConnectorHealthUseCase(deps: { connectorConfigs: ConnectorConfigRepository }) {
  return async function updateConnectorHealth(input: UpdateConnectorHealthInput): Promise<void> {
    const succeeded = input.runStatus !== 'failed';
    await deps.connectorConfigs.recordRunOutcome(input.connectorConfigId, succeeded, input.now);
  };
}
