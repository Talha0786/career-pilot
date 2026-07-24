-- Migration 0003: connector configuration/health tracking + ingestion history
-- (task 027, M4), plus the job_postings columns M2 deliberately left out
-- (design §2: external_id, dedup_group_id, status, location, remote, salary,
-- posted_at). M2 shipped the manual-paste subset only.
--
-- NUMBERING NOTE: this repo has two parallel milestone tracks (tasks/README.md)
-- — M3 (profile & documents, tasks 019-025, branch m3-profile-documents) and
-- M4 (connectors, tasks 026-032, this branch). M3's schema migration would be
-- 0002_profile_documents.sql; it does not exist on this branch because the
-- two tracks develop independently and merge later. This migration is
-- deliberately self-contained — it does not reference any table M3 would add
-- — so it is safe to apply on top of 0001_init.sql alone (as it will in this
-- branch's CI) and equally safe once 0002 lands from the other track and
-- both are applied together in numeric order after merge.

-- BACKFILL STRATEGY for job_postings.external_id: none needed. The column is
-- nullable and every existing row (all pre-M4: manual pastes) gets NULL.
-- Postgres unique indexes treat every NULL as distinct from every other NULL
-- for uniqueness purposes, so the new unique index on
-- (source_connector_key, external_id) added below does NOT reject having
-- many 'manual' rows all with external_id IS NULL — it only rejects two rows
-- from the SAME connector claiming the SAME non-null external id.

CREATE TYPE posting_status AS ENUM ('active', 'closed', 'expired');
CREATE TYPE remote_type AS ENUM ('remote', 'hybrid', 'onsite', 'unknown');
CREATE TYPE connector_health AS ENUM ('healthy', 'degraded', 'disabled');
CREATE TYPE ingestion_status AS ENUM ('running', 'ok', 'partial', 'failed');

ALTER TABLE job_postings
  ADD COLUMN external_id     text,
  ADD COLUMN status          posting_status NOT NULL DEFAULT 'active',
  ADD COLUMN location        jsonb,
  ADD COLUMN remote          remote_type NOT NULL DEFAULT 'unknown',
  ADD COLUMN salary          jsonb,
  ADD COLUMN posted_at       timestamptz,
  ADD COLUMN dedup_group_id  uuid;

CREATE UNIQUE INDEX job_postings_source_external_unique ON job_postings (source_connector_key, external_id);
CREATE INDEX job_postings_dedup_group_idx ON job_postings (dedup_group_id);

CREATE TABLE connector_configs (
  id                     uuid PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_key          text NOT NULL,
  display_name           text NOT NULL,
  enabled                boolean NOT NULL DEFAULT true,
  schedule_cron          text,
  config                 jsonb NOT NULL DEFAULT '{}',
  -- Reference into the secrets store (env var name / secrets-manager key)
  -- ONLY — never a raw credential/API key value (security model §4).
  credentials_ref        text,
  health                 connector_health NOT NULL DEFAULT 'healthy',
  consecutive_failures   integer NOT NULL DEFAULT 0,
  last_success_at        timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_configs_user_idx ON connector_configs (user_id);
CREATE UNIQUE INDEX connector_configs_user_connector_unique ON connector_configs (user_id, connector_key);

-- Append-only. Application code writes with start() (INSERT, status='running')
-- then complete() (UPDATE of that same row's terminal fields only) — never a
-- rewrite of a different run's history. Same posture as stage_transitions/outbox.
CREATE TABLE ingestion_runs (
  id                    uuid PRIMARY KEY,
  connector_config_id   uuid NOT NULL REFERENCES connector_configs(id) ON DELETE CASCADE,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  status                ingestion_status NOT NULL DEFAULT 'running',
  stats                 jsonb NOT NULL DEFAULT '{"fetched": 0, "deduped": 0, "inserted": 0}',
  error                 text
);
CREATE INDEX ingestion_runs_connector_config_idx ON ingestion_runs (connector_config_id, started_at DESC);
