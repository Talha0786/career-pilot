import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildRealMcpApp, loadMcpEnv } from './di.js';
import { attachRegistryToServer } from './sdk-bridge.js';

/**
 * stdio transport (task 056 -- local desktop clients, e.g. Claude
 * Desktop). Invoked DIRECTLY by the client as a child process (never a
 * compose service, per task 056's own file list) -- the bearer token is
 * supplied via the `MCP_TOKEN` environment variable in the client's MCP
 * server config (there is no HTTP request to carry an Authorization
 * header over stdio), read ONCE at startup, same for the lifetime of the
 * process. See docs/mcp-claude-desktop-manual-test.md for the exact
 * config shape a real Claude Desktop `claude_desktop_config.json` needs.
 */
async function main(): Promise<void> {
  const env = loadMcpEnv();
  const { registry, close } = buildRealMcpApp(env);

  const bearerToken = process.env.MCP_TOKEN;
  if (!bearerToken) {
    process.stderr.write('MCP_TOKEN environment variable is not set -- every tool call will be rejected as unauthorized.\n');
  }

  const server = new McpServer({ name: 'careerpilot-mcp', version: '0.1.0' }, { capabilities: {} });
  attachRegistryToServer(server, registry, () => bearerToken);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await server.close();
    await close();
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`MCP stdio server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
