# CareerPilot AI — Deployment Model

**Version:** 0.1 | **Status:** PROPOSED

## 1. Primary Target: single-host Docker Compose

Open-source self-host is the product. The canonical deployment must be: clone → copy `.env.example` → `docker compose up`. Anything harder kills adoption.

```
docker-compose.yml services:
  postgres (pgvector image)     — volume: pgdata
  redis                          — volume: redisdata
  api                            — :8080 behind caddy
  worker                         — scale: 1..N
  browser-runner                 — hardened (see below), scale: 1..N
  mcp-server                     — SSE transport; stdio mode runs via npx locally instead
  web                            — Next.js standalone
  caddy                          — TLS termination (auto-cert), single ingress
  backup (optional profile)      — nightly pg_dump to ./backups or S3
```

- Images: multi-stage builds, distroless/node-slim runtime, non-root user, pinned digests; published to GHCR with SBOM + provenance (GitHub attestations).
- browser-runner container: read-only rootfs, `no-new-privileges`, seccomp profile, tmpfs for Chromium, memory limit, internal network only.
- Health: `/healthz` (liveness) and `/readyz` (deps: PG, Redis) on api/worker/runner; compose healthchecks gate startup ordering.
- Config: env vars only, validated at boot; one `.env` for the stack. Profiles: `minimal` (no runner, no mcp) for tracker-only users.

## 2. Migrations & Upgrades

- Migrations run by a one-shot `migrate` service before api starts (compose `depends_on: condition: service_completed_successfully`).
- Versioning: semver; release notes flag breaking env/schema changes; migrations forward-only; documented rollback = restore backup (honest for a self-host product — no fake down-migrations).

## 3. Secondary Targets

- **Kubernetes (Helm chart, v1.1+):** same images; runner as its own Deployment with PodSecurity restricted profile; HPA on worker queue depth. Not in v1 — chart maintenance is real cost; ship when demand exists.
- **Local dev:** `docker compose -f compose.dev.yml` runs PG/Redis only; apps run via `pnpm dev` with hot reload; seed script creates demo user + fixture jobs.
- **Managed cloud SaaS:** explicitly out of scope v1; architecture keeps the door open (stateless services, object-store abstraction, `actor` plumbing) but no multi-tenant work now.

## 4. CI/CD

Pipeline (GitHub Actions):
1. lint + typecheck (turbo cache)
2. unit tests (all packages)
3. integration tests (ephemeral PG/Redis via services)
4. e2e (compose up full stack + Playwright against web + mock ATS)
5. security scans (CodeQL, osv, gitleaks, trivy)
6. build & push images on tag; deploy job optional (self-hosters pull)

Release gate: e2e green + nightly AI evals not regressed since last release tag.

## 5. Operations for self-hosters

- `docs/operations.md`: backup/restore drill, log locations, resource sizing (baseline: 2 vCPU / 4 GB without runner; +2 GB per concurrent browser context), upgrade steps.
- Built-in status page (`/admin/status`): connector health, queue depths, LLM spend month-to-date, last backup age.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Compose stack too heavy for hobbyists | `minimal` profile; SQLite was considered and rejected (ADR-002) — document sizing honestly |
| Broken upgrades brick user data | migrate-before-start, backup service, upgrade drill in CI (previous release → head) |
| Chromium image bloat | separate runner image; base app images stay slim |
