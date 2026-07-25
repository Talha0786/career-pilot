import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleApplicationRepository } from '../../src/db/repositories/application.repository.js';
import { DrizzleDocumentRepository } from '../../src/db/repositories/document.repository.js';
import { DrizzleApplyTaskRepository } from '../../src/db/repositories/drizzle-apply-task.repository.js';
import { applyTaskSteps } from '../../src/db/schema/index.js';
import { User, Email, PasswordHash, JobPosting, Application, Document, ApplyTask, isOk, uuidv7 } from '@careerpilot/domain';
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

describe('DrizzleApplyTaskRepository — REAL Postgres 16 (task 045)', () => {
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
        schemaVersion: 1, kind: 'resume',
        contact: { name: 'A B', email: 'a@b.com' }, summary: null, sections: [],
      },
    });
    if (!isOk(versionR)) throw new Error('setup failed');
    await docs.save(document);

    return { user, job: jobR.value, application, documentVersionId: versionR.value.id };
  }

  it('persists a newly-created ApplyTask (draft) and reloads it with the same stage', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const repo = new DrizzleApplyTaskRepository(db);

      const task = ApplyTask.create({
        userId: user.id, applicationId: application.id, jobPostingId: job.id, documentVersionId,
      });
      await repo.save(task);

      const reloaded = await repo.findByIdForUser(task.id, user.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.stage).toBe('draft');
      expect(reloaded!.applicationId).toBe(application.id);
    });
  });

  it('save persists a stage transition AND appends exactly one apply_task_steps row per transition', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const repo = new DrizzleApplyTaskRepository(db);

      const task = ApplyTask.create({
        userId: user.id, applicationId: application.id, jobPostingId: job.id, documentVersionId,
      });
      await repo.save(task); // persists the creation step

      task.transitionTo('mapping', 'detect-ats', { atsAdapter: 'greenhouse' });
      await repo.save(task);

      task.transitionTo('filling');
      await repo.save(task);

      const reloaded = await repo.findByIdForUser(task.id, user.id);
      expect(reloaded!.stage).toBe('filling');

      const steps = await db
        .select()
        .from(applyTaskSteps)
        .where(sql`apply_task_id = ${task.id}`)
        .orderBy(applyTaskSteps.createdAt);
      expect(steps).toHaveLength(3); // draft creation + mapping + filling
      expect(steps.map((s) => s.toStage)).toEqual(['draft', 'mapping', 'filling']);
      expect(steps[1]!.action).toBe('detect-ats');
      expect(steps[1]!.redactedPayload).toEqual({ atsAdapter: 'greenhouse' });
    });
  });

  it('pullSteps drains on the in-memory aggregate — calling save() twice without a new transition appends nothing extra', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const repo = new DrizzleApplyTaskRepository(db);

      const task = ApplyTask.create({
        userId: user.id, applicationId: application.id, jobPostingId: job.id, documentVersionId,
      });
      await repo.save(task);
      await repo.save(task); // no new transition since last save

      const steps = await db.select().from(applyTaskSteps).where(sql`apply_task_id = ${task.id}`);
      expect(steps).toHaveLength(1); // only the original creation step
    });
  });

  it('findByIdForUser is ownership-scoped — another user cannot read the task', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const repo = new DrizzleApplyTaskRepository(db);
      const task = ApplyTask.create({
        userId: user.id, applicationId: application.id, jobPostingId: job.id, documentVersionId,
      });
      await repo.save(task);

      const otherUser = User.register({ email: email(`other-${uuidv7()}@test.com`), passwordHash: hash() });
      const users = new DrizzleUserRepository(db);
      await users.save(otherUser);

      const found = await repo.findByIdForUser(task.id, otherUser.id);
      expect(found).toBeNull();

      const foundAnyOwner = await repo.findByIdAnyOwner(task.id);
      expect(foundAnyOwner).not.toBeNull();
    });
  });

  it('listForUser filters by stage and orders most-recently-updated first', async () => {
    await withTestDb(async (db) => {
      const { user, job, application, documentVersionId } = await seedFixture(db);
      const repo = new DrizzleApplyTaskRepository(db);

      const t1 = ApplyTask.create({ userId: user.id, applicationId: application.id, jobPostingId: job.id, documentVersionId });
      await repo.save(t1);
      t1.transitionTo('mapping');
      t1.transitionTo('filling');
      t1.transitionTo('awaiting_review');
      await repo.save(t1);

      // Second application/apply task also awaiting_review.
      const app2 = Application.create({ userId: user.id, jobPostingId: job.id });
      const apps = new DrizzleApplicationRepository(db);
      await apps.save(app2);
      const t2 = ApplyTask.create({ userId: user.id, applicationId: app2.id, jobPostingId: job.id, documentVersionId });
      await repo.save(t2);
      t2.transitionTo('mapping');
      t2.transitionTo('filling');
      t2.transitionTo('awaiting_review');
      await repo.save(t2);

      const reviewQueue = await repo.listForUser(user.id, { stage: 'awaiting_review' });
      expect(reviewQueue).toHaveLength(2);
      expect(reviewQueue.every((t) => t.stage === 'awaiting_review')).toBe(true);
    });
  });
});
