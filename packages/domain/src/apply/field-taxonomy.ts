/**
 * Task 048/050 — the canonical assisted-apply field taxonomy. Plain TS,
 * zero dependencies (no zod) — this is genuinely shared VOCABULARY, not an
 * HTTP/DTO shape, so it belongs in the domain layer's shared kernel, not
 * `@careerpilot/contracts`.
 *
 * ARCHITECTURE NOTE (judgment call, documented rather than silently
 * deviated): task 048's own file list originally placed this at
 * `apps/browser-runner/src/ats-maps/taxonomy.ts` with "task 050 (LLM
 * mapper) depends on it". Taken literally that would mean
 * `packages/application` importing from an app — a dependency-rule
 * inversion `scripts/verify-boundary-enforcement.mjs` exists to catch for
 * domain→infrastructure, and one that wouldn't even resolve (pnpm's
 * isolated `node_modules` — `packages/application`'s `package.json`
 * declares no dependency on `@careerpilot/browser-runner`). Also
 * considered `@careerpilot/contracts`, but `packages/application/src/
 * matching/commands/score-match.ts`'s own doc comment establishes the
 * existing house rule explicitly: "contracts is the HTTP/DTO boundary;
 * validating an LLM's output is an application-layer concern" — the
 * codebase's established pattern is domain owns the plain type, contracts
 * independently mirrors it as a zod schema (own copy, no cross-import),
 * and application keeps its own zod validator too (see
 * `packages/application/src/apply/commands/map-fields.ts`). Followed that
 * existing three-copies convention here rather than inventing a new one.
 * `apps/browser-runner/src/ats-maps/taxonomy.ts` re-exports this file so
 * 048/049's original call sites need no changes.
 */

export const TAXONOMY_FIELD_KEYS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'resumeUpload',
  'coverLetterUpload',
  'linkedinUrl',
  'portfolioUrl',
  'workAuthorization',
  'sponsorshipRequired',
  'howDidYouHear',
  'eeoGender',
  'eeoRace',
  'eeoVeteranStatus',
  'eeoDisabilityStatus',
] as const;

export type TaxonomyFieldKey = (typeof TAXONOMY_FIELD_KEYS)[number];

export type TaxonomyInputType = 'text' | 'email' | 'tel' | 'file' | 'select' | 'radio' | 'textarea';

export interface TaxonomyField {
  readonly key: TaxonomyFieldKey;
  readonly label: string;
  readonly inputType: TaxonomyInputType;
  /** §4 sensitive-field policy: never auto-filled, always surfaced untouched. Hard invariant, enforced independently at every stage that touches a field value. */
  readonly neverAutoFill: boolean;
  readonly priority: 'P0' | 'P1';
}

export const TAXONOMY: Readonly<Record<TaxonomyFieldKey, TaxonomyField>> = {
  firstName: { key: 'firstName', label: 'First name', inputType: 'text', neverAutoFill: false, priority: 'P0' },
  lastName: { key: 'lastName', label: 'Last name', inputType: 'text', neverAutoFill: false, priority: 'P0' },
  email: { key: 'email', label: 'Email', inputType: 'email', neverAutoFill: false, priority: 'P0' },
  phone: { key: 'phone', label: 'Phone', inputType: 'tel', neverAutoFill: false, priority: 'P0' },
  resumeUpload: { key: 'resumeUpload', label: 'Resume/CV upload', inputType: 'file', neverAutoFill: false, priority: 'P0' },
  coverLetterUpload: { key: 'coverLetterUpload', label: 'Cover letter upload', inputType: 'file', neverAutoFill: false, priority: 'P1' },
  linkedinUrl: { key: 'linkedinUrl', label: 'LinkedIn URL', inputType: 'text', neverAutoFill: false, priority: 'P1' },
  portfolioUrl: { key: 'portfolioUrl', label: 'Portfolio/website URL', inputType: 'text', neverAutoFill: false, priority: 'P1' },
  workAuthorization: { key: 'workAuthorization', label: 'Are you legally authorized to work?', inputType: 'radio', neverAutoFill: false, priority: 'P1' },
  sponsorshipRequired: { key: 'sponsorshipRequired', label: 'Will you require sponsorship?', inputType: 'radio', neverAutoFill: false, priority: 'P1' },
  howDidYouHear: { key: 'howDidYouHear', label: 'How did you hear about us?', inputType: 'select', neverAutoFill: false, priority: 'P1' },
  eeoGender: { key: 'eeoGender', label: 'Gender (voluntary self-identification)', inputType: 'select', neverAutoFill: true, priority: 'P1' },
  eeoRace: { key: 'eeoRace', label: 'Race/ethnicity (voluntary self-identification)', inputType: 'select', neverAutoFill: true, priority: 'P1' },
  eeoVeteranStatus: { key: 'eeoVeteranStatus', label: 'Veteran status (voluntary self-identification)', inputType: 'select', neverAutoFill: true, priority: 'P1' },
  eeoDisabilityStatus: { key: 'eeoDisabilityStatus', label: 'Disability status (voluntary self-identification)', inputType: 'select', neverAutoFill: true, priority: 'P1' },
};

export const P0_FIELD_KEYS: readonly TaxonomyFieldKey[] = TAXONOMY_FIELD_KEYS.filter((k) => TAXONOMY[k].priority === 'P0');
export const SENSITIVE_FIELD_KEYS: readonly TaxonomyFieldKey[] = TAXONOMY_FIELD_KEYS.filter((k) => TAXONOMY[k].neverAutoFill);
export const isTaxonomyFieldKey = (v: string): v is TaxonomyFieldKey => (TAXONOMY_FIELD_KEYS as readonly string[]).includes(v);
export const isNeverAutoFill = (key: TaxonomyFieldKey): boolean => TAXONOMY[key].neverAutoFill;
