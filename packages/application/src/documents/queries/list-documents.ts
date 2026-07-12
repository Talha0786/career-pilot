import type { DocumentRepository, ProfileRepository, Actor } from '../../ports/repositories.js';

export interface DocumentListItem {
  id: string;
  kind: string;
  title: string;
  currentVersionId: string | null;
  currentVersion: number | null;
  /**
   * True when the document's current version's `profileFactsHash` no longer
   * matches the user's active profile's current facts hash (task 025 UI
   * "stale" badge). Always false when the current version has no recorded
   * profileFactsHash (imported/edited versions never claim provenance from
   * a profile snapshot) or when the user has no active profile at all.
   */
  isStale: boolean;
  updatedAt: string;
}

/**
 * Lists the user's non-deleted documents. Depends on `ProfileRepository` in
 * addition to `DocumentRepository` — staleness (design §2: "lets UI flag
 * documents stale relative to profile") is a cross-aggregate read computed
 * here, not stored redundantly on the document.
 */
export function makeListDocumentsUseCase(deps: { documents: DocumentRepository; profiles: ProfileRepository }) {
  return async function listDocuments(actor: Actor): Promise<{ items: DocumentListItem[] }> {
    const [docs, profile] = await Promise.all([
      deps.documents.listForUser(actor.userId),
      deps.profiles.findActiveForUser(actor.userId),
    ]);
    const currentFactsHash = profile?.factsHash ?? null;

    return {
      items: docs.map((doc) => {
        const current = doc.currentVersion;
        const isStale =
          current !== null && currentFactsHash !== null ? current.isStaleAgainst(currentFactsHash) : false;
        return {
          id: doc.id,
          kind: doc.kind,
          title: doc.title,
          currentVersionId: doc.currentVersionId,
          currentVersion: current?.version ?? null,
          isStale,
          updatedAt: (current?.createdAt ?? doc.createdAt).toISOString(),
        };
      }),
    };
  };
}
