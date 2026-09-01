-- Spec 021 phase 7. Private Dance attempts remain shadow-only. This migration
-- creates no activity-registry, qualification, streak, leaderboard, or reward row.

CREATE TABLE dance_sessions (
  session_id TEXT PRIMARY KEY CHECK (is_dance_identifier(session_id)),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision BETWEEN 1 AND 9007199254740991),
  segment_id TEXT NOT NULL,
  choreography_id TEXT NOT NULL,
  choreography_revision BIGINT NOT NULL CHECK (
    choreography_revision BETWEEN 1 AND 9007199254740991
  ),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'created' CHECK (state IN (
    'created', 'consented', 'awaiting_upload', 'uploaded', 'grading_pending',
    'completed', 'rejected', 'processing_failed', 'expired', 'abandoned'
  )),
  reward_mode TEXT NOT NULL CHECK (reward_mode = 'practice'),
  objective_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    objective_snapshot = '[]'::jsonb
  ),
  expected_scored_duration_ms BIGINT NOT NULL CHECK (
    expected_scored_duration_ms BETWEEN 6000 AND 30000
  ),
  cue_kind TEXT NOT NULL CHECK (cue_kind IN ('hands_on_head', 'arms_t', 'hands_on_hips')),
  cue_hold_ms BIGINT NOT NULL CHECK (cue_hold_ms > 0),
  cue_observation_start_ms BIGINT NOT NULL CHECK (cue_observation_start_ms >= 0),
  cue_observation_end_ms BIGINT NOT NULL CHECK (
    cue_observation_end_ms > cue_observation_start_ms
  ),
  qualification_policy_version_id TEXT NOT NULL CHECK (
    is_dance_identifier(qualification_policy_version_id)
  ),
  calibration_version_id TEXT NOT NULL CHECK (is_dance_identifier(calibration_version_id)),
  calibration_checksum TEXT NOT NULL CHECK (calibration_checksum ~ '^[0-9a-f]{64}$'),
  captured_admission_state TEXT NOT NULL CHECK (captured_admission_state = 'shadow'),
  platform_floor_bps INTEGER NOT NULL CHECK (platform_floor_bps BETWEEN 0 AND 10000),
  pose_model_version TEXT NOT NULL CHECK (is_dance_identifier(pose_model_version)),
  feature_schema_version TEXT NOT NULL CHECK (is_dance_identifier(feature_schema_version)),
  scorer_contract_version TEXT NOT NULL CHECK (is_dance_identifier(scorer_contract_version)),
  mirror_policy_version TEXT NOT NULL CHECK (is_dance_identifier(mirror_policy_version)),
  cue_policy_version TEXT NOT NULL CHECK (is_dance_identifier(cue_policy_version)),
  fingerprint_policy_version TEXT NOT NULL CHECK (
    is_dance_identifier(fingerprint_policy_version)
  ),
  fingerprint_key_version TEXT NOT NULL CHECK (is_dance_identifier(fingerprint_key_version)),
  integrity_policy_version TEXT NOT NULL CHECK (is_dance_identifier(integrity_policy_version)),
  grader_adapter_version TEXT NOT NULL CHECK (is_dance_identifier(grader_adapter_version)),
  session_terms_hash TEXT NOT NULL UNIQUE CHECK (session_terms_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (
    choreography_id, choreography_revision, community_id, song_post_id, audio_revision
  ) REFERENCES dance_choreography_revisions (
    choreography_id, revision, community_id, song_post_id, audio_revision
  ),
  FOREIGN KEY (segment_id, community_id, song_post_id, audio_revision)
    REFERENCES dance_song_segments (segment_id, community_id, song_post_id, audio_revision),
  UNIQUE (session_id, account_id, persona_id),
  CONSTRAINT dance_session_cue_window CHECK (
    cue_hold_ms <= cue_observation_end_ms - cue_observation_start_ms
  ),
  CONSTRAINT dance_session_time_order CHECK (
    expires_at > created_at AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  CONSTRAINT dance_session_terminal_shape CHECK (
    (state IN ('completed', 'rejected', 'processing_failed', 'expired', 'abandoned')
      AND terminal_at IS NOT NULL)
    OR (state NOT IN ('completed', 'rejected', 'processing_failed', 'expired', 'abandoned')
      AND terminal_at IS NULL)
  )
);

CREATE UNIQUE INDEX dance_sessions_one_nonterminal_per_revision
  ON dance_sessions (account_id, choreography_id, choreography_revision)
  WHERE state IN ('created', 'consented', 'awaiting_upload', 'uploaded', 'grading_pending');

CREATE FUNCTION guard_dance_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Dance sessions cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF ROW(NEW.session_id, NEW.account_id, NEW.persona_id, NEW.community_id,
    NEW.song_post_id, NEW.audio_revision, NEW.segment_id, NEW.choreography_id,
    NEW.choreography_revision, NEW.reward_mode, NEW.objective_snapshot,
    NEW.expected_scored_duration_ms, NEW.cue_kind, NEW.cue_hold_ms,
    NEW.cue_observation_start_ms, NEW.cue_observation_end_ms,
    NEW.qualification_policy_version_id, NEW.calibration_version_id,
    NEW.calibration_checksum, NEW.captured_admission_state, NEW.platform_floor_bps,
    NEW.pose_model_version, NEW.feature_schema_version, NEW.scorer_contract_version,
    NEW.mirror_policy_version, NEW.cue_policy_version, NEW.fingerprint_policy_version,
    NEW.fingerprint_key_version, NEW.integrity_policy_version,
    NEW.grader_adapter_version, NEW.session_terms_hash, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.session_id, OLD.account_id, OLD.persona_id, OLD.community_id,
    OLD.song_post_id, OLD.audio_revision, OLD.segment_id, OLD.choreography_id,
    OLD.choreography_revision, OLD.reward_mode, OLD.objective_snapshot,
    OLD.expected_scored_duration_ms, OLD.cue_kind, OLD.cue_hold_ms,
    OLD.cue_observation_start_ms, OLD.cue_observation_end_ms,
    OLD.qualification_policy_version_id, OLD.calibration_version_id,
    OLD.calibration_checksum, OLD.captured_admission_state, OLD.platform_floor_bps,
    OLD.pose_model_version, OLD.feature_schema_version, OLD.scorer_contract_version,
    OLD.mirror_policy_version, OLD.cue_policy_version, OLD.fingerprint_policy_version,
    OLD.fingerprint_key_version, OLD.integrity_policy_version,
    OLD.grader_adapter_version, OLD.session_terms_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Dance session terms are immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NOT (
    (OLD.state = 'created' AND NEW.state IN ('consented', 'expired', 'abandoned'))
    OR (OLD.state = 'consented' AND NEW.state IN ('awaiting_upload', 'expired', 'abandoned'))
    OR (OLD.state = 'awaiting_upload' AND NEW.state IN ('uploaded', 'expired', 'abandoned'))
    OR (OLD.state = 'uploaded' AND NEW.state IN ('grading_pending', 'processing_failed'))
    OR (OLD.state = 'grading_pending'
      AND NEW.state IN ('completed', 'rejected', 'processing_failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid Dance session transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_sessions_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_sessions
FOR EACH ROW EXECUTE FUNCTION guard_dance_session();

CREATE TABLE dance_attempt_actions (
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  http_method TEXT NOT NULL CHECK (http_method = 'POST'),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template IN (
    '/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions',
    '/communities/:communityId/dance/sessions/:sessionId/consent',
    '/communities/:communityId/dance/sessions/:sessionId/upload-reservations',
    '/communities/:communityId/dance/sessions/:sessionId/upload/finalize',
    '/communities/:communityId/dance/sessions/:sessionId/grading-submissions'
  )),
  idempotency_key TEXT NOT NULL CHECK (is_dance_identifier(idempotency_key)),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_kind TEXT NOT NULL CHECK (result_kind = 'accepted'),
  response_snapshot BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (
    response_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(response_snapshot), 'hex') = response_snapshot_sha256
  ),
  session_id TEXT REFERENCES dance_sessions (session_id),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_account_id, http_method, endpoint_template, idempotency_key)
);

CREATE FUNCTION guard_dance_attempt_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Dance attempt actions are immutable'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_attempt_actions_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_attempt_actions
FOR EACH ROW EXECUTE FUNCTION guard_dance_attempt_action();

CREATE TABLE dance_session_consents (
  session_id TEXT PRIMARY KEY REFERENCES dance_sessions (session_id),
  account_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  session_terms_hash TEXT NOT NULL CHECK (session_terms_hash ~ '^[0-9a-f]{64}$'),
  consent_policy_version_id TEXT NOT NULL CHECK (is_dance_identifier(consent_policy_version_id)),
  retention_disclosure_version TEXT NOT NULL CHECK (
    is_dance_identifier(retention_disclosure_version)
  ),
  source TEXT NOT NULL CHECK (source IN ('camera', 'file_upload')),
  consented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (session_id, account_id, persona_id)
    REFERENCES dance_sessions (session_id, account_id, persona_id)
);

CREATE FUNCTION guard_dance_session_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Dance consent receipts are immutable';
  END IF;
  SELECT * INTO target FROM dance_sessions WHERE session_id = NEW.session_id FOR UPDATE;
  IF target.session_id IS NULL OR target.state <> 'created'
     OR target.account_id <> NEW.account_id OR target.persona_id <> NEW.persona_id
     OR target.session_terms_hash <> NEW.session_terms_hash
     OR NEW.consented_at < target.created_at OR NEW.consented_at >= target.expires_at THEN
    RAISE EXCEPTION 'Dance consent does not bind the created session';
  END IF;
  UPDATE dance_sessions SET state = 'consented', version = version + 1
   WHERE session_id = NEW.session_id AND state = 'created';
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_session_consents_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_session_consents
FOR EACH ROW EXECUTE FUNCTION guard_dance_session_consent();

CREATE TABLE dance_upload_reservations (
  reservation_id TEXT PRIMARY KEY CHECK (is_dance_identifier(reservation_id)),
  session_id TEXT NOT NULL UNIQUE REFERENCES dance_sessions (session_id),
  private_object_key TEXT NOT NULL UNIQUE CHECK (is_dance_identifier(private_object_key, 2048)),
  expected_content_type TEXT NOT NULL CHECK (
    expected_content_type IN ('video/mp4', 'video/quicktime', 'video/webm')
  ),
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
  expected_duration_ms BIGINT NOT NULL CHECK (expected_duration_ms > 0),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'sealed', 'expired')),
  server_sha256 TEXT UNIQUE CHECK (server_sha256 IS NULL OR server_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_size_bytes BIGINT CHECK (sealed_size_bytes > 0),
  sealed_duration_ms BIGINT CHECK (sealed_duration_ms > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  sealed_at TIMESTAMPTZ,
  UNIQUE (reservation_id, session_id),
  CONSTRAINT dance_upload_reservation_state_shape CHECK (
    (state = 'reserved' AND server_sha256 IS NULL AND sealed_size_bytes IS NULL
      AND sealed_duration_ms IS NULL AND sealed_at IS NULL)
    OR (state = 'sealed' AND server_sha256 IS NOT NULL
      AND sealed_size_bytes = expected_size_bytes
      AND sealed_duration_ms = expected_duration_ms AND sealed_at IS NOT NULL
      AND (expected_sha256 IS NULL OR expected_sha256 = server_sha256))
    OR (state = 'expired' AND server_sha256 IS NULL AND sealed_size_bytes IS NULL
      AND sealed_duration_ms IS NULL AND sealed_at IS NULL)
  ),
  CONSTRAINT dance_upload_reservation_time_order CHECK (
    expires_at > created_at AND (sealed_at IS NULL OR sealed_at < expires_at)
  )
);

CREATE FUNCTION guard_dance_upload_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_sessions%ROWTYPE;
BEGIN
  SELECT * INTO target FROM dance_sessions WHERE session_id = NEW.session_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF target.session_id IS NULL OR target.state <> 'consented'
       OR NOT EXISTS (SELECT 1 FROM dance_session_consents WHERE session_id = NEW.session_id)
       OR NEW.expires_at > target.expires_at THEN
      RAISE EXCEPTION 'Dance upload reservation requires committed consent';
    END IF;
    UPDATE dance_sessions SET state = 'awaiting_upload', version = version + 1
     WHERE session_id = NEW.session_id AND state = 'consented';
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Dance upload reservations cannot be deleted'; END IF;
  IF OLD.state <> 'reserved' OR NEW.state NOT IN ('sealed', 'expired')
     OR ROW(NEW.reservation_id, NEW.session_id, NEW.private_object_key,
       NEW.expected_content_type, NEW.expected_size_bytes, NEW.expected_duration_ms,
       NEW.expected_sha256, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.reservation_id, OLD.session_id, OLD.private_object_key,
       OLD.expected_content_type, OLD.expected_size_bytes, OLD.expected_duration_ms,
       OLD.expected_sha256, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Invalid Dance upload reservation transition';
  END IF;
  IF NEW.state = 'sealed' THEN
    IF target.state <> 'awaiting_upload'
       OR NEW.sealed_duration_ms < target.cue_observation_end_ms
          + target.expected_scored_duration_ms THEN
      RAISE EXCEPTION 'Sealed Dance upload cannot contain the cue and scored interval';
    END IF;
    UPDATE dance_sessions SET state = 'uploaded', version = version + 1
     WHERE session_id = NEW.session_id AND state = 'awaiting_upload';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_upload_reservations_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_upload_reservations
FOR EACH ROW EXECUTE FUNCTION guard_dance_upload_reservation();

CREATE TABLE dance_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (is_dance_identifier(attempt_id)),
  session_id TEXT NOT NULL UNIQUE REFERENCES dance_sessions (session_id),
  reservation_id TEXT NOT NULL,
  sealed_media_sha256 TEXT NOT NULL UNIQUE CHECK (sealed_media_sha256 ~ '^[0-9a-f]{64}$'),
  input_digest TEXT NOT NULL UNIQUE CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'grading_pending' CHECK (
    state IN ('grading_pending', 'completed', 'rejected', 'processing_failed')
  ),
  terminal_evidence_digest TEXT UNIQUE CHECK (
    terminal_evidence_digest IS NULL OR terminal_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  FOREIGN KEY (reservation_id, session_id)
    REFERENCES dance_upload_reservations (reservation_id, session_id),
  UNIQUE (attempt_id, session_id),
  UNIQUE (attempt_id, terminal_evidence_digest),
  CONSTRAINT dance_attempt_state_shape CHECK (
    (state = 'grading_pending' AND terminal_evidence_digest IS NULL AND terminal_at IS NULL)
    OR (state <> 'grading_pending' AND terminal_evidence_digest IS NOT NULL
      AND terminal_at IS NOT NULL)
  )
);

CREATE FUNCTION guard_dance_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_upload dance_upload_reservations%ROWTYPE;
  target_session dance_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Dance attempts cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO target_upload FROM dance_upload_reservations
     WHERE reservation_id = NEW.reservation_id FOR SHARE;
    SELECT * INTO target_session FROM dance_sessions
     WHERE session_id = NEW.session_id FOR UPDATE;
    IF target_upload.reservation_id IS NULL OR target_upload.state <> 'sealed'
       OR target_upload.session_id <> NEW.session_id
       OR target_upload.server_sha256 <> NEW.sealed_media_sha256
       OR target_session.state <> 'uploaded' THEN
      RAISE EXCEPTION 'Dance attempt requires the exact sealed session upload';
    END IF;
    UPDATE dance_sessions SET state = 'grading_pending', version = version + 1
     WHERE session_id = NEW.session_id AND state = 'uploaded';
    RETURN NEW;
  END IF;
  IF ROW(NEW.attempt_id, NEW.session_id, NEW.reservation_id,
    NEW.sealed_media_sha256, NEW.input_digest, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.attempt_id, OLD.session_id, OLD.reservation_id,
    OLD.sealed_media_sha256, OLD.input_digest, OLD.created_at)
    OR OLD.state <> 'grading_pending'
    OR NEW.state NOT IN ('completed', 'rejected', 'processing_failed') THEN
    RAISE EXCEPTION 'Invalid Dance attempt transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_attempts_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_attempts
FOR EACH ROW EXECUTE FUNCTION guard_dance_attempt();

CREATE TABLE dance_attempt_outbox (
  outbox_event_id TEXT PRIMARY KEY CHECK (is_dance_identifier(outbox_event_id)),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES dance_attempts (attempt_id),
  effect_identity TEXT NOT NULL UNIQUE CHECK (is_dance_identifier(effect_identity, 512)),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'running', 'delivered', 'failed', 'exhausted')
  ),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 3),
  claim_owner TEXT CHECK (claim_owner IS NULL OR is_dance_identifier(claim_owner)),
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence BETWEEN 0 AND 9007199254740991),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR is_dance_identifier(failure_code)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dance_attempt_outbox_payload_hash CHECK (
    encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') = payload_sha256
  ),
  CONSTRAINT dance_attempt_outbox_state_shape CHECK (
    (state = 'pending' AND delivery_attempts = 0 AND claim_owner IS NULL
      AND claim_fence = 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND delivered_at IS NULL AND failure_code IS NULL)
    OR (state = 'running' AND delivery_attempts BETWEEN 1 AND 3
      AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at > updated_at
      AND next_eligible_at IS NULL AND delivered_at IS NULL AND failure_code IS NULL)
    OR (state = 'failed' AND delivery_attempts BETWEEN 1 AND 2
      AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NOT NULL AND delivered_at IS NULL AND failure_code IS NOT NULL)
    OR (state = 'delivered' AND delivery_attempts BETWEEN 1 AND 3
      AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND delivered_at IS NOT NULL AND failure_code IS NULL)
    OR (state = 'exhausted' AND delivery_attempts = 3
      AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE FUNCTION is_dance_sha256_array(value TEXT[]) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(value) > 0
    AND bool_and(fingerprint ~ '^[0-9a-f]{64}$')
  FROM unnest(value) AS fingerprint
$$;

CREATE TABLE dance_replay_fingerprint_claims (
  fingerprint_claim_id TEXT PRIMARY KEY CHECK (is_dance_identifier(fingerprint_claim_id)),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES dance_attempts (attempt_id),
  fingerprint_policy_version TEXT NOT NULL CHECK (
    is_dance_identifier(fingerprint_policy_version)
  ),
  fingerprint_key_version TEXT NOT NULL CHECK (is_dance_identifier(fingerprint_key_version)),
  match_scope TEXT NOT NULL CHECK (match_scope IN ('same_account', 'platform_wide')),
  account_scope_id TEXT,
  whole_sequence_fingerprint TEXT NOT NULL CHECK (
    whole_sequence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  segment_fingerprints TEXT[] NOT NULL CHECK (is_dance_sha256_array(segment_fingerprints)),
  terminal_evidence_digest TEXT NOT NULL CHECK (
    terminal_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    fingerprint_policy_version, fingerprint_key_version, match_scope,
    account_scope_id, whole_sequence_fingerprint
  ),
  UNIQUE (fingerprint_claim_id, attempt_id),
  UNIQUE (attempt_id, terminal_evidence_digest),
  CONSTRAINT dance_fingerprint_scope_shape CHECK (
    (match_scope = 'same_account' AND account_scope_id IS NOT NULL)
    OR (match_scope = 'platform_wide' AND account_scope_id IS NULL)
  )
);

CREATE UNIQUE INDEX dance_replay_fingerprint_platform_unique
  ON dance_replay_fingerprint_claims (
    fingerprint_policy_version, fingerprint_key_version, match_scope,
    whole_sequence_fingerprint
  ) WHERE match_scope = 'platform_wide';

CREATE FUNCTION guard_dance_replay_fingerprint_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Dance fingerprint claims are immutable'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_replay_fingerprint_claims_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_replay_fingerprint_claims
FOR EACH ROW EXECUTE FUNCTION guard_dance_replay_fingerprint_claim();

CREATE TABLE dance_attempt_evidence (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  fingerprint_claim_id TEXT UNIQUE,
  matched_fingerprint_claim_id TEXT REFERENCES dance_replay_fingerprint_claims (
    fingerprint_claim_id
  ),
  claim_owner TEXT NOT NULL CHECK (is_dance_identifier(claim_owner)),
  claim_fence BIGINT NOT NULL CHECK (claim_fence BETWEEN 1 AND 9007199254740991),
  grade_outcome TEXT NOT NULL CHECK (grade_outcome IN ('scored', 'rejected', 'failed')),
  qualification_outcome TEXT NOT NULL DEFAULT 'suppressed_shadow' CHECK (
    qualification_outcome = 'suppressed_shadow'
  ),
  score_bps INTEGER CHECK (score_bps BETWEEN 0 AND 10000),
  rejection_code TEXT CHECK (rejection_code IS NULL OR is_dance_identifier(rejection_code)),
  scored_window_start_ms BIGINT NOT NULL CHECK (scored_window_start_ms >= 0),
  scored_window_end_ms BIGINT NOT NULL CHECK (scored_window_end_ms > 0),
  scored_duration_ms BIGINT NOT NULL CHECK (scored_duration_ms BETWEEN 6000 AND 30000),
  evidence_summary JSONB CHECK (
    evidence_summary IS NULL OR jsonb_typeof(evidence_summary) = 'object'
  ),
  evidence_digest TEXT NOT NULL UNIQUE CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attempt_id, session_id) REFERENCES dance_attempts (attempt_id, session_id),
  FOREIGN KEY (fingerprint_claim_id, attempt_id)
    REFERENCES dance_replay_fingerprint_claims (fingerprint_claim_id, attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (attempt_id, evidence_digest),
  CONSTRAINT dance_attempt_evidence_grade_shape CHECK (
    (grade_outcome = 'scored' AND score_bps IS NOT NULL AND rejection_code IS NULL
      AND evidence_summary IS NOT NULL AND fingerprint_claim_id IS NOT NULL
      AND matched_fingerprint_claim_id IS NULL)
    OR (grade_outcome = 'rejected' AND score_bps IS NULL AND rejection_code IS NOT NULL
      AND (
        (evidence_summary IS NULL AND fingerprint_claim_id IS NULL
          AND matched_fingerprint_claim_id IS NULL)
        OR (evidence_summary IS NOT NULL AND (
          (fingerprint_claim_id IS NOT NULL AND matched_fingerprint_claim_id IS NULL)
          OR (fingerprint_claim_id IS NULL AND matched_fingerprint_claim_id IS NOT NULL)
        ))
      ))
    OR (grade_outcome = 'failed' AND score_bps IS NULL AND rejection_code IS NOT NULL
      AND evidence_summary IS NULL AND fingerprint_claim_id IS NULL
      AND matched_fingerprint_claim_id IS NULL)
  ),
  CONSTRAINT dance_attempt_evidence_window CHECK (
    scored_window_end_ms - scored_window_start_ms = scored_duration_ms
  )
);

ALTER TABLE dance_replay_fingerprint_claims
  ADD CONSTRAINT dance_fingerprint_terminal_evidence_fk
  FOREIGN KEY (attempt_id, terminal_evidence_digest)
  REFERENCES dance_attempt_evidence (attempt_id, evidence_digest)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE dance_attempts
  ADD CONSTRAINT dance_attempt_terminal_evidence_fk
  FOREIGN KEY (attempt_id, terminal_evidence_digest)
  REFERENCES dance_attempt_evidence (attempt_id, evidence_digest)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_dance_attempt_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_attempt dance_attempts%ROWTYPE;
  target_outbox dance_attempt_outbox%ROWTYPE;
  target_session dance_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Dance attempt evidence is immutable'; END IF;
  SELECT * INTO target_attempt FROM dance_attempts WHERE attempt_id = NEW.attempt_id FOR UPDATE;
  SELECT * INTO target_outbox FROM dance_attempt_outbox
   WHERE attempt_id = NEW.attempt_id FOR UPDATE;
  SELECT * INTO target_session FROM dance_sessions
   WHERE session_id = NEW.session_id FOR UPDATE;
  IF target_attempt.attempt_id IS NULL OR target_attempt.state <> 'grading_pending'
     OR target_attempt.session_id <> NEW.session_id
     OR target_outbox.state <> 'running'
     OR target_outbox.claim_owner <> NEW.claim_owner
     OR target_outbox.claim_fence <> NEW.claim_fence
     OR target_outbox.lease_expires_at <= clock_timestamp()
     OR target_session.captured_admission_state <> 'shadow'
     OR NEW.qualification_outcome <> 'suppressed_shadow'
     OR NEW.scored_duration_ms <> target_session.expected_scored_duration_ms
     OR NEW.scored_window_start_ms < target_session.cue_observation_end_ms THEN
    RAISE EXCEPTION 'Dance terminal evidence lacks current shadow lease authority';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_attempt_evidence_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_attempt_evidence
FOR EACH ROW EXECUTE FUNCTION guard_dance_attempt_evidence();

CREATE FUNCTION finalize_dance_attempt_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_state TEXT;
BEGIN
  next_state := CASE NEW.grade_outcome
    WHEN 'scored' THEN 'completed'
    WHEN 'rejected' THEN 'rejected'
    ELSE 'processing_failed'
  END;
  UPDATE dance_attempts SET
    state = next_state,
    terminal_evidence_digest = NEW.evidence_digest,
    terminal_at = NEW.completed_at
   WHERE attempt_id = NEW.attempt_id AND state = 'grading_pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Dance attempt terminal transition lost'; END IF;
  UPDATE dance_sessions SET
    state = next_state,
    terminal_at = NEW.completed_at,
    version = version + 1
   WHERE session_id = NEW.session_id AND state = 'grading_pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Dance session terminal transition lost'; END IF;
  UPDATE dance_attempt_outbox SET
    state = 'delivered', claim_owner = NULL, lease_expires_at = NULL,
    next_eligible_at = NULL, delivered_at = NEW.completed_at,
    failure_code = NULL, updated_at = NEW.completed_at
   WHERE attempt_id = NEW.attempt_id AND state = 'running'
     AND claim_owner = NEW.claim_owner AND claim_fence = NEW.claim_fence
     AND lease_expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Dance outbox terminal fence lost'; END IF;
  INSERT INTO dance_media_cleanup_operations (
    cleanup_operation_id, session_id, artifact_kind, private_artifact_ref
  ) SELECT
    'dance-cleanup-' || encode(sha256(convert_to(
      NEW.session_id || ':raw_video:' || upload.private_object_key, 'UTF8')), 'hex'),
    NEW.session_id, 'raw_video', upload.private_object_key
  FROM dance_upload_reservations upload
  WHERE upload.session_id = NEW.session_id AND upload.state = 'sealed'
  ON CONFLICT (session_id, artifact_kind, private_artifact_ref) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dance raw-media cleanup was not scheduled'; END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER dance_attempt_evidence_finalize
AFTER INSERT ON dance_attempt_evidence
FOR EACH ROW EXECUTE FUNCTION finalize_dance_attempt_evidence();

CREATE TABLE dance_media_cleanup_operations (
  cleanup_operation_id TEXT PRIMARY KEY CHECK (is_dance_identifier(cleanup_operation_id)),
  session_id TEXT NOT NULL REFERENCES dance_sessions (session_id),
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN ('raw_video', 'extracted_audio', 'extracted_frames', 'provider_payload')
  ),
  private_artifact_ref TEXT NOT NULL CHECK (is_dance_identifier(private_artifact_ref, 2048)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'completed', 'failed')),
  lease_owner TEXT,
  lease_fence BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence BETWEEN 0 AND 9007199254740991),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  failure_code TEXT CHECK (failure_code IS NULL OR is_dance_identifier(failure_code)),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, artifact_kind, private_artifact_ref),
  CONSTRAINT dance_media_cleanup_state_shape CHECK (
    (state = 'pending' AND lease_owner IS NULL AND lease_fence = 0
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND attempts = 0
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (state = 'leased' AND lease_owner IS NOT NULL AND lease_fence > 0
      AND lease_expires_at > updated_at AND next_eligible_at IS NULL
      AND attempts BETWEEN 1 AND 10 AND failure_code IS NULL AND completed_at IS NULL)
    OR (state = 'failed' AND lease_owner IS NULL AND lease_fence > 0
      AND lease_expires_at IS NULL AND attempts BETWEEN 1 AND 10
      AND failure_code IS NOT NULL AND completed_at IS NULL
      AND ((attempts < 10 AND next_eligible_at IS NOT NULL)
        OR (attempts = 10 AND next_eligible_at IS NULL)))
    OR (state = 'completed' AND lease_owner IS NULL AND lease_fence > 0
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND attempts BETWEEN 1 AND 10 AND failure_code IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE FUNCTION guard_dance_media_cleanup_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Dance cleanup operations cannot be deleted'; END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF ROW(NEW.cleanup_operation_id, NEW.session_id, NEW.artifact_kind,
    NEW.private_artifact_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.cleanup_operation_id, OLD.session_id, OLD.artifact_kind,
    OLD.private_artifact_ref, OLD.created_at)
    OR NOT (
      (OLD.state IN ('pending', 'failed') AND NEW.state = 'leased'
        AND NEW.lease_fence = OLD.lease_fence + 1 AND NEW.attempts = OLD.attempts + 1)
      OR (OLD.state = 'leased' AND OLD.lease_expires_at <= clock_timestamp()
        AND NEW.state = 'leased' AND NEW.lease_fence = OLD.lease_fence + 1
        AND NEW.attempts = OLD.attempts + 1)
      OR (OLD.state = 'leased' AND NEW.state IN ('completed', 'failed')
        AND NEW.lease_fence = OLD.lease_fence AND NEW.attempts = OLD.attempts)
    ) THEN
    RAISE EXCEPTION 'Invalid Dance cleanup transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_media_cleanup_operations_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_media_cleanup_operations
FOR EACH ROW EXECUTE FUNCTION guard_dance_media_cleanup_operation();

CREATE TABLE dance_grading_usage_counters (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  environment TEXT NOT NULL CHECK (is_dance_identifier(environment)),
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_end TIMESTAMPTZ NOT NULL,
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  provider_spend_microunits BIGINT NOT NULL DEFAULT 0 CHECK (provider_spend_microunits >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, environment, bucket_start),
  CHECK (bucket_end > bucket_start)
);
