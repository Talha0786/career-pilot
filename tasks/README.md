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
| [010](010.md) | Worker: BullMQ + idempotent embed handler | M2 | TODO |
| [011](011.md) | API: Fastify, auth, jobs, board, WS | M2 | TODO |
| [012](012.md) | Web: Next.js auth + live board | M2 | TODO |
| [013](013.md) | Docker Compose stack | M2 | TODO |
| [014](014.md) | CI pipeline + chaos test | M2 | TODO |
| [015](015.md) | Atomic budget increment — primitive proven | M2 | DONE |
| [016](016.md) | Wire budget lock into GuardedLlmPort | M2 | TODO |

Milestones beyond M2 get tasks when their design is approved — not before. Speculative tasks rot.
