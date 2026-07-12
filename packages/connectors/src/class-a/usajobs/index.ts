import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError, RawJobSalary } from '@careerpilot/application';

/**
 * USAJobs Search API (Class A — official U.S. federal government API).
 * https://developer.usajobs.gov/api-reference/get-api-search — requires a
 * free API key (`Authorization-Key` header) and a `User-Agent` set to the
 * requester's email, per USAJobs' terms. This is still Class A: it's an
 * official, documented, keyed public API, not a scrape — the key is free to
 * obtain and its only purpose is attribution/rate-limiting, unlike Class C's
 * paid licensed-provider keys.
 *
 * `apiKey`/`userAgentEmail` are resolved by the composition root from
 * `connector_configs.credentials_ref` (task 027) before `fetchJobs` is
 * called — this connector never reads `credentials_ref` itself, and the
 * resolved value is never persisted back into `connector_configs.config`.
 */
export const usajobsConfigSchema = z.object({
  apiKey: z.string().min(1),
  userAgentEmail: z.string().email(),
  keyword: z.string().min(1).optional(),
  resultsPerPage: z.number().int().positive().max(500).optional(),
});

export type UsajobsConfig = z.infer<typeof usajobsConfigSchema>;

interface UsajobsRemuneration {
  MinimumRange?: string;
  MaximumRange?: string;
  RateIntervalCode?: string;
}

interface UsajobsDescriptor {
  PositionTitle: string;
  PositionURI: string;
  OrganizationName?: string;
  PositionLocationDisplay?: string;
  PositionRemuneration?: UsajobsRemuneration[];
  PublicationStartDate?: string;
  UserArea?: { Details?: { JobSummary?: string } };
}

interface UsajobsItem {
  MatchedObjectId: string;
  MatchedObjectDescriptor: UsajobsDescriptor;
}

interface UsajobsResponse {
  SearchResult: { SearchResultItems: UsajobsItem[] };
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createUsajobsConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<UsajobsConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'usajobs', displayName: 'USAJobs', complianceClass: 'A' },
    configSchema: usajobsConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      const params = new URLSearchParams();
      if (config.keyword) params.set('Keyword', config.keyword);
      params.set('ResultsPerPage', String(config.resultsPerPage ?? 100));
      const url = `https://data.usajobs.gov/api/search?${params.toString()}`;

      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: {
            Host: 'data.usajobs.gov',
            'User-Agent': config.userAgentEmail,
            'Authorization-Key': config.apiKey,
          },
        });
      } catch (e) {
        yield err(upstreamError(`Network error calling USAJobs: ${String(e)}`));
        return;
      }

      if (res.status === 401 || res.status === 403) {
        yield err({ code: 'auth_error', message: `USAJobs rejected the API key (${res.status})`, retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'USAJobs rate limit hit', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`USAJobs returned ${res.status}`));
        return;
      }

      let body: UsajobsResponse;
      try {
        body = (await res.json()) as UsajobsResponse;
      } catch (e) {
        yield err({ code: 'invalid_response', message: `USAJobs returned invalid JSON: ${String(e)}`, retryable: false });
        return;
      }

      for (const item of body.SearchResult?.SearchResultItems ?? []) {
        const d = item.MatchedObjectDescriptor;
        const locationName = d.PositionLocationDisplay?.trim() ?? '';
        yield ok<RawJob>({
          externalId: item.MatchedObjectId,
          url: d.PositionURI,
          title: d.PositionTitle,
          company: d.OrganizationName ?? 'U.S. Government',
          location: locationName ? { raw: locationName } : null,
          remote: /remote/i.test(locationName) ? 'remote' : 'unknown',
          salary: mapRemuneration(d.PositionRemuneration),
          descriptionMd: d.UserArea?.Details?.JobSummary?.trim() ?? '',
          postedAt: d.PublicationStartDate ? new Date(d.PublicationStartDate) : null,
        });
      }
    },

    async healthCheck(config) {
      const url = 'https://data.usajobs.gov/api/search?ResultsPerPage=1';
      try {
        const res = await fetchImpl(url, {
          headers: {
            Host: 'data.usajobs.gov',
            'User-Agent': config.userAgentEmail,
            'Authorization-Key': config.apiKey,
          },
        });
        if (res.status === 401 || res.status === 403) {
          return err({ code: 'auth_error', message: `USAJobs rejected the API key (${res.status})`, retryable: false });
        }
        if (!res.ok) return err(upstreamError(`USAJobs healthcheck returned ${res.status}`));
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during USAJobs healthcheck: ${String(e)}`));
      }
    },
  };
}

function mapRemuneration(list: UsajobsRemuneration[] | undefined): RawJobSalary | null {
  const r = list?.[0];
  if (!r) return null;
  const min = r.MinimumRange ? Number(r.MinimumRange) : undefined;
  const max = r.MaximumRange ? Number(r.MaximumRange) : undefined;
  const period = r.RateIntervalCode === 'Per Year' ? 'year' : r.RateIntervalCode === 'Per Hour' ? 'hour' : undefined;
  if (min === undefined && max === undefined) return null;
  const salary: { min?: number; max?: number; currency?: string; period?: 'year' | 'month' | 'hour' } = { currency: 'USD' };
  if (min !== undefined && !Number.isNaN(min)) salary.min = min;
  if (max !== undefined && !Number.isNaN(max)) salary.max = max;
  if (period !== undefined) salary.period = period;
  return salary;
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
