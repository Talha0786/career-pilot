import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleConnectorConfigRepository } from '../../src/db/repositories/connector-config.repository.js';
import { DrizzleIngestionRunRepository } from '../../src/db/repositories/ingestion-run.repository.js';
import { User, Email, PasswordHash, JobPosting, uuidv7, isOk } from '@careerpilot/domain';
import { sql } from 'drizzle-orm';

const email = (s: string) => {
  const r = Email.create(s);
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};
const hash = () => {
  const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y');
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};

/**
 * Task 027 integration tests: migrate-from-scratch is exercised by every
 * `withTestDb` call in this suite (the migration already ran once via
 * `pnpm db:migrate` in CI/the verification container — these tests prove
 * the resulting schema/repositories actually work, not just that the SQL
 * applied without error).
 */
describe('Task 027: connector_configs, ingestion_runs, job_postings extensions (REAL Postgres)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('connector_configs: round-trips CRUD and enforces (user_id, connector_key) uniqueness', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const configs = new DrizzleConnectorConfigRepository(db);
      const user = User.register({ email: email('conn@x.com'), passwordHash: hash() });
      await users.save(user);

      const now = new Date();
      const config = {
        id: uuidv7(),
        userId: user.id,
        connectorKey: 'greenhouse',
        displayName: 'Greenhouse — Acme board',
        enabled: true,
        scheduleCron: '0 * * * *',
        config: { boardToken: 'acme' },
        // NEVER the raw key — a reference into the secrets store only.
        credentialsRef: 'env:GREENHOUSE_ACME_TOKEN',
        health: 'healthy' as const,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await configs.save(config);

      const found = await configs.findById(config.id);
      expect(found).not.toBeNull();
      expect(found!.connectorKey).toBe('greenhouse');
      expect(found!.credentialsRef).toBe('env:GREENHOUSE_ACME_TOKEN');
      expect(found!.config).toEqual({ boardToken: 'acme' });

      const forUser = await configs.findByIdForUser(config.id, user.id);
      expect(forUser).not.toBeNull();

      const enabledList = await configs.listEnabled();
      expect(enabledList.some((c) => c.id === config.id)).toBe(true);

      // Duplicate (user_id, connector_key) must be rejected at the DB level.
      const dup = { ...config, id: uuidv7() };
      await expect(configs.save(dup)).rejects.toThrow();
    });
  });

  it('connector_configs.credentials_ref never stores the raw value — column is a reference string, not a secret vault', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const configs = new DrizzleConnectorConfigRepository(db);
      const user = User.register({ email: email('creds@x.com'), passwordHash: hash() });
      await users.save(user);

      const now = new Date();
      await configs.save({
        id: uuidv7(),
        userId: user.id,
        connectorKey: 'serpapi-google-jobs',
        displayName: 'SerpApi',
        enabled: true,
        scheduleCron: null,
        config: {},
        credentialsRef: 'secretsmanager:serpapi-key',
        health: 'healthy',
        consecutiveFailures: 0,
        lastSuccessAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const rows = await db.execute(sql`SELECT credentials_ref FROM connector_configs`);
      const ref = (rows as unknown as { credentials_ref: string }[])[0]!.credentials_ref;
      // It's a pointer, not a key — a real SerpApi key looks nothing like this.
      expect(ref).toBe('secretsmanager:serpapi-key');
      expect(ref.startsWith('sk-') || ref.length > 200).toBe(false);
    });
  });

  it('ingestion_runs: append-only start()/complete() lifecycle, listed newest-first', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const configs = new DrizzleConnectorConfigRepository(db);
      const runs = new DrizzleIngestionRunRepository(db);
      const user = User.register({ email: email('runs@x.com'), passwordHash: hash() });
      await users.save(user);

      const now = new Date();
      const configId = uuidv7();
      await configs.save({
        id: configId,
        userId: user.id,
        connectorKey: 'rss',
        displayName: 'RSS feed',
        enabled: true,
        scheduleCron: '*/15 * * * *',
        config: { feedUrl: 'https://example.com/jobs.rss' },
        credentialsRef: null,
        health: 'healthy',
        consecutiveFailures: 0,
        lastSuccessAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const run1 = await runs.start(configId, new Date(now.getTime()));
      expect(run1.status).toBe('running');
      await runs.complete(run1.id, {
        status: 'ok',
        stats: { fetched: 10, deduped: 2, inserted: 8 },
        finishedAt: new Date(now.getTime() + 1000),
      });

      const run2 = await runs.start(configId, new Date(now.getTime() + 2000));
      await runs.complete(run2.id, {
        status: 'failed',
        stats: { fetched: 0, deduped: 0, inserted: 0 },
        error: 'upstream 500',
        finishedAt: new Date(now.getTime() + 2500),
      });

      const recent = await runs.listRecentForConnector(configId, 10);
      expect(recent).toHaveLength(2);
      expect(recent[0]!.status).toBe('failed'); // newest first
      expect(recent[0]!.error).toBe('upstream 500');
      expect(recent[1]!.status).toBe('ok');
      expect(recent[1]!.stats).toEqual({ fetched: 10, deduped: 2, inserted: 8 });

      // Append-only: two runs exist as two distinct rows, not one row overwritten twice.
      const rowCount = await db.execute(sql`SELECT count(*)::int AS n FROM ingestion_runs WHERE connector_config_id = ${configId}`);
      expect((rowCount as unknown as { n: number }[])[0]!.n).toBe(2);
    });
  });

  it('job_postings: unique (source_connector_key, external_id) rejects a duplicate pair', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const user = User.register({ email: email('dedup@x.com'), passwordHash: hash() });
      await users.save(user);

      const first = JobPosting.ingest({
        userId: user.id,
        sourceConnectorKey: 'greenhouse',
        externalId: 'gh-999',
        title: 'Engineer A',
        descriptionMd: 'D',
        company: 'Acme',
      });
      if (!isOk(first)) throw new Error('setup failed');
      await jobs.save(first.value);

      const second = JobPosting.ingest({
        userId: user.id,
        sourceConnectorKey: 'greenhouse',
        externalId: 'gh-999', // same source + external id
        title: 'Engineer A (dup)',
        descriptionMd: 'D2',
        company: 'Acme',
      });
      if (!isOk(second)) throw new Error('setup failed');

      // save() does an ON CONFLICT DO UPDATE keyed on the PRIMARY KEY (id),
      // not the (source_connector_key, external_id) unique index — the two
      // domain instances have different generated ids, so this exercises
      // the unique index directly via the ingestion path's lookup-then-insert
      // pattern (task 029) rather than relying on save()'s own conflict target.
      await expect(jobs.save(second.value)).rejects.toThrow();
    });
  });

  it('job_postings: multiple manual (external_id IS NULL) rows coexist without unique-index collision', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const user = User.register({ email: email('manual@x.com'), passwordHash: hash() });
      await users.save(user);

      const a = JobPosting.createManual({ userId: user.id, title: 'A', descriptionMd: 'D' });
      const b = JobPosting.createManual({ userId: user.id, title: 'B', descriptionMd: 'D' });
      if (!isOk(a) || !isOk(b)) throw new Error('setup failed');

      await jobs.save(a.value); // both externalId === null, sourceConnectorKey === 'manual'
      await jobs.save(b.value); // must NOT collide — this is the backfill-strategy proof

      const rows = await db.execute(sql`SELECT count(*)::int AS n FROM job_postings WHERE source_connector_key = 'manual'`);
      expect((rows as unknown as { n: number }[])[0]!.n).toBe(2);
    });
  });

  it('job_postings: findBySourceAndExternalId locates an ingested posting', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const user = User.register({ email: email('lookup@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = JobPosting.ingest({
        userId: user.id,
        sourceConnectorKey: 'lever',
        externalId: 'lv-42',
        title: 'Platform Engineer',
        descriptionMd: 'D',
        company: 'Acme',
        location: { raw: 'NYC' },
        remote: 'hybrid',
        salary: { min: 100_000, max: 140_000, currency: 'USD', period: 'year' },
        postedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      if (!isOk(created)) throw new Error('setup failed');
      await jobs.save(created.value);

      const found = await jobs.findBySourceAndExternalId('lever', 'lv-42');
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Platform Engineer');
      expect(found!.location).toEqual({ raw: 'NYC' });
      expect(found!.remote).toBe('hybrid');
      expect(found!.salary).toEqual({ min: 100_000, max: 140_000, currency: 'USD', period: 'year' });
      expect(found!.postedAt).toEqual(new Date('2026-06-01T00:00:00.000Z'));

      const missing = await jobs.findBySourceAndExternalId('lever', 'does-not-exist');
      expect(missing).toBeNull();
    });
  });
});
