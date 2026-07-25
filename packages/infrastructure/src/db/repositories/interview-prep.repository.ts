import { eq, and, desc } from 'drizzle-orm';
import type { InterviewPrepRepository, InterviewPrepRecord, InterviewPrepKind } from '@careerpilot/application';
import type { Db } from '../client.js';
import { interviewPreps } from '../schema/index.js';

export class DrizzleInterviewPrepRepository implements InterviewPrepRepository {
  constructor(private readonly db: Db) {}

  async save(record: { id: string; applicationId: string; kind: InterviewPrepKind; content: unknown }): Promise<InterviewPrepRecord> {
    const now = new Date();
    const rows = await this.db
      .insert(interviewPreps)
      .values({
        id: record.id,
        applicationId: record.applicationId,
        kind: record.kind,
        content: record.content as object,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [interviewPreps.id],
        set: { content: record.content as object, updatedAt: now },
      })
      .returning();
    return this.toDomain(rows[0]!);
  }

  async findById(id: string): Promise<InterviewPrepRecord | null> {
    const rows = await this.db.select().from(interviewPreps).where(eq(interviewPreps.id, id)).limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listForApplication(applicationId: string, kind?: InterviewPrepKind): Promise<InterviewPrepRecord[]> {
    const where = kind
      ? and(eq(interviewPreps.applicationId, applicationId), eq(interviewPreps.kind, kind))
      : eq(interviewPreps.applicationId, applicationId);
    const rows = await this.db.select().from(interviewPreps).where(where).orderBy(desc(interviewPreps.createdAt));
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof interviewPreps.$inferSelect): InterviewPrepRecord {
    return {
      id: row.id,
      applicationId: row.applicationId,
      kind: row.kind,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
