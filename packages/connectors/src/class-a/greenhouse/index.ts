import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError } from '@careerpilot/application';
import { htmlToText } from '../../sdk/html-to-text.js';

/**
 * Greenhouse Job Board API (Class A — official, public, no auth required).
 * https://developers.greenhouse.io/job-board.html — `GET /v1/boards/{token}/jobs?content=true`.
 * Returns every open posting for a board in one response; there is no
 * cursor-based pagination on this public endpoint, so `fetchJobs` always
 * yields a single page regardless of the `cursor` argument.
 */
export const greenhouseConfigSchema = z.object({
  boardToken: z.string().min(1),
  /** Optional display name; falls back to boardToken when the board's own name isn't configured. */
  companyName: z.string().min(1).optional(),
});

export type GreenhouseConfig = z.infer<typeof greenhouseConfigSchema>;

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at?: string;
  location?: { name?: string };
  absolute_url: string;
  content?: string;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createGreenhouseConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<GreenhouseConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'greenhouse', displayName: 'Greenhouse Job Board', complianceClass: 'A' },
    configSchema: greenhouseConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(config.boardToken)}/jobs?content=true`;

      let res: Response;
      try {
        res = await fetchImpl(url);
      } catch (e) {
        yield err(upstreamError(`Network error calling Greenhouse: ${String(e)}`));
        return;
      }

      if (res.status === 401 || res.status === 403) {
        yield err({ code: 'auth_error', message: `Greenhouse rejected the request (${res.status})`, retryable: false });
        return;
      }
      if (res.status === 404) {
        yield err({ code: 'config_error', message: `Greenhouse board "${config.boardToken}" not found`, retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'Greenhouse rate limit hit', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`Greenhouse returned ${res.status}`));
        return;
      }

      let body: GreenhouseResponse;
      try {
        body = (await res.json()) as GreenhouseResponse;
      } catch (e) {
        yield err({ code: 'invalid_response', message: `Greenhouse returned invalid JSON: ${String(e)}`, retryable: false });
        return;
      }

      for (const job of body.jobs ?? []) {
        const locationName = job.location?.name?.trim() ?? '';
        yield ok<RawJob>({
          externalId: String(job.id),
          url: job.absolute_url,
          title: job.title,
          company: config.companyName ?? config.boardToken,
          location: locationName ? { raw: locationName } : null,
          remote: /remote/i.test(locationName) ? 'remote' : 'unknown',
          salary: null, // not present in the public Greenhouse job board feed
          descriptionMd: htmlToText(job.content ?? ''),
          // Greenhouse's public board API exposes `updated_at`, not an original
          // posting date — used as the best available approximation.
          postedAt: job.updated_at ? new Date(job.updated_at) : null,
        });
      }
    },

    async healthCheck(config) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(config.boardToken)}/jobs`;
      try {
        const res = await fetchImpl(url);
        if (res.status === 404) {
          return err({ code: 'config_error', message: `Greenhouse board "${config.boardToken}" not found`, retryable: false });
        }
        if (!res.ok) {
          return err(upstreamError(`Greenhouse healthcheck returned ${res.status}`));
        }
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during Greenhouse healthcheck: ${String(e)}`));
      }
    },
  };
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
