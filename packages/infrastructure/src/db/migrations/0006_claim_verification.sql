-- Migration 0006 (task 040): claim-verification / human-review state on
-- document_versions. Additive columns only — no existing row's meaning
-- changes; every pre-existing version defaults to needs_human_review=false
-- (nothing to review, it predates this gate).
--
-- These are legitimate post-hoc field updates on an already-inserted
-- version (same posture as rendered_pdf_key, task 024) — task 041's human
-- review resolution will UPDATE needs_human_review/flagged_claims on an
-- EXISTING row, never content/version/source/created_at. Still append-only
-- with respect to the row's FACTUAL content.

ALTER TABLE document_versions
  ADD COLUMN needs_human_review boolean NOT NULL DEFAULT false,
  ADD COLUMN flagged_claims jsonb;
