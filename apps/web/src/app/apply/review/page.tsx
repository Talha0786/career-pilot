'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader, Alert, Spinner } from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { applyApi, type ApplyTaskListItem } from '@/lib/api/apply';
import { ApplyReviewCard } from '@/components/ApplyReviewCard';

/**
 * Task 052 — the batch review queue (ADR-003): lists every `awaiting_review`
 * ApplyTask for the user, lets them approve (mints a fresh single-use
 * token, then immediately submits) or reject each one individually.
 *
 * SCOPE NOTE: does not yet render `FieldDiffView` — see that component's
 * own doc comment for why (no live per-field diff read endpoint exists
 * yet). Does not render a live CDP screencast — building the CDP capture
 * pipeline (`apps/browser-runner/src/screencast.ts`) + Redis pub/sub +
 * WS relay was judged lower-value than the mapping/filling/submit
 * correctness work within this milestone's time budget; documented here
 * rather than silently omitted. `updatedAt` is shown instead as a
 * lightweight proxy for "is this task still active."
 */
export default function ApplyReviewPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ApplyTaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  async function handleApprove(id: string) {
    setBusyId(id);
    setError(null);
    try {
      // Each card mints and consumes its OWN token — never shared, never
      // batched, even when approving several in one sitting (ADR-003).
      const { token } = await applyApi.approve(id);
      await applyApi.submit(id, token);
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
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
          <ApplyReviewCard
            key={task.id}
            task={task}
            busy={busyId === task.id}
            onApprove={() => handleApprove(task.id)}
            onReject={() => handleReject(task.id)}
          />
        ))}
      </main>
    </div>
  );
}
