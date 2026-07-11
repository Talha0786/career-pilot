# CareerPilot AI — System Design

**Version:** 0.1 | **Status:** PROPOSED | Depends on: PRD 0.1

---

## 1. Architectural Style

Clean Architecture + DDD, organized as a **modular monolith** in a TypeScript monorepo (ADR-001). Services are separated by *deployment concern*, not microservice dogma:

| Runtime process | Why it's separate |
|---|---|
| `api` (Fastify) | Synchronous HTTP + WebSocket API for the web app and external clients |
| `worker` (BullMQ consumers) | Long-running/async work: ingestion, embeddings, generation, exports |
| `mcp-server` | Stdio/SSE MCP transport; isolates MCP protocol lifecycle from HTTP API |
| `browser-runner` | Playwright sessions; isolated because browser processes are heavy, crash-prone, and need different security posture |
| `web` (Next.js) | UI |

All share domain/application packages; only infrastructure adapters differ. This keeps DDD boundaries in code (bounded contexts as packages) while deployment stays a simple `docker compose`.

## 2. Bounded Contexts

```
┌─────────────────────────────────────────────────────────────┐
│                        CareerPilot Core                      │
├──────────────┬──────────────┬───────────────┬───────────────┤
│   Profile    │   Discovery  │  Application  │  Intelligence │
│              │              │   Pipeline    │               │
│ - Career     │ - Connectors │ - Kanban      │ - Matching    │
│   profile    │ - Ingestion  │   stages      │ - Tailoring   │
│ - Documents  │ - Dedup /    │ - Events      │ - Interview   │
│ - Versions   │   normalize  │ - Assisted    │   prep        │
│ - Import     │ - Job store  │   apply       │ - Agents      │
├──────────────┴──────────────┴───────────────┴───────────────┤
│         Shared Kernel: Identity, Audit, Budget, Events       │
└─────────────────────────────────────────────────────────────┘
```

Context boundaries and language:

- **Profile**: `CareerProfile` (aggregate root), `ExperienceEntry`, `Skill`, `Document`, `DocumentVersion`. Invariant: generated documents may only assert facts present in the profile.
- **Discovery**: `Connector` (port), `JobPosting` (aggregate), `IngestionRun`. Invariant: a `JobPosting` is immutable once ingested; updates create revisions.
- **Application Pipeline**: `Application` (aggregate), `StageTransition`, `ApplyTask`. Invariant: stage transitions append-only; assisted-apply tasks require explicit user approval token before any browser action that submits data.
- **Intelligence**: `MatchScore`, `GenerationJob`, `AgentRun`. Invariant: every LLM call recorded in `ai_invocations` with token/cost accounting; budget enforced *before* dispatch.
- **Shared Kernel**: user identity, audit log, cost budget, domain event bus (in-process + outbox to BullMQ).

Cross-context communication: **domain events only** (e.g., `JobIngested` → Intelligence schedules match scoring). No context imports another's internals.

## 3. Layering (per package)

```
domain/          Entities, value objects, domain events, domain services. Zero deps.
application/     Use cases (command/query handlers), ports (interfaces). Depends on domain.
infrastructure/  Adapters: Postgres repos, BullMQ, LLM providers, connectors, Playwright.
interface/       HTTP routes, MCP tool handlers, CLI. Thin; maps DTOs ↔ use cases.
```

Dependency rule enforced by ESLint boundaries plugin + `tsconfig` project references. Zod schemas define DTOs at the interface edge; domain objects never serialize directly.

## 4. Technology Choices (see ADRs)

| Concern | Choice | ADR |
|---|---|---|
| Repo | pnpm workspaces + Turborepo monorepo | 001 |
| API | Fastify + Zod (type-provider) | 001 |
| DB | PostgreSQL 16 + pgvector | 002 |
| ORM | Drizzle (SQL-first, no runtime magic) | 002 |
| Queue | BullMQ on Redis | 005 |
| LLM | Provider-agnostic port; adapters: Anthropic, OpenAI-compatible (covers Ollama/vLLM) | 006 |
| Browser | Playwright, isolated runner service | 004/Playwright doc |
| UI | Next.js (App Router) + Tailwind | 001 |
| Auth | Local credentials + session cookies; OIDC optional | Security doc |

## 5. Data Flow (happy path)

1. **Ingestion:** scheduler enqueues `ingest:{connectorId}` → worker calls connector `fetchJobs(cursor)` → normalizes to canonical `JobPosting` → dedup (URL hash + fuzzy title/company) → persist → emit `JobIngested`.
2. **Matching:** `JobIngested` → embed JD (batched) → cosine similarity vs. profile embedding → rubric LLM pass for top-N → persist `MatchScore` → notify if above threshold.
3. **Tailoring:** user requests tailor → `GenerationJob` queued → agent produces draft constrained to profile facts → claim-verification pass → user reviews diff → approve → render PDF/DOCX → new `DocumentVersion`.
4. **Assisted apply:** user clicks Apply → `ApplyTask` created → browser-runner opens page, fills mapped fields, pauses at submit → user reviews in embedded view (CDP screencast) → user approves → runner submits (or user submits manually) → `Application` moves to Applied → audit record.

## 6. Failure Model

- Connector failure: circuit breaker per connector; 3 consecutive failures → connector marked `DEGRADED`, alert emitted, other connectors unaffected.
- LLM failure: retry with exponential backoff (idempotent generation jobs keyed by content hash); fallback provider optional.
- Browser-runner crash: ApplyTask state machine persists every step; resume or safely abort — never re-submit (submission step is exactly-once via approval token consumption).
- Worker crash: BullMQ at-least-once + idempotency keys on all handlers.

## 7. Observability

- **Logging:** pino, structured JSON, request/job correlation IDs propagated across queue boundaries.
- **Metrics:** OpenTelemetry → Prometheus exposition; key series: ingestion lag, connector error rate, LLM cost/day, apply-task success rate.
- **Tracing:** OTel spans across api → queue → worker → LLM.
- **Audit:** separate append-only `audit_log` table for security-relevant and outbound actions.

## 8. Component Diagram

See `diagrams/component.md` (Mermaid).

## 9. Explicit trade-offs

- Modular monolith over microservices: one DB, one deploy, refactorable boundaries. Cost: shared failure domain for api+worker if deployed on one box — acceptable for self-host scale.
- Postgres+pgvector over dedicated vector DB: one operational dependency; pgvector HNSW adequate up to ~1M jobs. Cost: re-index churn on heavy write loads — not our profile.
- BullMQ over Kafka/Temporal: matches scale and ops budget. Cost: no durable workflow history; mitigated by persisting state machines (ApplyTask, IngestionRun) in Postgres, not in the queue.
