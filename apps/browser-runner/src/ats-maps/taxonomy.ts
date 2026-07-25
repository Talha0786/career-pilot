/**
 * Task 048 — re-exports the canonical taxonomy from
 * `@careerpilot/domain` (`packages/domain/src/apply/field-taxonomy.ts`) —
 * see that file's doc comment for the full boundary-rule reasoning behind
 * why it lives there and not in this app. Kept as a re-export (not deleted)
 * so 048/049's existing `from './taxonomy.js'` imports within this app
 * need no changes.
 */
export {
  TAXONOMY_FIELD_KEYS,
  TAXONOMY,
  P0_FIELD_KEYS,
  SENSITIVE_FIELD_KEYS,
  isTaxonomyFieldKey,
  isNeverAutoFill,
  type TaxonomyFieldKey,
  type TaxonomyInputType,
  type TaxonomyField,
} from '@careerpilot/domain';
