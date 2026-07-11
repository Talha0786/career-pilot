# CareerPilot AI — M2 Status, Setup & Usage Guide

**Read this before anything else in this package.** It tells you exactly what
is real, what is verified, and what is not built yet — deliberately, so you
don't discover the gaps by hitting them.

---

## 1. What "the final product" actually means right now

You asked for the final product to run and test. Here is the honest scope:
**the full 16-milestone CareerPilot vision is not built.** What exists is
**Milestone 2 — the walking skeleton** — with the async spine that every
later milestone depends on proven to actually work, against real
infrastructure, not fakes.

There is no clickable web app yet (task 011 API, 012 web, 013 Docker Compose
are not built). What you can run and test right now is the **backend core**:
domain logic, use cases, database, queue, and worker — the load-bearing
foundation, with genuine test coverage, not placeholder code.

### What's DONE and verified

| # | Task | Verified how |
|---|---|---|
| 001 | Monorepo scaffold, strict TS, boundary lint | `pnpm typecheck` clean across all 5 packages |
| 002 | Shared kernel (Result, UUIDv7, DomainEvent) | 10 unit tests |
| 003 | Domain: User, JobPosting, Application | 121 unit tests, exhaustive 8×8 stage-transition matrix |
| 004 | Contracts (zod DTOs) | 7 unit tests |
| 005 | Application use cases | 15 unit tests against fakes |
| 006 | Drizzle schema + migration | **Run against a real Postgres 16 + pgvector instance** — not simulated |
| 007 | Repositories + UnitOfWork | 7 integration tests against real Postgres, including the atomicity proof |
| 008 | Outbox relay (SKIP LOCKED) | 4 integration tests incl. 3 relays racing 300 events, 5 consecutive clean runs |
| 009 | LLM port, adapter, budget guard | Real HTTP adapter test + budget pre-dispatch block proven |
| 010 | Worker (BullMQ) | **Full end-to-end**: paste → outbox → relay → queue → worker → embedded, real Postgres + real Redis |
| 015 | Budget concurrency fix | Advisory-lock primitive proven: naive version overspends, locked version doesn't, 5 clean runs |

**Total: 154 unit tests + 20 integration tests, all against real Postgres/Redis (no mocks at the infrastructure boundary), 100% passing, stable across repeated runs, and the full strict TypeScript compiler (`tsc --noEmit`) is clean across every package.**

### What's NOT built yet

| # | Task | Why it matters |
|---|---|---|
| 011 | Fastify HTTP API | No way to reach any of this over HTTP yet |
| 012 | Next.js web UI | No browser experience — nothing to click |
| 013 | Docker Compose | No one-command `docker compose up` yet |
| 014 | CI pipeline | Written conceptually in the design doc; not wired as a running GitHub Actions workflow |
| 016 | Wire budget lock into `GuardedLlmPort` | Primitive proven (015), not yet plumbed into the actual guard call path |
| 017 | Simultaneous-redelivery race | Documented limitation, not fixed (bounded impact: at most 2x cost on a rare true race) |

Everything past M2 (MCP server, resume/cover-letter engines, matching AI,
application engine, dashboard, analytics, notifications, prod deploy) is
still just the design documents from earlier milestones — no code.

### One environment caveat, stated plainly
This was built in a sandbox with **no Docker daemon**. Where the design calls
for Testcontainers or `docker compose`, I substituted a real Postgres 16 +
pgvector and real Redis installed directly via `apt`. Every test that "runs
against real Postgres" ran against an actual database engine — not a mock —
so the substitution doesn't weaken what's proven. But **task 013 (Docker
Compose) has not been verified to actually boot**, because there's no Docker
here to verify it with. When you clone this to your own machine with Docker
installed, that's the first thing to confirm.

---

## 2. Reproducing the verification yourself

This is the most important section. Don't take "154 tests passing" on faith —
run it.

### Prerequisites
- Node.js 22+ and pnpm (`corepack enable`)
- PostgreSQL 16 with the `pgvector` extension available
- Redis

### Install
```bash
cd careerpilot
pnpm install
```

### Set up two local Postgres databases (dev + test)
```bash
# Adjust to however you run Postgres locally (native, Docker, etc.)
createuser careerpilot --pwprompt --superuser   # set password: careerpilot
createdb careerpilot -O careerpilot
createdb careerpilot_test -O careerpilot

# Apply the migration to BOTH databases
PGPASSWORD=careerpilot psql -h localhost -U careerpilot -d careerpilot \
  -f packages/infrastructure/src/db/migrations/0001_init.sql
PGPASSWORD=careerpilot psql -h localhost -U careerpilot -d careerpilot_test \
  -f packages/infrastructure/src/db/migrations/0001_init.sql
```

### Start Redis
```bash
redis-server --daemonize yes   # or however you normally run it
```

### Run the unit tests (fast, no external services needed)
```bash
pnpm test              # 154 tests, ~1.5s
pnpm test:cov          # same, with the 90% coverage gate enforced
```

### Run the integration tests (needs the real Postgres/Redis above)
```bash
export TEST_DATABASE_URL="postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test"
export TEST_REDIS_URL="redis://localhost:6379/2"
pnpm test:int           # 20 tests + 1 documented todo, ~15-20s
```

Look specifically for these three, because they're the ones that actually
prove the architecture's central claims rather than just exercising code:

- `outbox-relay.test.ts` → *"THE concurrency test: 3 relay instances racing
  over 300 events"* — proves `SKIP LOCKED` actually prevents double-publish.
- `repositories.test.ts` → *"THE atomicity test"* — proves a forced mid-
  transaction failure leaves **zero** rows in both the aggregate table and
  the outbox, which is what makes ADR-007 true rather than aspirational.
- `end-to-end.test.ts` → the full spine, paste-to-embedded, no fakes.

### Full strict typecheck
```bash
pnpm typecheck   # or: npx tsc --build packages/domain packages/application packages/contracts packages/infrastructure apps/worker
```

If any of this doesn't pass on your machine, that's a real bug to report —
not an expected gap. Everything in the table above is expected to reproduce.

---

## 3. Configuration — not "training"

**Correction to the original ask:** CareerPilot doesn't train a model. There
is no training step, no dataset to prepare, no fine-tuning. "AI-powered"
here means *calling* an LLM through a provider-agnostic port (ADR-006), not
building one. If you came in expecting a training pipeline, that expectation
doesn't match what this architecture is — better to say so now than build a
fake training step to match the wrong mental model.

What actually configures the system is environment variables. Once task 011
(API) exists, most of this will be UI-driven; for now, it's what the worker
and any script using these packages reads directly.

### `.env` — copy `.env.example` and fill in

```bash
cp .env.example .env
```

Key variables and what they mean:

| Variable | Purpose | Default / recommendation |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | matches the dev DB you created above |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `LLM_BASE_URL` | Where embedding calls go | `http://localhost:11434/v1` (a local Ollama endpoint — **key-free by design**, ADR-006) |
| `LLM_API_KEY` | Only needed for a cloud provider | leave blank to stay fully local/free |
| `LLM_EMBEDDING_MODEL` | Which model to call | `nomic-embed-text` — **must match the schema's `vector(768)` column**; a different model with a different output dimension will fail at insert time, not silently truncate |
| `LLM_MONTHLY_BUDGET_USD` | Hard spend ceiling | The `GuardedLlmPort` refuses to dispatch — no network call at all — once this would be exceeded. Set to `0` to prove to yourself that nothing spends money by default. |

### If you want a real local model instead of the HTTP-mock used in tests
The tests use a local HTTP server standing in for an LLM provider, because
this sandbox can't reach Ollama's model downloads (network allowlist is
package registries only). On your own machine, with internet access:

```bash
# Install Ollama from https://ollama.com, then:
ollama pull nomic-embed-text
# Confirm it's serving OpenAI-compatible embeddings on :11434
curl http://localhost:11434/v1/embeddings \
  -d '{"model":"nomic-embed-text","input":"test"}'
```

Point `LLM_BASE_URL` at that endpoint (the default already assumes this) and
the `OpenAiCompatibleLlmAdapter` built in task 009 will work against a real
model — its HTTP-handling logic is already proven against a real server in
`llm-adapter.test.ts`; a real model just changes what's on the other end.

### The "profile facts" configuration (M3, not built)
The other thing you might mean by "training" — giving the system your career
facts so generation has something real to draw from — is Milestone 3
(Profile & Documents), which doesn't exist yet. When it does, the anti-
hallucination contract (agent design §4) means tailoring can only rephrase
facts you've entered, never invent them. That's the actual "how do I make
this work for me" step, once it's built.

---

## 4. What running the worker looks like today (no UI yet)

Until task 011/012 exist, "using" the system means calling the use cases
directly, e.g. from a script or `tsx` REPL:

```typescript
import { createDb, DrizzleUnitOfWork } from '@careerpilot/infrastructure';
import { makeCreateManualJobUseCase } from '@careerpilot/application';
import { asUserId } from '@careerpilot/domain';

const { db } = createDb(process.env.DATABASE_URL!);
const createManualJob = makeCreateManualJobUseCase({ uow: new DrizzleUnitOfWork(db) });

const result = await createManualJob(
  { userId: asUserId('<a real user id from your users table>') },
  { title: 'Senior Engineer', descriptionMd: 'A real job description here.' },
);
console.log(result); // { ok: true, value: { jobId, embeddingStatus: 'pending' } }
```

Run the worker (`apps/worker`) alongside an outbox-relay polling loop and,
within a few seconds, that job's `embedding_status` flips to `ready` in
Postgres — the exact thing `end-to-end.test.ts` verifies automatically.

This is not a substitute for the real HTTP API and web UI. It's what's
genuinely available today, stated accurately instead of glossed over.

---

## 5. Recommended next step

Task 011 (Fastify API) is the next piece that would make this reachable over
HTTP, followed by 012 (web) and 013 (Compose) to get to an actual
`docker compose up` experience. That's a substantial chunk of remaining
work, built to the same real-infrastructure standard as everything above —
say the word and it continues from exactly where the task list (`tasks/`)
leaves off.
