import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFormFields, mapFormFieldsHeuristically } from '../src/heuristic-mapper.js';
import { P0_FIELD_KEYS, SENSITIVE_FIELD_KEYS, type TaxonomyFieldKey } from '../src/ats-maps/taxonomy.js';

const FIXTURE = `file://${path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/heuristic-corpus/corpus.html',
)}`;

const FORM_IDS = Array.from({ length: 14 }, (_, i) => `#form-${i + 1}`);

/**
 * Task 049's testing plan: "Unit tests against the corpus fixtures —
 * precision/recall on the P0 fields... reported as a real number, not just
 * 'looks right.'" See corpus.html's header comment for the honest
 * corpus-size disclosure (14 synthetic forms, not the aspirational 100+ —
 * no network access in this sandbox to collect real ones).
 */
test.describe('heuristic-mapper — corpus precision/recall (task 049)', () => {
  test('never assigns a non-zero auto-fill confidence to a sensitive (EEO-taxonomy) field', async ({ page }) => {
    await page.goto(FIXTURE);
    for (const formId of FORM_IDS) {
      const fields = await extractFormFields(page, formId);
      const matches = mapFormFieldsHeuristically(fields);
      for (const m of matches) {
        if (SENSITIVE_FIELD_KEYS.includes(m.taxonomyKey)) {
          expect(m.confidence, `${formId} ${m.taxonomyKey}`).toBe(0);
          expect(m.neverAutoFill, `${formId} ${m.taxonomyKey}`).toBe(true);
        }
      }
    }
  });

  test('decoy fields (data-expect="none") never win a taxonomy-key assignment over the genuine field', async ({ page }) => {
    await page.goto(FIXTURE);
    // form-2's "Referral Code", form-3's salary/start-date, form-10's decoys
    // must not have stolen a real taxonomy key from a co-present genuine
    // field — spot-checked directly since the aggregate precision/recall
    // test below could in principle average this out.
    const decoyFormsWithP0Genuine = ['#form-2', '#form-3'];
    for (const formId of decoyFormsWithP0Genuine) {
      const fields = await extractFormFields(page, formId);
      const decoySelectors = await page.locator(`${formId} [data-expect="none"]`).evaluateAll((els) =>
        els.map((el) => (el.id ? `#${el.id}` : `[name="${(el as HTMLInputElement).name}"]`)),
      );
      const matches = mapFormFieldsHeuristically(fields);
      for (const m of matches) {
        expect(decoySelectors, `${formId}: ${m.selector} wrongly won ${m.taxonomyKey}`).not.toContain(m.selector);
      }
    }
  });

  test('precision/recall on P0 fields across the full corpus — real numbers, not vibes', async ({ page }) => {
    await page.goto(FIXTURE);

    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const formId of FORM_IDS) {
      const fields = await extractFormFields(page, formId);
      const expectedBySelector = await page.locator(`${formId} [data-expect]`).evaluateAll((els) =>
        els.map((el) => ({
          selector: el.id ? `#${el.id}` : `[name="${(el as HTMLInputElement).name}"]`,
          expected: el.getAttribute('data-expect'),
        })),
      );
      const matches = mapFormFieldsHeuristically(fields);
      const matchBySelector = new Map(matches.map((m) => [m.selector, m.taxonomyKey]));

      for (const { selector, expected } of expectedBySelector) {
        if (!expected || expected === 'none') continue;
        if (!P0_FIELD_KEYS.includes(expected as TaxonomyFieldKey)) continue;
        const got = matchBySelector.get(selector);
        if (got === expected) truePositives++;
        else falseNegatives++;
      }
      // False positives: this stage assigned a P0 key to a selector whose
      // ground truth says something else (or none).
      for (const [selector, key] of matchBySelector) {
        if (!P0_FIELD_KEYS.includes(key)) continue;
        const truth = expectedBySelector.find((e) => e.selector === selector)?.expected;
        if (truth !== key) falsePositives++;
      }
    }

    const precision = truePositives / (truePositives + falsePositives || 1);
    const recall = truePositives / (truePositives + falseNegatives || 1);
    console.log(
      `[task 049 corpus eval] P0 fields — TP=${truePositives} FP=${falsePositives} FN=${falseNegatives} ` +
        `precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`,
    );

    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});
