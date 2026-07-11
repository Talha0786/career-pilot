# CareerPilot AI — Playwright / Browser Automation Design

**Version:** 0.1 | **Status:** PROPOSED | Governed by ADR-003 (human-in-the-loop) and ADR-004 (compliance tiers)

## 1. Scope — and what this is NOT

The browser-runner does **assisted application**: it opens a career-site application form, maps and pre-fills fields from the user's profile, uploads documents, and **stops before submission**. The user reviews every field (live screencast + field-value diff) and either approves submission or submits manually.

Not in scope, by design: unattended mass-apply, CAPTCHA solving/bypass, login automation against platforms whose ToS prohibit automation, fingerprint spoofing. These aren't deferred features; they are exclusions (see ADR-003/004 for reasoning). Community connectors that violate a platform's ToS fall under ADR-004 Class D and are never shipped, documented, or endorsed first-party.

## 2. Process Architecture

- Separate `browser-runner` service. Reasons: Chromium memory/crash isolation; different security posture (it touches arbitrary third-party pages); horizontal scaling of browser capacity independent of API.
- One **fresh browser context per ApplyTask** (no shared cookies between tasks unless user explicitly saves a site session, stored encrypted).
- Internal task API bound to the compose network only; authenticated with a service token; never internet-exposed.
- Runner is stateless: all task state in Postgres (`apply_tasks`, `apply_task_steps`), so crash → resume or safe abort. The submit step is guarded by single-use approval token consumption (exactly-once).

## 3. ApplyTask State Machine

```
draft → mapping → filling → awaiting_review → approved → submitting → submitted
                     │              │                          │
                     └──────────────┴──────→ failed / aborted ─┘
```

- Every transition + every browser action appended to `apply_task_steps` with a redacted payload and a screenshot key.
- `awaiting_review → approved` only via user action in web UI, which mints the approval token (5-min TTL, single-use). Multiple tasks may sit in `awaiting_review` simultaneously and be approved from a **batch review queue** (ADR-003) — each approval mints its own token and each submission is individually consented; batching reduces per-form friction without weakening per-application consent.
- Timeouts: mapping 90s, filling 120s, awaiting_review 30 min (then aborted, context closed).

## 4. Form Detection & Field Mapping

Three-stage pipeline, cheapest first:

1. **Known-ATS adapters**: Greenhouse, Lever, Ashby, Workday hosted forms have stable structures → deterministic selector maps, versioned per ATS, covered by recorded-fixture tests.
2. **Heuristic detection**: label/`name`/`autocomplete`/aria attributes → canonical field taxonomy (name, email, phone, resume-upload, work-auth, EEO questions…).
3. **LLM field mapper (fallback)**: serialized accessible form tree → LLM classifies fields into the taxonomy with confidence scores. Low-confidence fields are left blank and flagged for the user. LLM never invents answer content for open questions — it can *draft* answers to essay questions only when the user opts in per-task, and drafts are always part of the review diff.

Sensitive-field policy: EEO/demographic/veteran/disability questions are **never auto-filled**; they are surfaced to the user untouched.

## 5. Anti-Fragility (selector drift is the steady state)

- Selector maps versioned; nightly canary tasks run against ATS sandbox/demo forms; failures flip the ATS adapter to `DEGRADED` and fall back to heuristic+LLM mapping.
- Structured `MappingFailure` telemetry (which stage failed, taxonomy field, anonymized form signature) feeds a triage dashboard.
- Graceful degradation ladder: known-ATS map → heuristics → LLM map → "copy-paste assist" mode (side-panel showing user's values to paste manually). The product never dead-ends.

## 6. Security posture of the runner

- Container: no volume mounts except tmp screenshot dir; read-only rootfs; seccomp default; egress allowlist optional (self-host toggle).
- Downloads disabled; uploads restricted to document-store files referenced by the task.
- Screenshots stored in object store, retained 30 days, encrypted at rest; payload logs redact values of password/SSN-pattern fields (uploaded resumes obviously contain PII — see Security Model §5 for data classification).
- CDP screencast to the web UI over authenticated WS; view limited to the task owner.

## 7. Testing Strategy (this component)

| Layer | Approach |
|---|---|
| Selector maps | Playwright tests against recorded HTML fixtures per ATS version |
| Heuristic mapper | Unit tests on a corpus of 100+ real (sanitized) form snapshots |
| LLM mapper | Golden-set eval: form tree → expected taxonomy; regression gate ≥95% on P0 fields |
| State machine | Property tests: no path reaches `submitting` without unconsumed token |
| End-to-end | Local mock career site (fixture app in `e2e/mock-ats/`) exercised in CI |

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ToS violation claims against the project | High | ADR-003/004; no first-party Class D connectors or login-automation; docs disclaimers; HITL default |
| CAPTCHA blocks task | Expected | Surface to user in screencast — the human completes it; never automated |
| Wrong data submitted | High | Mandatory field diff review; sensitive fields never auto-filled; exactly-once submit |
| Chromium resource exhaustion | Medium | Context pool cap, per-task memory limits, task queue backpressure |
