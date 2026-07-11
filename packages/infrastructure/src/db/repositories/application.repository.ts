import { eq, and } from 'drizzle-orm';
import { Application, asUserId, asApplicationId, asJobPostingId } from '@careerpilot/domain';
import type { ApplicationRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { applications, stageTransitions } from '../schema/index.js';
import { uuidv7 } from '@careerpilot/domain';

export class DrizzleApplicationRepository implements ApplicationRepository {
  constructor(private readonly db: Db) {}

  async findByIdForUser(id: ReturnType<typeof asApplicationId>, userId: ReturnType<typeof asUserId>): Promise<Application | null> {
    const rows = await this.db
      .select()
      .from(applications)
      .where(and(eq(applications.id, id), eq(applications.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listForUser(userId: ReturnType<typeof asUserId>): Promise<Application[]> {
    const rows = await this.db.select().from(applications).where(eq(applications.userId, userId));
    return rows.map((r) => this.toDomain(r));
  }

  async save(app: Application): Promise<void> {
    const snap = app.toSnapshot();
    await this.db
      .insert(applications)
      .values({
        id: snap.id,
        userId: snap.userId,
        jobPostingId: snap.jobPostingId,
        stage: snap.stage,
        createdAt: snap.createdAt,
        updatedAt: snap.updatedAt,
      })
      .onConflictDoUpdate({
        target: applications.id,
        set: { stage: snap.stage, updatedAt: snap.updatedAt },
      });

    // Append-only history — never updated, only inserted (db design §2).
    const transitions = app.pullTransitions();
    for (const t of transitions) {
      await this.db.insert(stageTransitions).values({
        id: uuidv7(),
        applicationId: snap.id,
        fromStage: t.fromStage,
        toStage: t.toStage,
        actor: t.actor,
        reason: t.reason,
        createdAt: t.occurredAt,
      });
    }
  }

  private toDomain(row: typeof applications.$inferSelect): Application {
    return Application.fromSnapshot({
      id: asApplicationId(row.id),
      userId: asUserId(row.userId),
      jobPostingId: asJobPostingId(row.jobPostingId),
      stage: row.stage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
