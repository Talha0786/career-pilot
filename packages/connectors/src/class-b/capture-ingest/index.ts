import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ok, err, type Result } from '@careerpilot/domain';
import type { ConnectorPort, RawJob, ConnectorError } from '@careerpilot/application';
import { htmlToText } from '../../sdk/html-to-text.js';

/**
 * Class B — user-session capture (ADR-004, the LinkedIn/Indeed on-ramp).
 * The user is already logged into their own account viewing a job they're
 * authorized to see; a bookmarklet/extension (out of scope here — task 030
 * is the ingest endpoint it posts to, `apps/api/src/routes/capture.ts`)
 * reads the ALREADY-RENDERED page and posts it. No stored credentials, no
 * server-side fetch of the source, no automated login, no scroll loop.
 *
 * Unlike Class A connectors, this "connector" is never polled by the
 * scheduler (task 029) — data arrives pushed, one item at a time, from the
 * API route. `fetchJobs` is therefore a no-op generator, same posture as
 * the manual connector (task 028) and for the same reason: nothing to pull.
 * The real work is `normalizeCapturePayload`, called directly by the API
 * route to turn one posted payload into one `RawJob` before it goes through
 * the same `ingestJobBatch` pipeline (task 029) every other connector uses.
 */
export const captureIngestConfigSchema = z.object({}).strict();
export type CaptureIngestConfig = z.infer<typeof captureIngestConfigSchema>;

export interface CapturePayload {
  readonly url: string;
  readonly title: string;
  readonly company: string;
  readonly descriptionHtml?: string | undefined;
  readonly descriptionText?: string | undefined;
  readonly location?: string | undefined;
  readonly postedAt?: string | undefined;
}

export function createCaptureIngestConnector(): ConnectorPort<CaptureIngestConfig> {
  return {
    metadata: { key: 'capture', displayName: 'Capture (bookmarklet / extension)', complianceClass: 'B' },
    configSchema: captureIngestConfigSchema,

    async *fetchJobs(): AsyncIterable<Result<RawJob, ConnectorError>> {},

    async healthCheck() {
      return ok({ ok: true as const });
    },
  };
}

/**
 * Normalizes one posted capture payload into the canonical `RawJob` shape
 * (task 026). `externalId` has no natural source-provided id (unlike an
 * ATS's own job id) — the SHA-256 of the canonical URL is used instead, so
 * re-capturing the exact same URL twice is idempotent at the
 * `(source_connector_key, external_id)` unique-index level (task 027),
 * exactly like every other connector's idempotent re-fetch guarantee.
 */
export function normalizeCapturePayload(payload: CapturePayload): Result<RawJob, ConnectorError> {
  const title = payload.title.trim();
  const company = payload.company.trim();
  const url = payload.url.trim();

  if (title.length === 0 || company.length === 0 || url.length === 0) {
    return err({ code: 'invalid_response', message: 'Capture payload missing required title/company/url', retryable: false });
  }

  const descriptionMd = (payload.descriptionText?.trim() || htmlToText(payload.descriptionHtml ?? '')).trim();
  if (descriptionMd.length === 0) {
    return err({ code: 'invalid_response', message: 'Capture payload has no usable description', retryable: false });
  }

  let postedAt: Date | null = null;
  if (payload.postedAt) {
    const parsed = new Date(payload.postedAt);
    if (!Number.isNaN(parsed.getTime())) postedAt = parsed;
  }

  const externalId = createHash('sha256').update(canonicalizeUrl(url)).digest('hex');

  const rawJob: RawJob = {
    externalId,
    url,
    title,
    company,
    location: payload.location ? { raw: payload.location } : null,
    remote: 'unknown',
    salary: null,
    descriptionMd,
    postedAt,
  };
  return ok(rawJob);
}

function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref', 'refId', 'trackingId'];
    for (const p of TRACKING) u.searchParams.delete(p);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return raw;
  }
}
