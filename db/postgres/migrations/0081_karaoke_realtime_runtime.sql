-- Spec 019 Karaoke realtime runtime. Session authority is frozen before the
-- Durable Object accepts audio; terminal score evidence and recording archive
-- reconciliation remain independent state transitions.

ALTER TABLE karaoke_sessions
  ADD COLUMN lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  ADD COLUMN scoring_version INTEGER NOT NULL DEFAULT 5 CHECK (scoring_version = 5),
  ADD COLUMN scoring_provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (
    scoring_provider = 'elevenlabs'
  ),
  ADD COLUMN scoring_model TEXT NOT NULL DEFAULT 'scribe_v2_realtime' CHECK (
    scoring_model = 'scribe_v2_realtime'
  ),
  ADD COLUMN line_snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(line_snapshot) = 'array'
    AND jsonb_array_length(line_snapshot) BETWEEN 1 AND 500
    AND octet_length(line_snapshot::text) <= 262144
  ),
  ADD COLUMN client_context JSONB CHECK (
    jsonb_typeof(client_context) = 'object'
    AND octet_length(client_context::text) <= 1024
  );

CREATE FUNCTION guard_karaoke_runtime_session_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.lyrics_revision, NEW.scoring_version, NEW.scoring_provider,
    NEW.scoring_model, NEW.line_snapshot, NEW.client_context
  ) IS DISTINCT FROM ROW(
    OLD.lyrics_revision, OLD.scoring_version, OLD.scoring_provider,
    OLD.scoring_model, OLD.line_snapshot, OLD.client_context
  ) THEN
    RAISE EXCEPTION 'Karaoke runtime session authority is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER karaoke_runtime_session_authority_guard
BEFORE UPDATE ON karaoke_sessions
FOR EACH ROW EXECUTE FUNCTION guard_karaoke_runtime_session_authority();

ALTER TABLE karaoke_attempts
  ADD COLUMN lyrics_score_bps INTEGER NOT NULL CHECK (lyrics_score_bps BETWEEN 0 AND 10000),
  ADD COLUMN timing_score_bps INTEGER CHECK (timing_score_bps BETWEEN 0 AND 10000),
  ADD COLUMN timing_trend TEXT NOT NULL CHECK (
    timing_trend IN ('early', 'late', 'mixed', 'on_time')
  ),
  ADD COLUMN uncertain_line_count INTEGER NOT NULL CHECK (
    uncertain_line_count BETWEEN 0 AND line_count
  ),
  ADD COLUMN no_recognition_line_count INTEGER NOT NULL CHECK (
    no_recognition_line_count BETWEEN 0 AND line_count
  ),
  ADD COLUMN low_confidence_line_count INTEGER NOT NULL CHECK (
    low_confidence_line_count BETWEEN 0 AND line_count
  ),
  ADD COLUMN scoring_diagnostics JSONB NOT NULL CHECK (
    jsonb_typeof(scoring_diagnostics) = 'object'
    AND scoring_diagnostics->>'schema_version' = '1'
    AND (scoring_diagnostics->>'scoring_version')::integer = scoring_version
    AND jsonb_typeof(scoring_diagnostics->'line_diagnostics') = 'array'
    AND jsonb_array_length(scoring_diagnostics->'line_diagnostics') <= line_count
    AND octet_length(scoring_diagnostics::text) <= 131072
  ),
  ADD COLUMN transport_facts JSONB NOT NULL CHECK (
    jsonb_typeof(transport_facts) = 'object'
    AND transport_facts->>'schema_version' = '1'
    AND octet_length(transport_facts::text) <= 4096
  );

CREATE TABLE karaoke_recordings (
  session_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES users (user_id),
  artifact_id TEXT NOT NULL UNIQUE CHECK (
    btrim(artifact_id) <> '' AND artifact_id = btrim(artifact_id)
    AND octet_length(artifact_id) <= 128
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'stored', 'failed', 'deleted')
  ),
  object_ref TEXT,
  content_sha256 TEXT CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT CHECK (byte_size > 0),
  duration_ms INTEGER CHECK (duration_ms > 0),
  failure_kind TEXT CHECK (
    failure_kind IN ('multipart_aborted', 'multipart_failed', 'reconciliation_failed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reconciled_at TIMESTAMPTZ,
  FOREIGN KEY (session_id, attempt_id)
    REFERENCES karaoke_sessions (session_id, attempt_id),
  CONSTRAINT karaoke_recording_terminal_shape CHECK (
    (state = 'pending' AND object_ref IS NULL AND content_sha256 IS NULL
      AND byte_size IS NULL AND duration_ms IS NULL AND failure_kind IS NULL
      AND reconciled_at IS NULL)
    OR (state = 'stored' AND object_ref IS NOT NULL AND content_sha256 IS NOT NULL
      AND byte_size IS NOT NULL AND duration_ms IS NOT NULL AND failure_kind IS NULL
      AND reconciled_at IS NOT NULL)
    OR (state = 'failed' AND object_ref IS NULL AND failure_kind IS NOT NULL
      AND reconciled_at IS NOT NULL)
    OR (state = 'deleted' AND object_ref IS NULL AND reconciled_at IS NOT NULL)
  )
);

CREATE FUNCTION guard_karaoke_recording() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Karaoke recording rows cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.session_id, NEW.attempt_id, NEW.account_id, NEW.artifact_id, NEW.created_at)
      IS DISTINCT FROM
       ROW(OLD.session_id, OLD.attempt_id, OLD.account_id, OLD.artifact_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Karaoke recording identity is immutable';
    END IF;
    IF OLD.state <> 'pending' OR NEW.state NOT IN ('stored', 'failed') THEN
      IF OLD.state <> 'stored' OR NEW.state <> 'deleted' THEN
        RAISE EXCEPTION 'Invalid Karaoke recording transition';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER karaoke_recordings_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON karaoke_recordings
FOR EACH ROW EXECUTE FUNCTION guard_karaoke_recording();

CREATE INDEX karaoke_sessions_revision_score_idx
  ON karaoke_sessions (community_id, post_id, karaoke_revision_id, account_id);
