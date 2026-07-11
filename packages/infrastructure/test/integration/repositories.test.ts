import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleApplicationRepository } from '../../src/db/repositories/application.repository.js';
import { DrizzleUnitOfWork } from '../../src/db/repositories/outbox.repository.js';
import { schema } from '../../src/db/client.js';
import { User, Email, PasswordHash, JobPosting, Application, asUserId, isOk } from '@careerpilot/domain';
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

describe('Repositories against REAL Postgres 16 + pgvector', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('User: round-trips through save/findByEmail with fidelity', async () => {
    await withTestDb(async (db) => {
      const repo = new DrizzleUserRepository(db);
      const user = User.register({ email: email('a@b.com'), passwordHash: hash() });
      await repo.save(user);

      const found = await repo.findByEmail('A@B.COM'); // case-insensitive per schema
      expect(found).not.toBeNull();
      expect(found!.toSnapshot()).toEqual(user.toSnapshot());
    });
  });

  it('User: enforces case-insensitive email uniqueness at the DB level', async () => {
    await withTestDb(async (db) => {
      const repo = new DrizzleUserRepository(db);
      await repo.save(User.register({ email: email('dup@b.com'), passwordHash: hash() }));

      // Different id, colliding email (different case) — the unique index must reject this.
      const second = User.register({ email: email('DUP@b.com'), passwordHash: hash() });
      await expect(repo.save(second)).rejects.toThrow();
    });
  });

  it('JobPosting: round-trips including a real pgvector embedding', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const user = User.register({ email: email('c@d.com'), passwordHash: hash() });
      await users.save(user);

      const created = JobPosting.createManual({
        userId: user.id,
        title: 'Backend Engineer',
        descriptionMd: 'Postgres and TypeScript.',
        url: 'https://jobs.example.com/1',
      });
      if (!isOk(created)) throw new Error('setup failed');
      const job = created.value;
      job.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'nomic-embed-text');
      await jobs.save(job);

      const found = await jobs.findByIdForUser(job.id, user.id);
      expect(found).not.toBeNull();
      expect(found!.embeddingStatus).toBe('ready');
      expect(found!.embedding).toHaveLength(768);
      expect(found!.embedding![0]).toBeCloseTo(0, 5);
      expect(found!.urlHash).toBe(job.urlHash);
    });
  });

  it('JobPosting: ownership scoping — a different user gets null, not the row', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const owner = User.register({ email: email('owner@x.com'), passwordHash: hash() });
      const intruder = User.register({ email: email('intruder@x.com'), passwordHash: hash() });
      await users.save(owner);
      await users.save(intruder);

      const created = JobPosting.createManual({ userId: owner.id, title: 'T', descriptionMd: 'D' });
      if (!isOk(created)) throw new Error('setup failed');
      await jobs.save(created.value);

      const asIntruder = await jobs.findByIdForUser(created.value.id, intruder.id);
      expect(asIntruder).toBeNull(); // no leakage, not even a "forbidden" — same as not-found
    });
  });

  it('Application: stage_transitions is append-only — history survives multiple saves', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const apps = new DrizzleApplicationRepository(db);

      const user = User.register({ email: email('e@f.com'), passwordHash: hash() });
      await users.save(user);
      const jobResult = JobPosting.createManual({ userId: user.id, title: 'T', descriptionMd: 'D' });
      if (!isOk(jobResult)) throw new Error('setup failed');
      await jobs.save(jobResult.value);

      const app = Application.create({ userId: user.id, jobPostingId: jobResult.value.id });
      await apps.save(app); // writes the opening transition

      app.transitionTo({ toStage: 'applied', actor: 'user' });
      await apps.save(app); // writes a second transition

      const rows = await db.execute(
        sql`SELECT from_stage, to_stage FROM stage_transitions WHERE application_id = ${app.id} ORDER BY created_at`,
      );
      expect(rows).toHaveLength(2);
      expect((rows as unknown as { to_stage: string }[])[0]!.to_stage).toBe('discovered');
      expect((rows as unknown as { to_stage: string }[])[1]!.to_stage).toBe('applied');
    });
  });

  it('UnitOfWork: THE atomicity test — a forced error rolls back BOTH the aggregate and the outbox row', async () => {
    await withTestDb(async (db) => {
      const uow = new DrizzleUnitOfWork(db);
      const users = new DrizzleUserRepository(db);
      const user = User.register({ email: email('atomic@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = JobPosting.createManual({ userId: user.id, title: 'T', descriptionMd: 'D' });
      if (!isOk(created)) throw new Error('setup failed');
      const job = created.value;
      const events = job.pullEvents();

      await expect(
        uow.withTransaction(async (ctx) => {
          await ctx.jobPostings.save(job);
          await ctx.outbox.enqueue(events);
          throw new Error('simulated failure after both writes');
        }),
      ).rejects.toThrow('simulated failure');

      // The assertion that matters: NEITHER write persisted. This is what
      // turns "dual write" into "one atomic write" (ADR-007).
      const jobRows = await db.execute(sql`SELECT id FROM job_postings WHERE id = ${job.id}`);
      const outboxRows = await db.execute(sql`SELECT id FROM outbox WHERE aggregate_id = ${job.id}`);
      expect(jobRows).toHaveLength(0);
      expect(outboxRows).toHaveLength(0);
    });
  });

  it('UnitOfWork: a successful transaction commits BOTH the aggregate and the outbox row together', async () => {
    await withTestDb(async (db) => {
      const uow = new DrizzleUnitOfWork(db);
      const users = new DrizzleUserRepository(db);
      const user = User.register({ email: email('commit@x.com'), passwordHash: hash() });
      await users.save(user);

      const created = JobPosting.createManual({ userId: user.id, title: 'T', descriptionMd: 'D' });
      if (!isOk(created)) throw new Error('setup failed');
      const job = created.value;
      const events = job.pullEvents();

      await uow.withTransaction(async (ctx) => {
        await ctx.jobPostings.save(job);
        await ctx.outbox.enqueue(events);
      });

      const jobRows = await db.execute(sql`SELECT id FROM job_postings WHERE id = ${job.id}`);
      const outboxRows = await db.execute(sql`SELECT id, event_type FROM outbox WHERE aggregate_id = ${job.id}`);
      expect(jobRows).toHaveLength(1);
      expect(outboxRows).toHaveLength(1);
      expect((outboxRows as unknown as { event_type: string }[])[0]!.event_type).toBe('discovery.job_posted');
    });
  });
});
