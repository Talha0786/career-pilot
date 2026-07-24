-- Migration 0004 (task 036): pgvector HNSW ANN indexes on job_postings.embedding
-- and career_profiles.embedding — deliberately deferred from M2/M3 (schema
-- comment: "real cardinality needed to choose parameters sensibly"). M5's
-- matching pipeline (task 038) needs the embedding prefilter
-- (docs/06-agent-design.md §3) to be a real indexed ANN query, not a
-- sequential scan over every posting.
--
-- PARAMETER CHOICE: no prior guidance found in docs/02-database-design.md or
-- docs/06-agent-design.md beyond "HNSW on embedding" (no m/ef_construction
-- specified) — using pgvector's own documented defaults (m=16,
-- ef_construction=64), which are a reasonable general-purpose starting point
-- for this milestone's scale. Revisit once real production cardinality is
-- known (same "defer the real number until real data exists" posture the
-- original schema comment already established).
--
-- vector_cosine_ops matches the `<=>` cosine-distance operator the
-- application layer's ANN queries use (task 036's findNearestByEmbedding) —
-- consistent with embeddings being compared for directional similarity, not
-- magnitude, same as every other embedding-similarity use case in this
-- design.
CREATE INDEX job_postings_embedding_hnsw_idx
  ON job_postings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX career_profiles_embedding_hnsw_idx
  ON career_profiles
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
