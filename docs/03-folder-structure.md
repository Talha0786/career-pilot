# CareerPilot AI — Repository & Folder Structure

**Version:** 0.1 | **Status:** PROPOSED | pnpm workspaces + Turborepo

```
careerpilot/
├── package.json                  # workspace root, scripts only
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json            # strict: true, project references
├── .env.example                  # every env var documented; no secrets committed
├── docker-compose.yml            # pg, redis, api, worker, browser-runner, web
├── docs/
│   ├── 00-PRD.md … 10-roadmap.md
│   ├── adr/                      # ADR-001…N (MADR format)
│   └── diagrams/
│
├── apps/
│   ├── api/                      # Fastify
│   │   └── src/
│   │       ├── main.ts           # composition root (DI wiring)
│   │       ├── plugins/          # auth, otel, error-handler, rate-limit
│   │       └── routes/           # thin: zod DTO ↔ use case
│   ├── worker/
│   │   └── src/
│   │       ├── main.ts
│   │       ├── scheduler.ts      # cron → queues
│   │       └── handlers/         # ingestion/, matching/, generation/, export/
│   ├── mcp-server/
│   │   └── src/
│   │       ├── main.ts           # stdio + SSE transports
│   │       └── tools/            # one file per tool, zod input schemas
│   ├── browser-runner/
│   │   └── src/
│   │       ├── main.ts
│   │       ├── task-api.ts       # internal HTTP API (mTLS/localhost only)
│   │       ├── session/          # context lifecycle, screencast
│   │       └── mapping/          # form detection + field mapper
│   ├── web/                      # Next.js App Router
│   │   └── src/{app,components,features,lib}/
│   └── capture-extension/        # Class B: browser extension + bookmarklet
│       └── src/                  # content script → POST /capture; zero stored creds
│
├── packages/
│   ├── domain/                   # ZERO runtime deps
│   │   └── src/
│   │       ├── profile/          # entities, VOs, events, invariants
│   │       ├── discovery/
│   │       ├── pipeline/
│   │       ├── intelligence/
│   │       └── shared/           # Result<T,E>, DomainEvent, ids
│   ├── application/              # use cases + ports
│   │   └── src/
│   │       ├── profile/{commands,queries}/
│   │       ├── discovery/…  pipeline/…  intelligence/…
│   │       └── ports/            # ConnectorPort, LlmPort, *Repository,
│   │                             # QueuePort, SecretsPort, ClockPort, BrowserPort
│   ├── infrastructure/
│   │   └── src/
│   │       ├── db/{schema,repositories,migrations}/   # Drizzle
│   │       ├── queue/            # BullMQ adapters + outbox
│   │       ├── llm/              # anthropic.ts, openai-compat.ts, budget-guard.ts
│   │       ├── secrets/          # env provider, file provider (age-encrypted)
│   │       ├── storage/          # local-fs, s3
│   │       └── telemetry/        # pino, otel setup
│   ├── connectors/
│   │   └── src/
│   │       ├── sdk/              # ConnectorPort contract, test-kit, registry, complianceClass
│   │       ├── class-a/          # greenhouse/ lever/ ashby/ usajobs/ rss/ manual/
│   │       ├── class-b/          # capture-ingest: validates + normalizes posted rendered jobs
│   │       ├── class-c/          # serpapi-google-jobs/ (+ mantiks/brightdata/coresignal adapters), BYO key
│   │       └── README.md         # how to write a connector + the 4 compliance classes (ADR-004)
│   ├── contracts/                # zod schemas + generated OpenAPI; shared FE/BE
│   ├── doc-engine/               # structured resume model → PDF/DOCX renderers
│   └── config/                   # eslint, prettier, tsconfig fragments
│
├── e2e/                          # Playwright tests for OUR web app (not connectors)
└── .github/workflows/            # ci.yml (lint, typecheck, unit, integration, e2e), release.yml
```

Rules enforced in CI:
- `domain` imports nothing outside itself; `application` imports only `domain`; apps never import `infrastructure` internals except via composition root (eslint-plugin-boundaries).
- Every package: `src/`, `tests/` colocated `*.test.ts`, `README.md`.
- Connector packages must pass the shared connector test-kit (contract tests) to register.
