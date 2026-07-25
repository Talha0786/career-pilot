import { eq, desc } from 'drizzle-orm';
import { uuidv7 } from '@careerpilot/domain';
import type { ApplicationNoteRepository, ApplicationNote } from '@careerpilot/application';
import type { Db } from '../client.js';
import { applicationNotes } from '../schema/index.js';

export class DrizzleApplicationNoteRepository implements ApplicationNoteRepository {
  constructor(private readonly db: Db) {}

  async add(note: { id: string; applicationId: string; noteMd: string; actor: 'user' | 'system' | 'agent' }): Promise<void> {
    await this.db.insert(applicationNotes).values({
      id: note.id || uuidv7(),
      applicationId: note.applicationId,
      noteMd: note.noteMd,
      actor: note.actor,
    });
  }

  async listForApplication(applicationId: string): Promise<ApplicationNote[]> {
    const rows = await this.db
      .select()
      .from(applicationNotes)
      .where(eq(applicationNotes.applicationId, applicationId))
      .orderBy(desc(applicationNotes.createdAt));
    return rows.map((r) => ({
      id: r.id,
      applicationId: r.applicationId,
      noteMd: r.noteMd,
      actor: r.actor,
      createdAt: r.createdAt,
    }));
  }
}
