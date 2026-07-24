import { eq, and, sql } from 'drizzle-orm';
import { asUserId } from '@careerpilot/domain';
import {
  DEGRADED_AFTER_CONSECUTIVE_FAILURES, DISABLED_AFTER_CONSECUTIVE_FAILURES,
  type ConnectorConfig, type ConnectorConfigRepository,
} from '@careerpilot/application';
import type { Db } from '../client.js';
import { connectorConfigs } from '../schema/index.js';

export class DrizzleConnectorConfigRepository implements ConnectorConfigRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<ConnectorConfig | null> {
    const rows = await this.db.select().from(connectorConfigs).where(eq(connectorConfigs.id, id)).limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async listEnabled(): Promise<ConnectorConfig[]> {
    const rows = await this.db.select().from(connectorConfigs).where(eq(connectorConfigs.enabled, true));
    return rows.map((r) => this.toDomain(r));
  }

  async listForUser(userId: ReturnType<typeof asUserId>): Promise<ConnectorConfig[]> {
    const rows = await this.db.select().from(connectorConfigs).where(eq(connectorConfigs.userId, userId));
    return rows.map((r) => this.toDomain(r));
  }

  async save(config: ConnectorConfig): Promise<void> {
    await this.db
      .insert(connectorConfigs)
      .values({
        id: config.id,
        userId: config.userId,
        connectorKey: config.connectorKey,
        displayName: config.displayName,
        enabled: config.enabled,
        scheduleCron: config.scheduleCron,
        config: config.config,
        credentialsRef: config.credentialsRef,
        health: config.health,
        consecutiveFailures: config.consecutiveFailures,
        lastSuccessAt: config.lastSuccessAt,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      })
      .onConflictDoUpdate({
        target: connectorConfigs.id,
        set: {
          displayName: config.displayName,
          enabled: config.enabled,
          scheduleCron: config.scheduleCron,
          config: config.config,
          credentialsRef: config.credentialsRef,
          health: config.health,
          consecutiveFailures: config.consecutiveFailures,
          lastSuccessAt: config.lastSuccessAt,
          updatedAt: config.updatedAt,
        },
      });
  }

  /**
   * ONE atomic UPDATE — the CASE expressions read `consecutive_failures`
   * from the row Postgres is currently locking for this statement, not a
   * value the JS client read moments earlier. Two concurrent calls for the
   * same `connectorConfigId` are serialized by Postgres' row-level lock:
   * the second one's CASE expressions see the FIRST one's already-committed
   * result, not a stale pre-increment value — this is what makes it
   * immune to the lost-update race a `findById` + `save` pair hit (task
   * 032's own chaos test caught this for real: 3 concurrent real failures
   * only advanced the naive version's counter by 2).
   */
  async recordRunOutcome(connectorConfigId: string, succeeded: boolean, now: Date): Promise<ConnectorConfig | null> {
    const rows = await this.db
      .update(connectorConfigs)
      .set({
        consecutiveFailures: succeeded ? 0 : sql`${connectorConfigs.consecutiveFailures} + 1`,
        health: succeeded
          ? sql`'healthy'::connector_health`
          : sql`CASE
              WHEN ${connectorConfigs.consecutiveFailures} + 1 >= ${DISABLED_AFTER_CONSECUTIVE_FAILURES} THEN 'disabled'::connector_health
              WHEN ${connectorConfigs.consecutiveFailures} + 1 >= ${DEGRADED_AFTER_CONSECUTIVE_FAILURES} THEN 'degraded'::connector_health
              ELSE 'healthy'::connector_health
            END`,
        lastSuccessAt: succeeded ? now : sql`${connectorConfigs.lastSuccessAt}`,
        updatedAt: now,
      })
      .where(eq(connectorConfigs.id, connectorConfigId))
      .returning();
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  /** Used by task 032's PATCH /connectors/:id — enables a user-scoped ownership check before mutating. */
  async findByIdForUser(id: string, userId: ReturnType<typeof asUserId>): Promise<ConnectorConfig | null> {
    const rows = await this.db
      .select()
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.id, id), eq(connectorConfigs.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  private toDomain(row: typeof connectorConfigs.$inferSelect): ConnectorConfig {
    return {
      id: row.id,
      userId: asUserId(row.userId),
      connectorKey: row.connectorKey,
      displayName: row.displayName,
      enabled: row.enabled,
      scheduleCron: row.scheduleCron,
      config: row.config as Record<string, unknown>,
      credentialsRef: row.credentialsRef,
      health: row.health,
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
