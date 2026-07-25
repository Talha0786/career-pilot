import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleApplicationRepository } from '../../src/db/repositories/application.repository.js';
import { DrizzleDocumentRepository } from '../../src/db/repositories/document.repository.js';
import { applyTasks, applyTaskSteps } from '../../src/db/schema/index.js';
import { User, Email, PasswordHash, JobPosting, Application, Document, isOk } from '@careerpilot/domain';
import { uuidv7 } from '@careerpilot/domain';
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
 * Task 044 — schema-level smoke test. This deliberately writes/reads the
 * `apply_tasks`/`apply_task_steps` tables directly via Drizzle (not through
 * a repository — the repository is task 045's job) to prove: the migration
 * applies cleanly, FK constraints hold (orphan application_id rejected),
 * and both tables round-trip insert/select. Task 045's aggregate/repository
 * tests build on this with real domain-object round-trips.
 */
describe('apply_tasks / apply_task_steps schema (task 044) — REAL Postgres 16', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  async function seedFixture(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const users = new DrizzleUserRepository(db);
    const jobs = new DrizzleJobPostingRepository(db);
    const apps = new DrizzleApplicationRepository(db);
    const docs = new DrizzleDocumentRepository(db);

    const user = User.register({ email: email(`u-${uuidv7()}@test.com`), passwordHash: hash() });
    await users.save(user);

    const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup failed');
    await jobs.save(jobR.value);

    const application = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
    await apps.save(application);

    const docR = Document.create({ userId: user.id, kind: 'resume', title: 'Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    const document = docR.value;
    const versionR = document.addVersion({
      source: 'imported',
      content: {
        schemaVersion: 1,
        kind: 'resume',
        contact: { name: 'A B', email: 'a@b.com' },
        summary: null,
        sections: [],
      },
    });
    if (!isOk(versionR)) throw new Error('setup failed');
    await docs.save(document);

    return { user, job: jobR.value, application, documentVersionId: versionR.value.id };
  }

  it('applies cleanly and round-trips insert/select for apply_tasks', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const applyTaskId = uuidv7();

      await db.insert(applyTasks).values({
        id: applyTaskId,
        userId: user.id,
        applicationId: application.id,
        jobPostingId: job.id,
        documentVersionId,
        stage: 'draft',
      });

      const rows = await db.select().from(applyTasks).where(sql`id = ${applyTaskId}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stage).toBe('draft');
      expect(rows[0]!.userId).toBe(user.id);
      expect(rows[0]!.atsAdapter).toBeNull();
    });
  });

  it('round-trips insert/select for apply_task_steps, ordered by created_at', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const applyTaskId = uuidv7();
      await db.insert(applyTasks).values({
        id: applyTaskId, userId: user.id, applicationId: application.id,
        jobPostingId: job.id, documentVersionId, stage: 'draft',
      });

      await db.insert(applyTaskSteps).values([
        {
          id: uuidv7(), applyTaskId, fromStage: null, toStage: 'draft',
          action: null, redactedPayload: null, screenshotKey: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: uuidv7(), applyTaskId, fromStage: 'draft', toStage: 'mapping',
          action: 'detect-ats', redactedPayload: { atsAdapter: 'greenhouse' }, screenshotKey: null,
          createdAt: new Date('2026-01-01T00:00:05Z'),
        },
      ]);

      const rows = await db
        .select()
        .from(applyTaskSteps)
        .where(sql`apply_task_id = ${applyTaskId}`)
        .orderBy(applyTaskSteps.createdAt);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.toStage).toBe('draft');
      expect(rows[1]!.toStage).toBe('mapping');
      expect(rows[1]!.redactedPayload).toEqual({ atsAdapter: 'greenhouse' });
    });
  });

  it('rejects an apply_task with an orphan application_id (FK constraint holds)', async () => {
    await withTestDb(async (db) => {
      const { user, job, documentVersionId } = await seedFixture(db);
      const bogusApplicationId = uuidv7();

      await expect(
        db.insert(applyTasks).values({
          id: uuidv7(),
          userId: user.id,
          applicationId: bogusApplicationId,
          jobPostingId: job.id,
          documentVersionId,
          stage: 'draft',
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects an apply_task with an orphan document_version_id (FK constraint holds)', async () => {
    await withTestDb(async (db) => {
      const { user, job, application } = await seedFixture(db);
      const bogusVersionId = uuidv7();

      await expect(
        db.insert(applyTasks).values({
          id: uuidv7(),
          userId: user.id,
          applicationId: application.id,
          jobPostingId: job.id,
          documentVersionId: bogusVersionId,
          stage: 'draft',
        }),
      ).rejects.toThrow();
    });
  });

  it('cascade-deletes apply_tasks (and their steps) when the parent application is deleted', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const applyTaskId = uuidv7();
      await db.insert(applyTasks).values({
        id: applyTaskId, userId: user.id, applicationId: application.id,
        jobPostingId: job.id, documentVersionId, stage: 'draft',
      });
      await db.insert(applyTaskSteps).values({
        id: uuidv7(), applyTaskId, fromStage: null, toStage: 'draft',
      });

      await db.execute(sql`DELETE FROM applications WHERE id = ${application.id}`);

      const taskRows = await db.select().from(applyTasks).where(sql`id = ${applyTaskId}`);
      const stepRows = await db.select().from(applyTaskSteps).where(sql`apply_task_id = ${applyTaskId}`);
      expect(taskRows).toHaveLength(0);
      expect(stepRows).toHaveLength(0);
    });
  });
});
