# ADR-004: Connector Plugin Architecture with Compliance Classes

**Status:** Accepted (supersedes 0.1 draft) | **Date:** 2026-07-09
**Decision record for the LinkedIn/Indeed coverage question.**

## Context
Extensibility to new job platforms is a core requirement; platforms differ wildly in access legitimacy. Stakeholder requires LinkedIn and Indeed coverage in phase 1. Investigation (2026-07) established the constraints:
- **Indeed**: Publisher Job Search API deprecated for new integrations; no official job-seeker search API remains. Every direct access path is unofficial scraping or a paid third-party reseller.
- **LinkedIn**: hiQ line protects only *logged-out public* scraping under the CFAA; LinkedIn's User Agreement §8.2 contractually bans automated collection regardless of public/private. hiQ paid a ~$500K judgment + permanent ban for User-Agreement breach (logged-in collection was the worst-hit conduct). LinkedIn sued Proxycurl in 2025; that data API shut down entirely.

Two rejected implementations for LinkedIn/Indeed coverage:
- **First-party server-side scrapers** — makes the OSS repo a C&D/DMCA takedown target; anti-bot arms race = permanent maintenance tax; brittle.
- **Credentialed login + unattended scroll-harvest** — strictly worse: forfeits the hiQ public-data protection by authenticating, breaches §8.2 head-on, requires storing users' primary-network credentials/sessions, and predictably gets the user's own account banned (platforms tolerate ~20–50 human-paced actions/day; bulk harvest blows past instantly).

## Decision
`ConnectorPort` contract in `packages/connectors/sdk`: `fetchJobs(cursor)` / `normalize` / `healthCheck` / `configSchema` (zod) / `metadata {key, complianceClass}`. Registry pattern; connectors are workspace packages that must pass the shared contract test-kit to register.

Coverage is delivered through **four connector compliance classes**:

- **Class A — Official APIs & public feeds** (shipped first-party): Greenhouse, Lever, Ashby, USAJobs, RSS, manual paste. Zero legal risk.
- **Class B — User-session capture** (shipped first-party; the LinkedIn/Indeed on-ramp): a browser extension / bookmarklet. The user is already logged into their own account viewing a job they're authorized to see; a "Capture to CareerPilot" action posts the *already-rendered* page to their pipeline. User-initiated, single-item, no stored credentials, no automated login, no server-side bot, no scroll loop. Posture is closer to copy-paste than to scraping.
- **Class C — BYO-key licensed provider adapters** (shipped first-party; secondary LinkedIn/Indeed path): adapters for licensed third-party job-data providers (e.g. Google Jobs via SerpApi, Mantiks, Bright Data, Coresignal). The user supplies their own paid key; scraping and compliance liability sit with the licensed provider under the user's contract with them. CareerPilot ships an adapter, not a scraper.
- **Class D — ToS-prohibited direct automation** (NEVER first-party): server-side scraping or credentialed login-harvest of platforms whose ToS forbid it (LinkedIn/Indeed direct). The SDK does not technically block community forks, but the project neither ships, documents, nor endorses Class D. Credentialed login automation against such platforms is explicitly excluded (consistent with the Playwright design doc).

## Consequences
+ LinkedIn/Indeed coverage lands in phase 1 (via B and C) without the project or its users touching a scraper or a login bot.
+ New platform = new package, zero core changes; test-kit keeps quality uniform.
+ Class B needs no credentials — strictly less to store, maintain, and get anyone banned.
+ Legal posture explicit, reviewable, and defensible.
− Class B is one-job-at-a-time (user-driven), not bulk auto-discovery.
− Class C costs the user money and coverage varies by provider.
− Users expecting "unattended mass discovery from LinkedIn" are not served; that is a deliberate, documented non-goal.

## Boundary note (why assisted-apply automation is still fine)
The excluded thing is *credentialed bulk harvesting*. Assisted-apply (ADR-003) is attended, single-item, user's own session, one form the user opened and watches — the defensible axis. The line is "attended single-action" vs "credentialed bulk harvesting," not "browser automation good/bad."
