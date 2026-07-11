# ADR-003: Human-in-the-Loop Application Submission

**Status:** Accepted | **Date:** 2026-07-09

## Context
"Auto-apply" is the headline feature users ask for and the primary legal/ethical exposure: major platforms' ToS prohibit automation; unattended submission risks sending wrong or hallucinated data under the user's name, irreversibly, to an employer; an OSS project endorsing ToS violations invites takedowns.

The naive HITL design (approve one form at a time, forever) over-corrects: it caps throughput so hard that volume-oriented users get no meaningful time savings on the submission step, which pushes them toward forks that remove the guardrail entirely — the worst outcome. So the decision is not just "HITL yes/no" but "how to preserve human judgment without artificially crippling throughput."

## Decision
A human must review a field-level diff and explicitly approve every submission. Approval is a single-use, short-TTL token; the submit path is architecturally unreachable without it (domain invariant + DB constraint + property tests). No unattended mode ships in v1. MCP/agents cannot trigger submission.

**Refinement over the 0.1 draft — batch review:** the UI supports a *review queue* where the user inspects N pre-filled applications and approves them in a batch. Each approval still mints its own single-use token and each submission is still individually consented to — the exactly-once and per-application-consent invariants are unchanged — but the human reviews many in one sitting instead of context-switching per form. This keeps human judgment mandatory while removing the per-application friction that would otherwise drive users to unsafe forks. Sensitive fields (EEO/demographic) remain never-auto-filled and always surfaced in the review.

## Consequences
+ Compliance posture defensible; wrong-data risk bounded; complete audit trail.
+ Batch review recovers most of the throughput users actually want without giving up consent.
+ Delivers the real toil savings (tailoring + form-filling ≈ 90% of the work).
− Users wanting fully unattended mass-apply are still not served; some fork. Accepted.
− Batch review is a richer UI surface than single-form approve — more to build/test in M6.

## Revisit trigger
Only if a platform offers an official application-submission API.
