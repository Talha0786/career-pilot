import { Badge, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '@careerpilot/ui';
import type { ApplyTaskFieldDiffEntryDto } from '@careerpilot/contracts';

/**
 * Task 052 — the field-value diff: "mapped value vs. taxonomy field vs.
 * what will be submitted." Sensitive (EEO/demographic) fields render
 * UNFILLED and clearly marked, per §4/ADR-003 — this component is the
 * UI-level restatement of the same invariant tasks 048/049/050 enforce
 * upstream (never trust a single layer alone).
 *
 * WIRING NOTE (documented scope decision, not silently incomplete): this
 * is a presentational component taking `entries` as a prop — there is no
 * live `GET /apply-tasks/:id/fields` endpoint yet returning
 * `ApplyTaskFieldDiffEntryDto[]` (the field-level detail lives in
 * `apply_task_steps` rows today, task 044/051, but no dedicated read route
 * projects it into this shape). Given this milestone's time budget, the
 * route/query wiring is a follow-up; this component is real and ready for
 * it. `apps/web/src/app/apply/review/page.tsx` does not currently render
 * this component for that reason — see that file's own comment.
 */
export function FieldDiffView(props: { entries: readonly ApplyTaskFieldDiffEntryDto[] }) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>Field</TableHeaderCell>
          <TableHeaderCell>Value that will be submitted</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {props.entries.map((entry) => (
          <TableRow key={entry.selector}>
            <TableCell>
              {entry.label}
              {entry.neverAutoFill && <Badge variant="warning">Never auto-filled</Badge>}
            </TableCell>
            <TableCell>
              {entry.neverAutoFill ? (
                <em>Left blank — please fill this in yourself</em>
              ) : (
                entry.mappedValue ?? <em>Not mapped — please review</em>
              )}
            </TableCell>
            <TableCell>{entry.source}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
