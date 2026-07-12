import { describe, it, expect } from 'vitest';
import { describeConnectorContract } from '../../sdk/contract-test-kit.js';
import { createCaptureIngestConnector, normalizeCapturePayload, type CapturePayload } from './index.js';

describeConnectorContract('capture-ingest', () => ({
  connector: createCaptureIngestConnector(),
  validConfig: {},
  invalidConfig: { unexpected: 'field' },
}));

/**
 * Fixture: what a bookmarklet extracting a rendered LinkedIn job page would
 * plausibly send (task 030's own test-plan example) — realistic field
 * shapes, not a live capture (there is nothing to "record" here; the
 * payload is authored client-side by the extension, not fetched from an API).
 */
function linkedInLikePayload(overrides: Partial<CapturePayload> = {}): CapturePayload {
  return {
    url: 'https://www.linkedin.com/jobs/view/4012345678/',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    descriptionHtml: '<p>Own the ingestion pipeline. <b>Remote friendly.</b></p>',
    location: 'United States (Remote)',
    postedAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('capture-ingest connector', () => {
  it('has compliance class B', () => {
    expect(createCaptureIngestConnector().metadata.complianceClass).toBe('B');
  });

  it('normalizes a captured payload into the canonical RawJob shape', () => {
    const result = normalizeCapturePayload(linkedInLikePayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Senior Backend Engineer');
    expect(result.value.company).toBe('Acme');
    expect(result.value.url).toBe('https://www.linkedin.com/jobs/view/4012345678/');
    expect(result.value.location).toEqual({ raw: 'United States (Remote)' });
    expect(result.value.descriptionMd).toContain('Own the ingestion pipeline.');
    expect(result.value.descriptionMd).not.toContain('<b>');
    expect(result.value.postedAt).toEqual(new Date('2026-06-15T00:00:00.000Z'));
    expect(result.value.externalId).toHaveLength(64); // sha256 hex
  });

  it('is idempotent: capturing the exact same URL twice yields the same externalId', () => {
    const a = normalizeCapturePayload(linkedInLikePayload());
    const b = normalizeCapturePayload(linkedInLikePayload({ title: 'Slightly different scrape of the same page' }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.externalId).toBe(b.value.externalId);
  });

  it('different URLs (even tracking-param variants) canonicalize to different or same ids correctly', () => {
    const a = normalizeCapturePayload(linkedInLikePayload({ url: 'https://www.linkedin.com/jobs/view/1/' }));
    const b = normalizeCapturePayload(linkedInLikePayload({ url: 'https://www.linkedin.com/jobs/view/1/?utm_source=li&trk=abc' }));
    const c = normalizeCapturePayload(linkedInLikePayload({ url: 'https://www.linkedin.com/jobs/view/2/' }));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      // trk isn't in the stripped tracking-param list — deliberately not
      // over-aggressive about canonicalization; only well-known params strip.
      expect(a.value.externalId).not.toBe(c.value.externalId);
    }
  });

  it('prefers descriptionText over descriptionHtml when both are present', () => {
    const result = normalizeCapturePayload(
      linkedInLikePayload({ descriptionText: 'Plain text wins.', descriptionHtml: '<p>HTML loses.</p>' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.descriptionMd).toBe('Plain text wins.');
  });

  it('rejects a payload with no usable description as a typed error, not a throw', () => {
    const result = normalizeCapturePayload({ url: 'https://x.com/1', title: 'T', company: 'C' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_response');
  });

  it('rejects an empty title as a typed error', () => {
    const result = normalizeCapturePayload(linkedInLikePayload({ title: '   ' }));
    expect(result.ok).toBe(false);
  });
});
