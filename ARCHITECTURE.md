# Architecture

This is the high-level map. The authoritative, detailed design lives in [`docs/`](docs/); this file orients you and links there. Significant decisions are recorded as [ADRs](docs/adr/).

## Style

Clean Architecture + Domain-Driven Design, implemented as a **modular monolith** in a TypeScript monorepo (pnpm + Turborepo). Bounded contexts are code packages; the deployment is a handful of processes sharing those packages. This gives DDD boundaries and refactorability without microservice operational cost — see [ADR-001](docs/adr/ADR-001-monorepo-modular-monolith.md).

## Processes

| Process | Role |
|---|---|
| `api` | Fastify HTTP + WebSocket API for the web app and external clients |
| `worker` | BullMQ consumers: ingestion, embeddings, matching, generation, exports |
| `mcp-server` | MCP transport (stdio + SSE); thin layer over the same use cases as the API |
| `browser-runner` | Isolated Playwright sessions for assisted apply |
| `web` | Next.js UI |
| `capture-extension` | Browser extension / bookmarklet (Class B connector) |

## Bounded contexts

- **Profile** — career profile, documents, versions, import. Invariant: generated documents may only assert facts present in the profile.
- **Discovery** — connectors, ingestion, dedup, job store. Invariant: postings immutable once ingested.
- **Application Pipeline** — kanban stages, append-only transitions, assisted-apply tasks. Invariant: submission requires a single-use human approval token.
- **Intelligence** — matching, tailoring, interview prep, agents. Invariant: every LLM call is budget-checked and recorded.
- **Shared Kernel** — identity, audit, budget, domain event bus.

Contexts communicate via **domain events only**, never by importing each other's internals.

## Layering (enforced in CI)

```
domain/          entities, value objects, events — zero dependencies
application/     use cases + ports — depends on domain only
infrastructure/  adapters (Postgres, BullMQ, LLM, connectors, Playwright)
interface/       HTTP routes, MCP tools, CLI — thin; DTOs at the edge
```

`eslint-plugin-boundaries` + tsconfig project references make violations a build failure.

## Key technology choices

| Concern | Choice | ADR |
|---|---|---|
| Repo / API | pnpm + Turborepo monorepo; Fastify; Next.js | [001](docs/adr/ADR-001-monorepo-modular-monolith.md) |
| Storage | PostgreSQL 16 + pgvector; Drizzle ORM | [002](docs/adr/ADR-002-postgres-pgvector-drizzle.md) |
| Async | BullMQ on Redis; long-lived flows persisted as state machines in Postgres | [005](docs/adr/ADR-005-bullmq-over-kafka-temporal.md) |
| LLM | Provider-agnostic port; Anthropic + OpenAI-compatible (Ollama/vLLM); guarded dispatch | [006](docs/adr/ADR-006-provider-agnostic-llm-port.md) |
| Browser | Playwright in an isolated, hardened runner | [Playwright design](docs/05-playwright-design.md) |

## The three decisions that shape the product most

1. **Human-in-the-loop submission** ([ADR-003](docs/adr/ADR-003-human-in-the-loop-apply.md)) — nothing is submitted without explicit per-item human approval; a batch-review queue keeps this from throttling throughput.
2. **Connector compliance classes** ([ADR-004](docs/adr/ADR-004-connector-plugin-architecture.md)) — Class A official / B capture / C licensed are shipped; Class D (ToS-prohibited direct automation) is never first-party. This is how LinkedIn/Indeed coverage is delivered *without* scraping.
3. **Local-default, BYO-key-recommended LLM** ([ADR-006](docs/adr/ADR-006-provider-agnostic-llm-port.md)) — boots key-free on a local model; a cloud key is recommended for quality-critical tailoring and claim verification.

## Anti-hallucination contract

Resume/cover-letter tailoring is the highest-stakes AI feature. Generation is constrained to a numbered fact list compiled from the profile; a separate claim-verification pass maps every claim in the draft back to a fact or flags it `UNSUPPORTED`; unsupported claims block export; and human review is non-skippable. Details in [agent design §4](docs/06-agent-design.md).

## Data & security

PostgreSQL is the single source of truth (see [database design](docs/02-database-design.md)); append-only tables (`stage_transitions`, `apply_task_steps`, `ai_invocations`, `audit_log`) provide auditability. Secrets never live in source or the database in plaintext — a `SecretsPort` abstracts env vars and an encrypted file store. Full threat model and data classification in the [security model](docs/07-security-model.md).

## Licensing rationale

CareerPilot is licensed **[AGPL-3.0](LICENSE)**. Reasoning: it is an end-user *application*, not a library meant to be embedded, and its explicit product philosophy is self-hosting rather than hosted SaaS. AGPL's network-use copyleft ensures that anyone who runs a modified CareerPilot as a service must share their modifications — aligning the license with the project's "you own your data, no closed repackaging" stance. The trade-off: AGPL deters some corporate adoption and embedding. Because the connector SDK is a natural third-party extension surface, a future permissive carve-out or dual-license for `packages/connectors/sdk` is an open option, to be decided if a connector ecosystem materializes. This is a strategic/legal choice owned by the maintainers and is **not legal advice**.

## Where to go next

- Full document index and API contract summary: [docs/README.md](docs/README.md)
- Diagrams (component + sequence): [docs/diagrams/](docs/diagrams/)
- Roadmap with milestone acceptance criteria: [ROADMAP.md](ROADMAP.md)
