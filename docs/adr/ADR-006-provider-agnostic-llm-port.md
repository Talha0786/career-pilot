# ADR-006: Provider-Agnostic LLM Port; Local-Default, BYO-Key-Recommended

**Status:** Accepted | **Date:** 2026-07-09

## Context
Self-hosters demand BYO keys and local models; costs must be controllable; every AI feature must be auditable. Pure BYO-key (0.1 draft) has a hidden adoption tax: a non-technical self-hoster must obtain and pay for a cloud API key before the product does anything, which kills first-run experience. But the highest-value tasks (resume tailoring, claim verification) are quality-sensitive, and small local models degrade them — precisely where the anti-hallucination contract lives.

## Decision
`LlmPort` (complete/embed/stream) with adapters: Anthropic and OpenAI-compatible (covers OpenAI, Ollama, vLLM). Task-class → model-tier routing in config. All dispatch flows through BudgetGuard (pre-check hard stop) + invocation accounting; the raw port is not injectable outside the composition root. Prompts are versioned, reviewed, schema-validated.

**Posture (refinement over 0.1 draft):**
- **The system MUST boot and perform non-critical tasks (parsing, embedding, matching, interview prep) with zero cloud key**, defaulting to a local OpenAI-compatible endpoint (Ollama). First run works offline and free.
- **BYO cloud key is the *recommended* path for quality-critical tasks** (tailoring, claim verification). Config routing lets these tasks target a stronger model.
- If a quality-critical task is routed to a local model below a capability threshold, the UI shows a **non-blocking quality warning** on that output (the human-review gate from ADR-003 still applies regardless).
- No bundled/project-funded provider — unviable for OSS.

## Consequences
+ No vendor lock; local-first users fully served; first-run needs no signup or spend.
+ Costs bounded and visible; uniform audit trail enables evals.
+ Quality-sensitive paths nudge toward capable models without hard-requiring them.
− Local-default means out-of-box tailoring quality varies by the user's hardware/model — mitigated by the warning + mandatory human review, but expectations must be set in docs.
− Two adapters to maintain; capability flags added to the port only when a provider feature demands them.
