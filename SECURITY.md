# Security Policy

CareerPilot handles sensitive personal data — resumes, contact details, and potentially platform credentials and LLM API keys. We take security seriously and appreciate responsible disclosure.

## Supported versions

The project is **pre-alpha**; only `main` is supported today. Once we ship tagged releases, this table will list which are receiving security fixes.

| Version | Supported |
|---|---|
| `main` (pre-release) | ✅ |
| tagged releases | _table added at 1.0_ |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Please report privately via one of:

- **GitHub Private Vulnerability Reporting** — the "Report a vulnerability" button under this repository's *Security* tab (preferred).
- **Email** — `security@<project-domain>` _(placeholder; maintainers to configure before public launch)_.

Please include, where you can:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected component (`api`, `worker`, `browser-runner`, `mcp-server`, `web`, a connector, etc.) and version/commit.
- Any suggested remediation.

**Redact real secrets and personal data** from your report — use placeholders.

## What to expect

- **Acknowledgement:** within 3 business days.
- **Triage & initial assessment:** within 7 business days.
- **Fix timeline:** communicated after triage, prioritized by severity. Critical issues are worked immediately.
- **Disclosure:** coordinated. We'll agree on a disclosure date with you and credit you in the advisory and `CHANGELOG.md` unless you prefer to remain anonymous.

We will not pursue legal action against researchers who act in good faith, avoid privacy violations and service disruption, and give us reasonable time to remediate before public disclosure.

## Scope

In scope: the CareerPilot codebase and its default Docker Compose deployment.

Out of scope (report to the relevant party instead): vulnerabilities in third-party dependencies (report upstream; we track advisories via `osv-scanner`), in LLM providers or licensed data providers you configure, or in your own hosting/infrastructure.

## Security posture (for self-hosters)

CareerPilot is designed to be run by individuals on their own infrastructure. Key controls, detailed in the [security model](docs/07-security-model.md):

- **Secrets never in source or the database in plaintext** — `.env` and an encrypted secrets store only. `gitleaks` runs in CI.
- **Human-in-the-loop for all outbound actions** — nothing is submitted on your behalf without explicit approval ([ADR-003](docs/adr/ADR-003-human-in-the-loop-apply.md)).
- **Isolated, hardened browser-runner** — read-only rootfs, no shared cookies between tasks, downloads disabled.
- **Append-only audit log** of security-relevant and outbound actions, surfaced in an in-app Activity view.
- **Prompt-injection resistance** — MCP tools are read-only by default and expose no irreversible actions; untrusted job-description content is treated as data, not instructions.
- **Supply-chain checks** in CI: dependency scanning (`osv-scanner`), secret scanning (`gitleaks`), static analysis (CodeQL), image scanning (`trivy`), and signed release provenance.

Your deployment's security also depends on **you**: keep your host patched, protect your `.env`, use strong credentials, and prefer a local LLM if you don't want any data leaving your machine.

## Hardening checklist for operators

- [ ] Set a strong password and enable TOTP 2FA.
- [ ] Keep `.env` off version control and restrict its file permissions.
- [ ] Terminate TLS (the bundled Caddy service does this by default).
- [ ] Restrict network exposure — don't expose Postgres/Redis/browser-runner ports publicly.
- [ ] Enable the backup service and test a restore.
- [ ] Review the in-app Activity log periodically.

_This document describes the project's security process and design intent. It is not a warranty. See the [LICENSE](LICENSE) disclaimer of warranties._
