-- Migration 0005 (task 038): match_scores table — persisted rubric-LLM
-- scores from the match-scoring pipeline. Unique on (profile_id,
-- job_posting_id): a rescan is an upsert (replaces the row), not an
-- append — see MatchScoreRepository's doc comment in
-- packages/application/src/ports/repositories.ts for why this is a
-- deliberate simplification of docs/02-database-design.md's original
-- (job_posting_id, profile_id, method) append-many sketch.

CREATE TABLE match_scores (
  id               uuid PRIMARY KEY,
  profile_id       uuid NOT NULL REFERENCES career_profiles(id) ON DELETE CASCADE,
  job_posting_id   uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  components       jsonb NOT NULL,
  facts_hash       text NOT NULL,
  embedding_model  text NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX match_scores_profile_job_unique ON match_scores (profile_id, job_posting_id);
CREATE INDEX match_scores_profile_idx ON match_scores (profile_id, computed_at DESC);
