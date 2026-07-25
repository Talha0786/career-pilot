import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Request, Response } from 'express';
import pino from 'pino';
import { buildRealMcpApp, loadMcpEnv } from './di.js';
import { attachRegistryToServer } from './sdk-bridge.js';

/**
 * Streamable HTTP/SSE transport (task 056 -- "remote clients"), run as the
 * `mcp-server` compose service. STATELESS mode (`sessionIdGenerator:
 * undefined`, per the SDK's own documented pattern) -- a fresh `McpServer`
 * + transport is built per request, all backed by the SAME long-lived
 * `McpRegistry`/DI (one process-wide Postgres/Redis connection pool, per
 * `buildRealMcpApp`), so this is cheap (closures only) not a new DB
 * connection per request.
 */
async function main(): Promise<void> {
  const env = loadMcpEnv();
  const logger = pino({ level: env.logLevel });
  const { registry } = buildRealMcpApp(env);

  const port = Number(process.env.MCP_HTTP_PORT ?? 8090);
  // Bound to 0.0.0.0 so the compose network can reach this container --
  // disables the SDK's automatic localhost-only DNS-rebinding protection,
  // an accepted tradeoff for a containerized service (task 056's bearer-
  // token auth is the actual access control here, not network binding).
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const server = new McpServer({ name: 'careerpilot-mcp', version: '0.1.0' }, { capabilities: {} });
      const bearerToken = extractBearerToken(req.headers.authorization);
      attachRegistryToServer(server, registry, () => bearerToken);

      // The SDK's own `StreamableHTTPServerTransportOptions`/`Transport`
      // types declare several fields as plain-optional (`foo?: T`) rather
      // than `foo?: T | undefined`, which this repo's
      // `exactOptionalPropertyTypes: true` (tsconfig.base.json) treats as
      // a real mismatch for an explicit `undefined` value -- a friction
      // between this repo's strictness and a third-party library's types,
      // not a real type-safety issue (stateless mode requires explicitly
      // passing `sessionIdGenerator: undefined` per the SDK's own
      // documented pattern). Narrowly cast rather than loosening the
      // shared tsconfig for the whole app.
      const transportOptions = { sessionIdGenerator: undefined } as unknown as StreamableHTTPServerTransportOptions;
      const transport = new StreamableHTTPServerTransport(transportOptions);
      // Same exactOptionalPropertyTypes friction as above, this time on
      // `Transport.onclose` (interface: `() => void`) vs
      // `StreamableHTTPServerTransport.onclose` (concrete class: `(() =>
      // void) | undefined`) -- a real SDK-internal type inconsistency
      // under this strictness flag, not a runtime behavior difference.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (error) {
      logger.error({ error }, 'MCP HTTP request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      }
    }
  });

  app.listen(port, () => {
    logger.info({ port }, 'MCP HTTP/SSE server listening');
  });
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1];
}

main().catch((error) => {
  console.error('MCP HTTP server failed to start', error);
  process.exit(1);
});
