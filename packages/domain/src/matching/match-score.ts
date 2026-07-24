import { type MatchScoreId, type CareerProfileId, type JobPostingId, newMatchScoreId } from '../shared/ids.js';

/**
 * The rubric dimensions this task scores (task 038). Matches
 * `prompts/match-score/v1.md`'s output shape exactly (task 034) — that
 * prompt file and this type must never drift apart, since `score-match.ts`
 * validates the LLM's JSON response against the contracts-package mirror of
 * this shape (`ScoreComponentsSchema`).
 *
 * Dimension choice: `docs/02-database-design.md`'s `match_scores.components`
 * lists `{skills, seniority, domain, location, compensation}` — this swaps
 * `compensation` for `experience` (salary data is frequently absent from a
 * job posting, making it an unreliable rubric dimension to score against,
 * whereas years/type of experience is almost always inferable from both the
 * profile and the posting) and keeps the other four. Documented here rather
 * than silently diverging from the design doc.
 */
export interface ScoreComponents {
  readonly skills: number; // 0-1
  readonly experience: number; // 0-1
  readonly seniority: number; // 0-1
  readonly domain: number; // 0-1
  readonly location: number; // 0-1
  readonly overall: number; // 0-1 — the holistic score, not a simple average
  readonly rationale: string;
}

export interface MatchScoreSnapshot {
  readonly id: MatchScoreId;
  readonly profileId: CareerProfileId;
  readonly jobPostingId: JobPostingId;
  readonly components: ScoreComponents;
  readonly computedAt: Date;
  /** The profile's factsHash AT SCORING TIME — same staleness pattern as `DocumentVersion.profileFactsHash`. */
  readonly factsHash: string;
  /** The profile's embedding model at scoring time (which produced the ANN-prefiltered candidate pool this score came from). */
  readonly embeddingModel: string;
}

/**
 * MatchScore — value object (task 038), deliberately NOT an `AggregateRoot`:
 * no domain events, no mutation methods. It's an immutable snapshot of "this
 * profile scored against this job posting, at this factsHash" — a rescan
 * produces a brand-new instance (upserted over the old row by the
 * repository), never an in-place edit.
 */
export class MatchScore {
  private constructor(
    readonly id: MatchScoreId,
    readonly profileId: CareerProfileId,
    readonly jobPostingId: JobPostingId,
    readonly components: ScoreComponents,
    readonly computedAt: Date,
    readonly factsHash: string,
    readonly embeddingModel: string,
  ) {}

  static create(args: {
    profileId: CareerProfileId;
    jobPostingId: JobPostingId;
    components: ScoreComponents;
    factsHash: string;
    embeddingModel: string;
    now?: Date;
  }): MatchScore {
    return new MatchScore(
      newMatchScoreId(),
      args.profileId,
      args.jobPostingId,
      args.components,
      args.now ?? new Date(),
      args.factsHash,
      args.embeddingModel,
    );
  }

  static fromSnapshot(s: MatchScoreSnapshot): MatchScore {
    return new MatchScore(s.id, s.profileId, s.jobPostingId, s.components, s.computedAt, s.factsHash, s.embeddingModel);
  }

  /** Stale relative to a profile whose CURRENT factsHash no longer matches — same posture as `DocumentVersion.isStaleAgainst`. */
  isStaleAgainst(currentProfileFactsHash: string): boolean {
    return this.factsHash !== currentProfileFactsHash;
  }

  toSnapshot(): MatchScoreSnapshot {
    return {
      id: this.id,
      profileId: this.profileId,
      jobPostingId: this.jobPostingId,
      components: this.components,
      computedAt: this.computedAt,
      factsHash: this.factsHash,
      embeddingModel: this.embeddingModel,
    };
  }
}
