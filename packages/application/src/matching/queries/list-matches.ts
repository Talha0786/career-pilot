import { notFound, type Result, ok, err, type DomainError } from '@careerpilot/domain';
import type { ProfileRepository, JobPostingRepository, MatchScoreRepository, Actor } from '../../ports/repositories.js';

export interface MatchListItem {
  readonly jobPostingId: string;
  readonly title: string;
  readonly company: string | null;
  readonly components: {
    skills: number; experience: number; seniority: number; domain: number; location: number;
    overall: number; rationale: string;
  };
  readonly computedAt: string;
  readonly stale: boolean;
}

/**
 * Task 038 "queryable per profile" acceptance criterion, surfaced at the API
 * level (not just internally via the repository) — lets the UI show a
 * ranked list of scored candidates outside the board's per-application
 * cards (`get-board.ts`'s `matchScore` field only covers postings the user
 * already tracks as an `Application`; this covers every scored candidate,
 * tracked or not).
 */
export function makeListMatchesUseCase(deps: {
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  matchScores: MatchScoreRepository;
}) {
  return async function listMatches(actor: Actor): Promise<Result<MatchListItem[], DomainError>> {
    const profile = await deps.profiles.findActiveForUser(actor.userId);
    if (profile === null) {
      return err(notFound('No career profile exists yet'));
    }

    const scores = await deps.matchScores.listForProfile(profile.id);
    const items: MatchListItem[] = [];
    for (const score of scores) {
      const job = await deps.jobPostings.findByIdForUser(score.jobPostingId, actor.userId);
      if (job === null) continue; // orphaned reference — skip rather than crash the list
      items.push({
        jobPostingId: job.id,
        title: job.title,
        company: job.company,
        components: score.components,
        computedAt: score.computedAt.toISOString(),
        stale: score.isStaleAgainst(profile.factsHash),
      });
    }
    // Highest overall match first — the whole point of a ranked candidate list.
    items.sort((a, b) => b.components.overall - a.components.overall);
    return ok(items);
  };
}
