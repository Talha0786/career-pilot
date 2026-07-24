import { eq, and, notInArray } from 'drizzle-orm';
import {
  CareerProfile,
  asUserId,
  asCareerProfileId,
  asProfileSectionId,
  type ProfileSectionContent,
  type ProfileSectionKind,
} from '@careerpilot/domain';
import type { ProfileRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { careerProfiles, profileSections } from '../schema/index.js';

export class DrizzleProfileRepository implements ProfileRepository {
  constructor(private readonly db: Db) {}

  async findByIdForUser(
    id: ReturnType<typeof asCareerProfileId>,
    userId: ReturnType<typeof asUserId>,
  ): Promise<CareerProfile | null> {
    const rows = await this.db
      .select()
      .from(careerProfiles)
      .where(and(eq(careerProfiles.id, id), eq(careerProfiles.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? await this.toDomain(row) : null;
  }

  async findActiveForUser(userId: ReturnType<typeof asUserId>): Promise<CareerProfile | null> {
    const rows = await this.db
      .select()
      .from(careerProfiles)
      .where(and(eq(careerProfiles.userId, userId), eq(careerProfiles.isActive, true)))
      .limit(1);
    const row = rows[0];
    return row ? await this.toDomain(row) : null;
  }

  async save(profile: CareerProfile): Promise<void> {
    const snap = profile.toSnapshot();

    await this.db
      .insert(careerProfiles)
      .values({
        id: snap.id,
        userId: snap.userId,
        title: snap.title,
        summary: snap.summary,
        isActive: snap.isActive,
        embeddingStatus: snap.embeddingStatus,
        embeddingModel: snap.embeddingModel,
        embedding: snap.embedding ? [...snap.embedding] : null,
        embeddedFactsHash: snap.embeddedFactsHash,
        createdAt: snap.createdAt,
      })
      .onConflictDoUpdate({
        target: careerProfiles.id,
        set: {
          title: snap.title,
          summary: snap.summary,
          isActive: snap.isActive,
          embeddingStatus: snap.embeddingStatus,
          embeddingModel: snap.embeddingModel,
          embedding: snap.embedding ? [...snap.embedding] : null,
          embeddedFactsHash: snap.embeddedFactsHash,
        },
      });

    // Sections are reconciled as a full-set diff against the aggregate's
    // current in-memory list: upsert everything present, delete anything
    // that's no longer there (covers CareerProfile.removeSection).
    const currentIds = profile.sections.map((s) => s.id);
    if (currentIds.length > 0) {
      await this.db.delete(profileSections).where(
        and(eq(profileSections.profileId, snap.id), notInArray(profileSections.id, currentIds)),
      );
    } else {
      await this.db.delete(profileSections).where(eq(profileSections.profileId, snap.id));
    }

    for (const section of profile.sections) {
      await this.db
        .insert(profileSections)
        .values({
          id: section.id,
          profileId: snap.id,
          kind: section.kind,
          sort: section.sort,
          content: section.content,
          contentText: section.toContentText(),
        })
        .onConflictDoUpdate({
          target: profileSections.id,
          set: {
            kind: section.kind,
            sort: section.sort,
            content: section.content,
            contentText: section.toContentText(),
          },
        });
    }
  }

  /**
   * Two roundtrips (profile row, then its sections) rather than a JOIN — the
   * cardinality here is tiny (one profile, a few dozen sections at most)
   * and keeping the row shapes un-joined avoids hand-rolling a GROUP BY
   * aggregation just to reconstruct the sections array.
   */
  private async toDomain(row: typeof careerProfiles.$inferSelect): Promise<CareerProfile> {
    const sectionRows = await this.db
      .select()
      .from(profileSections)
      .where(eq(profileSections.profileId, row.id))
      .orderBy(profileSections.sort);

    return CareerProfile.fromSnapshot({
      id: asCareerProfileId(row.id),
      userId: asUserId(row.userId),
      title: row.title,
      summary: row.summary,
      isActive: row.isActive,
      embeddingStatus: row.embeddingStatus,
      embeddingModel: row.embeddingModel,
      embedding: row.embedding ?? null,
      embeddedFactsHash: row.embeddedFactsHash,
      createdAt: row.createdAt,
      sections: sectionRows.map((s) => ({
        id: asProfileSectionId(s.id),
        profileId: asCareerProfileId(s.profileId),
        kind: s.kind as ProfileSectionKind,
        sort: s.sort,
        content: s.content as ProfileSectionContent,
      })),
    });
  }
}
