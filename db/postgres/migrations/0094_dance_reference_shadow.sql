-- Spec 021 phase 6. Dance reference resources remain shadow-only: this
-- migration creates no session, attempt, qualification, registry, or reward row.

CREATE FUNCTION is_dance_identifier(value TEXT, maximum_octets INTEGER DEFAULT 256)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT btrim(value) <> ''
     AND value = btrim(value)
     AND octet_length(value) <= maximum_octets
$$;

CREATE TABLE dance_song_segments (
  segment_id TEXT PRIMARY KEY CHECK (is_dance_identifier(segment_id)),
  community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  song_submission_id TEXT NOT NULL REFERENCES media_publication_projections (submission_id),
  audio_revision BIGINT NOT NULL CHECK (audio_revision BETWEEN 1 AND 9007199254740991),
  start_ms BIGINT NOT NULL CHECK (start_ms BETWEEN 0 AND 9007199254740991),
  end_ms BIGINT NOT NULL CHECK (end_ms BETWEEN 1 AND 9007199254740991),
  duration_ms BIGINT GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  canonical_audio_duration_ms BIGINT NOT NULL CHECK (
    canonical_audio_duration_ms BETWEEN 1 AND 9007199254740991
  ),
  canonical_segment_audio_ref TEXT NOT NULL CHECK (
    is_dance_identifier(canonical_segment_audio_ref, 2048)
  ),
  canonical_segment_sha256 TEXT NOT NULL CHECK (
    canonical_segment_sha256 ~ '^[0-9a-f]{64}$'
  ),
  extraction_policy_version TEXT NOT NULL CHECK (
    is_dance_identifier(extraction_policy_version)
  ),
  source_media_sha256 TEXT NOT NULL CHECK (source_media_sha256 ~ '^[0-9a-f]{64}$'),
  segment_terms_hash TEXT NOT NULL UNIQUE CHECK (segment_terms_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, song_post_id) REFERENCES posts (community_id, post_id),
  UNIQUE (
    community_id, song_post_id, audio_revision, start_ms, end_ms,
    canonical_segment_sha256, extraction_policy_version
  ),
  UNIQUE (segment_id, community_id, song_post_id, audio_revision),
  CONSTRAINT dance_song_segment_interval CHECK (
    end_ms > start_ms
    AND end_ms <= canonical_audio_duration_ms
    AND end_ms - start_ms BETWEEN 6000 AND 30000
  )
);

CREATE TABLE dance_choreographies (
  choreography_id TEXT PRIMARY KEY CHECK (is_dance_identifier(choreography_id)),
  community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  creator_account_id TEXT NOT NULL REFERENCES users (user_id),
  creator_persona_id TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('draft', 'processing', 'ready', 'disabled', 'retired')),
  active_revision BIGINT CHECK (active_revision BETWEEN 1 AND 9007199254740991),
  disabled_reason TEXT CHECK (disabled_reason IN ('rights', 'safety')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  FOREIGN KEY (community_id, song_post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (creator_account_id, creator_persona_id)
    REFERENCES personas (account_id, persona_id),
  UNIQUE (choreography_id, community_id, song_post_id),
  CONSTRAINT dance_choreography_state_shape CHECK (
    (status = 'draft' AND active_revision IS NULL
      AND disabled_reason IS NULL AND disabled_at IS NULL AND retired_at IS NULL)
    OR (status = 'processing' AND active_revision IS NULL
      AND disabled_reason IS NULL AND disabled_at IS NULL AND retired_at IS NULL)
    OR (status = 'ready' AND active_revision IS NOT NULL
      AND disabled_reason IS NULL AND disabled_at IS NULL AND retired_at IS NULL)
    OR (status = 'disabled' AND disabled_reason IS NOT NULL
      AND disabled_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL
      AND ((disabled_reason IS NULL AND disabled_at IS NULL)
        OR (disabled_reason IS NOT NULL AND disabled_at IS NOT NULL)))
  ),
  CONSTRAINT dance_choreography_time_order CHECK (
    updated_at >= created_at
    AND (disabled_at IS NULL OR disabled_at >= created_at)
    AND (retired_at IS NULL OR retired_at >= created_at)
  )
);

CREATE TABLE dance_choreography_revisions (
  choreography_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  aggregate_version BIGINT NOT NULL CHECK (
    aggregate_version BETWEEN 1 AND 9007199254740991
  ),
  community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision BETWEEN 1 AND 9007199254740991),
  requested_start_ms BIGINT NOT NULL CHECK (requested_start_ms BETWEEN 0 AND 9007199254740991),
  requested_end_ms BIGINT NOT NULL CHECK (requested_end_ms BETWEEN 1 AND 9007199254740991),
  segment_id TEXT,
  reference_video_post_id TEXT NOT NULL,
  reference_video_song_post_id TEXT NOT NULL,
  reference_video_audio_revision BIGINT NOT NULL CHECK (
    reference_video_audio_revision BETWEEN 1 AND 9007199254740991
  ),
  reference_video_object_ref TEXT NOT NULL CHECK (
    is_dance_identifier(reference_video_object_ref, 2048)
  ),
  reference_video_sha256 TEXT NOT NULL CHECK (
    reference_video_sha256 ~ '^[0-9a-f]{64}$'
  ),
  mirror_policy TEXT NOT NULL CHECK (mirror_policy IN ('strict', 'allowed')),
  alignment_policy_version TEXT NOT NULL CHECK (is_dance_identifier(alignment_policy_version)),
  alignment_adapter TEXT NOT NULL CHECK (is_dance_identifier(alignment_adapter)),
  alignment_revision TEXT NOT NULL CHECK (is_dance_identifier(alignment_revision)),
  pose_model_version TEXT NOT NULL CHECK (is_dance_identifier(pose_model_version)),
  pose_runtime_version TEXT NOT NULL CHECK (is_dance_identifier(pose_runtime_version)),
  feature_schema_version TEXT NOT NULL CHECK (is_dance_identifier(feature_schema_version)),
  scorer_contract_version TEXT NOT NULL CHECK (is_dance_identifier(scorer_contract_version)),
  fingerprint_policy_version TEXT NOT NULL CHECK (
    is_dance_identifier(fingerprint_policy_version)
  ),
  integrity_policy_version TEXT NOT NULL CHECK (is_dance_identifier(integrity_policy_version)),
  owner_policy_revision BIGINT NOT NULL CHECK (
    owner_policy_revision BETWEEN 1 AND 9007199254740991
  ),
  owner_policy_hash TEXT NOT NULL CHECK (owner_policy_hash ~ '^[0-9a-f]{64}$'),
  revision_terms_hash TEXT NOT NULL UNIQUE CHECK (revision_terms_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (
    status IN ('processing', 'ready', 'processing_failed', 'disabled', 'retired')
  ),
  reference_video_scored_start_ms BIGINT,
  reference_video_scored_end_ms BIGINT,
  alignment_metrics JSONB,
  reference_duration_ms BIGINT,
  reference_width INTEGER,
  reference_height INTEGER,
  reference_frame_rate_numerator INTEGER,
  reference_frame_rate_denominator INTEGER,
  usable_frame_summary JSONB,
  alignment_accepted BOOLEAN,
  time_stretch_detected BOOLEAN,
  body_coverage_accepted BOOLEAN,
  timeline_evidence_accepted BOOLEAN,
  visibility_evidence_accepted BOOLEAN,
  subject_continuity_accepted BOOLEAN,
  meaningful_motion_accepted BOOLEAN,
  terminal_evidence_digest TEXT CHECK (
    terminal_evidence_digest IS NULL OR terminal_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  processing_failure_code TEXT CHECK (
    processing_failure_code IS NULL OR is_dance_identifier(processing_failure_code)
  ),
  cutoff_reason TEXT CHECK (cutoff_reason IN ('rights', 'safety', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  cutoff_at TIMESTAMPTZ,
  PRIMARY KEY (choreography_id, revision),
  FOREIGN KEY (choreography_id, community_id, song_post_id)
    REFERENCES dance_choreographies (choreography_id, community_id, song_post_id),
  FOREIGN KEY (community_id, reference_video_post_id)
    REFERENCES posts (community_id, post_id),
  FOREIGN KEY (segment_id, community_id, song_post_id, audio_revision)
    REFERENCES dance_song_segments (segment_id, community_id, song_post_id, audio_revision),
  UNIQUE (choreography_id, revision, community_id, song_post_id, audio_revision),
  CONSTRAINT dance_revision_requested_interval CHECK (
    requested_end_ms > requested_start_ms
    AND requested_end_ms - requested_start_ms BETWEEN 6000 AND 30000
  ),
  CONSTRAINT dance_revision_reference_binding CHECK (
    reference_video_song_post_id = song_post_id
    AND reference_video_audio_revision = audio_revision
  ),
  CONSTRAINT dance_revision_terminal_shape CHECK (
    (status = 'processing' AND segment_id IS NULL
      AND reference_video_scored_start_ms IS NULL
      AND reference_video_scored_end_ms IS NULL
      AND alignment_metrics IS NULL AND reference_duration_ms IS NULL
      AND reference_width IS NULL AND reference_height IS NULL
      AND reference_frame_rate_numerator IS NULL
      AND reference_frame_rate_denominator IS NULL
      AND usable_frame_summary IS NULL
      AND alignment_accepted IS NULL AND time_stretch_detected IS NULL
      AND body_coverage_accepted IS NULL AND timeline_evidence_accepted IS NULL
      AND visibility_evidence_accepted IS NULL
      AND subject_continuity_accepted IS NULL AND meaningful_motion_accepted IS NULL
      AND terminal_evidence_digest IS NULL AND processing_failure_code IS NULL
      AND terminal_at IS NULL AND cutoff_reason IS NULL AND cutoff_at IS NULL)
    OR (status = 'processing_failed' AND segment_id IS NULL
      AND reference_video_scored_start_ms IS NULL
      AND reference_video_scored_end_ms IS NULL
      AND alignment_metrics IS NULL AND reference_duration_ms IS NULL
      AND reference_width IS NULL AND reference_height IS NULL
      AND reference_frame_rate_numerator IS NULL
      AND reference_frame_rate_denominator IS NULL
      AND usable_frame_summary IS NULL
      AND alignment_accepted IS NULL AND time_stretch_detected IS NULL
      AND body_coverage_accepted IS NULL AND timeline_evidence_accepted IS NULL
      AND visibility_evidence_accepted IS NULL
      AND subject_continuity_accepted IS NULL AND meaningful_motion_accepted IS NULL
      AND terminal_evidence_digest IS NOT NULL AND processing_failure_code IS NOT NULL
      AND terminal_at IS NOT NULL AND cutoff_reason IS NULL AND cutoff_at IS NULL)
    OR (status IN ('ready', 'disabled', 'retired') AND segment_id IS NOT NULL
      AND reference_video_scored_start_ms >= 0
      AND reference_video_scored_end_ms > reference_video_scored_start_ms
      AND alignment_metrics IS NOT NULL AND jsonb_typeof(alignment_metrics) = 'object'
      AND reference_duration_ms > 0 AND reference_width > 0 AND reference_height > 0
      AND reference_frame_rate_numerator > 0 AND reference_frame_rate_denominator > 0
      AND usable_frame_summary IS NOT NULL AND jsonb_typeof(usable_frame_summary) = 'object'
      AND alignment_accepted IS TRUE AND time_stretch_detected IS FALSE
      AND body_coverage_accepted IS TRUE AND timeline_evidence_accepted IS TRUE
      AND visibility_evidence_accepted IS TRUE
      AND subject_continuity_accepted IS TRUE AND meaningful_motion_accepted IS TRUE
      AND terminal_evidence_digest IS NOT NULL AND processing_failure_code IS NULL
      AND terminal_at IS NOT NULL
      AND ((status = 'ready' AND cutoff_reason IS NULL AND cutoff_at IS NULL)
        OR (status IN ('disabled', 'retired')
          AND cutoff_reason IS NOT NULL AND cutoff_at IS NOT NULL)))
  )
);

ALTER TABLE dance_choreographies
  ADD CONSTRAINT dance_choreography_active_revision_fk
  FOREIGN KEY (choreography_id, active_revision)
  REFERENCES dance_choreography_revisions (choreography_id, revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE dance_reference_artifacts (
  artifact_id TEXT PRIMARY KEY CHECK (is_dance_identifier(artifact_id)),
  choreography_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  private_artifact_ref TEXT NOT NULL CHECK (is_dance_identifier(private_artifact_ref, 2048)),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  pose_model_version TEXT NOT NULL CHECK (is_dance_identifier(pose_model_version)),
  pose_runtime_version TEXT NOT NULL CHECK (is_dance_identifier(pose_runtime_version)),
  feature_schema_version TEXT NOT NULL CHECK (is_dance_identifier(feature_schema_version)),
  scorer_contract_version TEXT NOT NULL CHECK (is_dance_identifier(scorer_contract_version)),
  integrity_policy_version TEXT NOT NULL CHECK (is_dance_identifier(integrity_policy_version)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (choreography_id, revision)
    REFERENCES dance_choreography_revisions (choreography_id, revision),
  UNIQUE (choreography_id, revision),
  UNIQUE (private_artifact_ref, artifact_sha256)
);

CREATE TABLE dance_reference_processing_attempts (
  processing_attempt_id TEXT PRIMARY KEY CHECK (is_dance_identifier(processing_attempt_id)),
  choreography_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  adapter_id TEXT NOT NULL CHECK (is_dance_identifier(adapter_id)),
  adapter_revision TEXT NOT NULL CHECK (is_dance_identifier(adapter_revision)),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'leased' CHECK (
    state IN ('leased', 'succeeded', 'failed', 'exhausted')
  ),
  lease_owner TEXT CHECK (lease_owner IS NULL OR is_dance_identifier(lease_owner)),
  lease_fence BIGINT NOT NULL DEFAULT 1 CHECK (lease_fence BETWEEN 1 AND 9007199254740991),
  lease_expires_at TIMESTAMPTZ,
  prepared_operation JSONB,
  prepared_operation_bytes BYTEA,
  prepared_operation_sha256 TEXT CHECK (
    prepared_operation_sha256 IS NULL OR prepared_operation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  result_digest TEXT CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  private_evidence_ref TEXT CHECK (
    private_evidence_ref IS NULL OR is_dance_identifier(private_evidence_ref, 2048)
  ),
  failure_code TEXT CHECK (failure_code IS NULL OR is_dance_identifier(failure_code)),
  retryable BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (choreography_id, revision)
    REFERENCES dance_choreography_revisions (choreography_id, revision),
  UNIQUE (choreography_id, revision, attempt_number),
  CONSTRAINT dance_reference_processing_attempt_state_shape CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at > updated_at
      AND result_digest IS NULL AND private_evidence_ref IS NULL
      AND failure_code IS NULL AND retryable IS NULL AND completed_at IS NULL
      AND ((prepared_operation IS NULL AND prepared_operation_bytes IS NULL
          AND prepared_operation_sha256 IS NULL)
        OR (jsonb_typeof(prepared_operation) = 'object'
          AND prepared_operation_bytes IS NOT NULL
          AND convert_from(prepared_operation_bytes, 'UTF8')::jsonb = prepared_operation
          AND encode(sha256(prepared_operation_bytes), 'hex') = prepared_operation_sha256)))
    OR (state = 'succeeded' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_digest IS NOT NULL AND private_evidence_ref IS NOT NULL
      AND failure_code IS NULL AND retryable IS FALSE AND completed_at IS NOT NULL)
    OR (state = 'failed' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_digest IS NOT NULL AND private_evidence_ref IS NOT NULL
      AND failure_code IS NOT NULL AND retryable IS TRUE AND completed_at IS NOT NULL)
    OR (state = 'exhausted' AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND result_digest IS NOT NULL AND private_evidence_ref IS NOT NULL
      AND failure_code IS NOT NULL AND retryable IS FALSE AND completed_at IS NOT NULL)
  ),
  CONSTRAINT dance_reference_processing_attempt_time_order CHECK (
    updated_at >= created_at AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE TABLE dance_reference_outbox (
  outbox_event_id TEXT PRIMARY KEY CHECK (is_dance_identifier(outbox_event_id)),
  choreography_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'reference_processing'),
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
  FOREIGN KEY (choreography_id, revision)
    REFERENCES dance_choreography_revisions (choreography_id, revision),
  UNIQUE (choreography_id, revision, event_type),
  CONSTRAINT dance_reference_outbox_payload_hash CHECK (
    encode(sha256(convert_to(payload::text, 'UTF8')), 'hex') = payload_sha256
  ),
  CONSTRAINT dance_reference_outbox_state_shape CHECK (
    (state = 'pending' AND delivery_attempts = 0 AND claim_owner IS NULL
      AND claim_fence = 0 AND lease_expires_at IS NULL
      AND next_eligible_at IS NULL AND delivered_at IS NULL AND failure_code IS NULL)
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

CREATE TABLE dance_reference_processing_requests (
  choreography_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  effect_identity TEXT NOT NULL UNIQUE CHECK (is_dance_identifier(effect_identity, 512)),
  request_material JSONB NOT NULL CHECK (jsonb_typeof(request_material) = 'object'),
  canonical_request BYTEA NOT NULL,
  input_digest TEXT NOT NULL UNIQUE CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (choreography_id, revision),
  FOREIGN KEY (choreography_id, revision)
    REFERENCES dance_choreography_revisions (choreography_id, revision),
  FOREIGN KEY (effect_identity) REFERENCES dance_reference_outbox (effect_identity),
  CONSTRAINT dance_reference_processing_request_digest CHECK (
    convert_from(canonical_request, 'UTF8')::jsonb = request_material
    AND encode(sha256(canonical_request), 'hex') = input_digest
  )
);

CREATE TABLE song_dance_presentations (
  community_id TEXT NOT NULL,
  song_post_id TEXT NOT NULL,
  song_submission_id TEXT NOT NULL REFERENCES media_publication_projections (submission_id),
  audio_revision BIGINT NOT NULL CHECK (audio_revision BETWEEN 1 AND 9007199254740991),
  presentation_revision BIGINT NOT NULL CHECK (
    presentation_revision BETWEEN 1 AND 9007199254740991
  ),
  featured_choreography_id TEXT,
  featured_choreography_revision BIGINT,
  song_owner_account_id TEXT NOT NULL REFERENCES users (user_id),
  updated_by_account_id TEXT NOT NULL REFERENCES users (user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, song_post_id, audio_revision),
  FOREIGN KEY (community_id, song_post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (
    featured_choreography_id, featured_choreography_revision,
    community_id, song_post_id, audio_revision
  ) REFERENCES dance_choreography_revisions (
    choreography_id, revision, community_id, song_post_id, audio_revision
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT song_dance_presentation_feature_shape CHECK (
    (featured_choreography_id IS NULL) = (featured_choreography_revision IS NULL)
  ),
  CONSTRAINT song_dance_presentation_owner CHECK (
    song_owner_account_id = updated_by_account_id
  ),
  CONSTRAINT song_dance_presentation_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE dance_reference_actions (
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  http_method TEXT NOT NULL CHECK (http_method IN ('POST', 'PUT', 'DELETE')),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template IN (
    '/communities/:communityId/posts/:postId/dance/choreographies',
    '/communities/:communityId/dance/choreographies/:choreographyId/revisions',
    '/communities/:communityId/dance/choreographies/:choreographyId/disable',
    '/communities/:communityId/dance/choreographies/:choreographyId/retire',
    '/communities/:communityId/posts/:postId/dance/presentation'
  )),
  idempotency_key TEXT NOT NULL CHECK (is_dance_identifier(idempotency_key, 128)),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('accepted', 'rejected')),
  response_snapshot BYTEA NOT NULL CHECK (octet_length(response_snapshot) BETWEEN 1 AND 1048576),
  response_snapshot_sha256 TEXT NOT NULL CHECK (
    response_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(response_snapshot), 'hex') = response_snapshot_sha256
  ),
  choreography_id TEXT,
  choreography_revision BIGINT,
  presentation_revision BIGINT,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_account_id, http_method, endpoint_template, idempotency_key),
  CONSTRAINT dance_reference_action_route_shape CHECK (
    (http_method = 'POST'
      AND endpoint_template <> '/communities/:communityId/posts/:postId/dance/presentation')
    OR (http_method IN ('PUT', 'DELETE')
      AND endpoint_template = '/communities/:communityId/posts/:postId/dance/presentation')
  ),
  CONSTRAINT dance_reference_action_result_shape CHECK (
    (result_kind = 'accepted' AND (
      choreography_id IS NOT NULL OR presentation_revision IS NOT NULL
    )) OR (result_kind = 'rejected' AND choreography_id IS NULL
      AND choreography_revision IS NULL AND presentation_revision IS NULL)
  )
);

CREATE FUNCTION guard_dance_song_segment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  publication media_publication_projections%ROWTYPE;
  song posts%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Dance song segments are immutable';
  END IF;
  SELECT * INTO publication FROM media_publication_projections
   WHERE submission_id = NEW.song_submission_id FOR SHARE;
  SELECT * INTO song FROM posts
   WHERE community_id = NEW.community_id AND post_id = NEW.song_post_id FOR SHARE;
  IF publication.submission_id IS NULL OR song.post_id IS NULL
     OR publication.community_id <> NEW.community_id
     OR publication.post_id <> NEW.song_post_id
     OR publication.audio_revision <> NEW.audio_revision
     OR publication.canonical_audio_sha256 <> NEW.source_media_sha256
     OR song.post_type <> 'song' OR song.status <> 'published' THEN
    RAISE EXCEPTION 'Dance segment requires exact published canonical song audio';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_song_segments_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_song_segments
FOR EACH ROW EXECUTE FUNCTION guard_dance_song_segment();

CREATE FUNCTION guard_dance_choreography() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_choreography_revisions%ROWTYPE;
  song posts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dance choreographies cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT active_owned_persona(NEW.creator_account_id, NEW.creator_persona_id) THEN
      RAISE EXCEPTION 'Dance choreography requires an active owned persona';
    END IF;
    SELECT * INTO song FROM posts
     WHERE community_id = NEW.community_id AND post_id = NEW.song_post_id FOR SHARE;
    IF song.post_id IS NULL OR song.post_type <> 'song' OR song.status <> 'published' THEN
      RAISE EXCEPTION 'Dance choreography requires a published song';
    END IF;
  ELSE
    IF ROW(NEW.choreography_id, NEW.community_id, NEW.song_post_id,
      NEW.creator_account_id, NEW.creator_persona_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.choreography_id, OLD.community_id, OLD.song_post_id,
      OLD.creator_account_id, OLD.creator_persona_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Dance choreography identity is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'Dance choreography update requires the next version';
    END IF;
    IF NOT (
      (OLD.status = 'draft' AND NEW.status IN ('processing', 'disabled', 'retired'))
      OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'ready', 'disabled', 'retired'))
      OR (OLD.status = 'ready' AND NEW.status IN ('ready', 'disabled'))
      OR (OLD.status = 'disabled' AND NEW.status = 'retired')
    ) THEN
      RAISE EXCEPTION 'Invalid Dance choreography transition';
    END IF;
  END IF;
  IF NEW.active_revision IS NOT NULL THEN
    SELECT * INTO target FROM dance_choreography_revisions
     WHERE choreography_id = NEW.choreography_id AND revision = NEW.active_revision;
    IF target.choreography_id IS NULL OR target.status <> 'ready' THEN
      RAISE EXCEPTION 'Dance active revision must be ready';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_choreographies_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_choreographies
FOR EACH ROW EXECUTE FUNCTION guard_dance_choreography();

CREATE FUNCTION guard_dance_reference_artifact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_choreography_revisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Dance reference artifacts are immutable';
  END IF;
  SELECT * INTO target FROM dance_choreography_revisions
   WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision FOR SHARE;
  IF target.choreography_id IS NULL
     OR target.pose_model_version <> NEW.pose_model_version
     OR target.pose_runtime_version <> NEW.pose_runtime_version
     OR target.feature_schema_version <> NEW.feature_schema_version
     OR target.scorer_contract_version <> NEW.scorer_contract_version
     OR target.integrity_policy_version <> NEW.integrity_policy_version THEN
    RAISE EXCEPTION 'Dance reference artifact does not match revision terms';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_reference_artifacts_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_reference_artifacts
FOR EACH ROW EXECUTE FUNCTION guard_dance_reference_artifact();

CREATE FUNCTION guard_dance_choreography_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  aggregate dance_choreographies%ROWTYPE;
  reference_post posts%ROWTYPE;
  selected_segment dance_song_segments%ROWTYPE;
  artifact dance_reference_artifacts%ROWTYPE;
  latest_revision BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dance choreography revisions cannot be deleted';
  END IF;
  SELECT * INTO aggregate FROM dance_choreographies
   WHERE choreography_id = NEW.choreography_id FOR SHARE;
  SELECT * INTO reference_post FROM posts
   WHERE community_id = NEW.community_id AND post_id = NEW.reference_video_post_id FOR SHARE;
  IF aggregate.choreography_id IS NULL
     OR aggregate.community_id <> NEW.community_id OR aggregate.song_post_id <> NEW.song_post_id
     OR reference_post.post_id IS NULL OR reference_post.post_type <> 'video'
     OR reference_post.status <> 'published' OR reference_post.visibility <> 'public' THEN
    RAISE EXCEPTION 'Dance revision requires exact aggregate and published reference video';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF aggregate.status NOT IN ('processing', 'ready') THEN
      RAISE EXCEPTION 'Dance choreography is not open for a revision append';
    END IF;
    IF NEW.aggregate_version <> aggregate.version THEN
      RAISE EXCEPTION 'Dance revision append requires the current aggregate version';
    END IF;
    SELECT max(existing.revision) INTO latest_revision
      FROM dance_choreography_revisions AS existing
     WHERE existing.choreography_id = NEW.choreography_id;
    IF NEW.revision <> COALESCE(latest_revision, 0) + 1 THEN
      RAISE EXCEPTION 'Dance revisions must append in order';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'processing' AND aggregate.status IN ('disabled', 'retired') THEN
      RAISE EXCEPTION 'Disabled or retired Dance choreography rejects late processing';
    END IF;
    IF ROW(NEW.choreography_id, NEW.revision, NEW.aggregate_version,
      NEW.community_id, NEW.song_post_id,
      NEW.audio_revision, NEW.requested_start_ms, NEW.requested_end_ms,
      NEW.reference_video_post_id, NEW.reference_video_song_post_id,
      NEW.reference_video_audio_revision, NEW.reference_video_object_ref,
      NEW.reference_video_sha256, NEW.mirror_policy, NEW.alignment_policy_version,
      NEW.alignment_adapter, NEW.alignment_revision, NEW.pose_model_version,
      NEW.pose_runtime_version, NEW.feature_schema_version, NEW.scorer_contract_version,
      NEW.fingerprint_policy_version, NEW.integrity_policy_version,
      NEW.owner_policy_revision, NEW.owner_policy_hash, NEW.revision_terms_hash, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.choreography_id, OLD.revision, OLD.aggregate_version,
      OLD.community_id,
      OLD.song_post_id, OLD.audio_revision, OLD.requested_start_ms, OLD.requested_end_ms,
      OLD.reference_video_post_id, OLD.reference_video_song_post_id,
      OLD.reference_video_audio_revision, OLD.reference_video_object_ref,
      OLD.reference_video_sha256, OLD.mirror_policy, OLD.alignment_policy_version,
      OLD.alignment_adapter, OLD.alignment_revision, OLD.pose_model_version,
      OLD.pose_runtime_version, OLD.feature_schema_version, OLD.scorer_contract_version,
      OLD.fingerprint_policy_version, OLD.integrity_policy_version,
      OLD.owner_policy_revision, OLD.owner_policy_hash, OLD.revision_terms_hash, OLD.created_at) THEN
      RAISE EXCEPTION 'Dance revision terms are immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NOT (
      (OLD.status = 'processing' AND NEW.status IN ('ready', 'processing_failed'))
      OR (OLD.status = 'ready' AND NEW.status IN ('disabled', 'retired'))
    ) THEN
      RAISE EXCEPTION 'Invalid Dance revision transition';
    END IF;
  END IF;
  IF NEW.status IN ('ready', 'disabled', 'retired') THEN
    IF NEW.status = 'ready' AND aggregate.status IN ('disabled', 'retired') THEN
      RAISE EXCEPTION 'Disabled or retired Dance choreography cannot become ready';
    END IF;
    SELECT * INTO selected_segment FROM dance_song_segments WHERE segment_id = NEW.segment_id;
    SELECT * INTO artifact FROM dance_reference_artifacts
     WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision;
    IF selected_segment.segment_id IS NULL
       OR selected_segment.community_id <> NEW.community_id
       OR selected_segment.song_post_id <> NEW.song_post_id
       OR selected_segment.audio_revision <> NEW.audio_revision
       OR selected_segment.start_ms <> NEW.requested_start_ms
       OR selected_segment.end_ms <> NEW.requested_end_ms
       OR NEW.reference_video_scored_end_ms - NEW.reference_video_scored_start_ms
          <> selected_segment.duration_ms
       OR artifact.artifact_id IS NULL THEN
      RAISE EXCEPTION 'Ready Dance revision lacks exact segment, window, or artifact';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_choreography_revisions_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_choreography_revisions
FOR EACH ROW EXECUTE FUNCTION guard_dance_choreography_revision();

CREATE FUNCTION validate_dance_choreography_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id TEXT;
  aggregate dance_choreographies%ROWTYPE;
  ready_count BIGINT;
BEGIN
  target_id := NEW.choreography_id;
  SELECT * INTO aggregate FROM dance_choreographies
   WHERE choreography_id = target_id;
  IF aggregate.choreography_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO ready_count FROM dance_choreography_revisions
   WHERE choreography_id = target_id AND status = 'ready';
  IF aggregate.status = 'ready' THEN
    IF ready_count = 0 OR NOT EXISTS (
      SELECT 1 FROM dance_choreography_revisions
       WHERE choreography_id = target_id
         AND revision = aggregate.active_revision AND status = 'ready'
    ) THEN
      RAISE EXCEPTION 'Ready Dance choreography requires an exact ready active revision';
    END IF;
  ELSIF aggregate.status IN ('draft', 'processing') AND ready_count <> 0 THEN
    RAISE EXCEPTION 'Non-ready Dance choreography cannot retain a ready revision';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dance_choreographies_consistency
AFTER INSERT OR UPDATE ON dance_choreographies
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_dance_choreography_consistency();
CREATE CONSTRAINT TRIGGER dance_choreography_revisions_consistency
AFTER INSERT OR UPDATE ON dance_choreography_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_dance_choreography_consistency();

CREATE FUNCTION guard_dance_reference_processing_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_choreography_revisions%ROWTYPE;
  outbox dance_reference_outbox%ROWTYPE;
  publication media_publication_projections%ROWTYPE;
  request_keys TEXT[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Dance reference processing requests are immutable';
  END IF;
  SELECT * INTO target FROM dance_choreography_revisions
   WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision FOR SHARE;
  SELECT * INTO outbox FROM dance_reference_outbox
   WHERE effect_identity = NEW.effect_identity FOR SHARE;
  SELECT * INTO publication FROM media_publication_projections
   WHERE community_id = target.community_id AND post_id = target.song_post_id
     AND audio_revision = target.audio_revision FOR SHARE;
  SELECT array_agg(key ORDER BY key) INTO request_keys
    FROM jsonb_object_keys(NEW.request_material) AS key;
  IF target.choreography_id IS NULL OR target.status <> 'processing'
     OR outbox.choreography_id <> NEW.choreography_id OR outbox.revision <> NEW.revision
     OR request_keys IS DISTINCT FROM ARRAY[
       'alignment', 'canonicalAudio', 'choreographyId', 'choreographyRevision',
       'effectIdentity', 'extraction', 'mirrorPolicy', 'outputs', 'ownerPolicy', 'pose',
       'qualityLimits', 'referenceVideo', 'requestedEndMs', 'requestedStartMs', 'revisionTermsHash',
       'segmentTermsHash', 'version'
     ]::TEXT[]
     OR NEW.request_material->>'version' <> 'frozen-dance-reference-input-v1'
     OR NEW.request_material->>'effectIdentity' <> NEW.effect_identity
     OR NEW.request_material->>'choreographyId' <> NEW.choreography_id
     OR NEW.request_material->>'choreographyRevision' <> NEW.revision::TEXT
     OR NEW.request_material->>'revisionTermsHash' <> target.revision_terms_hash
     OR NEW.request_material->'canonicalAudio'->>'audioRevision' <> target.audio_revision::TEXT
     OR NEW.request_material->'canonicalAudio'->>'objectKey' <> publication.audio_asset_ref
     OR NEW.request_material->'canonicalAudio'->>'sha256' <> publication.canonical_audio_sha256
     OR NEW.request_material->'referenceVideo'->>'postId' <> target.reference_video_post_id
     OR NEW.request_material->'referenceVideo'->>'objectKey' <> target.reference_video_object_ref
     OR NEW.request_material->'referenceVideo'->>'sha256' <> target.reference_video_sha256
     OR NEW.request_material->>'requestedStartMs' <> target.requested_start_ms::TEXT
     OR NEW.request_material->>'requestedEndMs' <> target.requested_end_ms::TEXT
     OR NEW.request_material->>'mirrorPolicy' <> target.mirror_policy
     OR NEW.request_material->'alignment'->>'policyVersion' <> target.alignment_policy_version
     OR NEW.request_material->'alignment'->>'adapterId' <> target.alignment_adapter
     OR NEW.request_material->'alignment'->>'adapterRevision' <> target.alignment_revision
     OR NEW.request_material->'pose'->>'modelVersion' <> target.pose_model_version
     OR NEW.request_material->'pose'->>'runtimeVersion' <> target.pose_runtime_version
     OR NEW.request_material->'pose'->>'featureSchemaVersion' <> target.feature_schema_version
     OR NEW.request_material->'pose'->>'scorerContractVersion' <> target.scorer_contract_version
     OR NEW.request_material->'pose'->>'fingerprintPolicyVersion' <>
        target.fingerprint_policy_version
     OR NEW.request_material->'pose'->>'integrityPolicyVersion' <> target.integrity_policy_version
     OR NEW.request_material->'ownerPolicy'->>'revision' <> target.owner_policy_revision::TEXT
     OR NEW.request_material->'ownerPolicy'->>'hash' <> target.owner_policy_hash THEN
    RAISE EXCEPTION 'Dance reference processing request is not exact revision authority';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_reference_processing_requests_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_reference_processing_requests
FOR EACH ROW EXECUTE FUNCTION guard_dance_reference_processing_request();

CREATE FUNCTION guard_dance_processing_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_choreography_revisions%ROWTYPE;
  latest dance_reference_processing_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dance processing attempts cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO target FROM dance_choreography_revisions
     WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision FOR SHARE;
    SELECT * INTO latest FROM dance_reference_processing_attempts
     WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision
     ORDER BY attempt_number DESC LIMIT 1 FOR SHARE;
    IF target.choreography_id IS NULL OR target.status <> 'processing'
       OR NEW.attempt_number <> COALESCE(latest.attempt_number, 0) + 1
       OR NEW.lease_expires_at <= clock_timestamp()
       OR (latest.processing_attempt_id IS NOT NULL
         AND (latest.state <> 'failed' OR latest.retryable IS NOT TRUE)) THEN
      RAISE EXCEPTION 'Dance processing attempt is not the exact next retry';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.processing_attempt_id, NEW.choreography_id, NEW.revision,
      NEW.attempt_number, NEW.adapter_id, NEW.adapter_revision,
      NEW.input_digest, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.processing_attempt_id, OLD.choreography_id, OLD.revision,
      OLD.attempt_number, OLD.adapter_id, OLD.adapter_revision,
      OLD.input_digest, OLD.created_at) THEN
      RAISE EXCEPTION 'Dance processing attempt identity is immutable';
    END IF;
    IF OLD.prepared_operation IS NOT NULL AND ROW(
      NEW.prepared_operation, NEW.prepared_operation_bytes, NEW.prepared_operation_sha256
    ) IS DISTINCT FROM ROW(
      OLD.prepared_operation, OLD.prepared_operation_bytes, OLD.prepared_operation_sha256
    ) THEN
      RAISE EXCEPTION 'Dance prepared operation is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD.state = 'leased' AND NEW.state = 'leased' THEN
      IF OLD.prepared_operation IS NULL AND NEW.prepared_operation IS NOT NULL THEN
        IF NEW.lease_owner <> OLD.lease_owner OR NEW.lease_fence <> OLD.lease_fence
           OR NEW.lease_expires_at <> OLD.lease_expires_at
           OR OLD.lease_expires_at <= clock_timestamp() OR NEW.updated_at <= OLD.updated_at THEN
          RAISE EXCEPTION 'Dance prepared operation fence is stale';
        END IF;
      ELSIF OLD.lease_expires_at > clock_timestamp()
         AND NEW.lease_owner = OLD.lease_owner
         AND NEW.lease_fence = OLD.lease_fence
         AND NEW.lease_expires_at > OLD.lease_expires_at
         AND NEW.updated_at > OLD.updated_at THEN
        NULL;
      ELSIF OLD.lease_expires_at > clock_timestamp()
         OR NEW.lease_expires_at <= clock_timestamp()
         OR NEW.lease_fence <> OLD.lease_fence + 1
         OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Dance processing lease cannot be reclaimed';
      END IF;
    ELSIF OLD.state = 'leased' AND NEW.state IN ('succeeded', 'failed', 'exhausted') THEN
      IF OLD.lease_expires_at <= clock_timestamp()
         OR NEW.lease_fence <> OLD.lease_fence OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Dance processing terminal fence is stale';
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid Dance processing attempt transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_reference_processing_attempts_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_reference_processing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_dance_processing_attempt();

CREATE FUNCTION guard_dance_reference_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target dance_choreography_revisions%ROWTYPE;
  payload_keys TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Dance reference outbox rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO target FROM dance_choreography_revisions
     WHERE choreography_id = NEW.choreography_id AND revision = NEW.revision FOR SHARE;
    SELECT array_agg(key ORDER BY key) INTO payload_keys FROM jsonb_object_keys(NEW.payload) AS key;
    IF target.choreography_id IS NULL OR target.status <> 'processing'
       OR payload_keys IS DISTINCT FROM
          ARRAY['choreography_id', 'effect_identity', 'revision', 'revision_terms_hash']::TEXT[]
       OR NEW.payload->>'choreography_id' <> NEW.choreography_id
       OR NEW.payload->>'effect_identity' <> NEW.effect_identity
       OR NEW.payload->>'revision' <> NEW.revision::TEXT
       OR NEW.payload->>'revision_terms_hash' <> target.revision_terms_hash THEN
      RAISE EXCEPTION 'Dance reference outbox payload is not exact processing authority';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.outbox_event_id, NEW.choreography_id, NEW.revision, NEW.event_type,
      NEW.effect_identity, NEW.payload, NEW.payload_sha256, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.outbox_event_id, OLD.choreography_id, OLD.revision,
      OLD.event_type, OLD.effect_identity, OLD.payload, OLD.payload_sha256, OLD.created_at) THEN
      RAISE EXCEPTION 'Dance reference outbox identity is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF OLD.state IN ('pending', 'failed') AND NEW.state = 'running' THEN
      IF (OLD.state = 'failed' AND OLD.next_eligible_at > clock_timestamp())
         OR NEW.lease_expires_at <= clock_timestamp()
         OR NEW.delivery_attempts <> OLD.delivery_attempts + 1
         OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Dance outbox claim fence is invalid';
      END IF;
    ELSIF OLD.state = 'running' AND NEW.state = 'running' THEN
      IF OLD.lease_expires_at > clock_timestamp()
         AND NEW.claim_owner = OLD.claim_owner
         AND NEW.delivery_attempts = OLD.delivery_attempts
         AND NEW.claim_fence = OLD.claim_fence
         AND NEW.lease_expires_at > OLD.lease_expires_at
         AND NEW.updated_at > OLD.updated_at THEN
        NULL;
      ELSIF OLD.lease_expires_at > clock_timestamp()
         OR NEW.lease_expires_at <= clock_timestamp()
         OR NEW.delivery_attempts <> OLD.delivery_attempts + 1
         OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Dance outbox lease cannot be reclaimed or renewed';
      END IF;
    ELSIF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') THEN
      IF OLD.lease_expires_at <= clock_timestamp()
         OR NEW.delivery_attempts <> OLD.delivery_attempts
         OR NEW.claim_fence <> OLD.claim_fence OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'Dance outbox terminal fence is invalid';
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid Dance reference outbox transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dance_reference_outbox_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON dance_reference_outbox
FOR EACH ROW EXECUTE FUNCTION guard_dance_reference_outbox();

CREATE FUNCTION guard_song_dance_presentation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  publication media_publication_projections%ROWTYPE;
  target dance_choreography_revisions%ROWTYPE;
  aggregate dance_choreographies%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Song Dance presentations cannot be deleted';
  END IF;
  SELECT * INTO publication FROM media_publication_projections
   WHERE submission_id = NEW.song_submission_id FOR SHARE;
  IF publication.submission_id IS NULL
     OR publication.community_id <> NEW.community_id
     OR publication.post_id <> NEW.song_post_id
     OR publication.audio_revision <> NEW.audio_revision
     OR publication.actor_account_id <> NEW.song_owner_account_id
     OR NEW.updated_by_account_id <> NEW.song_owner_account_id THEN
    RAISE EXCEPTION 'Song Dance presentation requires exact song-owner authority';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.community_id, NEW.song_post_id, NEW.song_submission_id,
      NEW.audio_revision, NEW.song_owner_account_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.community_id, OLD.song_post_id, OLD.song_submission_id,
      OLD.audio_revision, OLD.song_owner_account_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Song Dance presentation identity is immutable';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    IF NEW.presentation_revision <> OLD.presentation_revision + 1
       OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'Song Dance presentation requires the next revision';
    END IF;
  END IF;
  IF NEW.featured_choreography_id IS NOT NULL THEN
    SELECT * INTO target FROM dance_choreography_revisions
     WHERE choreography_id = NEW.featured_choreography_id
       AND revision = NEW.featured_choreography_revision;
    SELECT * INTO aggregate FROM dance_choreographies
     WHERE choreography_id = NEW.featured_choreography_id;
    IF target.choreography_id IS NULL OR target.status <> 'ready'
       OR aggregate.status <> 'ready'
       OR target.community_id <> NEW.community_id
       OR target.song_post_id <> NEW.song_post_id
       OR target.audio_revision <> NEW.audio_revision THEN
      RAISE EXCEPTION 'Featured Dance presentation target is not selectable';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_dance_presentations_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_dance_presentations
FOR EACH ROW EXECUTE FUNCTION guard_song_dance_presentation();

CREATE FUNCTION reject_dance_reference_action_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Dance reference actions are append-only';
END
$$;
CREATE TRIGGER dance_reference_actions_append_only
BEFORE UPDATE OR DELETE ON dance_reference_actions
FOR EACH ROW EXECUTE FUNCTION reject_dance_reference_action_change();

CREATE INDEX dance_song_segments_song_idx
  ON dance_song_segments (community_id, song_post_id, audio_revision, created_at, segment_id);
CREATE INDEX dance_choreographies_song_ready_idx
  ON dance_choreographies (community_id, song_post_id, status, created_at, choreography_id);
CREATE INDEX dance_choreography_revisions_ready_idx
  ON dance_choreography_revisions (
    community_id, song_post_id, audio_revision, status, choreography_id, revision
  );
CREATE INDEX dance_reference_processing_attempts_lease_idx
  ON dance_reference_processing_attempts (state, lease_expires_at, created_at)
  WHERE state = 'leased';
CREATE INDEX dance_reference_outbox_claim_idx
  ON dance_reference_outbox (state, next_eligible_at, lease_expires_at, created_at)
  WHERE state IN ('pending', 'running', 'failed');
