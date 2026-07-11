# CareerPilot AI — MCP Server Design

**Version:** 0.1 | **Status:** PROPOSED

## 1. Purpose & Position

The MCP server makes CareerPilot drivable from any MCP client (Claude Desktop, IDEs). It is a **thin interface layer over the same application-layer use cases as the HTTP API** — no business logic in tool handlers. Two transports: stdio (local desktop clients) and Streamable HTTP/SSE (remote), both authenticated.

## 2. Threat framing (read before the tool list)

An MCP client is an *LLM acting on the user's behalf*, which means prompt-injected instructions in job descriptions can reach our tools. Consequences drive the design:

1. **No destructive or outbound-irreversible action is exposed as a plain tool.** Submitting an application, deleting data, and changing credentials are *not* MCP tools. `prepare_application` stages work; final approval happens in the web UI (or via an explicit out-of-band confirmation flow), consistent with ADR-003.
2. Job description content returned by tools is wrapped in a data envelope with an injection warning, and tool descriptions instruct clients to treat it as untrusted data.
3. Every tool call → `audit_log`.
4. Tool-level scopes: MCP tokens are minted with scopes (`read`, `write:pipeline`, `write:documents`); default token is read-only.

## 3. Tool Catalog (v1)

| Tool | Scope | Description | Input (zod, summarized) |
|---|---|---|---|
| `search_jobs` | read | Query ingested postings | `{ query?, filters?: {remote, location, minSalary, postedAfter}, limit≤50 }` |
| `get_job` | read | Full posting + match score | `{ jobId }` |
| `get_profile` | read | Structured career profile | `{ profileId? }` |
| `match_job` | read | Score/refresh match for a job | `{ jobId, method?: 'embedding'\|'rubric' }` |
| `list_applications` | read | Pipeline query | `{ stage?, staleDays?, limit }` |
| `update_application_stage` | write:pipeline | Move card; system actor logged | `{ applicationId, toStage, reason? }` |
| `add_application_note` | write:pipeline | Append note | `{ applicationId, noteMd }` |
| `tailor_document` | write:documents | Enqueue tailoring; returns jobId to poll | `{ jobPostingId, kind: 'resume'\|'cover_letter', baseDocumentId? }` |
| `get_generation_status` | read | Poll generation job | `{ generationJobId }` |
| `prepare_application` | write:pipeline | Create ApplyTask up to `awaiting_review` — never submits | `{ applicationId }` |
| `generate_interview_prep` | write:documents | Questions / company brief | `{ applicationId, kind }` |
| `get_pipeline_analytics` | read | Funnel stats | `{ range }` |

Deliberately absent: `submit_application`, `delete_*`, `set_credentials`, `enable_connector`. Documented in tool list description so clients don't hallucinate them.

## 4. Resources & Prompts

- **Resources:** `careerpilot://profile/{id}`, `careerpilot://job/{id}`, `careerpilot://application/{id}` — read-only projections for context loading.
- **Prompts:** `weekly_review` (summarize pipeline, flag stale apps), `job_triage` (batch-evaluate new matches). Prompts are versioned files in `apps/mcp-server/src/prompts/`.

## 5. Implementation Notes

- `@modelcontextprotocol/sdk` (official TS SDK). One file per tool exporting `{name, description, inputSchema, handler}`; registry composes them.
- Handlers call application-layer use cases through the same DI container as the API — guarantees budget checks, validation, and audit behave identically across interfaces.
- Errors: map domain errors → MCP tool errors with stable codes; never leak stack traces.
- Rate limits per token (Redis sliding window); generation tools additionally gated by the LLM budget guard.
- Contract tests: each tool has a golden-file test (input → expected use-case call + output shape) plus an integration test against ephemeral PG.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Prompt injection via JD content triggers unwanted writes | Read-only default scope; no irreversible tools; data envelopes |
| MCP client floods generation tools → cost blowout | Budget guard pre-dispatch + per-token rate limits |
| Tool schema drift vs API | Shared zod contracts package; CI schema-diff check |
