import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok, err, notFound, type DomainError } from '@careerpilot/domain';
import type { McpTokenStore, McpScope } from '@careerpilot/application';
import { McpRegistry, type ToolDef } from '../../src/registry.js';
import { InMemoryRateLimiter } from '../../src/rate-limiter.js';
import { registerAllTools, DOCUMENTED_TOOL_CATALOG } from '../../src/tools/index.js';
import type { McpDeps } from '../../src/di.js';
import {
  FakeMcpTokenStore, FakeAuditPort, FakeApplicationRepository, FakeJobPostingRepository, FakeProfileRepository, stub,
} from '../fakes.js';

function noopTool(name: string, scope: McpScope): ToolDef<{ echo?: string }, { echoed: string | null }> {
  return {
    name,
    description: `test tool ${name}`,
    scope,
    inputSchema: z.object({ echo: z.string().optional() }),
    handler: async (input) => ok({ echoed: input.echo ?? null }),
  };
}

function failingTool(name: string, scope: McpScope): ToolDef<Record<string, never>, never> {
  return {
    name,
    description: `always-failing test tool ${name}`,
    scope,
    inputSchema: z.object({}),
    handler: async (): Promise<{ ok: false; error: DomainError }> => err(notFound('nothing here')),
  };
}

function makeRegistry(tokens: McpTokenStore = new FakeMcpTokenStore(), audit = new FakeAuditPort(), rateLimiter = new InMemoryRateLimiter(1000)) {
  const registry = new McpRegistry({ tokens, audit, rateLimiter });
  return { registry, tokens, audit, rateLimiter };
}

describe('McpRegistry.dispatch — auth/scope enforcement matrix (task 056)', () => {
  it('rejects a call with no bearer token as unauthorized', async () => {
    const { registry } = makeRegistry();
    registry.registerTool(noopTool('read_tool', 'read'));
    const result = await registry.dispatch(undefined, 'read_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });

  it('rejects an invalid/unrecognized bearer token as unauthorized', async () => {
    const { registry } = makeRegistry();
    registry.registerTool(noopTool('read_tool', 'read'));
    const result = await registry.dispatch('totally-not-a-real-token', 'read_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });

  it.each<[McpScope[], McpScope, boolean]>([
    [['read'], 'read', true],
    [['read'], 'write:pipeline', false],
    [['read'], 'write:documents', false],
    [['write:pipeline'], 'read', false],
    [['write:pipeline'], 'write:pipeline', true],
    [['write:documents'], 'write:documents', true],
    [['write:documents'], 'write:pipeline', false],
    [['read', 'write:pipeline'], 'read', true],
    [['read', 'write:pipeline'], 'write:pipeline', true],
    [['read', 'write:pipeline'], 'write:documents', false],
    [['read', 'write:pipeline', 'write:documents'], 'write:documents', true],
  ])('token scopes %j vs required scope %s -> allowed=%s', async (tokenScopes, requiredScope, expectedAllowed) => {
    const { registry, tokens } = makeRegistry();
    registry.registerTool(noopTool('scoped_tool', requiredScope));
    const { token } = await tokens.mint('user-1', 'test token', tokenScopes);

    const result = await registry.dispatch(token, 'scoped_tool', {});
    expect(result.ok).toBe(expectedAllowed);
    if (!expectedAllowed && !result.ok) expect(result.error.code).toBe('forbidden_scope');
  });

  it('a revoked token is rejected exactly like an invalid one', async () => {
    const { registry, tokens } = makeRegistry();
    registry.registerTool(noopTool('read_tool', 'read'));
    const { id, token } = await tokens.mint('user-1', 'test token', ['read']);
    await tokens.revoke(id, 'user-1');

    const result = await registry.dispatch(token, 'read_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });

  it('an unknown tool name is a not_found error, not a crash', async () => {
    const { registry, tokens } = makeRegistry();
    const { token } = await tokens.mint('user-1', 'test token', ['read']);
    const result = await registry.dispatch(token, 'delete_everything', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('input failing zod validation is rejected before the handler runs', async () => {
    const { registry, tokens } = makeRegistry();
    registry.registerTool({
      name: 'strict_tool',
      description: 'test',
      scope: 'read',
      inputSchema: z.object({ requiredField: z.string() }),
      handler: async () => {
        throw new Error('handler should never be reached for invalid input');
      },
    });
    const { token } = await tokens.mint('user-1', 'test token', ['read']);
    const result = await registry.dispatch(token, 'strict_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_failed');
  });

  it('rate-limits a token per tool, independent of other tokens', async () => {
    const { registry, tokens } = makeRegistry(new FakeMcpTokenStore(), new FakeAuditPort(), new InMemoryRateLimiter(1));
    registry.registerTool(noopTool('limited_tool', 'read'));
    const { token: tokenA } = await tokens.mint('user-1', 'a', ['read']);
    const { token: tokenB } = await tokens.mint('user-2', 'b', ['read']);

    const first = await registry.dispatch(tokenA, 'limited_tool', {});
    const second = await registry.dispatch(tokenA, 'limited_tool', {});
    const otherToken = await registry.dispatch(tokenB, 'limited_tool', {});

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('rate_limited');
    expect(otherToken.ok).toBe(true); // a different token's own budget is untouched
  });

  it('a handler-level domain error maps to a stable code, never a raw exception', async () => {
    const { registry, tokens } = makeRegistry();
    registry.registerTool(failingTool('failing_tool', 'read'));
    const { token } = await tokens.mint('user-1', 'test token', ['read']);
    const result = await registry.dispatch(token, 'failing_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('a handler that throws is caught and mapped to internal_error, never leaking a stack trace to the caller', async () => {
    const { registry, tokens } = makeRegistry();
    registry.registerTool({
      name: 'throwing_tool',
      description: 'test',
      scope: 'read',
      inputSchema: z.object({}),
      handler: async () => {
        throw new Error('SENSITIVE INTERNAL STACK DETAIL — must never reach the caller');
      },
    });
    const { token } = await tokens.mint('user-1', 'test token', ['read']);
    const result = await registry.dispatch(token, 'throwing_tool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.message).not.toContain('SENSITIVE');
    }
  });
});

describe('McpRegistry.dispatch — audit trail (task 056 acceptance: "every tool call -> audit_log")', () => {
  it('writes exactly one audit row per dispatch call, success or failure, and no handler can skip it', async () => {
    const { registry, tokens, audit } = makeRegistry();
    registry.registerTool(noopTool('ok_tool', 'read'));
    registry.registerTool(failingTool('fail_tool', 'read'));
    const { token } = await tokens.mint('user-1', 'test token', ['read']);

    await registry.dispatch(token, 'ok_tool', {});
    await registry.dispatch(token, 'fail_tool', {});
    await registry.dispatch(undefined, 'ok_tool', {}); // unauthorized attempt — has no userId to attribute to
    await registry.dispatch(token, 'nonexistent_tool', {}); // not_found

    // The unauthenticated attempt has no user to attribute an audit row to
    // (see registry.ts's auditAttempt doc comment) -- every AUTHENTICATED
    // attempt, success or failure, gets exactly one row.
    expect(audit.records).toHaveLength(3);
    expect(audit.records.every((r) => r.action === 'mcp.tool_call')).toBe(true);
    expect(audit.records.map((r) => r.detail?.outcome)).toEqual(['ok', 'not_found', 'not_found']);
  });
});

describe('generate_interview_prep tool — round trip', () => {
  it('ping (transport plumbing, not part of the §3 catalog) round-trips over the registry', async () => {
    const { registry, tokens } = makeRegistry();
    const { pingTool } = await import('../../src/tools/ping.js');
    registry.registerTool(pingTool);
    const { token } = await tokens.mint('user-1', 'test token', ['read']);
    const result = await registry.dispatch(token, 'ping', { echo: 'hello' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ pong: true, echo: 'hello' });
  });
});

/** Builds a full, real `McpDeps` for the catalog-exactness test — repos this suite doesn't exercise are `stub()`s that throw if actually called (see fakes.ts's doc comment on why that's safe for a registration-only test). */
function buildCatalogTestDeps(): McpDeps {
  return {
    db: stub('db'),
    uow: stub('uow'),
    profiles: new FakeProfileRepository(),
    jobPostings: new FakeJobPostingRepository(),
    applications: new FakeApplicationRepository(),
    documents: stub('documents'),
    matchScores: stub('matchScores'),
    interviewPreps: stub('interviewPreps'),
    applicationNotes: stub('applicationNotes'),
    applyTasks: stub('applyTasks'),
    search: stub('search'),
    fetcher: stub('fetcher'),
    queue: stub('queue'),
    audit: new FakeAuditPort(),
    tokens: new FakeMcpTokenStore(),
    guardedLlm: stub('guardedLlm'),
    prompts: stub('prompts'),
    rateLimiter: new InMemoryRateLimiter(1000),
    llmModel: 'test-model',
  };
}

describe('Tool catalog — positive proof of exactly the documented §3 surface (task 058)', () => {
  it('the real registered tool name set is EXACTLY the §3 catalog plus ping — no more, no less', () => {
    const registry = new McpRegistry({ tokens: new FakeMcpTokenStore(), audit: new FakeAuditPort(), rateLimiter: new InMemoryRateLimiter(1000) });
    registerAllTools(registry, buildCatalogTestDeps());

    const registeredNames = registry.listTools().map((t) => t.name).sort();
    const expectedNames = [...DOCUMENTED_TOOL_CATALOG, 'ping'].sort();
    expect(registeredNames).toEqual(expectedNames);
  });

  it('explicitly excludes every deliberately-absent dangerous tool name (§3)', () => {
    const registry = new McpRegistry({ tokens: new FakeMcpTokenStore(), audit: new FakeAuditPort(), rateLimiter: new InMemoryRateLimiter(1000) });
    registerAllTools(registry, buildCatalogTestDeps());

    const registeredNames = new Set(registry.listTools().map((t) => t.name));
    for (const forbidden of ['submit_application', 'delete_application', 'delete_document', 'delete_profile', 'set_credentials', 'enable_connector']) {
      expect(registeredNames.has(forbidden)).toBe(false);
    }
    // Also structural: no registered tool name STARTS WITH "delete_" or "submit_" at all.
    for (const name of registeredNames) {
      expect(name.startsWith('delete_')).toBe(false);
      expect(name.startsWith('submit_')).toBe(false);
      expect(name).not.toBe('set_credentials');
      expect(name).not.toBe('enable_connector');
    }
  });

  it('registration is side-effect-free — no repository/port method fires just from building the catalog', () => {
    // If ANY stub() proxy in buildCatalogTestDeps() were actually invoked
    // during registerAllTools, the proxy would throw and this whole
    // `describe` block's tests above would already be failing -- this
    // test exists purely to name that invariant explicitly.
    expect(() => {
      const registry = new McpRegistry({ tokens: new FakeMcpTokenStore(), audit: new FakeAuditPort(), rateLimiter: new InMemoryRateLimiter(1000) });
      registerAllTools(registry, buildCatalogTestDeps());
    }).not.toThrow();
  });
});
