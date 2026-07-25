import type { ZodTypeAny } from 'zod';
import type { Result, DomainError } from '@careerpilot/domain';
import type { AuditPort, McpTokenStore, McpScope } from '@careerpilot/application';
import type { RateLimiter } from './rate-limiter.js';

/** Everything a tool handler is allowed to see about who's calling it. */
export interface ToolContext {
  readonly userId: string;
  readonly tokenId: string;
  readonly scopes: readonly McpScope[];
}

export interface ToolDef<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly scope: McpScope;
  readonly inputSchema: ZodTypeAny;
  readonly handler: (input: TInput, ctx: ToolContext) => Promise<Result<TOutput, DomainError>>;
}

export interface ResourceDef {
  readonly uriTemplate: string;
  readonly description: string;
  /** `params` are the values matched out of the URI template's `{...}` segments. */
  readonly resolve: (params: Record<string, string>, ctx: ToolContext) => Promise<Result<unknown, DomainError>>;
}

export interface PromptDef {
  readonly name: string;
  readonly description: string;
  readonly render: (args: Record<string, string>) => string;
}

export type McpErrorCode =
  | 'unauthorized'
  | 'forbidden_scope'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'invalid_transition'
  | 'conflict'
  | 'internal_error';

export class McpToolError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** Maps the domain error taxonomy (packages/domain/src/shared/errors.ts) to stable MCP error codes. Never forwards a stack trace (§5). */
function mapDomainError(error: DomainError): McpToolError {
  const code: McpErrorCode = ((): McpErrorCode => {
    switch (error.code) {
      case 'not_found': return 'not_found';
      case 'validation_failed': return 'validation_failed';
      case 'budget_exceeded': return 'budget_exceeded';
      case 'invalid_transition': return 'invalid_transition';
      case 'conflict': return 'conflict';
      case 'forbidden': return 'forbidden_scope';
      default: return 'internal_error';
    }
  })();
  return new McpToolError(code, error.message, error.details);
}

export interface RegistryDeps {
  readonly tokens: McpTokenStore;
  readonly audit: AuditPort;
  readonly rateLimiter: RateLimiter;
}

/**
 * The registry is the ONE place every MCP tool call passes through,
 * regardless of transport (stdio or HTTP/SSE — task 056 acceptance:
 * "handlers call application-layer use cases through the same DI
 * container... guarantees budget checks, validation, and audit behave
 * identically across interfaces"). Scope enforcement, rate limiting, input
 * validation, and audit logging all happen HERE, not in individual tool
 * files — task 056's acceptance criterion "no individual tool handler can
 * forget it" is enforced by construction: a tool handler is never called
 * directly by a transport, only through `dispatch`.
 *
 * A registry-level catalog test (058) asserts the exact set of registered
 * tool names — the positive proof that no `submit_application`/`delete_*`/
 * `set_credentials`/`enable_connector` tool has ever been registered here.
 */
export class McpRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly resources = new Map<string, ResourceDef>();
  private readonly prompts = new Map<string, PromptDef>();

  constructor(private readonly deps: RegistryDeps) {}

  registerTool<TInput, TOutput>(def: ToolDef<TInput, TOutput>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" already registered`);
    }
    this.tools.set(def.name, def as ToolDef);
  }

  registerResource(def: ResourceDef): void {
    if (this.resources.has(def.uriTemplate)) {
      throw new Error(`Resource "${def.uriTemplate}" already registered`);
    }
    this.resources.set(def.uriTemplate, def);
  }

  registerPrompt(def: PromptDef): void {
    if (this.prompts.has(def.name)) {
      throw new Error(`Prompt "${def.name}" already registered`);
    }
    this.prompts.set(def.name, def);
  }

  listTools(): readonly ToolDef[] {
    return [...this.tools.values()];
  }

  listResources(): readonly ResourceDef[] {
    return [...this.resources.values()];
  }

  listPrompts(): readonly PromptDef[] {
    return [...this.prompts.values()];
  }

  getPrompt(name: string): PromptDef | undefined {
    return this.prompts.get(name);
  }

  resolveResource(uri: string): { def: ResourceDef; params: Record<string, string> } | undefined {
    for (const def of this.resources.values()) {
      const params = matchUriTemplate(def.uriTemplate, uri);
      if (params) return { def, params };
    }
    return undefined;
  }

  /**
   * The single dispatch path: auth -> scope -> rate limit -> validate ->
   * handler -> audit. Every branch — including rejections — writes exactly
   * one `audit_log` row (task 056 acceptance criterion), so a rejected
   * call (bad token, missing scope, rate-limited) is just as visible in
   * the audit trail as a successful one.
   */
  async dispatch(
    bearerToken: string | undefined,
    toolName: string,
    rawInput: unknown,
  ): Promise<Result<unknown, McpToolError>> {
    const verification = bearerToken ? await this.deps.tokens.verify(bearerToken) : null;
    if (!verification) {
      await this.auditAttempt(null, toolName, 'unauthorized', rawInput);
      return { ok: false, error: new McpToolError('unauthorized', 'Missing or invalid bearer token') };
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      await this.auditAttempt(verification.userId, toolName, 'not_found', rawInput);
      return { ok: false, error: new McpToolError('not_found', `Unknown tool "${toolName}"`) };
    }

    if (!verification.scopes.includes(tool.scope)) {
      await this.auditAttempt(verification.userId, toolName, 'forbidden_scope', rawInput);
      return {
        ok: false,
        error: new McpToolError('forbidden_scope', `Token lacks required scope "${tool.scope}" for "${toolName}"`),
      };
    }

    const allowed = await this.deps.rateLimiter.consume(verification.tokenId, toolName);
    if (!allowed) {
      await this.auditAttempt(verification.userId, toolName, 'rate_limited', rawInput);
      return { ok: false, error: new McpToolError('rate_limited', `Rate limit exceeded for "${toolName}"`) };
    }

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      await this.auditAttempt(verification.userId, toolName, 'validation_failed', rawInput);
      return {
        ok: false,
        error: new McpToolError('validation_failed', 'Input failed schema validation', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      };
    }

    const ctx: ToolContext = { userId: verification.userId, tokenId: verification.tokenId, scopes: verification.scopes };

    try {
      const result = await tool.handler(parsed.data, ctx);
      if (!result.ok) {
        const mapped = mapDomainError(result.error);
        await this.auditAttempt(verification.userId, toolName, mapped.code, rawInput);
        return { ok: false, error: mapped };
      }
      await this.auditAttempt(verification.userId, toolName, 'ok', rawInput);
      return { ok: true, value: result.value };
    } catch {
      // Never leak stack traces (§5) — the audit row and the caller both
      // get a stable code + message, never the raw error/stack.
      await this.auditAttempt(verification.userId, toolName, 'internal_error', rawInput);
      return { ok: false, error: new McpToolError('internal_error', 'Tool handler failed unexpectedly') };
    }
  }

  /**
   * Task 059 — same auth/audit posture as `dispatch`, scoped to `read`
   * (resources are read-only projections by construction, see each
   * resource file's doc comment) since there's no per-resource scope
   * declared in §4. Not found (both "no matching URI template" and "id
   * doesn't exist/isn't owned by this user") maps to the same stable
   * `not_found` code — never a raw exception/stack trace (§5).
   */
  async dispatchResource(bearerToken: string | undefined, uri: string): Promise<Result<unknown, McpToolError>> {
    const verification = bearerToken ? await this.deps.tokens.verify(bearerToken) : null;
    if (!verification) {
      await this.auditAttempt(null, uri, 'unauthorized', { uri });
      return { ok: false, error: new McpToolError('unauthorized', 'Missing or invalid bearer token') };
    }

    if (!verification.scopes.includes('read')) {
      await this.auditAttempt(verification.userId, uri, 'forbidden_scope', { uri });
      return { ok: false, error: new McpToolError('forbidden_scope', 'Token lacks "read" scope') };
    }

    const resolved = this.resolveResource(uri);
    if (!resolved) {
      await this.auditAttempt(verification.userId, uri, 'not_found', { uri });
      return { ok: false, error: new McpToolError('not_found', `No resource matches "${uri}"`) };
    }

    const ctx: ToolContext = { userId: verification.userId, tokenId: verification.tokenId, scopes: verification.scopes };
    try {
      const result = await resolved.def.resolve(resolved.params, ctx);
      if (!result.ok) {
        const mapped = mapDomainError(result.error);
        await this.auditAttempt(verification.userId, uri, mapped.code, { uri });
        return { ok: false, error: mapped };
      }
      await this.auditAttempt(verification.userId, uri, 'ok', { uri });
      return { ok: true, value: result.value };
    } catch {
      await this.auditAttempt(verification.userId, uri, 'internal_error', { uri });
      return { ok: false, error: new McpToolError('internal_error', 'Resource handler failed unexpectedly') };
    }
  }

  private async auditAttempt(
    userId: string | null,
    toolName: string,
    outcome: string,
    rawInput: unknown,
  ): Promise<void> {
    if (userId === null) return; // no user to attribute an unauthenticated attempt to
    await this.deps.audit.record({
      userId,
      action: 'mcp.tool_call',
      subjectType: 'mcp_tool',
      subjectId: toolName,
      detail: { outcome, input: safeSummarizeInput(rawInput) },
    });
  }
}

/** Keeps audit rows small and avoids persisting large blobs (e.g. resume text) verbatim. */
function safeSummarizeInput(rawInput: unknown): unknown {
  if (rawInput === null || typeof rawInput !== 'object') return rawInput;
  const entries = Object.entries(rawInput as Record<string, unknown>).map(([k, v]) => {
    if (typeof v === 'string' && v.length > 200) return [k, `${v.slice(0, 200)}…(truncated)`];
    return [k, v];
  });
  return Object.fromEntries(entries);
}

/** Minimal `{param}` URI template matcher — no wildcard/regex support needed for the 3 resources in §4. */
function matchUriTemplate(template: string, uri: string): Record<string, string> | null {
  const templateParts = template.split('/');
  const uriParts = uri.split('/');
  if (templateParts.length !== uriParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i++) {
    const t = templateParts[i]!;
    const u = uriParts[i]!;
    if (t.startsWith('{') && t.endsWith('}')) {
      params[t.slice(1, -1)] = decodeURIComponent(u);
    } else if (t !== u) {
      return null;
    }
  }
  return params;
}
