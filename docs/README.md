# CareerPilot AI — Architecture Documentation (Milestone 1)

**Status: PROPOSED — awaiting approval of the decisions in §3 before implementation begins.**

## Document Index

| Doc | Contents |
|---|---|
| [00-PRD.md](00-PRD.md) | Problem, personas, goals/non-goals, FRs/NFRs, open questions |
| [01-system-design.md](01-system-design.md) | Bounded contexts, layering, processes, failure model, observability |
| [02-database-design.md](02-database-design.md) | Schema, ERD, invariants, migrations, retention |
| [diagrams/component-and-sequence.md](diagrams/component-and-sequence.md) | Component diagram + 3 sequence diagrams |
| [03-folder-structure.md](03-folder-structure.md) | Monorepo layout, CI-enforced boundary rules |
| [04-mcp-design.md](04-mcp-design.md) | Tool catalog, scopes, injection threat handling |
| [05-playwright-design.md](05-playwright-design.md) | Assisted-apply architecture, state machine, degradation ladder |
| [06-agent-design.md](06-agent-design.md) | LLM port, task inventory, anti-hallucination contract, evals |
| [07-security-model.md](07-security-model.md) | Threat model, secrets, data classification, audit |
| [08-deployment-model.md](08-deployment-model.md) | Compose stack, CI/CD, upgrades, ops |
| [09-roadmap.md](09-roadmap.md) | M1–M8 with acceptance criteria, risks, cut lines |
| [10-M2-technical-design.md](10-M2-technical-design.md) | **M2 walking skeleton** — widened slice, contracts, testing, acceptance |
| [adr/](adr/) | ADR-001…007 |

## API Contract Summary (v1 HTTP surface — full OpenAPI generated from zod in M2)

```
POST   /auth/register | /auth/login | /auth/logout
GET    /profiles/:id            PUT /profiles/:id
POST   /profiles/import        (multipart resume → parsed draft)
GET    /jobs?query&filters     GET /jobs/:id
POST   /jobs (manual paste)    POST /jobs/:id/match
POST   /capture                (Class B: rendered job from extension → normalized posting)
GET    /connectors             PATCH /connectors/:id (enable/config/BYO-key)
GET    /applications?stage     POST /applications
PATCH  /applications/:id/stage POST /applications/:id/notes
POST   /jobs/:id/tailor        GET  /generations/:id
GET    /documents/:id/versions POST /documents/:id/export
POST   /applications/:id/apply-tasks
GET    /apply-tasks/:id        POST /apply-tasks/:id/approve
POST   /apply-tasks/:id/abort
GET    /admin/status | /healthz | /readyz
WS     /ws (notifications, generation progress, apply-task screencast)
```
Conventions: cursor pagination; problem+json errors with stable codes; all bodies zod-validated; ownership asserted per request via `actor`.

## Milestone 1 Acceptance Criteria — CLOSED

- [x] All 12 deliverables produced and internally consistent
- [x] **RESOLVED:** HITL-only submission with batch-review affordance (ADR-003)
- [x] **RESOLVED:** Connector strategy = 4 compliance classes (ADR-004). LinkedIn/Indeed coverage via Class B (capture extension) + Class C (BYO-key licensed providers); no first-party scrapers or login-automation (Class D excluded).
- [x] **RESOLVED:** Local-default, BYO-key-recommended LLM posture (ADR-006) — boots key-free on a local model; cloud key recommended for tailoring/verification.

All three flagged decisions are decided. **M1 is closed; M2 is unblocked.**

## Top 5 Program Risks

1. ToS/legal exposure of automation (mitigated architecturally — ADR-003/004; residual risk documented)
2. Anti-hallucination contract may extend M5 (eval-gated; buffer allocated)
3. Form-mapper accuracy caps M6 value (floor: copy-paste assist mode)
4. Scope creep from "Operating System" framing (non-goals + cut lines)
5. Self-host complexity limits adoption (minimal compose profile; one-command install verified in CI)

## Testing Strategy (program-level)

Test pyramid per feature: domain unit → repo/adapter integration (ephemeral PG/Redis) → e2e (compose + Playwright + mock ATS). AI features additionally gated by the eval harness (agent-design §6). Coverage gate on domain/application: 90% lines; adapters covered by integration, not mocks-of-mocks.

## Next Milestone Recommendation

**M2 — Walking Skeleton** (roadmap §M2): scaffold repo, CI, compose, auth, and one vertical slice (manual job paste → pipeline board). Rationale: proves every architectural boundary (layering, DTO contracts, queue, DB, e2e harness) on the cheapest possible feature before expensive features stack on top. All M1 decision preconditions are now resolved — M2 can begin on approval to proceed with implementation.
