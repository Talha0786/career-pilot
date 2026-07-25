import type { Page } from 'playwright';
import type { TaxonomyFieldKey } from './taxonomy.js';

/**
 * Task 048 — shared shape every known-ATS adapter implements. `selectors`
 * only lists fields that platform's hosted-form layout actually presents
 * (a map claiming a field it can't resolve against its own fixture is
 * treated as worse than not claiming it — this task's acceptance
 * criterion), so it's a Partial, not a total Record.
 */
export interface AtsFieldSelector {
  readonly selector: string;
  readonly neverAutoFill: boolean;
}

export interface AtsMap {
  readonly atsKey: string;
  /** Selector-map schema version (task 055: nightly canary + DEGRADED tracking key on this). */
  readonly version: string;
  readonly selectors: Partial<Record<TaxonomyFieldKey, AtsFieldSelector>>;
  /** DOM-signature detector. Must return false for every OTHER adapter's fixture (no false-positive selection). */
  detect(page: Page): Promise<boolean>;
  /** Task 053 — the platform's submit-button selector, used by submit-runner.ts's ONLY caller (submit-apply-task.ts, gated by a consumed approval token). */
  readonly submitSelector: string;
}
