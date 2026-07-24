import { eq, and, desc } from 'drizzle-orm';
import { MatchScore, asCareerProfileId, asJobPostingId, asMatchScoreId } from '@careerpilot/domain';
import type { ScoreComponents } from '@careerpilot/domain';
import type { MatchScoreRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { matchScores } from '../schema/index.js';

export class DrizzleMatchScoreRepository implements MatchScoreRepository {
  constructor(private readonly db: Db) {}

  async findByProfileAndJob(
    profileId: ReturnType<typeof asCareerProfileId>,
    jobPostingId: ReturnType<typeof asJobPostingId>,
  ): Promise<MatchScore | null> {
    const rows = await this.db
      .select()
      .from(matchScores)
      .where(and(eq(matchScores.profileId, profileId), eq(matchScores.jobPostingId, jobPostingId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listForProfile(
    profileId: ReturnType<typeof asCareerProfileId>,
    opts?: { limit?: number },
  ): Promise<MatchScore[]> {
    const rows = await this.db
      .select()
      .from(matchScores)
      .where(eq(matchScores.profileId, profileId))
      .orderBy(desc(matchScores.computedAt))
      .limit(opts?.limit ?? 1000);
    return rows.map((r) => this.toDomain(r));
  }

  /** Upsert-on-recompute: unique on (profile_id, job_posting_id) — a rescan REPLACES the row. */
  async save(score: MatchScore): Promise<void> {
    const snap = score.toSnapshot();
    await this.db
      .insert(matchScores)
      .values({
        id: snap.id,
        profileId: snap.profileId,
        jobPostingId: snap.jobPostingId,
        components: snap.components,
        factsHash: snap.factsHash,
        embeddingModel: snap.embeddingModel,
        computedAt: snap.computedAt,
      })
      .onConflictDoUpdate({
        target: [matchScores.profileId, matchScores.jobPostingId],
        set: {
          components: snap.components,
          factsHash: snap.factsHash,
          embeddingModel: snap.embeddingModel,
          computedAt: snap.computedAt,
        },
      });
  }

  private toDomain(row: typeof matchScores.$inferSelect): MatchScore {
    return MatchScore.fromSnapshot({
      id: asMatchScoreId(row.id),
      profileId: asCareerProfileId(row.profileId),
      jobPostingId: asJobPostingId(row.jobPostingId),
      components: row.components as ScoreComponents,
      computedAt: row.computedAt,
      factsHash: row.factsHash,
      embeddingModel: row.embeddingModel,
    });
  }
}
