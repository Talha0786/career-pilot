import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError, RemoteType } from '@careerpilot/application';
import { htmlToText } from '../../sdk/html-to-text.js';

/**
 * Lever Postings API (Class A — official, public, no auth required).
 * https://github.com/lever/postings-api — `GET /v0/postings/{company}?mode=json`.
 * Returns every open posting in one response; no cursor pagination exists on
 * this endpoint, so `fetchJobs` always yields a single page.
 */
export const leverConfigSchema = z.object({
  company: z.string().min(1),
  companyName: z.string().min(1).optional(),
});

export type LeverConfig = z.infer<typeof leverConfigSchema>;

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string };
  description?: string;
  descriptionPlain?: string;
  createdAt?: number;
  workplaceType?: string;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createLeverConnector(deps: { fetchImpl?: FetchFn } = {}): ConnectorPort<LeverConfig> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    metadata: { key: 'lever', displayName: 'Lever Postings', complianceClass: 'A' },
    configSchema: leverConfigSchema,

    async *fetchJobs(config): AsyncIterable<Result<RawJob, ConnectorError>> {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(config.company)}?mode=json`;

      let res: Response;
      try {
        res = await fetchImpl(url);
      } catch (e) {
        yield err(upstreamError(`Network error calling Lever: ${String(e)}`));
        return;
      }

      if (res.status === 401 || res.status === 403) {
        yield err({ code: 'auth_error', message: `Lever rejected the request (${res.status})`, retryable: false });
        return;
      }
      if (res.status === 404) {
        yield err({ code: 'config_error', message: `Lever company "${config.company}" not found`, retryable: false });
        return;
      }
      if (res.status === 429) {
        yield err({ code: 'rate_limited', message: 'Lever rate limit hit', retryable: true });
        return;
      }
      if (!res.ok) {
        yield err(upstreamError(`Lever returned ${res.status}`));
        return;
      }

      let postings: LeverPosting[];
      try {
        postings = (await res.json()) as LeverPosting[];
      } catch (e) {
        yield err({ code: 'invalid_response', message: `Lever returned invalid JSON: ${String(e)}`, retryable: false });
        return;
      }

      for (const p of postings) {
        const locationName = p.categories?.location?.trim() ?? '';
        yield ok<RawJob>({
          externalId: p.id,
          url: p.hostedUrl,
          title: p.text,
          company: config.companyName ?? config.company,
          location: locationName ? { raw: locationName } : null,
          remote: mapWorkplaceType(p.workplaceType),
          salary: null, // Lever's public postings feed doesn't expose compensation by default
          descriptionMd: p.descriptionPlain?.trim() || htmlToText(p.description ?? ''),
          postedAt: p.createdAt ? new Date(p.createdAt) : null,
        });
      }
    },

    async healthCheck(config) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(config.company)}?mode=json`;
      try {
        const res = await fetchImpl(url);
        if (res.status === 404) {
          return err({ code: 'config_error', message: `Lever company "${config.company}" not found`, retryable: false });
        }
        if (!res.ok) return err(upstreamError(`Lever healthcheck returned ${res.status}`));
        return ok({ ok: true as const });
      } catch (e) {
        return err(upstreamError(`Network error during Lever healthcheck: ${String(e)}`));
      }
    },
  };
}

function mapWorkplaceType(t: string | undefined): RemoteType {
  if (t === 'remote') return 'remote';
  if (t === 'hybrid') return 'hybrid';
  if (t === 'on-site' || t === 'onsite') return 'onsite';
  return 'unknown';
}

function upstreamError(message: string): ConnectorError {
  return { code: 'upstream_error', message, retryable: true };
}
