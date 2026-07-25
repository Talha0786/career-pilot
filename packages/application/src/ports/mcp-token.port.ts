/**
 * M7 (task 056). Bearer-token auth for the MCP server — a separate path
 * from `apps/api`'s session-cookie system (§1: "MCP clients can't hold a
 * browser cookie"). Scopes per `docs/04-mcp-design.md` §2 rule 4: `read`,
 * `write:pipeline`, `write:documents`. A token is a flat set of these —
 * no hierarchy, no wildcard; `mcp-server/src/registry.ts` checks
 * `requiredScope` membership directly against the set minted on the token.
 */
export type McpScope = 'read' | 'write:pipeline' | 'write:documents';

export const MCP_SCOPES: readonly McpScope[] = ['read', 'write:pipeline', 'write:documents'];

export interface McpTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface McpTokenVerification {
  readonly tokenId: string;
  readonly userId: string;
  readonly scopes: readonly McpScope[];
}

/**
 * `mint` returns the plaintext token exactly once — nothing else in the
 * system can ever retrieve it again (only its hash is stored). `verify`
 * is the hot path every MCP request goes through; it must reject revoked
 * tokens and update `lastUsedAt` as a side effect (best-effort — a failed
 * `lastUsedAt` write must never fail the auth check itself).
 */
export interface McpTokenStore {
  mint(userId: string, label: string, scopes: readonly McpScope[]): Promise<{ id: string; token: string }>;
  revoke(id: string, userId: string): Promise<boolean>;
  list(userId: string): Promise<McpTokenRecord[]>;
  verify(token: string): Promise<McpTokenVerification | null>;
}
