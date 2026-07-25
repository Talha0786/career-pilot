'use client';

import { Card, CardHeader, CardTitle, CardContent, CardFooter, Button, Badge } from '@careerpilot/ui';
import type { ApplyTaskListItem } from '@/lib/api/apply';

/**
 * Task 052 — one card in the batch review queue. Each card approves
 * independently — approving one never batches consent for another (ADR-003:
 * "each approval still mints its own single-use token and each submission
 * is still individually consented to").
 */
export function ApplyReviewCard(props: {
  task: ApplyTaskListItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { task, busy, onApprove, onReject } = props;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application task {task.id.slice(0, 8)}</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          ATS: <Badge>{task.atsAdapter ?? 'unknown / heuristic'}</Badge>
        </p>
        <p>Stage: {task.stage}</p>
        <p>Last updated: {new Date(task.updatedAt).toLocaleString()}</p>
      </CardContent>
      <CardFooter>
        <Button variant="secondary" disabled={busy} onClick={onReject}>
          Reject
        </Button>
        <Button disabled={busy} onClick={onApprove}>
          Approve &amp; submit
        </Button>
      </CardFooter>
    </Card>
  );
}
