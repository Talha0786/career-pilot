import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KNOWN_ATS_MAPS, TAXONOMY, SENSITIVE_FIELD_KEYS, type AtsMap } from '../src/ats-maps/index.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const fixturePathFor = (atsKey: string) => `file://${path.join(FIXTURES_DIR, atsKey, 'application-form.html')}`;

/**
 * Task 048's own testing plan (docs/05-playwright-design.md §7): "Selector
 * maps | Playwright tests against recorded HTML fixtures per ATS version."
 */
for (const map of KNOWN_ATS_MAPS) {
  test.describe(`${map.atsKey} selector map v${map.version}`, () => {
    test(`resolves 100% of its declared taxonomy fields against its own fixture`, async ({ page }) => {
      await page.goto(fixturePathFor(map.atsKey));

      for (const [key, sel] of Object.entries(map.selectors)) {
        if (!sel) continue;
        const count = await page.locator(sel.selector).count();
        // Radio-group fields legitimately resolve to >1 element (one per
        // option); every other field type must resolve to exactly one.
        if (TAXONOMY[key as keyof typeof TAXONOMY].inputType === 'radio') {
          expect(count, `${map.atsKey}.${key} (${sel.selector})`).toBeGreaterThan(0);
        } else {
          expect(count, `${map.atsKey}.${key} (${sel.selector})`).toBe(1);
        }
      }
    });

    test(`detect() returns true for its OWN fixture`, async ({ page }) => {
      await page.goto(fixturePathFor(map.atsKey));
      expect(await map.detect(page)).toBe(true);
    });

    for (const other of KNOWN_ATS_MAPS.filter((m) => m.atsKey !== map.atsKey)) {
      test(`detect() returns false against ${other.atsKey}'s fixture (no false-positive adapter selection)`, async ({ page }) => {
        await page.goto(fixturePathFor(other.atsKey));
        expect(await map.detect(page)).toBe(false);
      });
    }

    test(`declares every sensitive (EEO) field it maps as neverAutoFill: true`, () => {
      for (const [key, sel] of Object.entries(map.selectors)) {
        if (!sel) continue;
        if (SENSITIVE_FIELD_KEYS.includes(key as (typeof SENSITIVE_FIELD_KEYS)[number])) {
          expect(sel.neverAutoFill, `${map.atsKey}.${key}`).toBe(true);
        }
      }
    });
  });
}

test('exactly one adapter matches each fixture — no ambiguous double-detection', async ({ page }) => {
  for (const target of KNOWN_ATS_MAPS) {
    await page.goto(fixturePathFor(target.atsKey));
    const matches: string[] = [];
    for (const map of KNOWN_ATS_MAPS as readonly AtsMap[]) {
      if (await map.detect(page)) matches.push(map.atsKey);
    }
    expect(matches).toEqual([target.atsKey]);
  }
});
