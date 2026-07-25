import { randomBytes, createHash } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { uuidv7 } from '@careerpilot/domain';
import type { McpTokenStore, McpTokenRecord, McpTokenVerification, McpScope } from '@careerpilot/application';
import type { Db } from '../db/client.js';
import { mcpTokens } from '../db/schema/index.js';

const TOKEN_PREFIX = 'cpmcp_';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Bearer-token store for the MCP server (task 056). Deliberately NOT the
 * same mechanism as `apps/api`'s session cookies (`SessionStore`, Redis-
 * backed, short-lived) — MCP tokens are long-lived, presented as a static
 * `Authorization: Bearer <token>` header by desktop/remote clients that
 * can't do a cookie-based login flow, and are stored (as a hash) in
 * Postgres rather than Redis since revocation/audit history matters more
 * than the O(1) expiry Redis gives sessions for free.
 *
 * Only `token_hash` (SHA-256) is ever persisted. `mint` is the one place
 * the plaintext exists — returned to the caller once and never stored,
 * same "never persist the secret" posture as `Argon2Hasher` for passwords
 * (a plain fast hash, not a slow password hash, is deliberate here: this
 * is a high-entropy random token, not a low-entropy user-chosen secret —
 * SHA-256 is the correct primitive for "detect the exact same random
 * string again quickly," not "make guessing expensive").
 */
export class McpTokenAdapter implements McpTokenStore {
  constructor(private readonly db: Db) {}

  async mint(userId: string, label: string, scopes: readonly McpScope[]): Promise<{ id: string; token: string }> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${secret}`;

    await this.db.insert(mcpTokens).values({
      id,
      userId,
      label,
      tokenHash: hashToken(token),
      scopes: [...scopes],
    });

    return { id, token };
  }

  async revoke(id: string, userId: string): Promise<boolean> {
    const result = await this.db
      .update(mcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)))
      .returning({ id: mcpTokens.id });
    return result.length > 0;
  }

  async list(userId: string): Promise<McpTokenRecord[]> {
    const rows = await this.db.select().from(mcpTokens).where(eq(mcpTokens.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      label: r.label,
      scopes: r.scopes as McpScope[],
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  }

  async verify(token: string): Promise<McpTokenVerification | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;

    const hash = hashToken(token);
    const rows = await this.db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt !== null) return null;

    // Best-effort — a failed lastUsedAt write must never fail the auth
    // check itself (task 056 doc comment on the port interface).
    this.db
      .update(mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokens.id, row.id))
      .catch(() => {
        /* swallow — telemetry only */
      });

    return { tokenId: row.id, userId: row.userId, scopes: row.scopes as McpScope[] };
  }
}
