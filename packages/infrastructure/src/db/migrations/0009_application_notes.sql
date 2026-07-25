-- Migration 0009 (task 058): application_notes table — append-only note
-- log for the `add_application_note` MCP tool. Deliberately not folded
-- into the `applications` table or the `stage_transitions` history; a
-- note has no state-machine rules, just an ownership-scoped insert.

CREATE TABLE application_notes (
  id              uuid PRIMARY KEY,
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  note_md         text NOT NULL,
  actor           transition_actor NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_notes_application_idx ON application_notes (application_id, created_at DESC);
