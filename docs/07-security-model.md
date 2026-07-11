# CareerPilot AI — Security Model

**Version:** 0.1 | **Status:** PROPOSED

## 1. Threat Model (STRIDE summary, self-host posture)

Assets: career PII (resumes, contact info, EEO answers if user enters them), platform credentials, LLM API keys, saved site sessions.

| Threat | Vector | Control |
|---|---|---|
| Credential theft | DB dump, logs, backups | Secrets never in DB plaintext (§4); log redaction; encrypted backups |
| Prompt injection | Malicious JD content → LLM/MCP actions | Data envelopes; no irreversible LLM-triggered actions; MCP read-only default |
| SSRF via connectors/RSS | User-supplied URLs | URL validation, deny private IP ranges, fetch through a pinned egress client with size/time limits |
| XSS via JD HTML | Rendered job descriptions | Sanitize to Markdown at ingestion (rehype-sanitize allowlist); CSP default-src 'self' |
| Browser-runner escape / malicious page | Third-party career sites | Hardened container (read-only FS, seccomp), no shared cookies, downloads off, network posture in Playwright doc §6 |
| Account takeover | Web auth | Argon2id, rate-limited login, session cookies (httpOnly, SameSite=Lax, secure), optional TOTP 2FA, optional OIDC |
| Supply chain | npm deps | pnpm lockfile, `pnpm audit` + osv-scanner in CI, Renovate, minimal-dependency rule, provenance-checked releases |
| Wrong outbound data | Automation submits bad PII | HITL review, sensitive fields never auto-filled, exactly-once submit |

Out of scope v1: multi-tenant isolation guarantees (single-tenant deploy), SOC2-style compliance.

## 2. AuthN / AuthZ

- Web: session cookie auth; passwords argon2id; optional TOTP; optional OIDC (generic provider) for households/teams.
- API tokens & MCP tokens: opaque, hashed at rest, scoped (`read`, `write:pipeline`, `write:documents`, `admin`), expiring, revocable, listed in UI.
- Internal service auth (api ↔ browser-runner, workers): shared service token from secrets store; services bound to compose-internal network.
- Authorization: single-tenant v1 keeps it simple — resource ownership checks in application layer (every use case takes `actor` and asserts ownership). Role enum exists so multi-user households work; RBAC expansion is a v2 concern, but the `actor` plumbing prevents a rewrite.

## 3. Data Classification & Handling

| Class | Examples | Handling |
|---|---|---|
| C3 Secret | LLM keys, connector creds, session cookies | Secrets store only (§4); never logged; never in DB |
| C2 Sensitive PII | Resume contents, contact info, EEO answers, screenshots | Encrypted at rest (PG disk-level + app-level for EEO answers via AES-256-GCM column encryption), redacted in logs, 30-day screenshot retention |
| C1 Personal | Pipeline notes, match scores | Standard DB controls |
| C0 Public | Ingested public job postings | — |

## 4. Secrets Management

- **No secrets in source, images, or DB plaintext.** `.env.example` documents every variable; real `.env` gitignored and referenced by compose.
- `SecretsPort` with providers: (a) env vars (12-factor default), (b) encrypted file store (age/libsodium sealed box, master key from env or OS keychain) for user-entered connector credentials, (c) extensible to Vault later.
- `credentials_ref` in DB is an opaque pointer; rotation = write new secret + update pointer; audit-logged.
- Startup config validation (zod on `process.env`) fails fast with named missing vars — never defaults for secrets.

## 5. Application Security Practices

- All input at trust boundaries zod-validated; Drizzle parameterized queries only (no string SQL).
- Central error handler: typed domain errors → sanitized HTTP problem+json; stack traces only in logs.
- Rate limiting: per-IP on auth routes, per-token on API/MCP, queue backpressure internally.
- Dependency budget rule: adding a dependency requires justification in PR description (enforced by convention + review checklist).
- Security CI: CodeQL, osv-scanner, gitleaks (secret scanning), Docker image scan (trivy).
- `SECURITY.md` with disclosure policy from day one.

## 6. Audit

Append-only `audit_log` (see DB design) for: auth, token lifecycle, credential changes, connector toggles, apply-task approval/submission, exports, MCP tool calls. Surfaced in a UI "Activity" page — self-hosters are their own SOC.
