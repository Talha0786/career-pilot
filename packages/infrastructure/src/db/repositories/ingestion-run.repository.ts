import { eq, desc } from 'drizzle-orm';
import { uuidv7 } from '@careerpilot/domain';
import type { IngestionRun, IngestionRunRepository, IngestionRunStats } from '@careerpilot/application';
import type { Db } from '../client.js';
import { ingestionRuns } from '../schema/index.js';

/**
 * Append-only by API shape: `start` INSERTs, `complete` UPDATEs only the
 * terminal fields of that exact row. There is no generic `save`/`update` —
 * a caller cannot accidentally rewrite a past run's history (same posture
 * as `stage_transitions`/`outbox`, task 027 acceptance criteria).
 */
export class DrizzleIngestionRunRepository implements IngestionRunRepository {
  constructor(private readonly db: Db) {}

  async start(connectorConfigId: string, startedAt: Date): Promise<IngestionRun> {
    const id = uuidv7();
    const stats: IngestionRunStats = { fetched: 0, deduped: 0, inserted: 0 };
    await this.db.insert(ingestionRuns).values({
      id,
      connectorConfigId,
      startedAt,
      status: 'running',
      stats,
    });
    return { id, connectorConfigId, startedAt, finishedAt: null, status: 'running', stats, error: null };
  }

  async complete(
    id: string,
    result: { status: 'ok' | 'partial' | 'failed'; stats: IngestionRunStats; error?: string | null; finishedAt: Date },
  ): Promise<void> {
    await this.db
      .update(ingestionRuns)
      .set({
        status: result.status,
        stats: result.stats,
        error: result.error ?? null,
        finishedAt: result.finishedAt,
      })
      .where(eq(ingestionRuns.id, id));
  }

  async listRecentForConnector(connectorConfigId: string, limit: number): Promise<IngestionRun[]> {
    const rows = await this.db
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.connectorConfigId, connectorConfigId))
      .orderBy(desc(ingestionRuns.startedAt))
      .limit(limit);
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: typeof ingestionRuns.$inferSelect): IngestionRun {
    return {
      id: row.id,
      connectorConfigId: row.connectorConfigId,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      stats: row.stats as IngestionRunStats,
      error: row.error,
    };
  }
}
