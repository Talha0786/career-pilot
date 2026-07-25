-- Migration 0007 (task 044): apply_tasks + apply_task_steps — persistence
-- for the ApplyTask state machine (docs/05-playwright-design.md §2-3). The
-- browser-runner (task 047) is stateless: all state lives here so a crashed
-- runner can resume (re-read the task row + its step history) or safely
-- abort, never leaving an ApplyTask silently orphaned mid-flight.
--
-- apply_task_steps mirrors stage_transitions (0001_init.sql): append-only,
-- one row per state transition / browser action. No updated_at column, no
-- UPDATE/DELETE path in any repository — enforced at the DB level the same
-- way stage_transitions is (application code discipline + this comment),
-- since Postgres has no first-class "insert-only" table constraint short of
-- a trigger. A `REVOKE UPDATE, DELETE` grant is deliberately NOT added here
-- (would also block the app's own connection role, which isn't split by
-- privilege in this schema) — documented as the enforcement mechanism task
-- 045's aggregate/repository must honor, per this task's acceptance
-- criterion.

CREATE TYPE apply_task_stage AS ENUM (
  'draft', 'mapping', 'filling', 'awaiting_review', 'approved',
  'submitting', 'submitted', 'failed', 'aborted'
);

CREATE TABLE apply_tasks (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id       uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  job_posting_id       uuid NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  document_version_id  uuid NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  stage                apply_task_stage NOT NULL DEFAULT 'draft',
  ats_adapter          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apply_tasks_user_idx ON apply_tasks (user_id, updated_at DESC);
CREATE INDEX apply_tasks_application_idx ON apply_tasks (application_id);
-- Task 052's review queue hot path: "list awaiting_review tasks for user".
CREATE INDEX apply_tasks_user_stage_idx ON apply_tasks (user_id, stage);

-- Append-only. Never UPDATE or DELETE a row here — same posture as
-- stage_transitions. redacted_payload is JSONB so each step can carry
-- whatever shape its action needs (field key + masked value, error detail,
-- mapping-stage summary, ...) without a schema migration per action type;
-- "redacted" is an application-layer discipline (task 051's fill-runner
-- never writes a raw sensitive field value here) documented at the call
-- site, not something the column type can enforce by itself.
CREATE TABLE apply_task_steps (
  id               uuid PRIMARY KEY,
  apply_task_id    uuid NOT NULL REFERENCES apply_tasks(id) ON DELETE CASCADE,
  from_stage       apply_task_stage,
  to_stage         apply_task_stage NOT NULL,
  action            text,
  redacted_payload  jsonb,
  screenshot_key    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apply_task_steps_task_idx ON apply_task_steps (apply_task_id, created_at);
