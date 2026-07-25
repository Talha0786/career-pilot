import { describe, it, expect } from 'vitest';
import { scoreFieldConfidence, mapFormFieldsHeuristically, type FormFieldDescriptor } from '../../src/heuristic-mapper.js';

const field = (overrides: Partial<FormFieldDescriptor>): FormFieldDescriptor => ({
  selector: '#x',
  tagName: 'input',
  type: null,
  name: null,
  id: null,
  autocomplete: null,
  ariaLabel: null,
  labelText: null,
  placeholder: null,
  ...overrides,
});

describe('scoreFieldConfidence — pure rubric (task 049)', () => {
  it('exact autocomplete token scores highest (1.0)', () => {
    expect(scoreFieldConfidence(field({ autocomplete: 'email' }), 'email')).toBe(1.0);
  });

  it('scoring is monotonic-sane: exact autocomplete beats exact name/id beats fuzzy label text (task acceptance criterion)', () => {
    const byAutocomplete = scoreFieldConfidence(field({ autocomplete: 'email' }), 'email');
    const byExactName = scoreFieldConfidence(field({ id: 'email' }), 'email');
    const byFuzzyLabel = scoreFieldConfidence(field({ labelText: 'Your e-mail so we can reach you' }), 'email');
    const byNothing = scoreFieldConfidence(field({}), 'email');
    expect(byAutocomplete).toBeGreaterThan(byExactName);
    expect(byExactName).toBeGreaterThan(byFuzzyLabel);
    expect(byFuzzyLabel).toBeGreaterThan(byNothing);
    expect(byNothing).toBe(0);
  });

  it('a sensitive (neverAutoFill) taxonomy key ALWAYS scores 0, even with an exact autocomplete-grade signal', () => {
    expect(scoreFieldConfidence(field({ id: 'gender' }), 'eeoGender')).toBe(0);
    expect(scoreFieldConfidence(field({ labelText: 'Gender' }), 'eeoGender')).toBe(0);
  });

  it('input type is only a boost, never sufficient alone', () => {
    // type=file alone (no name/label/aria signal at all) must not manufacture a resumeUpload match.
    expect(scoreFieldConfidence(field({ type: 'file' }), 'resumeUpload')).toBe(0);
    // type=file ON TOP of a real name signal boosts it.
    const withoutType = scoreFieldConfidence(field({ id: 'resume' }), 'resumeUpload');
    const withType = scoreFieldConfidence(field({ id: 'resume', type: 'file' }), 'resumeUpload');
    expect(withType).toBeGreaterThan(withoutType);
  });
});

describe('mapFormFieldsHeuristically — assignment (task 049)', () => {
  it('never assigns a non-zero confidence to a sensitive field, even when the label superficially resembles one', () => {
    const fields = [field({ selector: '#g', id: 'gender', labelText: 'Gender' })];
    const matches = mapFormFieldsHeuristically(fields);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.taxonomyKey).toBe('eeoGender');
    expect(matches[0]!.confidence).toBe(0);
    expect(matches[0]!.neverAutoFill).toBe(true);
  });

  it('below the confidence floor, a non-sensitive field is left unmapped rather than guessed', () => {
    const fields = [field({ selector: '#weird', id: 'q47' })]; // no signal at all
    const matches = mapFormFieldsHeuristically(fields);
    expect(matches).toHaveLength(0);
  });

  it('when two fields both plausibly match the same key, the higher-confidence one wins and the loser is left unmapped', () => {
    const fields = [
      field({ selector: '#strong', autocomplete: 'email' }),
      field({ selector: '#weak', labelText: 'email us' }),
    ];
    const matches = mapFormFieldsHeuristically(fields);
    const emailMatches = matches.filter((m) => m.taxonomyKey === 'email');
    expect(emailMatches).toHaveLength(1);
    expect(emailMatches[0]!.selector).toBe('#strong');
  });
});
