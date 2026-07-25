-- Migration 0008 (task 060, also used by task 061): interview_preps table.
-- One table backs three related content kinds, discriminated by `kind`:
-- LLM-generated question sets and citation-checked company research briefs
-- (both task 060), and mock-interviewer session transcripts (task 061).

CREATE TYPE interview_prep_kind AS ENUM ('questions', 'company_research', 'mock_interview_transcript');

CREATE TABLE interview_preps (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind            interview_prep_kind NOT NULL,
  content         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_preps_application_idx ON interview_preps (application_id, created_at DESC);
