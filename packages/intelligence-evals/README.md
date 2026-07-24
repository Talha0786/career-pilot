# @careerpilot/intelligence-evals

Task 042's M5 intelligence eval suite — a first-class workspace package
(unlike `docs/eval`, which started as a bolt-on during the M3/M4 merge and
only later grew a `package.json`; this package gets one from the start).

Three independent runners, one per pipeline this milestone shipped:

| Runner | Pipeline under test | Needs a live LLM? |
| --- | --- | --- |
| `eval:resume-import` | task 023's heuristic resume field mapper | No — pure function, no LLM in the path |
| `eval:matching` | task 038's `makeScoreMatchUseCase` | Yes — chat + embeddings |
| `eval:tailoring` | task 039/040's `makeTailorDocumentUseCase` (generate → adversarial verify → retry) | Yes — chat |

Run all three: `pnpm --filter @careerpilot/intelligence-evals run eval`.
Run one: `pnpm --filter @careerpilot/intelligence-evals run eval:tailoring`
(etc.). Every runner writes a timestamped JSON report to
`packages/intelligence-evals/results/` (gitignored — see `.gitignore`'s task
042 note; each run gets its own file rather than a single file that
accumulates diffs).

## What each gate actually checks

- **`eval:resume-import`** — migrates task 023's field-accuracy benchmark
  verbatim from `docs/eval/resume-import-benchmark/score.ts` (same 12-resume
  fixture corpus, same hand-labeled ground truth, same 90% threshold).
  `docs/eval/resume-import-benchmark/` is left in place as the historical
  task-023 evidence trail; this package is the new source of truth going
  forward.
- **`eval:matching`** — scores 5 golden `(profile, job posting)` fixtures
  (`fixtures/matching/*.json`) with human-labeled `expectedOverall` scores
  spanning strong-fit, strong-mismatch, moderate/adjacent-skills,
  seniority-mismatch, and domain-mismatch-with-strong-skills. Reports
  **Spearman rank correlation** as the primary metric (chosen over Pearson —
  see `src/run-matching-eval.ts`'s doc comment: ranking candidates correctly
  is what the feature needs, and Spearman isn't punished by a systematic
  scale offset between the model's calibration and the human labeler's).
  The correlation threshold is a **soft warning**, not a hard gate — 5
  fixtures is too small a sample for a numeric floor to be statistically
  meaningful. The run only hard-fails on an actual pipeline error or a
  negative (anti-correlated) result.
- **`eval:tailoring`** — the highest-stakes runner, and the one hard,
  non-negotiable gate in this package. Fixtures
  (`fixtures/tailoring/*.json`) include deliberate **trap prompts**: a job
  posting demanding a qualification (a PMP certification, 10+ years of
  experience) the profile's facts do not support. For every trap fixture,
  the FINAL PERSISTED document version must never contain the trapped claim
  as clean, unflagged content — either the model never fabricates it, or the
  adversarial claim-verification pass (task 040) catches it and the version
  ends up `needsHumanReview: true` with the claim in `flaggedClaims`. A trap
  term surviving into the final content WITHOUT being flagged fails the run.
  A control (non-trap) fixture checks the opposite failure mode: over-flagging
  legitimate, well-supported content would make the feature unusable even
  though it's technically "safe."

## Pinned models

"Pinned" (`src/pinned-models.ts`) means: this is the exact model version the
gates above are calibrated against, same posture as pinning an npm
dependency. The default pins (`llama3.1` for chat, `nomic-embed-text` for
embeddings) are the SAME models `apps/worker/src/main.ts` boots with
key-free by default (ADR-006) — this package evaluates the models
production actually ships with, not a separate "eval-only" model that could
mask a real regression. Override via `EVAL_CHAT_MODEL` /
`EVAL_EMBEDDING_MODEL` env vars for a BYO-cloud-key run against a stronger
model (ADR-006's "quality-critical tasks" path); point `EVAL_LLM_BASE_URL` /
`EVAL_LLM_API_KEY` at any OpenAI-compatible endpoint.

Bumping a pin is a deliberate, reviewed change — re-run the suite and look
at whether the correlation number and the trap-fixture outcomes move before
committing a new default.

## Running locally

The matching/tailoring runners need a reachable OpenAI-compatible chat
endpoint (and, for matching, an embeddings endpoint too). Local, key-free
default is Ollama:

```sh
docker run -d --name ollama-eval -p 11434:11434 -v ollama-eval-data:/root/.ollama ollama/ollama
docker exec ollama-eval ollama pull llama3.1
docker exec ollama-eval ollama pull nomic-embed-text
pnpm --filter @careerpilot/intelligence-evals run eval
```

If no endpoint is reachable, `eval:matching`/`eval:tailoring` fail fast with
a clear message (`src/harness.ts`'s `assertLlmReachable`) rather than
silently downgrading to a canned/scripted LLM stand-in — task 042's whole
point is to catch REAL scoring-quality and claim-leakage regressions against
a real model; a scripted response would only ever prove the harness's own
fixture data, never the pipeline's actual behavior. (`eval:resume-import` has
no LLM in its path and is unaffected.)

## Nightly CI

`.github/workflows/nightly.yml`'s `intelligence-evals` job installs real
Ollama (same `curl -fsSL https://ollama.com/install.sh | sh` pattern the
pre-existing `ollama-contract` job already uses), pulls the pinned models,
and runs this package's full suite for real — unlike this sandbox's
development runs, nightly CI has full internet access and a clean runner
every time, so it's the actual, unconditional gate. The job **fails the
workflow** (no `continue-on-error`) if the tailoring runner's trap-fixture
gate fails; the matching runner's correlation is reported but not currently
a hard CI gate, matching its own soft-warning posture above.

## Adding a fixture

- **Matching**: drop a new `fixtures/matching/<id>.json` — `{ id, notes,
  expectedOverall, profile: { sections: [...] }, job: { title, company,
  descriptionMd } }`. `profile.sections[].content` must satisfy the same
  validation `ProfileSection.create` enforces (see
  `packages/domain/src/profile/profile-section.ts`) — the runner constructs
  a real `CareerProfile` aggregate from it, so an invalid section throws
  loudly rather than silently skipping.
- **Tailoring**: drop a new `fixtures/tailoring/<id>.json` — same
  `profile`/`job` shape, plus `kind` (`"resume"` or `"cover_letter"`),
  `isTrap`, and (for trap fixtures) `trapTerms` — an array of substrings the
  final document must never contain unflagged. Keep a trap fixture's
  fabrication target UNAMBIGUOUS (a specific certification name, a specific
  number) so a leak is a clear string match, not a judgment call.
- **Resume import**: add `fixtures/resume-import/fixtures/<id>.txt` (raw
  resume text) and a matching hand-labeled
  `fixtures/resume-import/labels/<id>.json` — see any existing label file
  for the dotted-key field shape `run-resume-import-eval.ts` checks against.
