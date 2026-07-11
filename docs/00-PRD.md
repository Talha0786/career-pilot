# CareerPilot AI — Product Requirements Document (PRD)

**Version:** 0.1 (Draft — requires stakeholder approval)
**Status:** PROPOSED
**Owner:** Technical Product Manager
**Last updated:** 2026-07-09

---

## 1. Problem Statement

Job seekers manage a fragmented, manual workflow: discovering roles across many platforms, tailoring resumes and cover letters per application, tracking application state, preparing for interviews, and following up. Each step is repetitive, error-prone, and time-consuming. Existing tools solve slices (ATS trackers, resume builders) but nothing owns the end-to-end pipeline with AI assistance under the user's control.

## 2. Vision

An open-source, self-hostable **Career Operating System**: a single place where a job seeker's profile, documents, job pipeline, and AI assistants live — with the user owning their data and controlling every outbound action.

## 3. Target Users

| Persona | Description | Primary needs |
|---|---|---|
| **Active seeker** (primary) | Applying to 10–100 roles/month | Discovery, tailoring, tracking, volume management |
| **Passive seeker** | Employed, monitors market | Alerts, match scoring, low-effort pipeline |
| **Career switcher** | Changing domains | Skill-gap analysis, narrative reframing of experience |
| **Self-hoster / tinkerer** | Privacy-conscious technologist | Local deployment, BYO LLM keys, extensibility |

**Non-users (v1):** recruiters, hiring teams, career coaches managing multiple clients (multi-tenant coaching is a possible v3).

## 4. Goals & Non-Goals

### Goals (v1)
1. **Profile & document vault** — structured career profile (experience, skills, education, projects) that is the single source of truth; versioned resumes and cover letters generated from it.
2. **Job discovery via connectors** — pluggable connector architecture; v1 ships with compliant connectors (official APIs / RSS / user-pasted job descriptions), not scrapers.
3. **AI match scoring** — semantic match between profile and job description with explainable score breakdown.
4. **AI document tailoring** — resume/cover letter tailoring per job, with diff view and mandatory human review before export.
5. **Application tracking** — kanban pipeline (Discovered → Interested → Applied → Interview → Offer/Rejected) with full event history.
6. **Assisted application (human-in-the-loop)** — Playwright-driven form pre-filling on career sites where the **user watches and clicks submit**. No unattended submission by default.
7. **Interview preparation** — question generation from JD + profile, mock-interview chat, company research briefs.
8. **MCP server** — expose CareerPilot as MCP tools so users can drive it from Claude or other MCP clients.

### Non-Goals (v1)
- Fully unattended auto-apply (compliance risk — see ADR-003).
- First-party scraping or credentialed login-automation of platforms whose ToS prohibit it (LinkedIn, Indeed direct) — never shipped or endorsed (ADR-004 Class D). LinkedIn/Indeed *coverage* is delivered instead via user-session capture (Class B) and BYO-key licensed providers (Class C).
- Mobile apps.
- Multi-tenant SaaS billing (architecture must not preclude it, but v1 is single-tenant self-host).
- Recruiter-side features.

## 5. Functional Requirements (summary)

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | CRUD career profile with structured schema (JSON Resume superset) | P0 |
| FR-2 | Import resume (PDF/DOCX) → parsed into structured profile with user confirmation | P0 |
| FR-3 | Connector registry (Class A/B/C); enable/disable per connector; per-connector config & BYO keys | P0 |
| FR-3a | Browser-extension / bookmarklet capture (Class B) → post rendered job to pipeline (LinkedIn/Indeed on-ramp) | P0 |
| FR-3b | BYO-key licensed-provider adapters (Class C) for LinkedIn/Indeed coverage | P1 |
| FR-4 | Scheduled job ingestion; dedup across connectors; normalization to canonical Job schema | P0 |
| FR-5 | Embedding-based + rubric-based match score (0–100) with explanation | P0 |
| FR-6 | Generate tailored resume + cover letter per job; export PDF/DOCX; version history | P0 |
| FR-7 | Pipeline board with drag/drop stage transitions and event log | P0 |
| FR-8 | Assisted apply: Playwright session pre-fills forms; user reviews & submits | P1 |
| FR-9 | Interview prep: Q&A generation, mock interview, company brief | P1 |
| FR-10 | MCP server exposing search/match/tailor/track tools | P1 |
| FR-11 | Notifications (email/webhook) for new matches and stale applications | P2 |
| FR-12 | Analytics dashboard (funnel conversion, response rates) | P2 |

## 6. Non-Functional Requirements

- **Privacy:** all data local by default; only LLM API calls leave the machine, and users may point at local models (Ollama-compatible endpoint).
- **Extensibility:** new connector added without touching core (plugin contract + registry).
- **Reliability:** ingestion jobs idempotent and resumable; connector failure never crashes the system.
- **Performance:** match scoring for 1,000 jobs < 60s on commodity hardware (batch embeddings).
- **Auditability:** every AI generation and every outbound automation action is logged with inputs, model, cost, and outcome.
- **Cost control:** per-user monthly LLM budget with hard stop.

## 7. Success Metrics (v1)

- Time from "job discovered" to "tailored application ready" < 5 minutes median.
- ≥ 90% resume-parse field accuracy on a benchmark set of 50 resumes.
- Connector uptime dashboard; broken connector detected within 1 ingestion cycle.
- GitHub: reproducible one-command deploy (`docker compose up`) verified in CI.

## 8. Key Risks (product-level)

| Risk | Severity | Mitigation |
|---|---|---|
| Platform ToS violations via community connectors | High | Compliance tiers, no first-party scraping connectors, prominent docs, HITL default (ADR-003) |
| LLM hallucination in resumes (fabricated experience) | High | Generation constrained to profile facts; claim-verification pass; mandatory human review |
| Anti-bot escalation breaks assisted apply | Medium | Connector health monitoring; degrade to "copy-paste assist" mode |
| LLM cost surprises for self-hosters | Medium | Budget caps, token accounting, local-model support |
| Scope creep ("Operating System" framing) | Medium | Strict v1 non-goals; roadmap gates |

## 9. Open Questions (require product decision before Milestone 2)

1. ~~Is fully unattended auto-apply ever in scope?~~ **RESOLVED (ADR-003):** No. HITL with a batch-review queue instead — human consent per submission, reduced friction.
2. ~~Which official/compliant job sources ship in v1?~~ **RESOLVED (ADR-004):** Class A ships Greenhouse/Lever/Ashby/USAJobs/RSS/manual; Class B ships the capture extension (LinkedIn/Indeed on-ramp); Class C ships BYO-key licensed-provider adapters. No Class D.
3. ~~Default LLM provider posture?~~ **RESOLVED (ADR-006):** Local-default (boots key-free on Ollama), BYO cloud key *recommended* for tailoring/verification; no bundled provider.
