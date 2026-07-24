import { ReviewClient } from './ReviewClient.js';

/**
 * Task 041 — dedicated route for reviewing a generated `DocumentVersion`
 * flagged `needsHumanReview: true` by task 040's claim-verification pass.
 * A plain server component that unwraps the dynamic segments (Next 15:
 * `params` is a Promise) and hands them to the client component that does
 * the actual data fetching/interaction — keeps the 'use client' boundary
 * exactly where the existing pages (task 025) already draw it, one level
 * in from the route file itself.
 */
export default async function DocumentReviewPage({
  params,
}: {
  params: Promise<{ id: string; versionId: string }>;
}) {
  const { id, versionId } = await params;
  return <ReviewClient documentId={id} versionId={versionId} />;
}
