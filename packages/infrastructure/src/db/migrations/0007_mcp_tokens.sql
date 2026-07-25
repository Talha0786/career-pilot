-- Migration 0007 (task 056): mcp_tokens table — bearer-token auth for the
-- MCP server, separate from apps/api's session-cookie system. Only the
-- SHA-256 hash of the token is stored; the plaintext is shown once at
-- mint time and never persisted. scopes is a small fixed set stored as
-- jsonb text[] (read | write:pipeline | write:documents).

CREATE TABLE mcp_tokens (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          text NOT NULL,
  token_hash     text NOT NULL,
  scopes         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX mcp_tokens_token_hash_unique ON mcp_tokens (token_hash);
CREATE INDEX mcp_tokens_user_idx ON mcp_tokens (user_id);
