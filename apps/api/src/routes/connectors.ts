import type { FastifyInstance } from 'fastify';
import { UpdateConnectorConfigRequestSchema, type ConnectorConfigDto } from '@careerpilot/contracts';
import type { ConnectorConfigRepository, ConnectorConfig } from '@careerpilot/application';
import { sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * `GET /connectors`, `PATCH /connectors/:id` — enable/config/BYO-key
 * (task 032, per docs/README.md's documented route shape).
 *
 * `toDto` is the ONE place that decides what leaves this route — it never
 * reads `credentialsRef` off the domain object, so there is no code path
 * here that could accidentally leak a stored key reference, let alone the
 * raw key value (which this system never stores in the first place —
 * `credentialsRef` is itself only a pointer, security model §4).
 */
export function registerConnectorRoutes(app: FastifyInstance, deps: { connectorConfigs: ConnectorConfigRepository }): void {
  app.get('/connectors', { preHandler: requireAuth }, async (request, reply) => {
    const items = await deps.connectorConfigs.listForUser(request.actor!.userId);
    return reply.send({ items: items.map(toDto) });
  });

  app.patch<{ Params: { id: string } }>('/connectors/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = UpdateConnectorConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const existing = await deps.connectorConfigs.findByIdForUser(request.params.id, request.actor!.userId);
    if (!existing) {
      return sendProblem(reply, 404, { code: 'not_found', message: 'Connector config not found' });
    }

    const updated: ConnectorConfig = {
      ...existing,
      displayName: parsed.data.displayName ?? existing.displayName,
      enabled: parsed.data.enabled ?? existing.enabled,
      scheduleCron: parsed.data.scheduleCron !== undefined ? parsed.data.scheduleCron : existing.scheduleCron,
      config: parsed.data.config ?? existing.config,
      credentialsRef: parsed.data.credentialsRef !== undefined ? parsed.data.credentialsRef : existing.credentialsRef,
      updatedAt: new Date(),
    };
    await deps.connectorConfigs.save(updated);

    return reply.send(toDto(updated));
  });
}

function toDto(c: ConnectorConfig): ConnectorConfigDto {
  return {
    id: c.id,
    connectorKey: c.connectorKey,
    displayName: c.displayName,
    enabled: c.enabled,
    scheduleCron: c.scheduleCron,
    config: c.config,
    health: c.health,
    consecutiveFailures: c.consecutiveFailures,
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // credentialsRef intentionally omitted — write-only (task 032 acceptance).
  };
}
