import type { Result } from '@careerpilot/domain';
import type { ZodType } from 'zod';

/**
 * Connector compliance classes (ADR-004). Class D — ToS-prohibited direct
 * automation (server-side scraping / credentialed login-harvest of
 * platforms whose terms forbid it) — deliberately has NO value here. The
 * type system itself refuses to let a first-party connector declare 'D'.
 */
export type ComplianceClass = 'A' | 'B' | 'C';

export interface RawJobLocation {
  readonly raw: string;
  readonly city?: string;
  readonly region?: string;
  readonly country?: string;
}

export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export interface RawJobSalary {
  readonly min?: number;
  readonly max?: number;
  readonly currency?: string;
  readonly period?: 'year' | 'month' | 'hour';
}

/**
 * The canonical shape every connector (Class A/B/C) normalizes into,
 * regardless of source API shape. This is the only thing the ingestion
 * pipeline (task 029) ever sees — connector-specific fields never leak past
 * `normalize`.
 */
export interface RawJob {
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly company: string;
  readonly location: RawJobLocation | null;
  readonly remote: RemoteType;
  readonly salary: RawJobSalary | null;
  readonly descriptionMd: string;
  readonly postedAt: Date | null;
}

export type ConnectorErrorCode =
  | 'auth_error'
  | 'config_error'
  | 'rate_limited'
  | 'upstream_error'
  | 'invalid_response';

export interface ConnectorError {
  readonly code: ConnectorErrorCode;
  readonly message: string;
  /** Whether the scheduler (task 029) should retry this run vs. record failed and move on. */
  readonly retryable: boolean;
}

export interface ConnectorMetadata {
  readonly key: string;
  readonly displayName: string;
  readonly complianceClass: ComplianceClass;
}

/**
 * ConnectorPort — the shared contract every connector implements (ADR-004).
 * Mirrors `LlmPort`'s shape: one port defined in application, many adapters
 * in infrastructure/connectors packages. A connector package is infrastructure
 * even though it lives under `packages/connectors` rather than
 * `packages/infrastructure` — it depends on this port, never the reverse.
 */
export interface ConnectorPort<TConfig = Record<string, unknown>> {
  readonly metadata: ConnectorMetadata;
  /** zod schema validating this connector's `connector_configs.config` shape. */
  readonly configSchema: ZodType<TConfig>;
  /**
   * Cursor-paginated fetch. Errors surface as a `Result` value in the
   * stream, NEVER a thrown exception — a scheduler running N connectors in
   * the same process must be able to isolate one bad page from the rest of
   * a run without wrapping every `for await` in try/catch. `cursor` is
   * opaque to the caller; `null`/`undefined` means "start from the
   * beginning." Re-fetching from the same starting cursor must be
   * idempotent (contract test-kit, task 026).
   */
  fetchJobs(config: TConfig, cursor?: string | null): AsyncIterable<Result<RawJob, ConnectorError>>;
  /** Cheap reachability/auth check — used at connector-enable time (task 031/032), not during ingestion. */
  healthCheck(config: TConfig): Promise<Result<{ readonly ok: true }, ConnectorError>>;
}
