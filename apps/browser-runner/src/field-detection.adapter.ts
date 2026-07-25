import type { FieldDetectionPort, FieldDetectionResult, DetectedField } from '@careerpilot/application';
import { detectKnownAts } from './ats-maps/index.js';
import { extractFormFields, mapFormFieldsHeuristically } from './heuristic-mapper.js';
import type { ApplyTaskBrowserContextManager } from './context-manager.js';

/**
 * Task 051 — the real `FieldDetectionPort` implementation. Runs stages 1
 * (048's known-ATS `detect()`) and 2 (049's heuristic scorer) against the
 * ApplyTask's live Playwright page, held by `ApplyTaskBrowserContextManager`
 * (the page must already be open — `open()` is called by whatever starts
 * the ApplyTask's browser session, e.g. task-api.ts's mapping trigger).
 */
export class PlaywrightFieldDetectionAdapter implements FieldDetectionPort {
  constructor(private readonly contexts: ApplyTaskBrowserContextManager) {}

  async detectAndScore(applyTaskId: string): Promise<FieldDetectionResult> {
    const page = this.contexts.get(applyTaskId);
    if (!page) {
      throw new Error(
        `No open browser page for ApplyTask ${applyTaskId} — the task's page must be opened (context manager .open()) before mapping can run.`,
      );
    }

    const known = await detectKnownAts(page);
    const allFields = await extractFormFields(page);

    const detected: DetectedField[] = [];

    if (known) {
      for (const [key, sel] of Object.entries(known.selectors)) {
        if (!sel) continue;
        detected.push({ selector: sel.selector, taxonomyKey: key as DetectedField['taxonomyKey'], confidence: sel.neverAutoFill ? 0 : 0.98, neverAutoFill: sel.neverAutoFill, source: 'known_ats' });
      }
    }

    // Heuristics fill in whatever the known-ATS map (if any) didn't cover —
    // never re-scored for fields the known-ATS map already confidently
    // claimed (048 is the cheaper, more reliable signal when it applies).
    const knownSelectors = new Set(detected.map((d) => d.selector));
    const remainingFields = allFields.filter((f) => !knownSelectors.has(f.selector));
    const heuristicMatches = mapFormFieldsHeuristically(remainingFields);
    for (const m of heuristicMatches) {
      detected.push({ selector: m.selector, taxonomyKey: m.taxonomyKey, confidence: m.confidence, neverAutoFill: m.neverAutoFill, source: 'heuristic' });
    }

    return {
      atsAdapter: known?.atsKey ?? null,
      atsAdapterVersion: known?.version ?? null,
      detected,
      allFields,
    };
  }
}
