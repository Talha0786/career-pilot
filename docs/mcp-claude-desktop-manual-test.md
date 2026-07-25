# Claude Desktop Manual Test Script (task 062)

**Status of this document's own verification:** the steps below were authored and the underlying stdio transport was code-reviewed and exercised indirectly (it shares 100% of its dispatch/auth/audit code with the HTTP transport, via `apps/mcp-server/src/sdk-bridge.ts`'s `attachRegistryToServer`, which the HTTP transport's live verification below actually exercised end to end). **A real Claude Desktop application was NOT available in this sandboxed CI/agent environment to run these exact steps interactively** — same honesty posture as M4 task 031's "fixture-verified; live canary pending" status. What *was* verified for real in this session, against the real running Docker container, is recorded in §5 below and in `docs/mcp-injection-redteam-checklist.md` §7. Whoever has a real Claude Desktop install should run §1–4 once and update this status line.

## Prerequisites

1. The CareerPilot stack running locally: `docker compose up -d --build` (brings up `postgres`, `redis`, `migrate`, `api`, `worker`, `web`, `mcp-server`, `caddy`).
2. A CareerPilot account — register via `http://localhost` (or `apps/web`'s dev server) if you don't have one.
3. An MCP bearer token minted for that account:
   ```bash
   curl -X POST http://localhost/mcp-tokens \
     -H "Content-Type: application/json" \
     -b "<your session cookie, from logging in via the web UI>" \
     -d '{"label":"Claude Desktop","scopes":["read","write:pipeline","write:documents"]}'
   ```
   Record the `token` field from the response — **it is shown exactly once and never recoverable again** (task 056's design). If you only want to test the read-only default, omit `scopes` (mints `["read"]`).

## 1. Configure Claude Desktop (stdio transport)

Edit Claude Desktop's `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "careerpilot": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/career-pilot/apps/mcp-server/src/main-stdio.ts"],
      "env": {
        "MCP_TOKEN": "<the token from Prerequisites step 3>",
        "DATABASE_URL": "postgresql://careerpilot:careerpilot@localhost:5432/careerpilot",
        "REDIS_URL": "redis://localhost:6379",
        "LLM_BASE_URL": "http://localhost:11434/v1"
      }
    }
  }
}
```

Restart Claude Desktop. The CareerPilot server should appear connected in Claude Desktop's MCP server list (usually visible via the 🔌/tools icon in a new chat).

## 2. Exercise the read tools

In a new Claude Desktop chat, with the CareerPilot MCP server connected:

- "List my job applications." → should invoke `list_applications` and return a real list (or an empty one, if you have no applications yet).
- "Search for remote engineering jobs." → should invoke `search_jobs`. **Check**: does Claude's response treat the returned job descriptions as data, not instructions? (If a JD in your test data contains any unusual text, confirm Claude doesn't act on it.)
- "What's my career profile look like?" → should invoke `get_profile`.
- "Give me pipeline analytics for the last 30 days." → should invoke `get_pipeline_analytics`.

**Pass criterion:** every one of these returns real data from your account (or a clear "not found"/"empty" response) and Claude never asks to confirm a write action for any of these — they're all `read`-scoped and should be silent/non-destructive.

## 3. Exercise a write tool

- "Move my application for [some job] to the 'interested' stage." → should invoke `update_application_stage`. **If your token only has `read` scope, this must fail with a `forbidden_scope` error** — confirm Claude surfaces that failure clearly rather than silently retrying or pretending to succeed.
- With a `write:pipeline`-scoped token: repeat the same request. **Pass criterion:** the application's stage actually changes (verify via the web UI or `GET /board`), and a corresponding `audit_log` row exists (`action='mcp.tool_call'`, `subject_id='update_application_stage'`).

## 4. Confirm `prepare_application` genuinely stops at `awaiting_review`

- "Prepare my application for [some job] for submission." → should invoke `prepare_application`.
- **Pass criterion (the single most important check in this script):** whatever Claude Desktop reports back, there must be **no way, from within the chat interface, to make the application actually submit**. Concretely:
  - Try explicitly asking Claude: "Now submit it" / "Approve and submit that application." Claude has no tool available that can do this (§3's catalog has no `submit_application`/`approve_application` tool) — it should say it cannot, not attempt a workaround.
  - Check the web UI's application review queue — the ApplyTask should be sitting in `awaiting_review`, waiting for a human click in the browser, exactly as if a human had triggered `prepare_application` from the UI.
  - **Note on this M7 session's environment**: at the time this milestone was built, M6 (the ApplyTask/Playwright backend) was still in progress in a parallel worktree — `prepare_application` in this branch calls a placeholder (`NotYetImplementedApplyTaskPort`) that always returns a `conflict` error rather than a real `awaiting_review` state. If you're testing against a build where M6 has since been merged, you should see a real `awaiting_review` state instead; if you're testing against this exact branch pre-merge, expect a clear "ApplyTask backend is not yet available" error instead — either way, no path to `submitted` should ever be reachable from the chat interface.

## 5. What was verified for real in this session (no physical Claude Desktop available)

Run against the actual `mcp-server` Docker container (`docker compose up -d mcp-server`), via raw JSON-RPC over HTTP (the same wire protocol Claude Desktop's stdio transport speaks, minus the stdio framing):

```
$ curl -s -X POST http://localhost:8090/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual-test","version":"0"}}}'
→ real MCP handshake response, serverInfo={"name":"careerpilot-mcp","version":"0.1.0"}

$ curl ... tools/list
→ exactly 13 tools (the 12-tool §3 catalog + ping), correctly-shaped JSON schemas, no dangerous tool names

$ curl ... tools/call ping   (no Authorization header)
→ {"error":"unauthorized",...}

$ curl ... tools/call ping   (real bearer token, minted via a real Postgres-backed McpTokenAdapter)
→ {"pong":true,...} -- and a real audit_log row confirmed via psql

$ curl ... tools/call update_application_stage   (same read-only token)
→ {"error":"forbidden_scope",...}
```

Full transcript and the exact commands are in `docs/mcp-injection-redteam-checklist.md` §7 and this task's Status note in `tasks/062.md`. This exercises the identical registry/auth/dispatch/audit code path `main-stdio.ts` uses (both transports call the same `attachRegistryToServer` bridge over the same `McpRegistry`) — the only untested delta is the stdio framing itself (newline-delimited JSON-RPC over stdin/stdout instead of HTTP), which is the SDK's own `StdioServerTransport`, not code this project wrote.
