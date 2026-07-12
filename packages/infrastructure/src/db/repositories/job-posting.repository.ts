import { eq, and, lt, desc, sql } from 'drizzle-orm';
import { JobPosting, asUserId, asJobPostingId } from '@careerpilot/domain';
import type { JobPostingRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { jobPostings } from '../schema/index.js';

export class DrizzleJobPostingRepository implements JobPostingRepository {
  constructor(private readonly db: Db) {}

  async findByIdForUser(id: ReturnType<typeof asJobPostingId>, userId: ReturnType<typeof asUserId>): Promise<JobPosting | null> {
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  /** Unscoped by owner — worker path only (it processes on behalf of, not as, the user). */
  async findByIdAnyOwner(id: ReturnType<typeof asJobPostingId>): Promise<JobPosting | null> {
    const rows = await this.db.select().from(jobPostings).where(eq(jobPostings.id, id)).limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listForUser(
    userId: ReturnType<typeof asUserId>,
    opts: { cursor?: string; limit: number },
  ): Promise<{ items: JobPosting[]; nextCursor: string | null }> {
    const conditions = [eq(jobPostings.userId, userId)];
    if (opts.cursor) {
      // Cursor is the ingestedAt of the last-seen row; strictly-less-than keeps it stable.
      const cursorRow = await this.db.select().from(jobPostings).where(eq(jobPostings.id, opts.cursor)).limit(1);
      if (cursorRow[0]) conditions.push(lt(jobPostings.ingestedAt, cursorRow[0].ingestedAt));
    }

    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(and(...conditions))
      .orderBy(desc(jobPostings.ingestedAt))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: page.map((r) => this.toDomain(r)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async save(job: JobPosting): Promise<void> {
    const snap = job.toSnapshot();
    await this.db
      .insert(jobPostings)
      .values({
        id: snap.id,
        userId: snap.userId,
        sourceConnectorKey: snap.sourceConnectorKey,
        url: snap.url,
        urlHash: snap.urlHash,
        company: snap.company,
        title: snap.title,
        descriptionMd: snap.descriptionMd,
        embeddingStatus: snap.embeddingStatus,
        embeddingModel: snap.embeddingModel,
        embedding: snap.embedding ? [...snap.embedding] : null,
        ingestedAt: snap.ingestedAt,
      })
      .onConflictDoUpdate({
        target: jobPostings.id,
        set: {
          embeddingStatus: snap.embeddingStatus,
          embeddingModel: snap.embeddingModel,
          embedding: snap.embedding ? [...snap.embedding] : null,
        },
      });
  }

  /**
   * Same pattern as PostgresBudgetStore.withUserBudgetLock (task 016), keyed
   * on jobPostingId instead of userId — makes the worker's read-check-embed-
   * write sequence atomic across concurrent redeliveries of the same event
   * (task 017), instead of merely "correct at rest" via attachEmbedding's
   * per-model idempotency.
   */
  async withJobPostingLock<T>(jobPostingId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${jobPostingId}))`);
      return fn();
    });
  }

  private toDomain(row: typeof jobPostings.$inferSelect): JobPosting {
    return JobPosting.fromSnapshot({
      id: asJobPostingId(row.id),
      userId: asUserId(row.userId),
      sourceConnectorKey: row.sourceConnectorKey,
      url: row.url,
      urlHash: row.urlHash,
      company: row.company,
      title: row.title,
      descriptionMd: row.descriptionMd,
      embeddingStatus: row.embeddingStatus,
      embeddingModel: row.embeddingModel,
      embedding: row.embedding ?? null,
      ingestedAt: row.ingestedAt,
    });
  }
}
