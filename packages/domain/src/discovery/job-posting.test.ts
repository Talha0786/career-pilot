import { describe, it, expect } from 'vitest';
import { JobPosting } from './job-posting.js';
import { Email, JobUrl, PasswordHash } from './value-objects.js';
import { asUserId } from '../shared/ids.js';
import { isOk, isErr } from '../shared/result.js';

const USER = asUserId('018f0000-0000-7000-8000-000000000001');
const OTHER = asUserId('018f0000-0000-7000-8000-000000000002');

const validJob = () => ({
  userId: USER,
  title: 'Senior TypeScript Engineer',
  descriptionMd: 'We are hiring a backend engineer with Postgres experience.',
});

describe('Email', () => {
  it('normalizes case and whitespace', () => {
    const r = Email.create('  Test.User@Example.COM ');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.value).toBe('test.user@example.com');
  });

  it.each([
    ['', 'required'],
    ['not-an-email', 'format'],
    ['missing@domain', 'format'],
    ['@nolocal.com', 'format'],
    ['spaces in@email.com', 'format'],
  ])('rejects %j', (input) => {
    expect(isErr(Email.create(input))).toBe(true);
  });

  it('rejects an over-length address', () => {
    expect(isErr(Email.create(`${'a'.repeat(250)}@example.com`))).toBe(true);
  });
});

describe('JobUrl', () => {
  it('accepts http and https', () => {
    expect(isOk(JobUrl.create('https://jobs.example.com/1'))).toBe(true);
    expect(isOk(JobUrl.create('http://jobs.example.com/1'))).toBe(true);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url'])(
    'rejects dangerous or malformed scheme: %s',
    (input) => {
      // Security model §1: blocks XSS/SSRF vectors at the domain boundary.
      expect(isErr(JobUrl.create(input))).toBe(true);
    },
  );

  it('canonicalizes by stripping fragments and tracking params', () => {
    const a = JobUrl.create('https://x.com/job?id=1&utm_source=li&gclid=z#apply');
    const b = JobUrl.create('https://x.com/job?id=1');
    expect(isOk(a) && isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.value.canonical()).toBe(b.value.canonical());
    }
  });
});

describe('PasswordHash', () => {
  it('accepts an argon2 hash and refuses to leak it', () => {
    const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$abc$def');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.toString()).toBe('[redacted]');
      expect(JSON.stringify({ h: r.value })).toBe('{"h":"[redacted]"}');
    }
  });

  it('rejects a non-argon2 value (e.g. a raw password)', () => {
    expect(isErr(PasswordHash.fromHashed('hunter2'))).toBe(true);
  });
});

describe('JobPosting.createManual', () => {
  it('creates a pending posting and emits JobPosted', () => {
    const r = JobPosting.createManual(validJob());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    const job = r.value;
    expect(job.embeddingStatus).toBe('pending');
    expect(job.sourceConnectorKey).toBe('manual');
    expect(job.embedding).toBeNull();

    const events = job.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('discovery.job_posted');
    expect(events[0]!.aggregateId).toBe(job.id);
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['blank description', { descriptionMd: '' }],
    ['over-long title', { title: 'x'.repeat(301) }],
    ['over-long description', { descriptionMd: 'x'.repeat(100_001) }],
    ['invalid url', { url: 'javascript:alert(1)' }],
  ])('rejects %s', (_label, override) => {
    expect(isErr(JobPosting.createManual({ ...validJob(), ...override }))).toBe(true);
  });

  it('derives a urlHash only when a url is present', () => {
    const without = JobPosting.createManual(validJob());
    const withUrl = JobPosting.createManual({
      ...validJob(),
      url: 'https://jobs.example.com/42',
    });
    if (!isOk(without) || !isOk(withUrl)) throw new Error('setup failed');

    expect(without.value.urlHash).toBeNull();
    expect(withUrl.value.urlHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('JobPosting.attachEmbedding — idempotency (ADR-007)', () => {
  it('attaches a vector and flips status to ready', () => {
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');
    const job = r.value;

    const attached = job.attachEmbedding([0.1, 0.2, 0.3], 'nomic-embed-text');
    expect(isOk(attached)).toBe(true);
    expect(job.embeddingStatus).toBe('ready');
    expect(job.embeddingModel).toBe('nomic-embed-text');
    expect(job.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('is a no-op when replayed with the same model', () => {
    // Queue delivery is at-least-once (ADR-007), so this WILL happen in prod.
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');
    const job = r.value;

    job.attachEmbedding([0.1, 0.2], 'model-a');
    const replay = job.attachEmbedding([0.9, 0.9], 'model-a');

    expect(isOk(replay)).toBe(true); // not an error — a safe no-op
    expect(job.embedding).toEqual([0.1, 0.2]); // original preserved
  });

  it('overwrites when the model differs (legitimate re-embed)', () => {
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');
    const job = r.value;

    job.attachEmbedding([0.1], 'model-a');
    job.attachEmbedding([0.5, 0.6], 'model-b');

    expect(job.embeddingModel).toBe('model-b');
    expect(job.embedding).toEqual([0.5, 0.6]);
  });

  it('rejects an empty vector', () => {
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');
    expect(isErr(r.value.attachEmbedding([], 'm'))).toBe(true);
  });

  it('records a failed embedding without throwing', () => {
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');
    r.value.markEmbeddingFailed();
    expect(r.value.embeddingStatus).toBe('failed');
  });
});

describe('JobPosting.assertOwnedBy', () => {
  it('permits the owner and forbids everyone else', () => {
    const r = JobPosting.createManual(validJob());
    if (!isOk(r)) throw new Error('setup failed');

    expect(isOk(r.value.assertOwnedBy(USER))).toBe(true);

    const denied = r.value.assertOwnedBy(OTHER);
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe('forbidden');
  });
});

describe('JobPosting snapshot round-trip', () => {
  it('survives toSnapshot → fromSnapshot without loss', () => {
    const r = JobPosting.createManual({
      ...validJob(),
      company: 'Acme',
      url: 'https://jobs.example.com/7',
    });
    if (!isOk(r)) throw new Error('setup failed');
    const original = r.value;
    original.attachEmbedding([0.1, 0.2], 'm');

    const restored = JobPosting.fromSnapshot(original.toSnapshot());

    expect(restored.toSnapshot()).toEqual(original.toSnapshot());
    expect(restored.pullEvents()).toHaveLength(0); // rehydration emits nothing
  });
});

describe('JobPosting accessors', () => {
  it('exposes all fields through getters', () => {
    const r = JobPosting.createManual({
      ...validJob(),
      company: 'Acme',
      url: 'https://jobs.example.com/9',
    });
    if (!isOk(r)) throw new Error('setup failed');
    const job = r.value;

    expect(job.url).toBe('https://jobs.example.com/9');
    expect(job.company).toBe('Acme');
    expect(job.title).toBe('Senior TypeScript Engineer');
    expect(job.descriptionMd).toContain('Postgres');
    expect(job.embeddingStatus).toBe('pending');
    expect(job.embeddingModel).toBeNull();
    expect(job.embedding).toBeNull();
  });

  it('returns null company and url when omitted', () => {
    const r = JobPosting.createManual({ ...validJob(), company: '   ' });
    if (!isOk(r)) throw new Error('setup failed');
    expect(r.value.company).toBeNull();
    expect(r.value.url).toBeNull();
  });
});

describe('Email/JobUrl equality and stringification', () => {
  it('compares emails by value', () => {
    const a = Email.create('a@b.com');
    const b = Email.create('A@B.COM');
    if (!isOk(a) || !isOk(b)) throw new Error('setup failed');
    expect(a.value.equals(b.value)).toBe(true);
    expect(String(a.value)).toBe('a@b.com');
  });

  it('stringifies a JobUrl', () => {
    const u = JobUrl.create('https://x.com/j');
    if (!isOk(u)) throw new Error('setup failed');
    expect(String(u.value)).toBe('https://x.com/j');
  });
});
