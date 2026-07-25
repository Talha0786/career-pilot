import type { Page } from 'playwright';
import type { AtsMap } from './ats-map.js';
import { greenhouseMap } from './greenhouse.js';
import { leverMap } from './lever.js';
import { ashbyMap } from './ashby.js';
import { workdayMap } from './workday.js';

export * from './taxonomy.js';
export * from './ats-map.js';
export { greenhouseMap, leverMap, ashbyMap, workdayMap };

export const KNOWN_ATS_MAPS: readonly AtsMap[] = [greenhouseMap, leverMap, ashbyMap, workdayMap];

/**
 * Stage 1 of the mapping pipeline (task 051 wires this in): try each known
 * adapter's `detect()` in order, return the first (and per this task's
 * acceptance criterion, only) match. Task 055 layers `DEGRADED` skip-ahead
 * on top of this — deliberately NOT built into this function itself, to
 * keep the pure "which adapter matches this DOM" question separate from
 * the "should we even bother trying a known-flaky one" policy question.
 */
export async function detectKnownAts(page: Page): Promise<AtsMap | null> {
  for (const map of KNOWN_ATS_MAPS) {
    if (await map.detect(page)) return map;
  }
  return null;
}
