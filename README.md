<div align="center">

# CareerPilot AI

**An open-source, self-hostable AI Career Operating System.**

Own your job search: one place for your career profile, job pipeline, AI-tailored documents, and interview prep — with your data on your own machine and a human in control of every outbound action.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)](ROADMAP.md)

</div>

> **Project status: pre-alpha / architecture phase.** The design is complete (see [`docs/`](docs/) and [ARCHITECTURE.md](ARCHITECTURE.md)); implementation begins at Milestone 2. This README documents the intended product and how to get involved now. Commands marked _(planned)_ do not work yet.

---

## Why

Job seekers juggle a fragmented, manual workflow across many platforms: discovering roles, tailoring a resume per application, tracking state, prepping for interviews, following up. Existing tools solve slices. CareerPilot owns the end-to-end pipeline with AI assistance — and, unlike hosted alternatives, it runs on **your** infrastructure with **your** data.

Two principles shape every design decision:

- **You own your data.** Everything is local by default. The only thing that leaves your machine is an LLM API call — and you can point that at a local model so nothing leaves at all.
- **A human stays in control.** CareerPilot pre-fills and drafts; it never submits an application or sends anything on your behalf without your explicit, per-item approval. See [ADR-003](docs/adr/ADR-003-human-in-the-loop-apply.md).

## What it does

| Capability | Summary |
|---|---|
| **Profile & document vault** | One structured source of truth for your career; versioned resumes & cover letters generated from it |
| **Job discovery via connectors** | Pluggable sources — official ATS APIs (Greenhouse, Lever, Ashby), USAJobs, RSS, manual paste, a browser-extension capture button, and BYO-key licensed providers |
| **AI match scoring** | Explainable profile↔job match with a score breakdown |
| **AI document tailoring** | Per-job resume/cover-letter tailoring, constrained to facts in your profile, with a mandatory human-reviewed diff |
| **Application pipeline** | Kanban board with full, append-only event history |
| **Assisted apply** | Playwright pre-fills application forms; **you** review every field and submit |
| **Interview prep** | Question generation, mock interviews, company briefs |
| **MCP server** | Drive CareerPilot from Claude or any MCP client |

### What it deliberately does *not* do

- No unattended mass auto-apply. (Why: [ADR-003](docs/adr/ADR-003-human-in-the-loop-apply.md).)
- No first-party scraping or credentialed login-automation of platforms whose terms prohibit it (e.g. LinkedIn, Indeed direct). LinkedIn/Indeed **coverage** is provided through user-initiated capture and licensed data providers instead. (Why: [ADR-004](docs/adr/ADR-004-connector-plugin-architecture.md).)
- No hosted multi-tenant SaaS in v1. Self-hosting is the product.

## Connector compliance classes

New job sources are added as connectors. Every connector declares a compliance class:

- **Class A** — official APIs & public feeds (shipped): Greenhouse, Lever, Ashby, USAJobs, RSS, manual paste.
- **Class B** — user-session capture (shipped): a browser extension / bookmarklet that sends a job you're *already viewing* into your pipeline. No stored credentials, no bot.
- **Class C** — BYO-key licensed providers (shipped): adapters for third-party job-data APIs you subscribe to; compliance sits with the provider.
- **Class D** — ToS-prohibited direct automation: **never shipped, documented, or endorsed** first-party.

## Quickstart _(planned — targets Milestone 2+)_

```bash
git clone https://github.com/<org>/careerpilot.git
cd careerpilot
cp .env.example .env          # every variable is documented; no secrets committed
docker compose up             # postgres, redis, api, worker, browser-runner, web, caddy
```

Then open `http://localhost` and create your account. CareerPilot boots **key-free on a local model (Ollama)** for parsing/matching; add a cloud LLM key in settings for higher-quality tailoring (see [ADR-006](docs/adr/ADR-006-provider-agnostic-llm-port.md)).

A `minimal` compose profile (tracker only, no browser-runner/MCP) is available for lighter hosts.

## Architecture at a glance

TypeScript monorepo, Clean Architecture + DDD, deployed as a modular monolith across five processes (`api`, `worker`, `mcp-server`, `browser-runner`, `web`). PostgreSQL 16 + pgvector for storage and matching; BullMQ/Redis for async work; a provider-agnostic LLM port.

Full detail: **[ARCHITECTURE.md](ARCHITECTURE.md)** → **[docs/](docs/)** → **[ADRs](docs/adr/)**.

## Contributing

We especially welcome **new Class A/C connectors**. Every connector must pass the shared contract test-kit. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [connector authoring guide](packages/connectors/README.md) _(added in M4)_.

## Security

Please report vulnerabilities privately per [SECURITY.md](SECURITY.md) — do not open public issues for security problems.

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its source. See the [licensing rationale](#) in ARCHITECTURE.md. Not legal advice.
