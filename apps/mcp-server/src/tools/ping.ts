import { z } from 'zod';
import { ok } from '@careerpilot/domain';
import type { ToolDef } from '../registry.js';

/**
 * Trivial no-op tool (task 056 acceptance: "a trivial no-op tool call
 * round-trips over stdio and over HTTP/SSE"). Not part of §3's catalog —
 * excluded from the catalog-exactness test in task 058 (that test asserts
 * the CATALOG tools, this is transport plumbing, listed separately).
 */
export const pingTool: ToolDef<{ echo?: string }, { pong: true; echo: string | null; at: string }> = {
  name: 'ping',
  description: 'Health-check tool: round-trips a trivial request/response with no side effects.',
  scope: 'read',
  inputSchema: z.object({ echo: z.string().max(200).optional() }),
  handler: async (input) => ok({ pong: true, echo: input.echo ?? null, at: new Date().toISOString() }),
};
