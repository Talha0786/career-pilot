import { eq, sql } from 'drizzle-orm';
import { User, asUserId } from '@careerpilot/domain';
import type { UserRepository } from '@careerpilot/application';
import type { Db } from '../client.js';
import { users } from '../schema/index.js';

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.toDomain(row);
  }

  async findById(id: ReturnType<typeof asUserId>): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async save(user: User): Promise<void> {
    const snap = user.toSnapshot();
    await this.db
      .insert(users)
      .values({
        id: snap.id,
        email: snap.email,
        passwordHash: snap.passwordHash,
        role: snap.role,
        createdAt: snap.createdAt,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: { email: snap.email, passwordHash: snap.passwordHash, role: snap.role },
      });
  }

  private toDomain(row: typeof users.$inferSelect): User {
    const result = User.fromSnapshot({
      id: asUserId(row.id),
      email: row.email,
      passwordHash: row.passwordHash,
      role: row.role,
      createdAt: row.createdAt,
    });
    // A row that made it into the DB was valid at write time (validated at
    // the domain boundary before save). A failure here means data corruption,
    // which is exceptional, not an expected Result — hence the throw.
    if (!result.ok) {
      throw new Error(`Corrupt user row ${row.id}: ${result.error.message}`);
    }
    return result.value;
  }
}
