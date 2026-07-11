# Changelog

All notable changes to CareerPilot AI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until the first tagged release, changes are recorded under **[Unreleased]** and grouped by milestone.

## [Unreleased]

### Added
- **M1 — Architecture & Foundations** (complete): full architecture documentation set under `docs/` (PRD, system design, database design, component & sequence diagrams, folder structure, MCP design, Playwright design, AI agent design, security model, deployment model, roadmap).
- Six accepted Architecture Decision Records:
  - ADR-001 — TypeScript monorepo, modular monolith.
  - ADR-002 — PostgreSQL + pgvector + Drizzle.
  - ADR-003 — Human-in-the-loop application submission, with a batch-review queue.
  - ADR-004 — Connector plugin architecture with four compliance classes (A official / B capture / C licensed / D excluded); defines how LinkedIn/Indeed coverage is provided without scraping.
  - ADR-005 — BullMQ (Redis) for async work.
  - ADR-006 — Provider-agnostic LLM port; local-default, BYO-key-recommended.
- GitHub project documentation: `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `LICENSE`.

### Notes
- Project is **pre-alpha**; no runnable release yet. Implementation begins at Milestone 2 (walking skeleton).
- Licensed under **AGPL-3.0**.

---

<!--
Template for future entries. Copy under a new version heading on release.

## [x.y.z] - YYYY-MM-DD
### Added        — new features
### Changed      — changes in existing functionality
### Deprecated   — soon-to-be-removed features
### Removed       — now-removed features
### Fixed        — bug fixes
### Security     — vulnerability fixes (reference the advisory)

Link references:
[Unreleased]: https://github.com/<org>/careerpilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<org>/careerpilot/releases/tag/v0.1.0
-->

[Unreleased]: https://github.com/<org>/careerpilot/commits/main
