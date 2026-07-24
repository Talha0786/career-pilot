import type { ApplicationRepository, JobPostingRepository, ProfileRepository, MatchScoreRepository, Actor } from '../../ports/repositories.js';
import type { Stage, ScoreComponents } from '@careerpilot/domain';

export interface BoardCard {
  applicationId: string;
  jobPostingId: string;
  title: string;
  company: string | null;
  stage: Stage;
  embeddingStatus: 'pending' | 'ready' | 'failed';
  updatedAt: string;
  /** Task 038 — the caller's active-profile rubric score against this job, when one exists. */
  matchScore?: { components: ScoreComponents; computedAt: string } | undefined;
}

export function makeGetBoardUseCase(deps: {
  applications: ApplicationRepository;
  jobPostings: JobPostingRepository;
  /** Optional — task 038 additive extension. A board built without these still works exactly as before (task 011), just without matchScore populated. */
  profiles?: ProfileRepository | undefined;
  matchScores?: MatchScoreRepository | undefined;
}) {
  return async function getBoard(actor: Actor): Promise<Record<Stage, BoardCard[]>> {
    const apps = await deps.applications.listForUser(actor.userId);

    const columns = Object.fromEntries(
      (['discovered', 'interested', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn'] as Stage[]).map(
        (s) => [s, [] as BoardCard[]],
      ),
    ) as Record<Stage, BoardCard[]>;

    // Looked up once per board render, not per card — a user has at most
    // one active profile (task 020's singleton policy), so this is a
    // single extra read regardless of board size.
    const activeProfile = deps.profiles ? await deps.profiles.findActiveForUser(actor.userId) : null;

    for (const app of apps) {
      const job = await deps.jobPostings.findByIdForUser(app.jobPostingId, actor.userId);
      if (job === null) continue; // orphaned reference — skip rather than crash the board

      let matchScore: BoardCard['matchScore'];
      if (activeProfile && deps.matchScores) {
        const score = await deps.matchScores.findByProfileAndJob(activeProfile.id, job.id);
        if (score) matchScore = { components: score.components, computedAt: score.computedAt.toISOString() };
      }

      columns[app.stage].push({
        applicationId: app.id,
        jobPostingId: job.id,
        title: job.title,
        company: job.company,
        stage: app.stage,
        embeddingStatus: job.embeddingStatus,
        updatedAt: app.updatedAt.toISOString(),
        matchScore,
      });
    }

    return columns;
  };
}
