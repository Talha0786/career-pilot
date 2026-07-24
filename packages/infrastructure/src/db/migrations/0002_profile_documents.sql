-- Migration 0002: M3 profile & document tables (design §2). Additive only —
-- does not touch any M2 (0001) table.

CREATE TYPE profile_section_kind AS ENUM ('experience', 'education', 'project', 'skill_group', 'certification', 'summary');
CREATE TYPE document_kind AS ENUM ('resume', 'cover_letter', 'other');
CREATE TYPE document_version_source AS ENUM ('imported', 'generated', 'edited');

-- vector(768), not the design doc's 1024 — same correction already applied
-- to job_postings in 0001 (nomic-embed-text, ADR-006, emits 768 dims).
CREATE TABLE career_profiles (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 text NOT NULL,
  summary               text,
  is_active             boolean NOT NULL DEFAULT true,
  embedding_status      embedding_status NOT NULL DEFAULT 'pending',
  embedding_model       text,
  embedding             vector(768),
  embedded_facts_hash   text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX career_profiles_user_idx ON career_profiles (user_id);
-- Defense-in-depth for the application-layer "one active profile per user"
-- policy (createProfile use case, task 020) — closes the read-check-write
-- race a plain application check leaves open under concurrency, same
-- reasoning as users_email_unique in 0001.
CREATE UNIQUE INDEX career_profiles_user_active_unique ON career_profiles (user_id) WHERE is_active = true;

-- One row per entry (experience, education, project, skill-group,
-- certification, summary) — design §2 rationale: section schemas evolve
-- fast; queries are by profile, not by field.
CREATE TABLE profile_sections (
  id            uuid PRIMARY KEY,
  profile_id    uuid NOT NULL REFERENCES career_profiles(id) ON DELETE CASCADE,
  kind          profile_section_kind NOT NULL,
  sort          integer NOT NULL DEFAULT 0,
  content       jsonb NOT NULL,
  -- Populated by the repository from ProfileSection.toContentText() (the
  -- domain already knows how to flatten each kind to searchable text).
  content_text  text NOT NULL DEFAULT ''
);
CREATE INDEX profile_sections_profile_sort_idx ON profile_sections (profile_id, sort);

-- Real Postgres GENERATED column, derived from content_text — FTS can never
-- drift out of sync with content_text by construction (design §2: "FTS via
-- generated tsvector on content_text").
ALTER TABLE profile_sections
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED;
CREATE INDEX profile_sections_content_tsv_idx ON profile_sections USING gin (content_tsv);

-- current_version_id has NO foreign key — it would be circular with
-- document_versions.document_id (see schema/index.ts comment). Referential
-- integrity is enforced at the application layer instead.
CREATE TABLE documents (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                document_kind NOT NULL,
  title               text NOT NULL,
  current_version_id  uuid,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_user_idx ON documents (user_id);

-- Append-only (design §2 invariant): no updated_at column, and application
-- code must never UPDATE or DELETE a row here — INSERT only, ever.
CREATE TABLE document_versions (
  id                  uuid PRIMARY KEY,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version             integer NOT NULL,
  source              document_version_source NOT NULL,
  content             jsonb NOT NULL,
  rendered_pdf_key    text,
  generation_job_id   uuid,
  profile_facts_hash  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_versions_document_idx ON document_versions (document_id, version);
-- Duplicate version numbers for the same document are a hard DB error, not
-- just an application-level convention (task 021 acceptance criterion).
CREATE UNIQUE INDEX document_versions_document_version_unique ON document_versions (document_id, version);
