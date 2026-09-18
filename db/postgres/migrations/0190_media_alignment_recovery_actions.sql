-- Persisted authorization for one bounded re-alignment of a published song
-- whose exact-bound projection is unavailable. The row is created by an
-- operator-scoped transaction that verifies the publication binding, the
-- canonical audio SHA-256 and the stored lyrics SHA-256 before it advances the
-- Workflow revision and writes the replacement outbox. One row is permitted
-- per projection revision: the unique identity constraint makes a second,
-- concurrent or later launch for the same audio, analysis and lyrics revision
-- fail closed instead of spending another provider call. The consumed attempt
-- history is never rewritten; the recovery is a distinct attempt identity.
-- Completion is written in the same transaction as the projection update.

CREATE TABLE media_alignment_recovery_actions (
  recovery_action_id TEXT PRIMARY KEY CHECK (btrim(recovery_action_id) <> ''),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision INTEGER NOT NULL CHECK (audio_revision > 0),
  analysis_revision INTEGER NOT NULL CHECK (analysis_revision > 0),
  lyrics_revision INTEGER NOT NULL CHECK (lyrics_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL,
  lyrics_sha256 TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','completed')),
  result_kind TEXT CHECK (result_kind IN ('ready','unavailable')),
  artifact_ref TEXT,
  artifact_sha256 TEXT,
  failure_code TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CHECK (
    (state = 'requested' AND result_kind IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND result_kind IS NOT NULL AND completed_at IS NOT NULL)
  ),
  UNIQUE (operation_id, idempotency_key),
  UNIQUE (
    community_id,
    actor_user_id,
    submission_id,
    operation_id,
    post_id,
    audio_revision,
    analysis_revision,
    lyrics_revision
  )
);
