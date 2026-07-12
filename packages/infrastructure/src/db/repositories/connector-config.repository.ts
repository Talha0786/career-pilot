import { eq, and } from 'drizzle-orm';
import { asUserId } from '@careerpilot/domain';
import type { ConnectorConfig, ConnectorConfigRepository } from '@careerpilot/application';
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
