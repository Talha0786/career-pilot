import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleProfileRepository } from '../../src/db/repositories/profile.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleMatchScoreRepository } from '../../src/db/repositories/match-score.repository.js';
import { User, Email, PasswordHash, CareerProfile, JobPosting, MatchScore, isOk } from '@careerpilot/domain';
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
const components = (overall: number) => ({
  skills: 0.5, experience: 0.5, seniority: 0.5, domain: 0.5, location: 0.5, overall, rationale: 'r',
});

describe('DrizzleMatchScoreRepository — REAL Postgres 16 (task 038)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('persists a score and round-trips it through findByProfileAndJob', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const scores = new DrizzleMatchScoreRepository(db);

      const user = User.register({ email: email('ms1@test.com'), passwordHash: hash() });
      await users.save(user);

      const profileR = CareerProfile.create({ userId: user.id, title: 'P' });
      if (!isOk(profileR)) throw new Error('setup failed');
      await profiles.save(profileR.value);

      const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'd' });
      if (!isOk(jobR)) throw new Error('setup failed');
      await jobs.save(jobR.value);

      const score = MatchScore.create({
        profileId: profileR.value.id,
        jobPostingId: jobR.value.id,
        components: components(0.72),
        factsHash: profileR.value.factsHash,
        embeddingModel: 'test-model',
      });
      await scores.save(score);

      const found = await scores.findByProfileAndJob(profileR.value.id, jobR.value.id);
      expect(found).not.toBeNull();
      expect(found!.components.overall).toBeCloseTo(0.72, 5);
      expect(found!.factsHash).toBe(profileR.value.factsHash);
      expect(found!.embeddingModel).toBe('test-model');
    });
  });

  it('save is upsert-on-recompute: a second save for the SAME (profile, job) pair REPLACES the row, does not append', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const scores = new DrizzleMatchScoreRepository(db);

      const user = User.register({ email: email('ms2@test.com'), passwordHash: hash() });
      await users.save(user);
      const profileR = CareerProfile.create({ userId: user.id, title: 'P' });
      if (!isOk(profileR)) throw new Error('setup failed');
      await profiles.save(profileR.value);
      const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'd' });
      if (!isOk(jobR)) throw new Error('setup failed');
      await jobs.save(jobR.value);

      await scores.save(MatchScore.create({
        profileId: profileR.value.id, jobPostingId: jobR.value.id,
        components: components(0.5), factsHash: 'hash-v1', embeddingModel: 'model-v1',
      }));
      await scores.save(MatchScore.create({
        profileId: profileR.value.id, jobPostingId: jobR.value.id,
        components: components(0.9), factsHash: 'hash-v2', embeddingModel: 'model-v2',
      }));

      const all = await scores.listForProfile(profileR.value.id);
      expect(all).toHaveLength(1); // NOT 2 — upsert, not append
      expect(all[0]!.components.overall).toBeCloseTo(0.9, 5); // latest wins
      expect(all[0]!.factsHash).toBe('hash-v2');

      const rowCount = await db.execute(
        sql`SELECT count(*)::int AS n FROM match_scores WHERE profile_id = ${profileR.value.id}`,
      );
      expect((rowCount as unknown as { n: number }[])[0]!.n).toBe(1);
    });
  });

  it('listForProfile returns only scores for the given profile, ordered most-recently-computed first', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);
      const scores = new DrizzleMatchScoreRepository(db);

      const user = User.register({ email: email('ms3@test.com'), passwordHash: hash() });
      await users.save(user);
      const profileR = CareerProfile.create({ userId: user.id, title: 'P' });
      if (!isOk(profileR)) throw new Error('setup failed');
      await profiles.save(profileR.value);

      const otherProfileR = CareerProfile.create({ userId: user.id, title: 'P2', isActive: false });
      if (!isOk(otherProfileR)) throw new Error('setup failed');
      await profiles.save(otherProfileR.value);

      const jobA = JobPosting.createManual({ userId: user.id, title: 'A', descriptionMd: 'd' });
      const jobB = JobPosting.createManual({ userId: user.id, title: 'B', descriptionMd: 'd' });
      if (!isOk(jobA) || !isOk(jobB)) throw new Error('setup failed');
      await jobs.save(jobA.value);
      await jobs.save(jobB.value);

      await scores.save(MatchScore.create({
        profileId: profileR.value.id, jobPostingId: jobA.value.id,
        components: components(0.4), factsHash: 'h', embeddingModel: 'm',
        now: new Date('2026-01-01T00:00:00Z'),
      }));
      await scores.save(MatchScore.create({
        profileId: profileR.value.id, jobPostingId: jobB.value.id,
        components: components(0.6), factsHash: 'h', embeddingModel: 'm',
        now: new Date('2026-01-02T00:00:00Z'),
      }));
      // Score against the OTHER profile — must never show up in profileR's list.
      await scores.save(MatchScore.create({
        profileId: otherProfileR.value.id, jobPostingId: jobA.value.id,
        components: components(0.1), factsHash: 'h', embeddingModel: 'm',
      }));

      const list = await scores.listForProfile(profileR.value.id);
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.jobPostingId)).toEqual([jobB.value.id, jobA.value.id]); // most recent first
    });
  });

  it('findByProfileAndJob returns null when no score exists yet', async () => {
    await withTestDb(async (db) => {
      const scores = new DrizzleMatchScoreRepository(db);
      const users = new DrizzleUserRepository(db);
      const profiles = new DrizzleProfileRepository(db);
      const user = User.register({ email: email('ms4@test.com'), passwordHash: hash() });
      await users.save(user);
      const profileR = CareerProfile.create({ userId: user.id, title: 'P' });
      if (!isOk(profileR)) throw new Error('setup failed');
      await profiles.save(profileR.value);

      const found = await scores.findByProfileAndJob(
        profileR.value.id,
        '018f0000-0000-7000-8000-0000000000ff' as never,
      );
      expect(found).toBeNull();
    });
  });
});
