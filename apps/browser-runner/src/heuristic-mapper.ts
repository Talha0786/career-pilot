import type { Page } from 'playwright';
import { TAXONOMY, TAXONOMY_FIELD_KEYS, type TaxonomyFieldKey } from './ats-maps/taxonomy.js';

/**
 * Task 049 — Stage 2 of the field-mapping pipeline: what runs when no
 * known-ATS adapter (048) matched. `FormFieldDescriptor` is the serialized,
 * DOM-independent shape both this stage and task 050's LLM mapper consume
 * — extraction (I/O, needs a real `Page`) is deliberately split from
 * scoring (pure function), so the scoring rubric is unit-testable against
 * a corpus of plain objects without needing a browser at all.
 */
export interface FormFieldDescriptor {
  /** A selector that re-locates this exact element (falls back to an nth-of-type path if no id/name). */
  readonly selector: string;
  readonly tagName: 'input' | 'select' | 'textarea';
  readonly type: string | null;
  readonly name: string | null;
  readonly id: string | null;
  readonly autocomplete: string | null;
  readonly ariaLabel: string | null;
  readonly labelText: string | null;
  readonly placeholder: string | null;
}

export interface HeuristicFieldMatch {
  readonly selector: string;
  readonly taxonomyKey: TaxonomyFieldKey;
  /** 0-1. Forced to 0 for `neverAutoFill` taxonomy fields regardless of match strength — see scoreFieldConfidence. */
  readonly confidence: number;
  readonly neverAutoFill: boolean;
}

const norm = (s: string | null): string => (s ?? '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

/**
 * AUTOCOMPLETE tokens (WHATWG HTML spec, https://html.spec.whatwg.org/#autofill)
 * mapped to taxonomy keys — the single most reliable signal available,
 * since it's a browser-standardized vocabulary, not free text.
 */
const AUTOCOMPLETE_MAP: Partial<Record<string, TaxonomyFieldKey>> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
};

/** name/id keyword patterns, ordered strongest-signal-first per key. */
const NAME_ID_PATTERNS: Partial<Record<TaxonomyFieldKey, RegExp[]>> = {
  firstName: [/^first[_ ]?name$/, /first[_ ]?name/, /^fname$/],
  lastName: [/^last[_ ]?name$/, /last[_ ]?name/, /^lname$/, /surname/],
  email: [/^email$/, /email[_ ]?address/, /email/],
  phone: [/^phone$/, /phone[_ ]?number/, /mobile/, /telephone/],
  resumeUpload: [/^resume$/, /^cv$/, /resume/, /\bcv\b/],
  coverLetterUpload: [/cover[_ ]?letter/],
  linkedinUrl: [/linkedin/],
  portfolioUrl: [/portfolio/, /website/, /personal[_ ]?site/],
  workAuthorization: [/work[_ ]?auth/, /legally[_ ]?authorized/, /authorized[_ ]?to[_ ]?work/],
  sponsorshipRequired: [/sponsorship/, /require[_ ]?visa/],
  howDidYouHear: [/how[_ ]?did[_ ]?you[_ ]?hear/, /referral[_ ]?source/],
  eeoGender: [/^gender$/, /eeo[_ ]?gender/, /\bsex\b/],
  eeoRace: [/^race$/, /ethnicity/, /eeo[_ ]?race/],
  eeoVeteranStatus: [/veteran/],
  eeoDisabilityStatus: [/disability/],
};

/** Label/aria/placeholder free-text keyword patterns — weaker signal than name/id/autocomplete. */
const TEXT_PATTERNS: Partial<Record<TaxonomyFieldKey, RegExp[]>> = {
  firstName: [/first name/],
  lastName: [/last name/, /surname/],
  email: [/e[- ]?mail/],
  phone: [/phone/, /mobile/, /telephone/],
  resumeUpload: [/resume/, /\bcv\b/],
  coverLetterUpload: [/cover letter/],
  linkedinUrl: [/linkedin/],
  portfolioUrl: [/portfolio/, /website/],
  workAuthorization: [/authorized to work/, /work authorization/],
  sponsorshipRequired: [/sponsorship/, /require.*visa/],
  howDidYouHear: [/how did you hear/],
  eeoGender: [/gender/, /\bsex\b/],
  eeoRace: [/race/, /ethnicity/],
  eeoVeteranStatus: [/veteran/],
  eeoDisabilityStatus: [/disability/],
};

const TYPE_HINTS: Partial<Record<TaxonomyFieldKey, string[]>> = {
  email: ['email'],
  phone: ['tel'],
  resumeUpload: ['file'],
  coverLetterUpload: ['file'],
};

/**
 * Scoring rubric (documented so task 051's "low confidence → blank + flag"
 * threshold is a real decision, not arbitrary — this task's acceptance
 * criterion). Highest-signal-wins, not additive-stacking, to keep the
 * score interpretable as "how sure are we", not a points tally:
 *
 *   1.00  exact WHATWG autocomplete token match
 *   0.85  exact name/id match against the field's canonical pattern
 *   0.65  fuzzy name/id match (keyword present, not the whole token)
 *   0.55  label text contains the keyword
 *   0.45  aria-label contains the keyword
 *   0.35  placeholder contains the keyword
 *   +0.10 input `type` attribute corroborates (capped at 1.0), only ever
 *         a BOOST on top of another signal — type alone is never sufficient
 *         (a `type="file"` could be a cover letter OR a resume upload;
 *         type hints disambiguate between already-plausible candidates,
 *         they don't manufacture confidence from nothing)
 *
 * `neverAutoFill` taxonomy fields (048's sensitive-field policy) are scored
 * normally for DETECTION purposes (the review UI needs to know a field
 * exists to surface it unfilled) but the confidence returned to the
 * caller is force-zeroed — this task's own acceptance criterion: "never
 * assigned a non-zero auto-fill confidence, even when... labels
 * superficially resemble them."
 */
export function scoreFieldConfidence(field: FormFieldDescriptor, key: TaxonomyFieldKey): number {
  let score = 0;

  const autocompleteKey = AUTOCOMPLETE_MAP[norm(field.autocomplete)];
  if (autocompleteKey === key) score = Math.max(score, 1.0);

  const namePatterns = NAME_ID_PATTERNS[key] ?? [];
  const nameId = norm(field.name) + ' ' + norm(field.id);
  if (namePatterns.length > 0) {
    if (namePatterns.some((p, i) => i === 0 && p.test(nameId.replace(/\s/g, '_')))) {
      score = Math.max(score, 0.85);
    } else if (namePatterns.some((p) => p.test(nameId))) {
      score = Math.max(score, 0.65);
    }
  }

  const textPatterns = TEXT_PATTERNS[key] ?? [];
  if (textPatterns.some((p) => p.test(norm(field.labelText)))) score = Math.max(score, 0.55);
  if (textPatterns.some((p) => p.test(norm(field.ariaLabel)))) score = Math.max(score, 0.45);
  if (textPatterns.some((p) => p.test(norm(field.placeholder)))) score = Math.max(score, 0.35);

  const typeHints = TYPE_HINTS[key] ?? [];
  if (score > 0 && field.type && typeHints.includes(field.type)) {
    score = Math.min(1, score + 0.1);
  }

  if (TAXONOMY[key].neverAutoFill) return score > 0 ? 0 : 0; // always 0 — see doc comment

  return score;
}

const CONFIDENCE_FLOOR = 0.35;

/**
 * Pure — the whole scoring/assignment pass over an already-extracted field
 * list. Greedy highest-confidence-wins per taxonomy key (a field that loses
 * a key to a higher-confidence competitor is simply left unmapped by this
 * stage, not reassigned to its second-best guess — a documented
 * simplification over full bipartite matching, adequate at this form
 * scale). Sensitive fields ARE included in the output (so 052's diff view
 * can surface them) with confidence forced to 0.
 */
export function mapFormFieldsHeuristically(fields: readonly FormFieldDescriptor[]): HeuristicFieldMatch[] {
  const candidates: { field: FormFieldDescriptor; key: TaxonomyFieldKey; confidence: number; rawScore: number }[] = [];

  for (const field of fields) {
    let best: { key: TaxonomyFieldKey; confidence: number; rawScore: number } | null = null;
    for (const key of TAXONOMY_FIELD_KEYS) {
      const rawScore = TAXONOMY[key].neverAutoFill
        ? scoreFieldConfidenceRaw(field, key)
        : scoreFieldConfidence(field, key);
      if (rawScore <= 0) continue;
      const confidence = TAXONOMY[key].neverAutoFill ? 0 : rawScore;
      if (!best || rawScore > best.rawScore) best = { key, confidence, rawScore };
    }
    if (best && (best.rawScore >= CONFIDENCE_FLOOR || TAXONOMY[best.key].neverAutoFill)) {
      candidates.push({ field, key: best.key, confidence: best.confidence, rawScore: best.rawScore });
    }
  }

  // Dedup: if two fields both claim the same non-sensitive key, keep the
  // higher-confidence one only.
  const winners = new Map<TaxonomyFieldKey, (typeof candidates)[number]>();
  for (const c of candidates) {
    const existing = winners.get(c.key);
    if (!existing || c.rawScore > existing.rawScore) winners.set(c.key, c);
  }

  return [...winners.values()].map((c) => ({
    selector: c.field.selector,
    taxonomyKey: c.key,
    confidence: c.confidence,
    neverAutoFill: TAXONOMY[c.key].neverAutoFill,
  }));
}

/** Internal — the RAW (pre-zero-forcing) score, used only to pick the best-matching sensitive key for detection/dedup. */
function scoreFieldConfidenceRaw(field: FormFieldDescriptor, key: TaxonomyFieldKey): number {
  const saved = TAXONOMY[key].neverAutoFill;
  // scoreFieldConfidence force-zeroes neverAutoFill keys by design; this
  // helper recomputes the pre-zero raw signal for internal ranking only —
  // never exposed as a public confidence value.
  if (!saved) return scoreFieldConfidence(field, key);
  let score = 0;
  const autocompleteKey = AUTOCOMPLETE_MAP[norm(field.autocomplete)];
  if (autocompleteKey === key) score = Math.max(score, 1.0);
  const namePatterns = NAME_ID_PATTERNS[key] ?? [];
  const nameId = norm(field.name) + ' ' + norm(field.id);
  if (namePatterns.some((p) => p.test(nameId))) score = Math.max(score, 0.65);
  const textPatterns = TEXT_PATTERNS[key] ?? [];
  if (textPatterns.some((p) => p.test(norm(field.labelText)))) score = Math.max(score, 0.55);
  if (textPatterns.some((p) => p.test(norm(field.ariaLabel)))) score = Math.max(score, 0.45);
  if (textPatterns.some((p) => p.test(norm(field.placeholder)))) score = Math.max(score, 0.35);
  return score;
}

/**
 * The I/O half — real DOM extraction. Runs in the page context, since it
 * needs `document.querySelectorAll` and label resolution
 * (`<label for>`/wrapping `<label>`), then returns a plain, serializable
 * array back to Node.
 */
export async function extractFormFields(page: Page, rootSelector = 'body'): Promise<FormFieldDescriptor[]> {
  return page.evaluate((root) => {
    const out: FormFieldDescriptor[] = [];
    const scope = document.querySelector(root) ?? document.body;
    const els = scope.querySelectorAll('input, select, textarea');
    let idx = 0;
    for (const el of Array.from(els)) {
      const input = el as HTMLInputElement;
      // Radio buttons excluded deliberately (bug found + fixed during task
      // 054's e2e verification, documented in tasks/054.md's Status note):
      // a radio GROUP shares one taxonomy meaning (e.g. workAuthorization)
      // across MULTIPLE <input> elements, but known-ATS maps (048) declare
      // ONE group-level selector (e.g. `input[name="work_authorization"]`)
      // while per-element extraction here would generate a DIFFERENT
      // selector per radio option (`#work_authorization_yes`, `#..._no`) —
      // a string mismatch that made task 051's confidence-set matching
      // treat every known-ATS-covered radio group as "still unresolved"
      // and wrongly fall through to the LLM stage. Radio groups are P1
      // fields handled entirely through known-ATS group selectors for now;
      // generic per-option heuristic/LLM radio-group mapping is a
      // legitimate follow-up, not attempted here given time constraints.
      if (input.tagName === 'INPUT' && ['submit', 'button', 'hidden', 'checkbox', 'radio'].includes(input.type)) {
        idx++;
        continue;
      }
      let labelText: string | null = null;
      if (input.id) {
        const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l) labelText = l.textContent?.trim() ?? null;
      }
      if (!labelText) {
        const wrapping = input.closest('label');
        if (wrapping) labelText = wrapping.textContent?.trim() ?? null;
      }

      let selector: string;
      if (input.id) selector = `#${CSS.escape(input.id)}`;
      else if (input.name) selector = `[name="${CSS.escape(input.name)}"]`;
      else selector = `${input.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;

      out.push({
        selector,
        tagName: input.tagName.toLowerCase() as 'input' | 'select' | 'textarea',
        type: input.type ?? null,
        name: input.name || null,
        id: input.id || null,
        autocomplete: input.autocomplete || null,
        ariaLabel: input.getAttribute('aria-label'),
        labelText,
        placeholder: (input as HTMLInputElement).placeholder || null,
      });
      idx++;
    }
    return out;
  }, rootSelector);
}
