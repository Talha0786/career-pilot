# CareerPilot AI — AI Agent Design

**Version:** 0.1 | **Status:** PROPOSED

## 1. Philosophy: pipelines first, agency last

Most "agent" work here is **deterministic pipelines with LLM steps**, not open-ended tool-loop agents. Autonomy is a liability in a product whose outputs are legal-adjacent documents (resumes) and outbound actions (applications). Agentic loops are used only where the task genuinely requires iteration (mock interview, research).

## 2. LLM Abstraction (ADR-006)

```ts
interface LlmPort {
  complete(req: CompletionRequest): Promise<Result<CompletionResponse, LlmError>>;
  embed(req: EmbedRequest): Promise<Result<EmbedResponse, LlmError>>;
  stream(req: CompletionRequest): AsyncIterable<CompletionDelta>;
}
```

- Adapters: `anthropic`, `openai-compatible` (covers OpenAI, Ollama, vLLM, LM Studio).
- Model routing config: each task class (parse, map, tailor, verify, chat, embed) maps to a model tier in config. The system boots and runs non-critical tasks (parse, embed, match, interview prep) key-free on a local OpenAI-compatible endpoint (Ollama); a BYO cloud key is *recommended* for quality-critical tasks (tailoring, claim verification). When a quality-critical task runs on a local model below a capability threshold, its output carries a non-blocking quality warning (ADR-006). The mandatory human-review gate applies regardless of model.
- Every call passes through `BudgetGuard` (pre-check) and writes `ai_invocations` (post). No LLM call can bypass this — enforced by making `LlmPort` injectable only via the guarded decorator in the composition root.
- Prompts are versioned files (`prompts/{task}/{version}.md`) with frontmatter (model tier, temperature, output schema ref). Prompt changes are code-reviewed like code.
- All structured outputs validated with zod; on validation failure → one repair attempt → fail the job with the raw output stored for triage.

## 3. Task Inventory

| Task | Type | Model tier | Structured output | Safety gate |
|---|---|---|---|---|
| Resume parsing (import) | pipeline | mid | ProfileDraft schema | user confirms parsed fields |
| Job normalization assist | pipeline | small | JobFields schema | dedup + heuristics first, LLM only for gaps |
| Match rubric scoring | pipeline | mid | ScoreComponents schema | embedding prefilter caps volume |
| **Resume/CL tailoring** | pipeline | large | StructuredDoc schema | claim verification (below) + human review |
| Claim verification | pipeline | mid | ClaimAudit schema | blocks unverifiable output |
| Form field mapping | pipeline | mid | FieldMap schema | low-confidence → blank + flag |
| Interview Q&A generation | pipeline | mid | QuestionSet schema | — |
| Mock interviewer | agent (chat loop) | large | — | read-only tools |
| Company research brief | agent (tool loop) | mid | Brief schema | web tools read-only, source citations required |

## 4. The Anti-Hallucination Contract (tailoring)

This is the highest-stakes AI feature: a fabricated credential on a resume harms the user materially.

1. **Fact base**: profile sections are compiled to a numbered fact list (`F1: "Led migration of X at Company Y, 2021–2023"`). The tailoring prompt may *rephrase, reorder, emphasize, quantify only from provided numbers* — it may not introduce entities, employers, dates, titles, credentials, or metrics absent from facts.
2. **Claim verification pass** (separate call, different prompt, adversarial framing): extract every factual claim from the draft → map each to a fact ID or mark `UNSUPPORTED`.
3. Unsupported claims → targeted regeneration (≤2 retries) → else `needs_human` with flagged claims highlighted in the review UI.
4. Human review is **non-skippable** before export/use. The UI shows a semantic diff against the base document and the claim→fact mapping.
5. Eval harness: golden set of (profile, JD) pairs with known trap prompts (JD demands a certification the profile lacks); regression gate: 0 unsupported claims surviving verification.

## 5. Agentic loops (the two that earn it)

- **Mock interviewer**: chat loop over (JD + profile + question bank); tools: `get_profile`, `get_job` (read-only). Session transcript stored under `interview_preps`. Turn cap 40; budget-guarded.
- **Company research**: bounded tool loop (max 8 tool calls): web search/fetch → synthesize brief with citations. No write tools. Output schema-validated; uncited claims dropped.

Both run in the worker with the same idempotency/retry rules as other jobs.

## 6. Evaluation & Regression

- `packages/intelligence-evals/`: dataset fixtures + eval runner executed in CI nightly (not per-PR — cost) against pinned models.
- Metrics tracked over time: parse field-accuracy, mapper P0 accuracy, tailoring unsupported-claim rate, rubric score correlation with human-labeled sample.
- Any prompt or model-routing change requires an eval run linked in the PR.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Fabricated resume content | Facts contract + verification + mandatory human review (§4) |
| Prompt injection from JDs into tailoring/research | JDs wrapped as data with injection guards; research agent has no write tools |
| Model/provider drift silently degrades quality | Pinned models per routing config; nightly evals; version bump = eval run |
| Cost blowout | BudgetGuard hard stop; tiered routing; embedding prefilter before LLM scoring |
