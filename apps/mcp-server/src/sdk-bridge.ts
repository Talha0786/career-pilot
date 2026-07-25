import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRegistry } from './registry.js';

/**
 * Bridges our transport-agnostic `McpRegistry` (auth/scope/rate-limit/
 * validation/audit, see registry.ts's doc comment) onto the
 * `@modelcontextprotocol/sdk`'s `McpServer` API. Both `main-stdio.ts` and
 * `main-http.ts` call this with the SAME registry instance and the SAME
 * shape of bridging logic (task 056 acceptance: "handlers... guarantees
 * budget checks, validation, and audit behave identically across
 * interfaces") -- the only thing that differs between transports is
 * WHERE the bearer token comes from (`getBearerToken`): an env var for
 * stdio (a local desktop client has no HTTP header to carry it),
 * request headers per-call for HTTP.
 *
 * Deliberately uses the SDK's low-level-ish `registerTool`/
 * `registerResource`/`registerPrompt` on `McpServer` (the documented
 * high-level API) rather than the fully low-level `Server` class --
 * `McpServer` already handles JSON-RPC protocol plumbing (initialize,
 * capability negotiation, tools/list, etc.) correctly; only the actual
 * per-call AUTHORIZATION and DISPATCH is ours.
 */
export function attachRegistryToServer(
  server: McpServer,
  registry: McpRegistry,
  getBearerToken: () => string | undefined,
): void {
  for (const tool of registry.listTools()) {
    const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      async (args: unknown) => {
        const result = await registry.dispatch(getBearerToken(), tool.name, args);
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error.code, message: result.error.message, details: result.error.details }) }],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.value) }] };
      },
    );
  }

  for (const resource of registry.listResources()) {
    const template = new ResourceTemplate(resource.uriTemplate, { list: undefined });
    server.registerResource(
      resource.uriTemplate,
      template,
      { description: resource.description },
      async (uri: URL) => {
        const result = await registry.dispatchResource(getBearerToken(), uri.toString());
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }
        return {
          contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(result.value) }],
        };
      },
    );
  }

  for (const prompt of registry.listPrompts()) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: { user_name: z.string().optional(), since: z.string().optional() },
      },
      async (args: Record<string, string | undefined>) => {
        const filled = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Record<string, string>;
        return {
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(filled) } }],
        };
      },
    );
  }
}
