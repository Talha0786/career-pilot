import { uuidv7 } from '@careerpilot/domain';
import type { AuditPort, AuditRecord } from '@careerpilot/application';
import type { Db } from '../client.js';
import { auditLog } from '../schema/index.js';

/** Reuses the M2 `audit_log` table (task 006) — no new table needed for task 022. */
export class DrizzleAuditPort implements AuditPort {
  constructor(private readonly db: Db) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.db.insert(auditLog).values({
      id: uuidv7(),
      userId: entry.userId,
      action: entry.action,
      subjectType: entry.subjectType ?? null,
      subjectId: entry.subjectId ?? null,
      detail: entry.detail ?? {},
    });
  }
}
