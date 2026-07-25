import type { Page } from 'playwright';
import { ApplyTask, TAXONOMY, type TaxonomyFieldKey } from '@careerpilot/domain';
import type { ApplyTaskRepository } from '@careerpilot/application';
import type { DetectedField } from '@careerpilot/application';

/** docs/05-playwright-design.md §3: "Timeouts: ... filling 120s." */
export const FILLING_TIMEOUT_MS = 120_000;

export interface FillRunnerInput {
  readonly page: Page;
  readonly task: ApplyTask; // must be in 'mapping' stage
  readonly fieldMap: readonly DetectedField[];
  /**
   * Resolved values keyed by taxonomy field, supplied by the caller.
   * KNOWN LIMITATION (documented, not silently assumed): `CareerProfile`
   * (M3) has no first-class "contact info" section distinct from
   * experience/education/skills — resolving `firstName`/`email`/`phone`
   * from real user data is therefore left to the CALLER (task-api.ts's
   * mapping/filling trigger) rather than done here, since inventing that
   * resolution logic is outside this task's own file list. `fill-runner.ts`
   * is deliberately just the Playwright-mechanics + timeout + redacted-step
   * layer, given whatever values the caller already resolved.
   */
  readonly valuesByKey: Readonly<Partial<Record<TaxonomyFieldKey, string>>>;
  /** §6: "uploads restricted to document-store files referenced by the task" — a single resolved local path, never an arbitrary one from the field map. */
  readonly resumeFilePath: string | null;
  readonly timeoutMs?: number;
}

export interface FillStepRecord {
  readonly selector: string;
  readonly taxonomyKey: TaxonomyFieldKey;
  readonly action: 'fill' | 'select' | 'upload' | 'skip-no-value' | 'skip-sensitive' | 'error';
  /** Redacted per §6 — never the raw value, only whether one was applied and (on error) the error class. */
  readonly detail: string | null;
  /**
   * Task 052 — carried through from the field map so the review-diff
   * endpoint (`task-api.ts`'s `GET /internal/tasks/:id/fields`) can
   * reconstruct "how was this decided" without a second lookup. Still
   * NEVER the actual filled VALUE (§6's redaction rule is about this
   * audit-log row specifically) — the diff endpoint reads the real
   * submittable value separately, from the LIVE page DOM, which is the
   * only place a "what will actually be submitted" answer can honestly
   * come from.
   */
  readonly confidence: number;
  readonly source: 'known_ats' | 'heuristic' | 'llm';
  readonly neverAutoFill: boolean;
}

export interface FillRunnerOutput {
  readonly steps: readonly FillStepRecord[];
  readonly filledCount: number;
}

/**
 * Task 051 — `mapping → filling`: drives Playwright to actually fill the
 * mapped fields and upload the resume, honoring the 120s timeout (design
 * doc §3) and the never-auto-fill invariant (sensitive fields are always
 * `action: 'skip-sensitive'`, never touched, regardless of what's in
 * `valuesByKey` — defense in depth again, same posture as 048/049/050's
 * own independent enforcement). On success, transitions to
 * `awaiting_review`; on timeout, transitions to `failed` — a task is never
 * left hanging mid-fill.
 */
export async function runFillStage(
  input: FillRunnerInput,
  applyTasks: ApplyTaskRepository,
): Promise<{ ok: true; output: FillRunnerOutput } | { ok: false; reason: string }> {
  const timeoutMs = input.timeoutMs ?? FILLING_TIMEOUT_MS;

  const startTransition = input.task.transitionTo('filling', 'fill-started');
  if (!startTransition.ok) {
    return { ok: false, reason: startTransition.error.message };
  }
  await applyTasks.save(input.task);

  try {
    const output = await withTimeout(fillAllFields(input), timeoutMs);
    // One `apply_task_steps` row per field action (task 051's acceptance
    // criterion), recorded via `recordAction` — NOT `transitionTo` (a
    // same-stage `filling → filling` call would be an illegal self-transition
    // by the state machine; `recordAction` is the in-stage action-log path
    // task 045 added specifically for this).
    for (const s of output.steps) {
      input.task.recordAction(s.action, {
        taxonomyKey: s.taxonomyKey, selector: s.selector, detail: s.detail,
        confidence: s.confidence, source: s.source, neverAutoFill: s.neverAutoFill,
      });
    }

    const completion = input.task.transitionTo('awaiting_review', 'fill-complete', {
      filledCount: output.filledCount,
      totalFields: input.fieldMap.length,
    });
    if (!completion.ok) return { ok: false, reason: completion.error.message };
    await applyTasks.save(input.task);

    return { ok: true, output };
  } catch {
    input.task.transitionTo('failed', 'filling-timeout', { timeoutMs });
    await applyTasks.save(input.task);
    return { ok: false, reason: `Filling timed out after ${timeoutMs}ms` };
  }
}

async function fillAllFields(input: FillRunnerInput): Promise<FillRunnerOutput> {
  const steps: FillStepRecord[] = [];
  let filledCount = 0;

  for (const field of input.fieldMap) {
    const base = { selector: field.selector, taxonomyKey: field.taxonomyKey, confidence: field.confidence, source: field.source, neverAutoFill: field.neverAutoFill };

    if (field.neverAutoFill) {
      steps.push({ ...base, action: 'skip-sensitive', detail: null });
      continue;
    }

    if (field.taxonomyKey === 'resumeUpload' || field.taxonomyKey === 'coverLetterUpload') {
      if (!input.resumeFilePath) {
        steps.push({ ...base, action: 'skip-no-value', detail: null });
        continue;
      }
      try {
        await input.page.setInputFiles(field.selector, input.resumeFilePath);
        steps.push({ ...base, action: 'upload', detail: 'ok' });
        filledCount++;
      } catch (e) {
        steps.push({ ...base, action: 'error', detail: errorClass(e) });
      }
      continue;
    }

    const value = input.valuesByKey[field.taxonomyKey];
    if (value === undefined) {
      steps.push({ ...base, action: 'skip-no-value', detail: null });
      continue;
    }

    try {
      const inputType = TAXONOMY[field.taxonomyKey].inputType;
      if (inputType === 'select') {
        await input.page.selectOption(field.selector, value);
        steps.push({ ...base, action: 'select', detail: 'ok' });
      } else if (inputType === 'radio') {
        // Radio groups share one selector across multiple <input>s — pick the option whose value matches.
        await input.page.locator(`${field.selector}[value="${value}"]`).check();
        steps.push({ ...base, action: 'select', detail: 'ok' });
      } else {
        await input.page.fill(field.selector, value);
        steps.push({ ...base, action: 'fill', detail: 'ok' });
      }
      filledCount++;
    } catch (e) {
      steps.push({ ...base, action: 'error', detail: errorClass(e) });
    }
  }

  return { steps, filledCount };
}

function errorClass(e: unknown): string {
  // Redacted — never the raw Playwright error message (which can embed
  // page content/selector context), just a short class label for triage.
  return e instanceof Error ? e.constructor.name : 'UnknownError';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}
