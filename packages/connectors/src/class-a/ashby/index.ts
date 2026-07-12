import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError, RawJobSalary } from '@careerpilot/application';
import { htmlToText } from '../../sdk/html-to-text.js';

/**
 * Ashby Job Board API (Class A — official, public, no auth required).
 * https://developers.ashbyhq.com/docs/job-board-api — `GET /posting-api/job-board/{boardName}`.
 * Returns every open posting in one response; no cursor pagination exists on
 * this endpoint, so `fetchJobs` always yields a single page.
 */
export const ashbyConfigSchema = z.object({
  boardName: z.string().min(1),
  companyName: z.string().min(1).optional(),
});

export type AshbyConfig = z.infer<typeof ashbyConfigSchema>;

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  publishedAt?: string;
  isRemote?: boolean;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: { min?: number; max?: number; currency?: string; interval?: string };
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createAshbyConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<AshbyConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'ashby', displayName: 'Ashby Job Board', complianceClass: 'A' },
    configSchema: ashbyConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(config.boardName)}`;

      let res: Response;
      try {
        res = await fetchImpl(url);
      } catch (e) {
        yield err(upstreamError(`Network error calling Ashby: ${String(e)}`));
        return;
      }

      if (res.status === 401 || res.status === 403) {
        yield err({ code: 'auth_error', message: `Ashby rejected the request (${res.status})`, retryable: false });
        return;
      }
      if (res.status === 404) {
        yield err({ code: 'config_error', message: `Ashby board "${config.boardName}" not found`, retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'Ashby rate limit hit', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`Ashby returned ${res.status}`));
        return;
      }

      let body: AshbyResponse;
      try {
        body = (await res.json()) as AshbyResponse;
      } catch (e) {
        yield err({ code: 'invalid_response', message: `Ashby returned invalid JSON: ${String(e)}`, retryable: false });
        return;
      }

      for (const job of body.jobs ?? []) {
        const locationName = job.location?.trim() ?? '';
        yield ok<RawJob>({
          externalId: job.id,
          url: job.jobUrl,
          title: job.title,
          company: config.companyName ?? config.boardName,
          location: locationName ? { raw: locationName } : null,
          remote: job.isRemote ? 'remote' : locationName ? 'onsite' : 'unknown',
          salary: mapCompensation(job.compensation),
          descriptionMd: job.descriptionPlain?.trim() || htmlToText(job.descriptionHtml ?? ''),
          postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
        });
      }
    },

    async healthCheck(config) {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(config.boardName)}`;
      try {
        const res = await fetchImpl(url);
        if (res.status === 404) {
          return err({ code: 'config_error', message: `Ashby board "${config.boardName}" not found`, retryable: false });
        }
        if (!res.ok) return err(upstreamError(`Ashby healthcheck returned ${res.status}`));
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during Ashby healthcheck: ${String(e)}`));
      }
    },
  };
}

function mapCompensation(c: AshbyJob['compensation']): RawJobSalary | null {
  if (!c) return null;
  const period = c.interval === 'year' || c.interval === 'month' || c.interval === 'hour' ? c.interval : undefined;
  const salary: { min?: number; max?: number; currency?: string; period?: 'year' | 'month' | 'hour' } = {};
  if (c.min !== undefined) salary.min = c.min;
  if (c.max !== undefined) salary.max = c.max;
  if (c.currency !== undefined) salary.currency = c.currency;
  if (period !== undefined) salary.period = period;
  return salary;
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
