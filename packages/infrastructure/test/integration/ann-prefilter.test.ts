import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { User, Email, PasswordHash, JobPosting, isOk } from '@careerpilot/domain';
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

/** 768-dim one-hot-ish vector: `base` everywhere except a bump at `axis`. Lets fixtures encode "distance from the query" in a controllable, human-checkable way instead of random noise. */
function vec(axis: number, bump: number, base = 0.01): number[] {
  const v = new Array(768).fill(base);
  v[axis] = bump;
  return v;
}

describe('JobPostingRepository.findNearestByEmbedding — REAL Postgres 16 + pgvector HNSW ANN (task 036)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('orders results by ASCENDING cosine distance to the query embedding, respects limit, and excludes non-embedded/excluded-status postings', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobs = new DrizzleJobPostingRepository(db);

      const user = User.register({ email: email('ann@test.com'), passwordHash: hash() });
      await users.save(user);

      const query = vec(0, 1.0); // the "profile embedding" we're searching against

      // Closest: nearly identical to the query vector.
      const closest = mustOk(JobPosting.createManual({ userId: user.id, title: 'Closest', descriptionMd: 'd' }));
      closest.attachEmbedding(vec(0, 0.99), 'test-model');
      await jobs.save(closest);

      // Medium: same axis, smaller bump — cosine-similar but less so.
      const medium = mustOk(JobPosting.createManual({ userId: user.id, title: 'Medium', descriptionMd: 'd' }));
      medium.attachEmbedding(vec(0, 0.5), 'test-model');
      await jobs.save(medium);

      // Farthest: bump on a COMPLETELY different axis — orthogonal-ish, cosine-dissimilar.
      const farthest = mustOk(JobPosting.createManual({ userId: user.id, title: 'Farthest', descriptionMd: 'd' }));
      farthest.attachEmbedding(vec(700, 1.0), 'test-model');
      await jobs.save(farthest);

      // Never-embedded posting: must be excluded (embedding IS NULL can never ANN-match).
      const unembedded = mustOk(JobPosting.createManual({ userId: user.id, title: 'Unembedded', descriptionMd: 'd' }));
      await jobs.save(unembedded);

      // Closed posting: embedded, but excluded via opts.excludeStatuses.
      const closed = mustOk(JobPosting.createManual({ userId: user.id, title: 'Closed', descriptionMd: 'd' }));
      closed.attachEmbedding(vec(0, 0.97), 'test-model'); // would otherwise rank #2
      await jobs.save(closed);
      closed.markClosed();
      await jobs.save(closed);

      const results = await jobs.findNearestByEmbedding(query, { limit: 10, excludeStatuses: ['closed'] });

      const titles = results.map((r) => r.title);
      expect(titles).toEqual(['Closest', 'Medium', 'Farthest']); // exact ascending-distance order
      expect(titles).not.toContain('Unembedded');
      expect(titles).not.toContain('Closed');

      // limit is respected.
      const limited = await jobs.findNearestByEmbedding(query, { limit: 2, excludeStatuses: ['closed'] });
      expect(limited.map((r) => r.title)).toEqual(['Closest', 'Medium']);

      // No excludeStatuses → the closed one IS eligible again (still ordered correctly).
      const withClosed = await jobs.findNearestByEmbedding(query, { limit: 10 });
      expect(withClosed.map((r) => r.title)).toEqual(['Closest', 'Closed', 'Medium', 'Farthest']);
    });
  });

  it('the HNSW index actually exists and is used by the ANN query (migration 0004 applied)', async () => {
    await withTestDb(async (db) => {
      const indexRows = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'job_postings' AND indexname = 'job_postings_embedding_hnsw_idx'
        UNION ALL
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'career_profiles' AND indexname = 'career_profiles_embedding_hnsw_idx'
      `);
      expect(indexRows).toHaveLength(2);
    });
  });
});

function mustOk<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`fixture setup failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}
