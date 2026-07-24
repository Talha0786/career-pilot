'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DocumentDto, DocumentVersionDto } from '@careerpilot/contracts';
import { AppHeader, Card, CardHeader, CardTitle, CardContent, Alert, Badge, Button } from '@careerpilot/ui';
import { api, ApiError } from '@/lib/api-client';
import { documentsApi } from '@/lib/api/documents';
import { DocumentDiffView } from '@/components/DocumentDiffView';
import { ClaimReviewPanel } from '@/components/ClaimReviewPanel';

export function ReviewClient({ documentId, versionId }: { documentId: string; versionId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocumentDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolvedMessage, setResolvedMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await documentsApi.get(documentId);
      setDoc(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not load document');
    }
  }, [documentId]);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setEmail(me.email);
        await load();
      } catch {
        router.push('/login');
      }
    })();
  }, [router, load]);

  async function handleReviewSubmit(approved: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await documentsApi.review(documentId, versionId, { approved });
      setResolvedMessage(
        result.needsHumanReview
          ? 'Recorded — this version stays blocked from export. Generate a new version from the profile/job to fix the flagged claim.'
          : 'Approved — this version is now unblocked and can be exported.',
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.message : 'Could not submit review');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    await api.logout();
    router.push('/login');
  }

  const version: DocumentVersionDto | undefined = doc?.versions.find((v) => v.id === versionId);
  const baseVersion: DocumentVersionDto | undefined = version
    ? doc?.versions.find((v) => v.version === version.version - 1)
    : undefined;

  return (
    <div className="min-h-screen bg-neutral-50">
      <AppHeader
        title="Review generated document"
        right={
          <>
            <a href="/documents" className="text-sm text-neutral-500 hover:text-neutral-800">Documents</a>
            <span className="text-sm text-neutral-500">{email}</span>
            <Button variant="outline" size="sm" onClick={handleLogout}>Log out</Button>
          </>
        }
      />

      <main className="mx-auto max-w-4xl p-6">
        {error && <Alert variant="danger" className="mb-4">{error}</Alert>}
        {resolvedMessage && <Alert variant={version?.needsHumanReview ? 'warning' : 'success'} className="mb-4">{resolvedMessage}</Alert>}

        {!doc || !version ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {doc.title} · v{version.version}
                  {version.needsHumanReview ? (
                    <Badge variant="danger">needs review</Badge>
                  ) : (
                    <Badge variant="success">reviewed</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-neutral-500">
                  Generated {new Date(version.createdAt).toLocaleString()} — compare against the previous version below,
                  then resolve the flagged claims before this version can be exported.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Diff against previous version</CardTitle></CardHeader>
              <CardContent>
                <DocumentDiffView base={baseVersion?.content ?? null} current={version.content} />
              </CardContent>
            </Card>

            {version.needsHumanReview && version.flaggedClaims && version.flaggedClaims.length > 0 ? (
              <Card>
                <CardHeader><CardTitle>Flagged claims</CardTitle></CardHeader>
                <CardContent>
                  <ClaimReviewPanel
                    claims={version.flaggedClaims}
                    submitting={submitting}
                    onSubmit={handleReviewSubmit}
                  />
                </CardContent>
              </Card>
            ) : !version.needsHumanReview && version.flaggedClaims && version.flaggedClaims.length > 0 ? (
              <Card>
                <CardHeader><CardTitle>Flagged claims (resolved)</CardTitle></CardHeader>
                <CardContent>
                  <ul className="flex flex-col gap-2 text-sm">
                    {version.flaggedClaims.map((c, i) => (
                      <li key={i} className="rounded-md border border-neutral-200 p-3 text-neutral-700">{c.text}</li>
                    ))}
                  </ul>
                  <p className="mt-3 text-sm text-success-600">This version is approved and exportable.</p>
                </CardContent>
              </Card>
            ) : (
              <Alert variant="success">This version has no pending review — it is exportable.</Alert>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
