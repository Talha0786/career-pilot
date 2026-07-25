import type { ApplicationRepository, MatchScoreRepository, ProfileRepository, Actor } from '../../ports/repositories.js';
import type { Stage } from '@careerpilot/domain';

export interface GetPipelineAnalyticsInput {
  range: '7d' | '30d' | '90d' | 'all';
}
export interface PipelineAnalytics {
  range: '7d' | '30d' | '90d' | 'all';
  totalApplications: number;
  byStage: Record<Stage, number>;
  staleApplications: number;
  averageMatchScore: number | null;
}

const RANGE_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 };
const STALE_THRESHOLD_DAYS = 14;
const ALL_STAGES: Stage[] = [
  'discovered', 'interested', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn',
];

/**
 * Task 057's `get_pipeline_analytics` MCP tool. No analytics/funnel query
 * existed anywhere in the codebase before this task (M8's roadmap owns the
 * full analytics dashboard) — this is deliberately the minimal funnel-
 * stats computation the MCP tool needs, not a general-purpose analytics
 * engine: a handful of aggregate counts over `ApplicationRepository.
 * listForUser`, computed in memory (the same scale assumption `get-
 * board.ts` already makes — no pagination, one user's applications fit in
 * memory). A real dashboard (M8) would push this into SQL aggregates;
 * out of scope here per the task's own "keep it minimal" instruction.
 */
export function makeGetPipelineAnalyticsUseCase(deps: {
  applications: ApplicationRepository;
  matchScores: MatchScoreRepository;
  profiles: ProfileRepository;
}) {
  return async function getPipelineAnalytics(actor: Actor, input: GetPipelineAnalyticsInput): Promise<PipelineAnalytics> {
    const apps = await deps.applications.listForUser(actor.userId);
    const now = Date.now();

    const cutoff = input.range === 'all' ? null : now - RANGE_DAYS[input.range] * 24 * 60 * 60 * 1000;
    const inRange = cutoff === null ? apps : apps.filter((a) => a.updatedAt.getTime() >= cutoff);

    const byStage = Object.fromEntries(ALL_STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    let stale = 0;
    for (const app of inRange) {
      byStage[app.stage] += 1;
      const ageDays = (now - app.updatedAt.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays >= STALE_THRESHOLD_DAYS && app.stage !== 'rejected' && app.stage !== 'withdrawn' && app.stage !== 'offer') {
        stale += 1;
      }
    }

    const profile = await deps.profiles.findActiveForUser(actor.userId);
    let averageMatchScore: number | null = null;
    if (profile) {
      const scores = await deps.matchScores.listForProfile(profile.id);
      if (scores.length > 0) {
        averageMatchScore = scores.reduce((sum, s) => sum + s.components.overall, 0) / scores.length;
      }
    }

    return {
      range: input.range,
      totalApplications: inRange.length,
      byStage,
      staleApplications: stale,
      averageMatchScore,
    };
  };
}
