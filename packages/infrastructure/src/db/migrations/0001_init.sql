-- Migration 0001: initial M2 schema.
-- Postgres is the sole supported dialect (ADR-002 amendment) — no SQLite variant exists or will.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE user_role AS ENUM ('owner', 'member');
CREATE TYPE embedding_status AS ENUM ('pending', 'ready', 'failed');
CREATE TYPE stage AS ENUM ('discovered', 'interested', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn');
CREATE TYPE transition_actor AS ENUM ('user', 'system', 'agent');
CREATE TYPE invocation_status AS ENUM ('ok', 'error');
CREATE TYPE invocation_context AS ENUM ('matching', 'tailoring', 'interview', 'agent', 'parsing');

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           text NOT NULL,
  password_hash   text NOT NULL,
  role            user_role NOT NULL DEFAULT 'owner',
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- NOTE: vector(768), not the 1024 in the original design doc — the key-free
-- local default model (nomic-embed-text, ADR-006) emits 768 dims. The schema
-- follows the model that actually runs out of the box, not the doc.
CREATE TABLE job_postings (
  id                    uuid PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_connector_key  text NOT NULL DEFAULT 'manual',
  url                   text,
  url_hash              text,
  company               text,
  title                 text NOT NULL,
  description_md        text NOT NULL,
  embedding_status      embedding_status NOT NULL DEFAULT 'pending',
  embedding_model       text,
  embedding             vector(768),
  ingested_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_postings_user_ingested_idx ON job_postings (user_id, ingested_at DESC);
CREATE INDEX job_postings_url_hash_idx ON job_postings (url_hash);

CREATE TABLE applications (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_posting_id  uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  stage           stage NOT NULL DEFAULT 'discovered',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_user_idx ON applications (user_id);

-- Append-only. Application code must never UPDATE or DELETE here (db design §2).
CREATE TABLE stage_transitions (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage      stage,
  to_stage        stage NOT NULL,
  actor           transition_actor NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stage_transitions_application_idx ON stage_transitions (application_id, created_at);

-- Transactional outbox (ADR-007). Partial index is the relay's entire hot path:
-- "unpublished rows, oldest first" without ever scanning published history.
CREATE TABLE outbox (
  id               uuid PRIMARY KEY,
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text
);
CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL;

-- Append-only cost/audit trail written by GuardedLlmPort — success AND failure.
CREATE TABLE ai_invocations (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context             invocation_context NOT NULL,
  ref_id              text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  prompt_tokens       integer NOT NULL DEFAULT 0,
  completion_tokens   integer NOT NULL DEFAULT 0,
  cost_usd            numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms          integer NOT NULL DEFAULT 0,
  status              invocation_status NOT NULL,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_invocations_user_created_idx ON ai_invocations (user_id, created_at);

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  subject_type  text,
  subject_id    text,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
