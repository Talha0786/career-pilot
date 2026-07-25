import { asUserId, asApplyTaskId, notFound, invalidTransition, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ApplyTaskRepository } from '../../ports/repositories.js';
import type { FieldDetectionPort, DetectedField } from '../../ports/field-detection.port.js';
import { makeMapFieldsWithLlmUseCase } from './map-fields.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';

/** Mirrors heuristic-mapper.ts's own floor (task 049) — kept in sync manually, same documented posture as map-fields.ts. */
const CONFIDENCE_FLOOR = 0.35;
/** docs/05-playwright-design.md §3: "Timeouts: mapping 90s". */
const MAPPING_TIMEOUT_MS = 90_000;

export interface RunMappingInput {
  readonly userId: string;
  readonly applyTaskId: string;
  readonly profileFactsText: string;
  readonly allowEssayDrafting: boolean;
}

export interface RunMappingOutput {
  readonly atsAdapter: string | null;
  readonly fields: readonly DetectedField[];
  /**
   * Task 055 — docs/05-playwright-design.md §5's degradation ladder's last
   * rung: true when NONE of the three mapping stages (048/049/050)
   * resolved a single usable (non-sensitive) field. The caller (task 051's
   * orchestration, or a UI trigger) should route this task toward
   * copy-paste-assist (`apps/web/src/app/apply/copy-paste-assist/page.tsx`)
   * rather than proceeding to `fill-runner.ts`'s `filling` stage, which
   * would have nothing to fill. Deliberately NOT a `failed` transition —
   * "the product never dead-ends" (§5) is the whole point of this flag.
   */
  readonly manualAssistRequired: boolean;
}

/**
 * Task 051 — `draft → mapping`: 048's known-ATS detect + 049's heuristics
 * run behind `FieldDetectionPort` (implemented by `apps/browser-runner`,
 * which is the only place a live Playwright `Page` exists — see
 * `packages/domain/src/apply/field-taxonomy.ts`'s doc comment for the full
 * boundary-rule reasoning), then 050's LLM stage runs in-process for
 * whatever the port left unresolved/low-confidence. `mapping → filling` is
 * a SEPARATE transition (`apps/browser-runner/src/fill-runner.ts`) — this
 * command's job ends at persisting the computed field map, since actually
 * typing into the page is itself a Playwright-dependent action that
 * belongs in that same app, not here.
 */
export function makeRunMappingUseCase(deps: {
  applyTasks: ApplyTaskRepository;
  fieldDetection: FieldDetectionPort;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
  now?: () => Date;
  /** Overridable so tests can actually trigger the timeout path without waiting 90 real seconds — defaults to the design doc's 90s. */
  mappingTimeoutMs?: number;
}) {
  const mapFieldsWithLlm = makeMapFieldsWithLlmUseCase({ llm: deps.llm, prompts: deps.prompts, model: deps.model });
  const timeoutMs = deps.mappingTimeoutMs ?? MAPPING_TIMEOUT_MS;

  return async function runMapping(input: RunMappingInput): Promise<Result<RunMappingOutput, DomainError>> {
    const userId = asUserId(input.userId);
    const applyTaskId = asApplyTaskId(input.applyTaskId);

    const task = await deps.applyTasks.findByIdForUser(applyTaskId, userId);
    if (task === null) return err(notFound('ApplyTask not found'));
    if (task.stage !== 'draft') {
      return err(invalidTransition(`ApplyTask is in stage '${task.stage}', not 'draft' — mapping already ran or is not applicable`));
    }

    // Enter 'mapping' FIRST, unconditionally — the state machine (045) has
    // no draft→failed edge (only mapping/filling/awaiting_review/submitting
    // can reach failed, per the design doc's diagram), so a failure that
    // happens WHILE attempting to map must already be inside the 'mapping'
    // stage for the failure transition below to be legal. This also matches
    // the "stateless, crash → resume" design (§2): if the process dies
    // right after this save, a resumed task correctly reads back as
    // 'mapping' (retryable), never stuck looking like it was never attempted.
    const entered = task.transitionTo('mapping', 'mapping-started');
    if (!entered.ok) return err(entered.error);
    await deps.applyTasks.save(task);

    let detection: Awaited<ReturnType<FieldDetectionPort['detectAndScore']>>;
    try {
      detection = await withTimeout(deps.fieldDetection.detectAndScore(input.applyTaskId), timeoutMs);
    } catch {
      task.transitionTo('failed', 'mapping-timeout', { timeoutMs });
      await deps.applyTasks.save(task);
      return err(invalidTransition(`Field detection timed out after ${timeoutMs}ms — task moved to failed`));
    }

    const confidentSelectors = new Set(
      detection.detected.filter((d) => d.confidence >= CONFIDENCE_FLOOR || d.neverAutoFill).map((d) => d.selector),
    );
    const lowConfidenceFields = detection.allFields.filter((f) => !confidentSelectors.has(f.selector));

    const llmResult = await mapFieldsWithLlm({
      userId: input.userId,
      applyTaskId: input.applyTaskId,
      lowConfidenceFields,
      profileFactsText: input.profileFactsText,
      allowEssayDrafting: input.allowEssayDrafting,
    });
    if (!llmResult.ok) {
      task.transitionTo('failed', 'mapping-llm-error', { message: llmResult.error.message.slice(0, 500) });
      await deps.applyTasks.save(task);
      return err(invalidTransition(`Field mapping failed: ${llmResult.error.message}`));
    }

    const confidentDetected = detection.detected.filter((d) => confidentSelectors.has(d.selector));
    const finalFields: DetectedField[] = [...confidentDetected, ...llmResult.value];
    // A field that's only ever surfaced-unfilled (neverAutoFill) is not a
    // "usable mapped field" for this purpose — the ladder is about whether
    // there's anything left to actually FILL, not merely detect.
    const usableFields = finalFields.filter((f) => !f.neverAutoFill);
    const manualAssistRequired = usableFields.length === 0;

    if (detection.atsAdapter) task.setAtsAdapter(detection.atsAdapter);
    // Already IN 'mapping' (entered above) — this is an in-stage action
    // record (045's `recordAction`), not a transition; `mapping → mapping`
    // would be an illegal self-transition.
    task.recordAction('field-map-computed', {
      atsAdapter: detection.atsAdapter,
      atsAdapterVersion: detection.atsAdapterVersion,
      totalFields: detection.allFields.length,
      mappedFields: finalFields.length,
      llmInvoked: lowConfidenceFields.length > 0,
      manualAssistRequired,
    });
    await deps.applyTasks.save(task);

    return ok({ atsAdapter: detection.atsAdapter, fields: finalFields, manualAssistRequired });
  };
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
