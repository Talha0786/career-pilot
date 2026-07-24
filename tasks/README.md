# Living Task List

Resumable work log. Each task is a self-contained unit with everything needed to pick it up cold — in a fresh Claude Code session, or by a different contributor, weeks later.

## Format

Every task file (`NNN.md`) has exactly these sections:

- **Objective** — what done looks like, in one or two sentences
- **Files affected** — the paths this task creates or changes
- **Dependencies** — task IDs that must be `DONE` first
- **Acceptance criteria** — checkable, binary conditions
- **Test plan** — what proves it works, at which layer
- **Status** — `TODO` · `IN PROGRESS` · `BLOCKED` · `DONE`

## Rules

1. **One task, one PR** where practical. Conventional Commits; reference the task ID (`feat(domain): job posting aggregate (#003)`).
2. **Update Status in the same commit** as the work. A task list that lags the code is worse than none.
3. **Don't start a task with unmet dependencies.** If you must, mark it `BLOCKED` and say why.
4. **New work gets a new task file** — don't quietly widen an existing one. Scope creep is the #1 risk to M2.
5. Tasks are numbered globally and never renumbered. Gaps are fine.

## Index

| ID | Task | Milestone | Status |
|---|---|---|---|
| [001](001.md) | Monorepo scaffold, tooling, boundary lint | M2 | DONE |
| [002](002.md) | Shared kernel: Result, IDs, DomainEvent | M2 | DONE |
| [003](003.md) | Domain: User, JobPosting, Application aggregates | M2 | DONE |
| [004](004.md) | Contracts package (zod DTOs) | M2 | DONE |
| [005](005.md) | Application ports + use cases | M2 | DONE |
| [006](006.md) | Drizzle schema + migration 0001 | M2 | DONE |
| [007](007.md) | Repositories + integration tests (real Postgres, no Docker in sandbox) | M2 | DONE |
| [008](008.md) | Transactional outbox + relay (ADR-007) | M2 | DONE |
| [009](009.md) | LLM port, adapters, budget guard | M2 | DONE |
| [010](010.md) | Worker: BullMQ + idempotent embed handler | M2 | DONE |
| [011](011.md) | API: Fastify, auth, jobs, board, WS | M2 | DONE |
| [012](012.md) | Web: Next.js auth + live board | M2 | DONE |
| [013](013.md) | Docker Compose stack | M2 | DONE |
| [014](014.md) | CI pipeline + chaos test | M2 | DONE (branch protection excepted) |
| [015](015.md) | Atomic budget increment — primitive proven | M2 | DONE |
| [016](016.md) | Wire budget lock into GuardedLlmPort | M2 | DONE |
| [017](017.md) | Known limitation: simultaneous embed redelivery race | M2 | DONE |
| [018](018.md) | UI: `@careerpilot/ui` component library + Tailwind restyle | M2 | DONE |
| [019](019.md) | Domain: CareerProfile, ProfileSection, Document, DocumentVersion | M3 | DONE |
| [020](020.md) | Contracts + application ports/use-cases: profile & document CRUD | M3 | DONE |
| [021](021.md) | Drizzle schema + migration 0002: profile & document tables | M3 | DONE |
| [022](022.md) | API: profile & document routes | M3 | DONE |
| [023](023.md) | Resume import pipeline (PDF/DOCX → structured profile → confirm) | M3 | DONE |
| [024](024.md) | Document engine: structured model → PDF/DOCX rendering | M3 | DONE |
| [025](025.md) | Web UI: profile editor, import confirm flow, document history | M3 | DONE |
| [026](026.md) | Connector SDK: ConnectorPort, compliance classes, contract test-kit | M4 | DONE |
| [027](027.md) | Schema: connector_configs, ingestion_runs; extend job_postings | M4 | DONE |
| [028](028.md) | Class A connectors: Greenhouse, Lever, Ashby, USAJobs, RSS, manual | M4 | DONE |
| [029](029.md) | Scheduler + ingestion pipeline + dedup | M4 | DONE |
| [030](030.md) | Class B: capture ingest endpoint | M4 | DONE |
| [031](031.md) | Class C reference adapter: SerpApi Google Jobs (BYO key) | M4 | DONE (fixture-verified; live canary pending `SERPAPI_KEY`) |
| [032](032.md) | Connector health + chaos test | M4 | DONE |
| [033](033.md) | Real CostEstimator (per-model pricing table) | M5 | TODO |
| [034](034.md) | Prompt file convention + PromptStore loader | M5 | TODO |
| [035](035.md) | Profile embedding use case | M5 | TODO |
| [036](036.md) | pgvector ANN index + nearest-neighbor query | M5 | TODO |
| [037](037.md) | Numbered fact-list compilation from CareerProfile | M5 | TODO |
| [038](038.md) | Match rubric scoring pipeline | M5 | TODO |
| [039](039.md) | Resume/cover-letter tailoring pipeline | M5 | TODO |
| [040](040.md) | Claim verification pass (anti-hallucination gate) | M5 | TODO |
| [041](041.md) | Diff-review UI (web) | M5 | TODO |
| [042](042.md) | Intelligence eval harness (nightly CI gate) | M5 | TODO |
| [043](043.md) | Budget hard-stop proof (chaos/integration test) | M5 | TODO |

M3 (019-025) and M4 (026-032) ran as two parallel tracks — each internally sequential (per-track dependencies), independent of each other except both building on M2. M5 (033-043) is a single sequential track: unlike M3/M4, every stage feeds the next (embeddings → prefilter → rubric scoring → tailoring → claim verification → eval harness → budget proof), so there is no clean parallel split. Milestones beyond M5 get tasks when their design is approved — not before. Speculative tasks rot.
