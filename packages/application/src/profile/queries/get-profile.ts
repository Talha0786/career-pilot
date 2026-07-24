import { notFound, type CareerProfile, type Result, type DomainError } from '@careerpilot/domain';
import type { ProfileRepository, Actor } from '../../ports/repositories.js';

export interface ProfileSectionSummary {
  id: string;
  kind: string;
  sort: number;
  content: unknown;
}
export interface CareerProfileSummary {
  id: string;
  title: string;
  summary: string | null;
  isActive: boolean;
  embeddingStatus: 'pending' | 'ready' | 'failed';
  factsHash: string;
  isEmbeddingStale: boolean;
  sections: ProfileSectionSummary[];
  createdAt: string;
}

function toSummary(profile: CareerProfile): CareerProfileSummary {
  return {
    id: profile.id,
    title: profile.title,
    summary: profile.summary,
    isActive: profile.isActive,
    embeddingStatus: profile.embeddingStatus,
    factsHash: profile.factsHash,
    isEmbeddingStale: profile.isEmbeddingStale,
    sections: [...profile.sections]
      .sort((a, b) => a.sort - b.sort)
      .map((s) => ({ id: s.id, kind: s.kind, sort: s.sort, content: s.content })),
    createdAt: profile.createdAt.toISOString(),
  };
}

/** Not found (rather than an empty default) — the UI (task 025) distinguishes "no profile yet" from "empty profile". */
export function makeGetProfileUseCase(deps: { profiles: ProfileRepository }) {
  return async function getProfile(actor: Actor): Promise<Result<CareerProfileSummary, DomainError>> {
    const profile = await deps.profiles.findActiveForUser(actor.userId);
    if (profile === null) return { ok: false, error: notFound('No career profile exists yet') };
    return { ok: true, value: toSummary(profile) };
  };
}
