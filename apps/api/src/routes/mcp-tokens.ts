import type { FastifyInstance } from 'fastify';
import { MintMcpTokenRequestSchema, type McpTokenDto } from '@careerpilot/contracts';
import type { McpTokenStore, McpTokenRecord } from '@careerpilot/application';
import { sendProblem } from '../lib/problem.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Task 056 -- the user-facing mint/list/revoke surface for MCP bearer
 * tokens (needed for someone to actually get a token to paste into
 * Claude Desktop's config, per docs/mcp-claude-desktop-manual-test.md).
 * `POST /mcp-tokens` is the ONLY place the plaintext token is ever
 * returned -- `GET /mcp-tokens` and every other endpoint only ever see
 * the DTO shape (`toDto`), which never includes it.
 */
export function registerMcpTokenRoutes(app: FastifyInstance, deps: { tokens: McpTokenStore }): void {
  app.post('/mcp-tokens', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = MintMcpTokenRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, 400, { code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }

    const { id, token } = await deps.tokens.mint(request.actor!.userId, parsed.data.label, parsed.data.scopes);
    return reply.code(201).send({ id, token, label: parsed.data.label, scopes: parsed.data.scopes });
  });

  app.get('/mcp-tokens', { preHandler: requireAuth }, async (request, reply) => {
    const items = await deps.tokens.list(request.actor!.userId);
    return reply.send({ items: items.map(toDto) });
  });

  app.delete<{ Params: { id: string } }>('/mcp-tokens/:id', { preHandler: requireAuth }, async (request, reply) => {
    const revoked = await deps.tokens.revoke(request.params.id, request.actor!.userId);
    if (!revoked) {
      return sendProblem(reply, 404, { code: 'not_found', message: 'MCP token not found' });
    }
    return reply.code(204).send();
  });
}

function toDto(t: McpTokenRecord): McpTokenDto {
  return {
    id: t.id,
    label: t.label,
    scopes: [...t.scopes],
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}
