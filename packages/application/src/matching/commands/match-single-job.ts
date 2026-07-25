import {
  asJobPostingId, notFound, validationFailed, type Result, ok, err, type DomainError, compileFactList,
} from '@careerpilot/domain';
import type { ProfileRepository, JobPostingRepository, MatchScoreRepository, Actor } from '../../ports/repositories.js';
import type { GuardedLlmPort } from '../../ports/budget-guard.js';
import type { PromptStore } from '../../ports/prompt-store.port.js';
import { scoreOneCandidate } from './score-match.js';

export interface MatchSingleJobInput {
  jobId: string;
  method?: 'embedding' | 'rubric' | undefined;
}
export interface MatchSingleJobOutput {
  jobPostingId: string;
  components: { skills: number; experience: number; seniority: number; domain: number; location: number; overall: number; rationale: string } | null;
  computedAt: string | null;
  stale: boolean;
  method: 'embedding' | 'rubric';
}

/**
 * Task 057's `match_job` tool (§3: "Score/refresh match for a job", scope
 * `read` — deliberately read-scoped per the design doc despite `method:
 * 'rubric'` performing a live, budget-guarded LLM call: MCP write scopes
 * gate PIPELINE/DOCUMENT mutations, not read-adjacent recomputation of a
 * derived score that has no effect on application state. `method:
 * 'embedding'` (the default) is a pure read of whatever score is already
 * persisted — no LLM call, no cost — matching the "cheap default, explicit
 * opt-in to the expensive path" shape task 038's own scoring pipeline
 * already established for the board.
 */
export function makeMatchSingleJobUseCase(deps: {
  profiles: ProfileRepository;
  jobPostings: JobPostingRepository;
  matchScores: MatchScoreRepository;
  llm: GuardedLlmPort;
  prompts: PromptStore;
  model: string;
}) {
  return async function matchSingleJob(
    actor: Actor,
    input: MatchSingleJobInput,
  ): Promise<Result<MatchSingleJobOutput, DomainError>> {
    const method = input.method ?? 'embedding';

    const profile = await deps.profiles.findActiveForUser(actor.userId);
    if (profile === null) return err(notFound('No career profile exists yet'));

    const job = await deps.jobPostings.findByIdForUser(asJobPostingId(input.jobId), actor.userId);
    if (job === null) return err(notFound('Job posting not found'));

    if (method === 'embedding') {
      const existing = await deps.matchScores.findByProfileAndJob(profile.id, job.id);
      if (existing === null) {
        return ok({ jobPostingId: job.id, components: null, computedAt: null, stale: false, method });
      }
      return ok({
        jobPostingId: job.id,
        components: existing.components,
        computedAt: existing.computedAt.toISOString(),
        stale: existing.isStaleAgainst(profile.factsHash),
        method,
      });
    }

    // method === 'rubric': a live recompute for exactly this one job.
    if (profile.embedding === null || profile.embeddingStatus !== 'ready') {
      return err(validationFailed('Profile has no ready embedding yet — cannot score', {
        embeddingStatus: profile.embeddingStatus,
      }));
    }

    const promptResult = await deps.prompts.load('match-score');
    if (!promptResult.ok) {
      return err(validationFailed(`Could not load match-score prompt: ${promptResult.error.message}`));
    }

    const facts = compileFactList(profile);
    const factsText = facts.length > 0 ? facts.map((f) => `${f.id}: ${f.text}`).join('\n') : '(no profile facts yet)';

    const scored = await scoreOneCandidate({
      profile, job, factsText,
      promptRender: promptResult.value.render,
      temperature: promptResult.value.frontmatter.temperature,
      model: deps.model, llm: deps.llm, userId: actor.userId,
    });

    if (!scored.ok) {
      return err(validationFailed(`Scoring failed: ${scored.error.message}`));
    }

    await deps.matchScores.save(scored.value);

    return ok({
      jobPostingId: job.id,
      components: scored.value.components,
      computedAt: scored.value.computedAt.toISOString(),
      stale: false,
      method,
    });
  };
}
