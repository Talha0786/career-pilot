import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export interface RelayablePublisher {
  publish(event: { id: string; eventType: string; aggregateType: string; aggregateId: string; payload: unknown }): Promise<void>;
}

export interface RelayStats {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * The outbox relay (ADR-007). Claims a batch of unpublished rows with
 * `FOR UPDATE SKIP LOCKED` — the mechanism that makes running N relay
 * instances concurrently safe: two relays racing for the same row never
 * block each other or double-claim, because the loser simply skips rows
 * the winner has locked.
 *
 * Delivery is at-least-once, not exactly-once: a relay can publish to
 * BullMQ and then crash before marking the row published, in which case a
 * later poll re-publishes it. This is why every handler (task 010) MUST be
 * idempotent — it is not optional, it is the other half of this contract.
 */
export class OutboxRelay {
  constructor(
    private readonly db: Db,
    private readonly publisher: RelayablePublisher,
    private readonly maxAttempts: number = 5,
  ) {}

  async pollOnce(batchSize: number = 50): Promise<RelayStats> {
    const stats: RelayStats = { claimed: 0, published: 0, failed: 0 };

    // The whole claim-and-lock happens in one transaction so the SKIP LOCKED
    // guarantee holds for the duration of this batch's processing.
    await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
        FROM outbox
        WHERE published_at IS NULL AND attempts < ${this.maxAttempts}
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `);

      const claimed = rows as unknown as {
        id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: unknown; attempts: number;
      }[];
      stats.claimed = claimed.length;

      for (const row of claimed) {
        try {
          await this.publisher.publish({
            id: row.id,
            eventType: row.event_type,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            payload: row.payload,
          });
          await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE id = ${row.id}`);
          stats.published += 1;
        } catch (error) {
          await tx.execute(sql`
            UPDATE outbox
            SET attempts = attempts + 1, last_error = ${error instanceof Error ? error.message : String(error)}
            WHERE id = ${row.id}
          `);
          stats.failed += 1;
        }
      }
    });

    return stats;
  }

  /** Backlog visible on /admin/status — rows stuck past the retry ceiling. */
  async getBacklogCount(): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL
    `);
    return (rows as unknown as { n: number }[])[0]?.n ?? 0;
  }
}
