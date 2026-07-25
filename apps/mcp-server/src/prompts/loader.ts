import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * MCP-protocol prompts (§4: "Prompts are versioned files in
 * apps/mcp-server/src/prompts/") -- client-invokable conversation
 * starters. DELIBERATELY a separate convention from the repo-root
 * `prompts/{task}/{version}.md` LLM-pipeline convention (task 034) that
 * `packages/infrastructure`'s `FilePromptStore` loads: those are internal
 * templates rendered into a `CompleteRequest.prompt` for a guarded LLM
 * call; these are MCP protocol objects a CLIENT (Claude Desktop, an IDE)
 * lists and invokes to seed its own conversation. Same `{{var}}`
 * substitution syntax purely by convention/consistency, not because
 * they're the same mechanism.
 */
export function loadMcpPromptFile(filename: string): { frontmatterVersion: number; body: string } {
  const raw = readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatterVersion: 1, body: raw };
  const [, frontmatter, body] = match;
  const versionMatch = /version:\s*(\d+)/.exec(frontmatter ?? '');
  return { frontmatterVersion: versionMatch ? Number(versionMatch[1]) : 1, body: (body ?? '').trim() };
}

export function renderMcpPrompt(body: string, args: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => args[key] ?? `{{${key}}}`);
}
