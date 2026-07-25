'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader, Alert, Spinner, Card, CardContent } from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { applyApi, type ApplyTaskListItem, type ApplyTaskFieldDiffEntry } from '@/lib/api/apply';
import { ApplyReviewCard } from '@/components/ApplyReviewCard';
import { FieldDiffView } from '@/components/FieldDiffView';

/**
 * Task 052 — the batch review queue (ADR-003): lists every `awaiting_review`
 * ApplyTask for the user, lets them expand each one to see the REAL
 * field-level diff (`GET /apply-tasks/:id/fields`, task 052's follow-up —
 * see `FieldDiffView`'s own doc comment for the full data-flow story) before
 * approving (mints a fresh single-use token, then immediately submits) or
 * rejecting.
 *
 * SCOPE NOTE (still real, still honest): no live CDP screencast — building
 * the CDP capture pipeline (`apps/browser-runner/src/screencast.ts`) + Redis
 * pub/sub + WS relay was judged lower-value than the field-diff correctness
 * work within this milestone's time budget. The field diff itself IS live
 * (reads the actual current DOM state of the open browser-runner page for
 * every non-sensitive field), which is the part ADR-003 actually requires
 * ("a human must review a field-level diff") — visual monitoring is a
 * lesser gap than no diff data.
 */
export default function ApplyReviewPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ApplyTaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fields, setFields] = useState<ApplyTaskFieldDiffEntry[] | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await applyApi.list('awaiting_review');
      setTasks(res.tasks);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not load review queue');
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await api.me();
        await load();
      } catch {
        router.push('/login');
      }
    })();
  }, [router, load]);

  async function handleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setFields(null);
      return;
    }
    setExpandedId(id);
    setFields(null);
    setFieldsLoading(true);
    try {
      const res = await applyApi.fields(id);
      setFields(res.fields);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not load field diff');
    } finally {
      setFieldsLoading(false);
    }
  }

  async function handleApprove(id: string) {
    setBusyId(id);
    setError(null);
    try {
      // Each card mints and consumes its OWN token — never shared, never
      // batched, even when approving several in one sitting (ADR-003).
      const { token } = await applyApi.approve(id);
      await applyApi.submit(id, token);
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
      if (expandedId === id) { setExpandedId(null); setFields(null); }
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Approve/submit failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await applyApi.reject(id);
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
      if (expandedId === id) { setExpandedId(null); setFields(null); }
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Reject failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <AppHeader title="Review queue" />
      <main style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {error && <Alert variant="danger">{error}</Alert>}
        {tasks === null && <Spinner />}
        {tasks !== null && tasks.length === 0 && <p>Nothing waiting for review right now.</p>}
        {tasks?.map((task) => (
          <div key={task.id}>
            <ApplyReviewCard
              task={task}
              busy={busyId === task.id}
              onApprove={() => handleApprove(task.id)}
              onReject={() => handleReject(task.id)}
              onToggleDetails={() => handleExpand(task.id)}
              detailsOpen={expandedId === task.id}
            />
            {expandedId === task.id && (
              <Card>
                <CardContent>
                  {fieldsLoading && <Spinner />}
                  {!fieldsLoading && fields && <FieldDiffView entries={fields} />}
                </CardContent>
              </Card>
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
