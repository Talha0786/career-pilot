# CareerPilot AI — Roadmap

**Version:** 0.1 | **Status:** PROPOSED

Each milestone below carries: scope, acceptance criteria, key risks, testing focus. Detailed technical design docs are produced at milestone start (this file is the index, not the design).

---

## M1 — Architecture & Foundations (this milestone) ✅ docs delivered
**Scope:** all architecture documents in `/docs`, ADR-001…006.
**Acceptance:** stakeholder approves PRD assumptions + the three flagged decisions (HITL default, compliant-connector v1 set, BYO-key LLM posture).
**Exit gate:** open questions in PRD §9 answered.

## M2 — Walking Skeleton (2–3 wks) — [full technical design](10-M2-technical-design.md)
**Scope:** monorepo scaffolding; CI; compose stack; auth; executable database (Drizzle schema, migration 0001, Testcontainers). Vertical slice **widened to cross the async spine**: *manual job paste → persist → transactional outbox → worker → embedding via LlmPort → WebSocket update on board*.
**Why widened:** the original CRUD-only slice never touched BullMQ, the worker, the outbox, or the LlmPort — the four boundaries most expensive to retrofit. See M2 design §1.
**Acceptance:** one-command boot; live board update without refresh; zero lost/duplicated events under worker-kill chaos test; budget guard blocks at $0; boundary violation fails CI. Full list in the M2 design §10.
**Risks:** scope creep (#1); outbox concurrency; Testcontainers CI flakiness.
**Testing:** unit (domain) → integration (Testcontainers, real Postgres — no SQLite, ADR-002 amendment) → e2e (Playwright) → chaos. This is the template every later feature copies.

## M3 — Profile & Documents (2–3 wks)
**Scope:** career profile CRUD; resume import (PDF/DOCX → parse → confirm); doc-engine structured model + PDF/DOCX rendering; document versioning.
**Acceptance:** import benchmark set ≥90% field accuracy; round-trip profile→resume PDF renders correctly in golden-file tests.
**Risks:** parsing quality (mitigate: confirm-UI makes errors cheap); doc rendering rabbit hole (constrain to 2 templates).

## M4 — Discovery & Connectors (3–4 wks)
**Scope:** connector SDK + test-kit with compliance classes (ADR-004); Class A connectors: greenhouse, lever, ashby, usajobs, rss, manual; **Class B capture extension** (bookmarklet + browser extension → `POST /capture`, the LinkedIn/Indeed on-ramp — moved up from post-1.0 because it is now the primary coverage mechanism for those platforms); at least one **Class C** BYO-key licensed-provider adapter (Google Jobs via SerpApi as reference); scheduler, ingestion, dedup, connector health.
**Acceptance:** all connectors pass contract test-kit; capture extension round-trips a real LinkedIn/Indeed job into the pipeline with no stored credentials; Class C adapter ingests via BYO key; dedup precision ≥98% on fixture corpus (must dedup a captured job against the same job from a Class A/C source); connector failure isolates (chaos test).
**Risks:** third-party API instability → recorded fixtures for CI, live canaries nightly; extension review/store friction (mitigate: bookmarklet works with zero install as the floor); Class D pressure recurs (documented firm exclusion — do not implement).

## M5 — Intelligence: Matching & Tailoring (3–4 wks)
**Scope:** embeddings + rubric scoring; tailoring pipeline with claim verification; eval harness; budget guard.
**Acceptance:** eval gates from agent-design §6 pass; budget hard-stop demonstrated; diff-review UI functional.
**Risks:** the anti-hallucination contract is the schedule risk — evals may force prompt iteration; buffer built in.

## M6 — Assisted Apply (3–4 wks)
**Scope:** browser-runner, ApplyTask state machine, known-ATS maps, heuristic + LLM mapper, screencast review UI, **batch review queue (ADR-003)**, mock-ATS e2e.
**Acceptance:** exactly-once submit property tests; full HITL flow e2e on mock ATS + one real sandbox; degradation ladder demonstrable.
**Risks:** highest technical risk in the roadmap; if mapper accuracy stalls, ship copy-paste-assist mode as the M6 floor.

## M7 — MCP Server & Interview Prep (2 wks)
**Scope:** MCP tools per mcp-design; interview prep pipelines + mock interviewer.
**Acceptance:** tool contract tests green; Claude Desktop manual test script passes; injection red-team checklist executed.

## M8 — Hardening & 1.0 (2 wks)
**Scope:** notifications, analytics dashboard, operations docs, security review vs threat model, load/perf pass, upgrade drill.
**Acceptance:** 1,000-job match < 60s benchmark; threat-model checklist signed off; fresh-machine install test by someone who didn't build it.

## Post-1.0 candidates (unordered, demand-driven)
Helm chart; more ATS adapters (Class A); more Class C provider adapters; coaching multi-profile mode; local-embedding default; mobile PWA. (Capture extension moved forward into M4.)

## Cut lines
If schedule slips: FR-11/12 (notifications/analytics) drop from 1.0 first; M6 floor is copy-paste assist; MCP prompts/resources can trail tools.
