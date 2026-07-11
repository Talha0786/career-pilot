# Contributing to CareerPilot AI

Thanks for your interest. This document covers how to set up, the standards we hold code to, and how to get a change merged. Read it fully before your first PR — the architectural boundaries here are enforced in CI, so a change that ignores them will fail before a human sees it.

> **Current phase:** pre-alpha. Until Milestone 2 lands, the highest-value contributions are review of the [architecture docs](docs/) and ADRs. Code contributions open up as scaffolding merges.

## Ground rules

- **Be excellent to each other.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **No Class D connectors.** We do not accept contributions that scrape or automate logins against platforms whose terms prohibit it (see [ADR-004](docs/adr/ADR-004-connector-plugin-architecture.md)). PRs that do will be closed. This protects the project and its users.
- **No secrets in commits.** `gitleaks` runs in CI and will block them. Use `.env` (gitignored) and `.env.example` for documentation.
- **By contributing, you agree your contribution is licensed under [AGPL-3.0](LICENSE).**

## Prerequisites

- Node.js LTS (see `.nvmrc`) and [pnpm](https://pnpm.io) (`corepack enable`).
- Docker + Docker Compose (for Postgres, Redis, and e2e).
- Optional: [Ollama](https://ollama.com) for running LLM tasks locally without a cloud key.

## Local setup

```bash
git clone https://github.com/<org>/careerpilot.git
cd careerpilot
pnpm install
cp .env.example .env
docker compose -f compose.dev.yml up -d   # postgres + redis only
pnpm db:migrate
pnpm db:seed                              # demo user + fixture jobs
pnpm dev                                  # all apps, hot reload
```

Run the checks CI will run, before you push:

```bash
pnpm lint          # eslint incl. import-boundary rules
pnpm typecheck     # tsc across the workspace
pnpm test          # unit tests
pnpm test:int      # integration tests (needs compose.dev.yml up)
pnpm test:e2e      # Playwright against the web app + mock ATS
```

## Architecture you must respect

CareerPilot follows Clean Architecture. The dependency rule is enforced by `eslint-plugin-boundaries` and `tsconfig` project references — you cannot merge a violation.

```
domain/          → depends on nothing
application/     → depends on domain only
infrastructure/  → implements application ports
interface (apps) → wire adapters at the composition root only
```

Practical consequences:

- **Never import `infrastructure` from `domain` or `application`.** Depend on a **port** (interface) in `application/ports`, and wire the concrete adapter in an app's `main.ts`.
- **Domain objects never cross the HTTP/MCP boundary.** Map to/from DTOs (zod schemas in `packages/contracts`) at the edge.
- **New cross-context interaction goes through a domain event**, not a direct import of another context's internals.
- Every package has `src/`, colocated `*.test.ts`, and a `README.md`.

If you think a boundary is wrong, that's an [ADR](docs/adr/) discussion, not a lint-disable comment.

## Definition of Done (every feature)

Per project standards, a feature is not done until it has **all** of:

- [ ] Working, production-quality implementation (no placeholder/stub code where a real implementation is feasible)
- [ ] Tests at the right layer (unit for domain, integration for adapters, e2e for user flows)
- [ ] Structured logging (`pino`) and typed error handling (no swallowed errors, no leaked stack traces to clients)
- [ ] Documentation (package `README.md` and/or `docs/` updated)
- [ ] No new dependency without justification in the PR description
- [ ] For AI/prompt changes: an eval run linked (see [agent design](docs/06-agent-design.md))

## Writing a connector

Connectors are the primary extension point and the most welcome contribution.

1. Create a package under `packages/connectors/class-{a,b,c}/<name>/`.
2. Implement `ConnectorPort` from `packages/connectors/sdk` (`fetchJobs`, `normalize`, `healthCheck`, `configSchema`, `metadata` with a `complianceClass`).
3. Pass the shared **contract test-kit** — this is required to register; PRs whose connector fails the kit won't merge.
4. Keep third-party API responses in `__fixtures__/` so CI doesn't hit live services; add a nightly canary if you want live drift detection.
5. Document config and any BYO-key requirements in the connector's `README.md`.

Declare the correct compliance class honestly. Class A/B/C are accepted; Class D is not.

## Commits & PRs

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Scope by package where useful: `feat(connectors): add ashby adapter`.
- Branch from `main`; keep PRs focused and reviewable. Large features land as a stack of small PRs behind a feature flag where possible.
- Fill in the PR template: what/why, the DoD checklist, and the dependency-justification line.
- Link the issue. For non-trivial design, open an issue or ADR first — don't surprise reviewers with 3,000 lines.

## Reporting bugs / requesting features

Use the issue templates. For bugs: repro steps, expected vs actual, logs (redact PII/secrets), environment. For security issues: **do not** file a public issue — follow [SECURITY.md](SECURITY.md).

## Questions

Open a Discussion. If it's about a design decision, check the [ADRs](docs/adr/) first — the answer to "why is it built this way?" is usually there.
