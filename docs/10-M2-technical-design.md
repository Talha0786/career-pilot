# Milestone 2 — Walking Skeleton: Technical Design

**Version:** 1.0 | **Status:** PROPOSED — awaiting approval before implementation
**Depends on:** ADR-001, ADR-002 (+ Postgres-only amendment), ADR-005, ADR-006, ADR-007
**Estimated:** 2–3 weeks (one focused developer)

---

## 1. Objective

Build the thinnest possible feature that puts **every architectural boundary under load**, so that boundaries are proven — and cheap to fix — before expensive features stack on them.

**The corrected slice (widened from the M1 roadmap):**

> A logged-in user pastes a job description → it is persisted → a domain event crosses the transactional outbox → the worker consumes it → the worker computes an embedding through the `LlmPort` → writes it back → the board updates live over WebSocket.

### Why the M1 version of this slice was wrong
The original slice (paste → board) is synchronous CRUD. It exercises HTTP → use case → domain → repo → Postgres and *nothing else*. It never touches BullMQ, the worker process, the outbox, or the `LlmPort` — the four boundaries most likely to be designed wrong and most expensive to retrofit. The widened slice costs a few extra days in M2 and de-risks M4/M5/M6.

### What M2 is explicitly NOT
Not matching (no scoring logic — the embedding is computed and stored, unused). Not tailoring, connectors, Playwright, or MCP. Not a pretty UI. Resisting scope creep here is the milestone's main discipline.

## 2. Boundaries proven by the slice

| Boundary | Proven by |
|---|---|
| Clean Architecture layering | ESLint `boundaries` rules fail the build on violation; slice code obeys them |
| Domain modelling / invariants | `JobPosting` aggregate + value objects, unit-tested |
| DTO ↔ domain mapping | zod contracts in `packages/contracts`, shared by API and web |
| Repository port + Drizzle adapter | `JobPostingRepository` port; Postgres adapter; Testcontainers integration test |
| **Transactional outbox** | `JobPosted` event written in the same tx; relay publishes (ADR-007) |
| **Queue / worker process** | BullMQ consumer in a separate process; idempotent handler |
| **LlmPort** | Embedding computed via the port; local Ollama adapter + a fake in tests |
| Budget guard | Embedding call flows through `BudgetGuard`; `ai_invocations` row written |
| WebSocket push | Worker → Redis pub/sub → api → browser |
| AuthN + ownership | Session cookie; every use case asserts `actor` owns the resource |
| Migrations | `drizzle-kit` migration 0001; `migrate` service gates app start |
| Compose deploy | `docker compose up` boots the full stack green |
| CI pipeline | lint → typecheck → unit → integration (Testcontainers) → e2e (Playwright) |

## 3. Scope: features

1. **Auth** — register, login, logout. Argon2id password hashing; session cookie (httpOnly, SameSite=Lax, Secure); sessions in Redis. No TOTP/OIDC yet (M8).
2. **Manual job paste** — form: paste raw JD text + optional URL/company/title. Server normalizes to a canonical `JobPosting`. HTML is sanitized to Markdown at ingestion (security model §1).
3. **Embedding (async)** — worker consumes `JobPosted`, calls `LlmPort.embed()`, persists `embedding vector(1024)`. Purely to prove the async + LLM spine; nothing consumes it in M2.
4. **Pipeline board** — read-only-ish kanban listing the user's jobs/applications by stage; a job appears immediately (pending) and updates live when its embedding lands.
5. **Ops surface** — `/healthz`, `/readyz`, and a minimal `/admin/status` showing queue depth, outbox backlog, and month-to-date LLM spend.

## 4. Data model (subset of M1 database design)

Only the tables the slice needs. The full schema is *not* front-loaded — tables land with the milestone that uses them.

- `users` — id, email (citext, unique), password_hash, role, settings jsonb, timestamps.
- `sessions` — Redis-backed; DB table only for revocation list.
- `job_postings` — subset: id, user_id, source_connector_key (`'manual'`), url, url_hash, company, title, description_md, posted_at, ingested_at, status, **embedding vector(1024) NULL**, embedding_status enum(`pending`,`ready`,`failed`).
- `applications` — id, user_id, job_posting_id, stage enum, timestamps.
- `stage_transitions` — append-only.
- `outbox` — per ADR-007.
- `ai_invocations` — append-only; written by the budget-guarded LLM adapter.
- `audit_log` — append-only; auth events + job creation.

**Indexes shipped in M2:** `users.email` unique; `job_postings (user_id, ingested_at desc)`; `job_postings.url_hash`; `outbox (published_at, created_at) WHERE published_at IS NULL` (partial — the relay's hot path); `ai_invocations (user_id, created_at)`. HNSW on `embedding` is deferred to M5 — with a handful of rows it costs more than a seq scan, and index choice should be made against real cardinality.

## 5. Folder structure delta (against `docs/03-folder-structure.md`)

Only these are created in M2; the rest of the tree is scaffolded empty or omitted.

```
apps/api/src/{main.ts, plugins/{auth,errors,otel,rate-limit}, routes/{auth,jobs,applications,admin}}
apps/worker/src/{main.ts, relay/outbox-relay.ts, handlers/embed-job-posting.ts}
apps/web/src/{app/(auth), app/board, features/{auth,jobs,board}, lib/api-client.ts}
packages/domain/src/{shared/{result,ids,domain-event}, profile/user.ts,
                    discovery/{job-posting.ts, events.ts}, pipeline/{application.ts, stage.ts}}
packages/application/src/{ports/*, discovery/commands/create-manual-job.ts,
                          discovery/commands/embed-job-posting.ts,
                          pipeline/queries/get-board.ts, auth/*}
packages/infrastructure/src/{db/{schema,repositories,migrations}, queue/{bullmq,outbox-relay},
                             llm/{openai-compat,budget-guard,fake}, telemetry, secrets/env}
packages/contracts/src/{auth.ts, jobs.ts, board.ts}
packages/config/{eslint,tsconfig,prettier}
e2e/{specs, fixtures}
```

## 6. API contracts (M2 subset)

All bodies zod-validated; errors as `application/problem+json` with stable codes; ownership asserted per request.

```
POST /auth/register   {email, password}                → 201 {userId}
POST /auth/login      {email, password}                → 200 + Set-Cookie  | 401 invalid_credentials
POST /auth/logout                                      → 204
GET  /auth/me                                          → 200 {userId, email}

POST /jobs            {rawText, url?, company?, title?} → 202 {jobId, embeddingStatus:"pending"}
GET  /jobs?cursor&limit                                 → 200 {items[], nextCursor}
GET  /jobs/:id                                          → 200 {job} | 404

POST   /applications          {jobPostingId}            → 201 {applicationId}
PATCH  /applications/:id/stage {toStage, reason?}       → 200 {application}
GET    /board                                           → 200 {columns: {stage: [cards]}}

GET  /admin/status                                      → 200 {queueDepth, outboxBacklog, llmSpendMtd}
GET  /healthz | /readyz                                 → 200 | 503
WS   /ws        server→client: {type:"job.embedded", jobId, status}
```

`POST /jobs` returns **202**, not 201 — the resource exists but is not fully processed. This is the contract that forces the UI to handle async state from day one rather than pretending everything is synchronous.

## 7. Key implementation decisions

- **Composition root only.** `main.ts` in each app is the sole place adapters are wired to ports. Nothing else imports `infrastructure`.
- **`Result<T, E>` over exceptions** in domain/application. Exceptions are reserved for genuinely exceptional infrastructure failure; expected failures (invalid credentials, budget exceeded) are typed values. Prevents the "catch-all swallows a domain error" pattern.
- **`LlmPort` fake in tests.** Unit and integration tests use a deterministic fake embedder; no test hits a live model. One nightly CI job runs the real Ollama adapter as a contract test.
- **Idempotent handlers.** `embed-job-posting` keys on `jobPostingId + model`; re-delivery is a no-op. Property-tested (ADR-007 requires this of every handler).
- **Budget guard is not bypassable.** The raw `LlmPort` is not exported from the infrastructure barrel; only `guardedLlm(port, budget)` is. Wiring the raw port outside the composition root is a lint error.
- **Ownership everywhere.** Every use case signature takes `actor: Actor`. Repos never expose an unscoped `findById`. This is what makes multi-user (and any future multi-tenant) safe by construction rather than by vigilance.

## 8. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Domain invariants (stage transitions, URL/email VOs), use cases with fake ports. Gate: **90% lines** on `domain` + `application`. |
| Integration | Vitest + **Testcontainers (real Postgres 16 + pgvector)** | Drizzle repos, migrations up-from-scratch, outbox relay under `SKIP LOCKED` concurrency, BullMQ handler idempotency (deliver the same event twice → one row, one `ai_invocation`). |
| Contract | Vitest | zod contracts shared FE/BE; a schema-drift check fails CI if API and client disagree. |
| E2E | Playwright | Full compose stack: register → login → paste JD → card appears `pending` → WS flips it to `ready` → drag stage → reload persists. |
| Crash/chaos | scripted | Kill the worker mid-relay; assert no lost and no duplicated events. This is the test that justifies ADR-007 existing. |

Explicitly **not** mocked: Postgres, Redis. Mocking those is what produces green CI and broken prod.

## 9. CI pipeline

`lint` → `typecheck` → `unit` → `integration` (Testcontainers) → `build images` → `e2e` (compose up) → `security` (CodeQL, osv-scanner, gitleaks, trivy). Turborepo remote cache. Branch protection on `main`: all green + 1 review.

## 10. Acceptance criteria

- [ ] `git clone && cp .env.example .env && docker compose up` → healthy stack, no manual steps.
- [ ] Register → login → paste a JD → card appears on board as `pending` → within seconds flips to `ready` via WebSocket **without a page refresh**.
- [ ] Killing the `worker` mid-flight and restarting it loses **zero** events and duplicates **zero** rows (chaos test green).
- [ ] Delivering the same `JobPosted` event twice produces one embedding and one `ai_invocation` row.
- [ ] With no LLM key configured, the stack still boots and embeds via local Ollama (ADR-006 local-default), or degrades to `embedding_status=failed` with a clear UI state and no crash.
- [ ] Setting a $0 budget blocks the embedding call **before** dispatch, with a typed `BudgetExceeded` error surfaced in the UI.
- [ ] An ESLint boundary violation (e.g. importing `infrastructure` from `domain`) fails CI. Verified by a deliberately-broken branch.
- [ ] Coverage gate ≥90% on `domain` + `application`.
- [ ] `/admin/status` shows queue depth, outbox backlog, and MTD spend.
- [ ] A person who did not build it can follow `README.md` on a clean machine and reach the board.

## 11. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| **Scope creep** — "while we're here, add connectors/matching" | High | The slice is fixed. Anything not in §3 is an M4+ issue. This is the #1 risk to M2. |
| Over-scaffolding — building all packages before they're needed | High | Only packages the slice needs are created. Empty dirs are not architecture. |
| Outbox relay concurrency bugs (double publish) | Med | `FOR UPDATE SKIP LOCKED`; concurrency + chaos integration tests; idempotent handlers as the safety net |
| Testcontainers slow/flaky in CI | Med | Single reused PG container per suite; pinned pgvector image; fall back to a CI `services:` block if flaky |
| Next.js ↔ Fastify session cookie friction (SameSite, proxying) | Med | Single-origin behind Caddy in compose; documented dev proxy config; e2e catches it |
| Local Ollama unavailable on contributor machines | Low | `LlmPort` fake is the test default; Ollama needed only for the nightly real-adapter job |
| pgvector image vs. Drizzle vector type mismatch | Low | Pinned `pgvector/pgvector:pg16`; migration 0001 asserts `CREATE EXTENSION vector` |

## 12. Next milestone recommendation

**M3 — Profile & Documents.** Rationale: M3 is the last milestone with no external dependencies (no third-party APIs, no browsers, no anti-bot). It deepens the domain model (`CareerProfile` aggregate, document versioning) on top of a proven spine, and it produces the **fact base** that M5's anti-hallucination contract depends on. Doing M4 (connectors) first would mean building ingestion before there's a profile to match against — and connectors are where external flakiness enters the project. Keep the flaky stuff later; deepen the core first.

---

**Approval requested.** Two things to confirm before I write code:
1. The **widened slice** (crossing outbox → worker → LlmPort → WS) rather than the M1 CRUD-only slice — costs a few days, de-risks four boundaries.
2. **ADR-007 (transactional outbox)** as a new accepted decision, with its at-least-once/idempotent-handlers consequence binding on all future handlers.
