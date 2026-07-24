import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError, RawJobSalary } from '@careerpilot/application';

/**
 * SerpApi Google Jobs (Class C — BYO-key licensed provider, ADR-004). The
 * reference Class C adapter: the user supplies their own paid SerpApi key;
 * scraping/compliance liability sits with SerpApi under the user's contract
 * with them, not with CareerPilot. See docs/connectors/class-c-serpapi.md
 * for cost/setup.
 *
 * `apiKey` is resolved by the composition root from
 * `connector_configs.credentials_ref` before `fetchJobs` is called — same
 * contract as the USAJobs connector (task 028) — this connector never reads
 * `credentials_ref` itself and the resolved value is never persisted back.
 */
export const serpapiConfigSchema = z.object({
  apiKey: z.string().min(1),
  query: z.string().min(1),
  location: z.string().min(1).optional(),
});
export type SerpapiConfig = z.infer<typeof serpapiConfigSchema>;

interface SerpapiJobResult {
  title: string;
  company_name?: string;
  location?: string;
  description?: string;
  detected_extensions?: { posted_at?: string; schedule_type?: string; salary?: string };
  job_id: string;
  share_link?: string;
  apply_options?: { title?: string; link: string }[];
}

interface SerpapiResponse {
  jobs_results?: SerpapiJobResult[];
  error?: string;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createSerpapiGoogleJobsConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<SerpapiConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'serpapi-google-jobs', displayName: 'Google Jobs via SerpApi', complianceClass: 'C' },
    configSchema: serpapiConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      const params = new URLSearchParams({ engine: 'google_jobs', q: config.query, api_key: config.apiKey });
      if (config.location) params.set('location', config.location);
      const url = `https://serpapi.com/search.json?${params.toString()}`;

      let res: Response;
      try {
        res = await fetchImpl(url);
      } catch (e) {
        yield err(upstreamError(`Network error calling SerpApi: ${String(e)}`));
        return;
      }

      // SerpApi returns 401 for a missing/invalid key — confirmed against
      // the real live endpoint (not just documentation) with a deliberately
      // invalid key: {"error": "Invalid API key. ..."}, HTTP 401. This is
      // the ONE thing about this connector that WAS verified live (task
      // 031's Known gap: the success path fixture is not).
      if (res.status === 401) {
        yield err({ code: 'auth_error', message: 'SerpApi rejected the API key', retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'SerpApi rate limit / quota exceeded', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`SerpApi returned ${res.status}`));
        return;
      }

      let body: SerpapiResponse;
      try {
        body = (await res.json()) as SerpapiResponse;
      } catch (e) {
        yield err({ code: 'invalid_response', message: `SerpApi returned invalid JSON: ${String(e)}`, retryable: false });
        return;
      }

      if (body.error) {
        yield err({ code: 'auth_error', message: body.error, retryable: false });
        return;
      }

      for (const job of body.jobs_results ?? []) {
        const locationName = job.location?.trim() ?? '';
        yield ok<RawJob>({
          externalId: job.job_id,
          url: job.apply_options?.[0]?.link ?? job.share_link ?? '',
          title: job.title,
          company: job.company_name ?? 'Unknown',
          location: locationName ? { raw: locationName } : null,
          remote: /remote/i.test(locationName) || /remote/i.test(job.description ?? '') ? 'remote' : 'unknown',
          salary: parseSalaryText(job.detected_extensions?.salary),
          descriptionMd: job.description?.trim() ?? '',
          postedAt: parseRelativePostedAt(job.detected_extensions?.posted_at),
        });
      }
    },

    async healthCheck(config) {
      const params = new URLSearchParams({ engine: 'google_jobs', q: config.query, api_key: config.apiKey });
      try {
        const res = await fetchImpl(`https://serpapi.com/search.json?${params.toString()}`);
        if (res.status === 401) return err({ code: 'auth_error', message: 'SerpApi rejected the API key', retryable: false });
        if (!res.ok) return err(upstreamError(`SerpApi healthcheck returned ${res.status}`));
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during SerpApi healthcheck: ${String(e)}`));
      }
    },
  };
}

/**
 * SerpApi's `detected_extensions.salary` is free text ("$150,000–$190,000 a
 * year", "$25 an hour"). Best-effort regex parse; returns null rather than
 * a wrong guess when the text doesn't match a recognized shape — a missing
 * salary is honest, a wrong one isn't.
 */
function parseSalaryText(text: string | undefined): RawJobSalary | null {
  if (!text) return null;
  const match = text.match(/\$([\d,]+)(?:\s*[–-]\s*\$?([\d,]+))?\s*a\s*(year|month|hour)/i);
  if (!match) return null;
  const min = Number(match[1]!.replace(/,/g, ''));
  const max = match[2] ? Number(match[2].replace(/,/g, '')) : undefined;
  const periodRaw = match[3]!.toLowerCase();
  const period = periodRaw === 'year' || periodRaw === 'month' || periodRaw === 'hour' ? periodRaw : undefined;
  if (Number.isNaN(min)) return null;
  const salary: { min?: number; max?: number; currency?: string; period?: 'year' | 'month' | 'hour' } = { min, currency: 'USD' };
  if (max !== undefined && !Number.isNaN(max)) salary.max = max;
  if (period !== undefined) salary.period = period;
  return salary;
}

/**
 * SerpApi never returns an absolute posted date — only a relative string
 * ("3 days ago", "1 day ago", "Just posted"). Best-effort conversion using
 * the fetch time as "now"; anything unrecognized returns null rather than
 * a fabricated date. Documented limitation, not silently wrong.
 */
function parseRelativePostedAt(text: string | undefined, now: Date = new Date()): Date | null {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  if (lower === 'just posted' || lower === 'today') return now;
  const match = lower.match(/^(\d+)\s*(hour|day|week|month)s?\s*ago$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!;
  const msPerUnit: Record<string, number> = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // 30-day approximation — this whole function is best-effort by nature
  };
  return new Date(now.getTime() - amount * msPerUnit[unit]!);
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
