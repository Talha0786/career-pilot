import type { Logger } from 'pino';

/**
 * Task 055 — docs/05-playwright-design.md §5: "Structured MappingFailure
 * telemetry (which stage failed, taxonomy field, anonymized form
 * signature) feeds a triage dashboard."
 *
 * SCOPE NOTE (documented, not silently narrowed): a full triage dashboard
 * UI is explicitly out of scope for M6 per this task's own acceptance
 * criteria ("just the structured data feed"). Implemented as structured
 * pino logging (a real "log aggregation point" — the task file's own
 * phrasing explicitly allows this) rather than a new Postgres table +
 * migration + repository, given this milestone's time budget — every
 * field below is queryable/greppable/aggregatable by any standard log
 * pipeline (the `event: 'mapping_failure'` field is the stable filter key).
 * A DB-table-backed version is a reasonable follow-up if a real triage UI
 * gets built later, but would be speculative infrastructure today.
 */
export interface MappingFailure {
  readonly applyTaskId: string;
  readonly stage: 'known_ats' | 'heuristic' | 'llm';
  readonly atsAdapter: string | null;
  readonly taxonomyField: string | null;
  /** NEVER the raw form HTML/values — a small anonymized signature (field count, tag-type histogram) only, per §6's redaction posture. */
  readonly formSignature: {
    readonly fieldCount: number;
    readonly tagCounts: Readonly<Record<string, number>>;
  };
  readonly reason: string;
}

export function recordMappingFailure(logger: Logger, failure: MappingFailure): void {
  logger.warn({ event: 'mapping_failure', ...failure }, `mapping failure at stage '${failure.stage}': ${failure.reason}`);
}

export function buildFormSignature(fields: readonly { tagName: string }[]): MappingFailure['formSignature'] {
  const tagCounts: Record<string, number> = {};
  for (const f of fields) tagCounts[f.tagName] = (tagCounts[f.tagName] ?? 0) + 1;
  return { fieldCount: fields.length, tagCounts };
}
