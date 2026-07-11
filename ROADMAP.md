# Roadmap

Public-facing summary. The detailed engineering version — with full acceptance criteria, risks, testing focus, and cut lines — is [`docs/09-roadmap.md`](docs/09-roadmap.md). Timeframes assume roughly one focused developer and will move; treat ordering as firmer than dates.

**Legend:** ✅ done · 🔨 in progress · ⏳ planned

## ✅ M1 — Architecture & Foundations
All architecture documents and ADRs. The three product-shaping decisions (HITL submission, connector compliance classes, LLM posture) are decided. — **Complete.**

## ⏳ M2 — Walking Skeleton
Monorepo scaffold, CI pipeline, `docker compose up`, authentication, and one end-to-end vertical slice: **manual job paste → stored → shown on the pipeline board.** Proves every architectural boundary on the cheapest feature before expensive ones stack on top.

## ⏳ M3 — Profile & Documents
Career-profile CRUD; resume import (PDF/DOCX → parse → confirm); the structured document engine with PDF/DOCX rendering; document versioning. _Target: ≥90% import field accuracy._

## ⏳ M4 — Discovery & Connectors
Connector SDK + contract test-kit with compliance classes. Class A connectors (Greenhouse, Lever, Ashby, USAJobs, RSS, manual); the **Class B capture extension** (LinkedIn/Indeed on-ramp); a reference **Class C** BYO-key licensed provider (Google Jobs via SerpApi); scheduling, ingestion, dedup, connector health.

## ⏳ M5 — Intelligence: Matching & Tailoring
Embedding + rubric match scoring; the tailoring pipeline with its anti-hallucination claim-verification contract; the eval harness; the LLM budget guard. _The eval gate is the main schedule risk here._

## ⏳ M6 — Assisted Apply
The browser-runner, ApplyTask state machine, known-ATS field maps, heuristic + LLM field mapper, live screencast review UI, and the **batch review queue**. Floor if mapper accuracy stalls: ship "copy-paste assist" mode. _Highest technical risk in the plan._

## ⏳ M7 — MCP Server & Interview Prep
MCP tools (read-only by default, no irreversible actions), plus interview prep pipelines and the mock interviewer. Includes a prompt-injection red-team pass.

## ⏳ M8 — Hardening & 1.0
Notifications, analytics dashboard, operations docs, a security review against the threat model, a load/perf pass, and an upgrade drill. _Gate: a fresh-machine install by someone who didn't build it._

## Beyond 1.0 (demand-driven, unordered)
Helm chart · more Class A ATS adapters · more Class C provider adapters · coaching multi-profile mode · local-embedding default · mobile PWA.

## What we will *not* build
Unattended mass auto-apply · first-party scrapers or login-automation for ToS-restricted platforms · hosted multi-tenant SaaS (in v1). See [ADR-003](docs/adr/ADR-003-human-in-the-loop-apply.md) and [ADR-004](docs/adr/ADR-004-connector-plugin-architecture.md) for why.

---

Have a connector or platform you want supported? Open a Discussion — Class A/C connector requests (and PRs) are the most impactful way to expand coverage.
