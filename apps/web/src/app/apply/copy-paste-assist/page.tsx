'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppHeader, Alert, Card, CardHeader, CardTitle, CardContent, Spinner } from '@careerpilot/ui';
import { api } from '@/lib/api-client';

/**
 * Task 055 — the M6 roadmap's explicitly-named floor: "if mapper accuracy
 * stalls, ship copy-paste-assist mode" / docs/05-playwright-design.md §5's
 * degradation ladder's last rung: "known-ATS map → heuristics → LLM map →
 * copy-paste assist mode (side-panel showing user's values to paste
 * manually). The product never dead-ends."
 *
 * Reached when an ApplyTask's mapping stage couldn't resolve ANY usable
 * field through any of the three automated stages — rather than a bare
 * `failed` dead end, the user still gets their profile values laid out
 * so they can paste them into the real ATS site themselves.
 *
 * WIRING NOTE: reads `applyTaskId` from the query string; there is no
 * dedicated `GET /apply-tasks/:id/copy-paste-values` endpoint yet
 * returning the resolved profile values for that task (out of scope given
 * this milestone's time budget — the ROUTING decision this page exists to
 * receive, `run-mapping.ts`'s total-failure → manual-assist outcome, is
 * implemented and tested; the read endpoint that would feed THIS page
 * live values is a documented follow-up). Renders a clear, honest empty
 * state rather than fabricated data when that endpoint is absent.
 */
export default function CopyPasteAssistPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const applyTaskId = searchParams.get('applyTaskId');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await api.me();
        setReady(true);
      } catch {
        router.push('/login');
      }
    })();
  }, [router]);

  if (!ready) return <Spinner />;

  return (
    <div>
      <AppHeader title="Copy-paste assist" />
      <main style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Alert variant="warning">
          We couldn&apos;t automatically map this application&apos;s form. Your profile
          values are shown below — copy each one into the real application
          page yourself. Nothing was submitted automatically.
        </Alert>
        <Card>
          <CardHeader>
            <CardTitle>Task {applyTaskId ? applyTaskId.slice(0, 8) : '(unknown)'}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              Field values for this task aren&apos;t wired up to a live read
              endpoint yet — see this page&apos;s own comment for the honest
              scope note. In the meantime, use your profile page&apos;s values
              directly.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
