import { Badge, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '@careerpilot/ui';
import type { ApplyTaskFieldDiffEntry } from '@/lib/api/apply';

/**
 * Task 052 — the field-value diff: "mapped value vs. taxonomy field vs.
 * what will be submitted." Sensitive (EEO/demographic) fields render
 * UNFILLED and clearly marked, per §4/ADR-003 — this component is the
 * UI-level restatement of the same invariant tasks 048/049/050 enforce
 * upstream (never trust a single layer alone).
 *
 * NOW WIRED to live data (this task's follow-up over the original draft):
 * `apps/browser-runner/src/task-api.ts`'s `GET /internal/tasks/:id/fields`
 * reconstructs the field map from `apply_task_steps` and reads the
 * CURRENT value back from the live page DOM for non-sensitive fields;
 * `apps/api/src/routes/apply.ts`'s `GET /apply-tasks/:id/fields` proxies
 * that (ownership-checked, stage-gated); `apps/web/src/app/apply/review/page.tsx`
 * fetches it per-task and renders this component. Takes the web client's
 * own local `ApplyTaskFieldDiffEntry` shape (not the `@careerpilot/contracts`
 * DTO) — consistent with this feature's existing convention
 * (`apps/web/src/lib/api/apply.ts`'s own doc comment) of plain local
 * interfaces on this client, promoting to real zod contracts being a
 * reasonable follow-up.
 */
export function FieldDiffView(props: { entries: readonly ApplyTaskFieldDiffEntry[] }) {
  if (props.entries.length === 0) {
    return <p>No fields were mapped for this application yet.</p>;
  }

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
