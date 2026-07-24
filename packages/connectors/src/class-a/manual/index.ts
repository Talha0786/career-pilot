import { z } from 'zod';
import { ok, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError } from '@careerpilot/application';

/**
 * Manual paste (Class A — the user typing/pasting a job description
 * themselves; zero legal risk, zero automation). This is the M2 manual-paste
 * path (`create-manual-job.ts` / `POST /jobs`, task 011) re-expressed as a
 * `ConnectorPort` implementation — NOT new functionality. It exists purely
 * so `connector_configs`/the registry can treat "manual" as just another
 * connector key (matching `job_postings.source_connector_key`'s existing
 * `'manual'` default) instead of a special case threaded through the
 * scheduler/registry.
 *
 * `fetchJobs` is deliberately a no-op generator: manual postings are never
 * *fetched* by the scheduler (task 029) — they're pushed synchronously by
 * `createManualJob` when the user submits the paste form. There is nothing
 * for a scheduled run of this connector to pull, so it always yields zero
 * jobs and zero errors. `healthCheck` always succeeds — there's no external
 * dependency to be unhealthy.
 */
export const manualConfigSchema = z.object({}).strict();

export type ManualConfig = z.infer<typeof manualConfigSchema>;

export function createManualConnector(): ConnectorPort<ManualConfig> {
  return {
    metadata: { key: 'manual', displayName: 'Manual paste', complianceClass: 'A' },
    configSchema: manualConfigSchema,

    async *fetchJobs(): AsyncIterable<Result<RawJob, ConnectorError>> {
      // No-op: manual postings arrive via createManualJob, not a scheduled pull.
    },

    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}
