-- Spec 013 song-media persistence.  Providers and Workflow calls never run in
-- these transactions; Postgres owns the state, evidence, replay, and effects.

CREATE TABLE media_upload_reservations (
  reservation_id TEXT PRIMARY KEY CHECK (btrim(reservation_id) <> ''),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  actor_user_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/media-upload-reservations'
    CHECK (endpoint_template = '/communities/:communityId/media-upload-reservations'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  expected_content_type TEXT NOT NULL CHECK (
    expected_content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
  ),
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  upload_url TEXT NOT NULL CHECK (btrim(upload_url) <> ''),
  upload_headers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(upload_headers) = 'array'),
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'claimed', 'sealed', 'rejected', 'expired')),
  submission_id TEXT,
  operation_id TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('expectation_mismatch', 'source_precondition_failed', 'destination_conflict')),
  terminal_evidence_ref TEXT CHECK (terminal_evidence_ref IS NULL OR btrim(terminal_evidence_ref) <> ''),
  terminal_evidence_digest TEXT CHECK (terminal_evidence_digest IS NULL OR terminal_evidence_digest ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ,
  terminal_fence BIGINT CHECK (terminal_fence IS NULL OR terminal_fence > 0),
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_upload_reservations_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT media_upload_reservations_state_shape CHECK (
    (state = 'issued' AND submission_id IS NULL AND operation_id IS NULL)
    OR (state = 'expired' AND ((submission_id IS NULL AND operation_id IS NULL) OR (submission_id IS NOT NULL AND operation_id IS NOT NULL)))
    OR (state IN ('claimed', 'sealed', 'rejected') AND submission_id IS NOT NULL AND operation_id IS NOT NULL)
  ),
  CONSTRAINT media_upload_reservations_claim_shape CHECK (
    (state = 'issued' AND claim_fence = 0)
    OR (state = 'expired' AND ((submission_id IS NULL AND claim_fence = 0) OR (submission_id IS NOT NULL AND claim_fence > 0)))
    OR (state IN ('claimed', 'sealed', 'rejected') AND claim_fence > 0)
  ),
  CONSTRAINT media_upload_reservations_terminal_shape CHECK (
    (state = 'rejected' AND terminal_reason IS NOT NULL AND terminal_evidence_ref IS NOT NULL AND terminal_evidence_digest IS NOT NULL AND terminal_at IS NOT NULL AND terminal_fence IS NOT NULL)
    OR (state <> 'rejected' AND terminal_reason IS NULL AND terminal_evidence_ref IS NULL AND terminal_evidence_digest IS NULL AND terminal_at IS NULL AND terminal_fence IS NULL)
  ),
  CONSTRAINT media_upload_reservations_expiry_shape CHECK (
    state <> 'expired' OR expires_at <= updated_at
  ),
  CONSTRAINT media_upload_reservations_identity_unique UNIQUE (
    community_id, actor_user_id, reservation_id
  ),
  CONSTRAINT media_upload_reservations_claim_unique UNIQUE (
    community_id, actor_user_id, reservation_id, submission_id, operation_id
  ),
  CONSTRAINT media_upload_reservations_replay_unique UNIQUE (
    community_id, actor_user_id, endpoint_template, idempotency_key
  )
);
CREATE INDEX media_upload_reservations_expiry_idx
  ON media_upload_reservations (state, expires_at, reservation_id)
  WHERE state IN ('issued', 'claimed');

CREATE TABLE media_post_submissions (
  submission_id TEXT PRIMARY KEY CHECK (btrim(submission_id) <> ''),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  actor_user_id TEXT NOT NULL REFERENCES users (user_id),
  operation_id TEXT NOT NULL CHECK (btrim(operation_id) <> ''),
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/media-post-submissions'
    CHECK (endpoint_template = '/communities/:communityId/media-post-submissions'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 200),
  song_type TEXT NOT NULL CHECK (song_type IN ('original', 'remix')),
  start_input JSONB NOT NULL CHECK (jsonb_typeof(start_input) = 'object'),
  audio_reservation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL DEFAULT 1 CHECK (creation_revision > 0),
  audio_revision BIGINT NOT NULL DEFAULT 0 CHECK (audio_revision >= 0),
  analysis_revision BIGINT NOT NULL DEFAULT 0 CHECK (analysis_revision >= 0),
  decision_revision BIGINT NOT NULL DEFAULT 0 CHECK (decision_revision >= 0),
  workflow_revision BIGINT NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0),
  event_sequence BIGINT NOT NULL DEFAULT 1 CHECK (event_sequence > 0),
  current_terms_revision BIGINT,
  current_immutable_ref TEXT,
  current_analysis_revision BIGINT,
  current_decision_revision BIGINT,
  bound_reference_asset_id TEXT,
  bound_reference_evidence_ref TEXT,
  bound_reference_audio_revision BIGINT,
  bound_reference_analysis_revision BIGINT,
  bound_reference_audio_sha256 TEXT,
  bound_reference_upstream_share_bps INTEGER,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN (
    'processing', 'action_required', 'manual_review', 'published',
    'blocked', 'processing_failed', 'abandoned'
  )),
  phase TEXT DEFAULT 'reserve' CHECK (phase IS NULL OR phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  post_id TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'invalid_media', 'unsupported_media', 'probe_failed', 'hash_failed',
    'transform_failed', 'publication_failed', 'upload_seal_conflict'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  failure_retry_count INTEGER CHECK (failure_retry_count IS NULL OR failure_retry_count BETWEEN 0 AND 3),
  retryable BOOLEAN,
  last_safe_phase TEXT CHECK (last_safe_phase IS NULL OR last_safe_phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  action_kind TEXT CHECK (action_kind IS NULL OR action_kind = 'reference_required'),
  action_reference_request_ref TEXT,
  action_expires_at TIMESTAMPTZ,
  held_revision BIGINT,
  review_ref TEXT,
  review_reason_code TEXT CHECK (review_reason_code IS NULL OR review_reason_code IN ('review_required', 'moderation_unavailable')),
  review_exhaustion_code TEXT CHECK (review_exhaustion_code IS NULL OR review_exhaustion_code = 'acr_exhausted'),
  review_exhaustion_attempt_id TEXT,
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  moderator_evidence_ref TEXT,
  moderator_approval_kind TEXT CHECK (moderator_approval_kind IS NULL OR moderator_approval_kind IN ('standard', 'acr_override')),
  moderator_reason_code TEXT CHECK (moderator_reason_code IS NULL OR moderator_reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped', 'policy_violation')),
  abandonment_reason TEXT CHECK (abandonment_reason IS NULL OR abandonment_reason IN ('author_cancelled', 'reservation_expired', 'action_deadline_elapsed', 'upload_expectation_mismatch', 'upload_source_changed_before_finalize')),
  retention_disposition TEXT CHECK (retention_disposition IS NULL OR retention_disposition IN ('no_object', 'retain_for_reconciliation', 'retain_until_expiry')),
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_post_submissions_reservation_fk FOREIGN KEY (
    community_id, actor_user_id, audio_reservation_id
  ) REFERENCES media_upload_reservations (community_id, actor_user_id, reservation_id),
  CONSTRAINT media_post_submissions_post_fk FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT media_post_submissions_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT media_post_submissions_identity_unique UNIQUE (community_id, submission_id, operation_id),
  CONSTRAINT media_post_submissions_actor_operation_unique UNIQUE (community_id, actor_user_id, operation_id),
  CONSTRAINT media_post_submissions_actor_submission_unique UNIQUE (community_id, actor_user_id, submission_id),
  CONSTRAINT media_post_submissions_actor_lineage_unique UNIQUE (community_id, actor_user_id, submission_id, operation_id),
  CONSTRAINT media_post_submissions_replay_unique UNIQUE (community_id, actor_user_id, endpoint_template, idempotency_key),
  CONSTRAINT media_post_submissions_shape CHECK (
    (status = 'processing' AND phase IS NOT NULL AND post_id IS NULL)
    OR (status = 'action_required' AND phase IS NULL AND action_kind = 'reference_required' AND action_reference_request_ref IS NOT NULL AND action_expires_at IS NOT NULL AND held_revision = creation_revision AND post_id IS NULL)
    OR (status = 'manual_review' AND phase IS NULL AND review_ref IS NOT NULL AND held_revision = creation_revision AND post_id IS NULL AND (review_exhaustion_code IS NULL OR review_exhaustion_code = 'acr_exhausted'))
    OR (status = 'published' AND phase IS NULL AND post_id IS NOT NULL AND failure_code IS NULL)
    OR (status = 'blocked' AND phase IS NULL AND post_id IS NULL)
    OR (status = 'processing_failed' AND phase IS NULL AND failure_code IS NOT NULL AND failure_retry_count IS NOT NULL AND retryable IS NOT NULL AND last_safe_phase IS NOT NULL AND post_id IS NULL)
    OR (status = 'abandoned' AND phase IS NULL AND post_id IS NULL AND abandonment_reason IS NOT NULL AND retention_disposition IS NOT NULL AND action_kind IS NULL AND action_reference_request_ref IS NULL AND action_expires_at IS NULL AND review_ref IS NULL AND review_reason_code IS NULL AND review_exhaustion_code IS NULL AND held_revision IS NULL AND moderator_action_id IS NULL AND moderator_actor_id IS NULL AND moderator_evidence_ref IS NULL AND moderator_approval_kind IS NULL AND moderator_reason_code IS NULL)
  ),
  CONSTRAINT media_post_submissions_review_exhaustion_shape CHECK ((review_exhaustion_code IS NULL AND review_exhaustion_attempt_id IS NULL) OR (review_exhaustion_code = 'acr_exhausted' AND review_exhaustion_attempt_id IS NOT NULL AND status = 'manual_review')),
  CONSTRAINT media_post_submissions_revision_shape CHECK (
    (audio_revision = 0 AND current_immutable_ref IS NULL)
    OR (audio_revision > 0 AND current_immutable_ref IS NOT NULL)
  ),
  CONSTRAINT media_post_submissions_reference_shape CHECK (
    (bound_reference_asset_id IS NULL AND bound_reference_evidence_ref IS NULL AND bound_reference_audio_revision IS NULL AND bound_reference_analysis_revision IS NULL AND bound_reference_audio_sha256 IS NULL AND bound_reference_upstream_share_bps IS NULL)
    OR (bound_reference_asset_id IS NOT NULL AND bound_reference_evidence_ref IS NOT NULL AND btrim(bound_reference_evidence_ref) <> '' AND bound_reference_audio_revision = audio_revision AND bound_reference_analysis_revision > 0 AND bound_reference_analysis_revision <= analysis_revision AND bound_reference_audio_sha256 ~ '^[0-9a-f]{64}$' AND (bound_reference_upstream_share_bps IS NULL OR bound_reference_upstream_share_bps BETWEEN 0 AND 10000))
  )
);
CREATE INDEX media_post_submissions_author_idx
  ON media_post_submissions (community_id, actor_user_id, updated_at DESC, submission_id);

CREATE TABLE media_submission_command_replays (
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_actor_user_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL CHECK (btrim(endpoint_template) <> ''),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, actor_user_id, endpoint_template, idempotency_key),
  CONSTRAINT media_submission_command_replays_submission_fk FOREIGN KEY (
    community_id, submission_actor_user_id, submission_id, operation_id
  ) REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  CONSTRAINT media_submission_command_replays_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  )
);

CREATE TABLE media_submission_terms (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 1),
  license_preset TEXT NOT NULL CHECK (license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')),
  commercial_remix_share_bps INTEGER NOT NULL CHECK (commercial_remix_share_bps BETWEEN 0 AND 10000),
  royalty_allocations JSONB NOT NULL CHECK (jsonb_typeof(royalty_allocations) = 'array' AND jsonb_array_length(royalty_allocations) > 0),
  access_mode TEXT NOT NULL CHECK (access_mode = 'public'),
  terms_snapshot JSONB NOT NULL CHECK (jsonb_typeof(terms_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, creation_revision),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  CONSTRAINT media_submission_terms_share_shape CHECK ((license_preset = 'commercial-remix') OR commercial_remix_share_bps = 0)
);

CREATE TABLE media_immutable_objects (
  immutable_ref TEXT PRIMARY KEY CHECK (btrim(immutable_ref) <> ''),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL UNIQUE CHECK (btrim(destination_ref) <> ''),
  etag TEXT NOT NULL CHECK (btrim(etag) <> ''),
  object_version TEXT NOT NULL CHECK (btrim(object_version) <> ''),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  content_type TEXT NOT NULL CHECK (content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'),
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, reservation_id, submission_id, operation_id)
    REFERENCES media_upload_reservations (community_id, actor_user_id, reservation_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, immutable_ref),
  UNIQUE (community_id, immutable_ref, canonical_sha256, content_type, size_bytes),
  UNIQUE (community_id, actor_user_id, operation_id)
);

CREATE TABLE media_audio_revisions (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  immutable_ref TEXT NOT NULL,
  canonical_sha256 TEXT NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, audio_revision),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, immutable_ref, canonical_sha256, content_type, size_bytes)
    REFERENCES media_immutable_objects (community_id, immutable_ref, canonical_sha256, content_type, size_bytes),
  UNIQUE (submission_id, audio_revision, canonical_sha256, immutable_ref),
  UNIQUE (submission_id, audio_revision, canonical_sha256)
);

CREATE TABLE media_reference_evidence (
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL CHECK (btrim(asset_id) <> ''),
  evidence_audio_revision BIGINT NOT NULL CHECK (evidence_audio_revision > 0),
  evidence_analysis_revision BIGINT NOT NULL CHECK (evidence_analysis_revision > 0),
  evidence_audio_sha256 TEXT NOT NULL CHECK (evidence_audio_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  upstream_commercial_rev_share_bps INTEGER CHECK (upstream_commercial_rev_share_bps IS NULL OR upstream_commercial_rev_share_bps BETWEEN 0 AND 10000),
  inherited_license_preset TEXT CHECK (inherited_license_preset IS NULL OR inherited_license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')),
  inherited_commercial_rev_share_bps INTEGER CHECK (inherited_commercial_rev_share_bps IS NULL OR inherited_commercial_rev_share_bps BETWEEN 0 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, actor_user_id, submission_id, operation_id, asset_id, evidence_audio_revision, evidence_analysis_revision, evidence_audio_sha256),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id)
);

CREATE TABLE media_transcript_artifacts (
  transcript_artifact_ref TEXT PRIMARY KEY CHECK (btrim(transcript_artifact_ref) <> ''),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  transcript_sha256 TEXT NOT NULL CHECK (transcript_sha256 ~ '^[0-9a-f]{64}$'),
  transcript_text TEXT NOT NULL CHECK (char_length(transcript_text) <= 200000),
  segments JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array' AND jsonb_array_length(segments) <= 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256)
    REFERENCES media_audio_revisions (submission_id, audio_revision, canonical_sha256),
  UNIQUE (transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256)
);
CREATE INDEX media_transcript_lineage_idx ON media_transcript_artifacts (submission_id, audio_revision, analysis_revision, canonical_audio_sha256);

CREATE TABLE media_analysis_evidence (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  analysis_version TEXT NOT NULL CHECK (analysis_version = 'song-trusted-analysis-v1'),
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  finalized_audio_ref TEXT NOT NULL,
  probe_evidence_ref TEXT NOT NULL CHECK (btrim(probe_evidence_ref) <> ''),
  embedded_metadata_evidence_ref TEXT NOT NULL CHECK (btrim(embedded_metadata_evidence_ref) <> ''),
  embedded_metadata_adapter_revision TEXT NOT NULL CHECK (btrim(embedded_metadata_adapter_revision) <> ''),
  embedded_title TEXT,
  embedded_title_provenance TEXT NOT NULL CHECK (embedded_title_provenance IN ('embedded', 'absent')),
  cover_status TEXT NOT NULL CHECK (cover_status IN ('ready', 'absent', 'rejected')),
  cover_artifact_ref TEXT,
  cover_artifact_sha256 TEXT CHECK (cover_artifact_sha256 IS NULL OR cover_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  cover_media_type TEXT,
  cover_width INTEGER,
  cover_height INTEGER,
  cover_normalization_revision TEXT,
  cover_safety_policy_revision TEXT,
  cover_facts JSONB NOT NULL CHECK (jsonb_typeof(cover_facts) = 'object'),
  speech_status TEXT NOT NULL CHECK (speech_status IN ('ready', 'no_speech', 'unavailable')),
  transcript_artifact_ref TEXT,
  transcript_sha256 TEXT CHECK (transcript_sha256 IS NULL OR transcript_sha256 ~ '^[0-9a-f]{64}$'),
  explicitness TEXT NOT NULL CHECK (explicitness IN ('not_explicit', 'explicit', 'uncertain', 'no_lyrics')),
  primary_language_bcp47 TEXT,
  secondary_language_bcp47 TEXT,
  speech_evidence_ref TEXT NOT NULL CHECK (btrim(speech_evidence_ref) <> ''),
  speech_policy_revision TEXT NOT NULL CHECK (btrim(speech_policy_revision) <> ''),
  speech_adapter_revision TEXT NOT NULL CHECK (btrim(speech_adapter_revision) <> ''),
  acr_decision TEXT NOT NULL CHECK (acr_decision IN ('allow', 'requires_reference', 'inconclusive', 'skipped')),
  acr_evidence_ref TEXT NOT NULL CHECK (btrim(acr_evidence_ref) <> ''),
  acr_policy_revision TEXT NOT NULL CHECK (btrim(acr_policy_revision) <> ''),
  acr_adapter_revision TEXT NOT NULL CHECK (btrim(acr_adapter_revision) <> ''),
  media_safety TEXT NOT NULL CHECK (media_safety IN ('allow', 'draft', 'review_required', 'blocked')),
  lyrics_safety TEXT NOT NULL CHECK (lyrics_safety IN ('skipped', 'allow', 'review_required', 'blocked')),
  bound_reference_asset_id TEXT,
  bound_reference_audio_revision BIGINT,
  bound_reference_analysis_revision BIGINT,
  bound_reference_audio_sha256 TEXT,
  bound_reference_upstream_share_bps INTEGER,
  analysis_snapshot JSONB NOT NULL CHECK (jsonb_typeof(analysis_snapshot) = 'object'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, analysis_revision),
  UNIQUE (submission_id, audio_revision, analysis_revision, canonical_audio_sha256),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256, finalized_audio_ref)
    REFERENCES media_audio_revisions (submission_id, audio_revision, canonical_sha256, immutable_ref),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id, bound_reference_asset_id, bound_reference_audio_revision, bound_reference_analysis_revision, bound_reference_audio_sha256)
    REFERENCES media_reference_evidence (community_id, actor_user_id, submission_id, operation_id, asset_id, evidence_audio_revision, evidence_analysis_revision, evidence_audio_sha256),
  CONSTRAINT media_analysis_title_shape CHECK ((embedded_title_provenance = 'embedded' AND embedded_title IS NOT NULL AND btrim(embedded_title) <> '' AND char_length(embedded_title) <= 200) OR (embedded_title_provenance = 'absent' AND embedded_title IS NULL)),
  CONSTRAINT media_analysis_cover_shape CHECK ((cover_status = 'ready' AND cover_artifact_ref IS NOT NULL AND cover_artifact_sha256 IS NOT NULL AND cover_media_type IN ('image/jpeg', 'image/png', 'image/webp') AND cover_width IS NOT NULL AND cover_height IS NOT NULL AND cover_width > 0 AND cover_height > 0 AND btrim(cover_normalization_revision) <> '' AND btrim(cover_safety_policy_revision) <> '' AND NOT (cover_facts ? 'reasonCode')) OR (cover_status = 'absent' AND cover_facts->>'reasonCode' IS NOT NULL AND cover_facts->>'reasonCode' = 'not_embedded' AND cover_artifact_ref IS NULL AND cover_artifact_sha256 IS NULL AND cover_media_type IS NULL AND cover_width IS NULL AND cover_height IS NULL AND cover_normalization_revision IS NULL AND cover_safety_policy_revision IS NULL) OR (cover_status = 'rejected' AND cover_facts->>'reasonCode' IS NOT NULL AND cover_facts->>'reasonCode' IN ('invalid', 'unsafe', 'limits_exceeded') AND cover_artifact_ref IS NULL AND cover_artifact_sha256 IS NULL AND cover_media_type IS NULL AND cover_width IS NULL AND cover_height IS NULL AND cover_normalization_revision IS NULL AND cover_safety_policy_revision IS NULL)),
  CONSTRAINT media_analysis_speech_shape CHECK (
    (speech_status = 'ready' AND transcript_artifact_ref IS NOT NULL AND transcript_sha256 IS NOT NULL AND explicitness IN ('not_explicit', 'explicit', 'uncertain') AND primary_language_bcp47 IS NOT NULL AND char_length(primary_language_bcp47) <= 35 AND primary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$' AND (secondary_language_bcp47 IS NULL OR (char_length(secondary_language_bcp47) <= 35 AND secondary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$' AND secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47)) AND lyrics_safety IN ('skipped', 'allow'))
    OR (speech_status = 'no_speech' AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL AND explicitness = 'no_lyrics' AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL AND lyrics_safety = 'skipped')
    OR (speech_status = 'unavailable' AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL AND explicitness = 'uncertain' AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL AND lyrics_safety = 'review_required')
  ),
  CONSTRAINT media_analysis_reference_shape CHECK ((bound_reference_asset_id IS NULL AND bound_reference_audio_revision IS NULL AND bound_reference_analysis_revision IS NULL AND bound_reference_audio_sha256 IS NULL AND bound_reference_upstream_share_bps IS NULL) OR (bound_reference_asset_id IS NOT NULL AND bound_reference_audio_revision = audio_revision AND bound_reference_analysis_revision > 0 AND bound_reference_analysis_revision <= analysis_revision AND bound_reference_audio_sha256 = canonical_audio_sha256 AND (bound_reference_upstream_share_bps IS NULL OR bound_reference_upstream_share_bps BETWEEN 0 AND 10000)))
);
ALTER TABLE media_analysis_evidence
  ADD CONSTRAINT media_analysis_transcript_fk FOREIGN KEY (transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256)
    REFERENCES media_transcript_artifacts (transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256);

CREATE TABLE media_publication_decisions (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  decision_revision BIGINT NOT NULL CHECK (decision_revision > 0),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 1),
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'manual_review', 'block')),
  policy_revision TEXT NOT NULL CHECK (btrim(policy_revision) <> ''),
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  decision_snapshot JSONB NOT NULL CHECK (jsonb_typeof(decision_snapshot) = 'object'),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, decision_revision),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, creation_revision) REFERENCES media_submission_terms (submission_id, creation_revision),
  FOREIGN KEY (submission_id, audio_revision, analysis_revision, canonical_audio_sha256)
    REFERENCES media_analysis_evidence (submission_id, audio_revision, analysis_revision, canonical_audio_sha256)
);

CREATE TABLE media_submission_events (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
  event_id TEXT NOT NULL UNIQUE CHECK (btrim(event_id) <> ''),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('submission_reserved', 'text_input_bound', 'media_reservation_issued', 'finalize_requested', 'author_cancelled', 'reservation_expired', 'upload_finalized', 'upload_expectation_mismatch_recorded', 'upload_source_precondition_failed', 'seal_conflict_recorded', 'song_terms_bound', 'blocking_analysis_completed', 'review_exhaustion_recorded', 'media_failure_recorded', 'publication_allowed', 'reference_required', 'review_required', 'policy_blocked', 'reference_bound', 'action_deadline_elapsed', 'moderator_approved', 'moderator_blocked', 'publication_committed', 'technical_exhaustion_recorded', 'retry_authorized')),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  audio_revision BIGINT NOT NULL CHECK (audio_revision >= 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision >= 0),
  decision_revision BIGINT NOT NULL CHECK (decision_revision >= 0),
  workflow_revision BIGINT NOT NULL CHECK (workflow_revision >= 0),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, actor_user_id, submission_id, event_sequence),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id)
);

CREATE TABLE media_processing_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (btrim(attempt_id) <> ''),
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  stage TEXT NOT NULL CHECK (stage IN ('probe', 'embedded_metadata', 'cover', 'transcript', 'acr', 'lyrics_safety', 'media_safety', 'publication')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  provider_idempotency_key TEXT NOT NULL CHECK (btrim(provider_idempotency_key) <> ''),
  input_kind TEXT NOT NULL CHECK (input_kind IN ('audio', 'analysis', 'transcript', 'reference', 'publication')),
  input_revision BIGINT NOT NULL CHECK (input_revision > 0),
  policy_revision TEXT NOT NULL CHECK (btrim(policy_revision) <> ''),
  adapter_revision TEXT NOT NULL CHECK (btrim(adapter_revision) <> ''),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'retry_wait', 'succeeded', 'exhausted')),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  retryable BOOLEAN,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'invalid_media', 'unsupported_media', 'probe_failed', 'hash_failed',
    'transform_failed', 'publication_failed', 'upload_seal_conflict',
    'elevenlabs_key_missing', 'key_invalid', 'rate_limited',
    'provider_unavailable', 'timeout', 'invalid_response',
    'alignment_failed', 'lyrics_missing', 'audio_missing',
    'provider_timeout', 'provider_invalid'
  )),
  evidence_ref TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, audio_revision) REFERENCES media_audio_revisions (submission_id, audio_revision),
  UNIQUE (submission_id, audio_revision, analysis_revision, stage, attempt_number),
  UNIQUE (provider_idempotency_key),
  CONSTRAINT media_processing_attempt_state_shape CHECK (
    (state = 'pending' AND claim_owner IS NULL AND claim_fence = 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND retryable IS NULL AND failure_code IS NULL AND evidence_ref IS NULL AND result IS NULL)
    OR (state = 'running' AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL AND retryable IS NULL AND failure_code IS NULL AND evidence_ref IS NULL AND result IS NULL)
    OR (state = 'retry_wait' AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL AND failure_code IS NOT NULL AND evidence_ref IS NULL AND result IS NULL)
    OR (state = 'succeeded' AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND retryable IS NULL AND failure_code IS NULL AND evidence_ref IS NOT NULL AND result IS NOT NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND claim_fence > 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND retryable = FALSE AND failure_code IS NOT NULL AND result IS NULL)
  )
);
CREATE INDEX media_processing_attempts_claim_idx ON media_processing_attempts (state, next_eligible_at, lease_expires_at, attempt_id) WHERE state IN ('pending', 'running', 'retry_wait');

CREATE TABLE media_moderation_projections (
  submission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('none', 'open', 'approved', 'blocked', 'closed')),
  decision_revision BIGINT,
  review_ref TEXT,
  held_revision BIGINT,
  review_exhaustion_code TEXT CHECK (review_exhaustion_code IS NULL OR review_exhaustion_code = 'acr_exhausted'),
  review_exhaustion_attempt_id TEXT,
  action_kind TEXT CHECK (action_kind IS NULL OR action_kind IN ('approve', 'block')),
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  action_evidence_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, actor_user_id, submission_id, operation_id),
  CONSTRAINT media_moderation_projection_exhaustion_shape CHECK ((review_exhaustion_code IS NULL AND review_exhaustion_attempt_id IS NULL) OR (review_exhaustion_code = 'acr_exhausted' AND review_exhaustion_attempt_id IS NOT NULL AND status = 'open' AND held_revision IS NOT NULL))
);

CREATE TABLE media_moderation_actions (
  action_id TEXT PRIMARY KEY CHECK (btrim(action_id) <> ''),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  authority_actor_user_id TEXT NOT NULL REFERENCES users (user_id),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('approve', 'block')),
  approval_kind TEXT CHECK (approval_kind IS NULL OR approval_kind IN ('standard', 'acr_override')),
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped', 'policy_violation')),
  held_revision BIGINT NOT NULL,
  decision_revision BIGINT,
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  decision_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, decision_revision)
    REFERENCES media_publication_decisions (submission_id, decision_revision),
  CONSTRAINT media_moderation_action_shape CHECK (
    (
      action_kind IS NOT NULL AND action_kind = 'approve' AND approval_kind IS NOT NULL
      AND decision_revision IS NOT NULL AND decision_snapshot IS NOT NULL AND jsonb_typeof(decision_snapshot) = 'object'
      AND (
        (approval_kind = 'acr_override' AND reason_code IS NOT NULL AND reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped'))
        OR (approval_kind = 'standard' AND reason_code IS NULL)
      )
    )
    OR (
      action_kind IS NOT NULL AND action_kind = 'block' AND approval_kind IS NULL
      AND reason_code IS NOT NULL AND reason_code = 'policy_violation'
      AND decision_revision IS NULL AND decision_snapshot IS NOT NULL
      AND decision_snapshot = '{"reasonCode":"policy_violation"}'::jsonb
    )
  ),
  UNIQUE (community_id, authority_actor_user_id, action_id)
);

CREATE TABLE media_publication_projections (
  submission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL,
  audio_revision BIGINT NOT NULL,
  analysis_revision BIGINT NOT NULL,
  decision_revision BIGINT NOT NULL,
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  audio_asset_ref TEXT NOT NULL CHECK (btrim(audio_asset_ref) <> ''),
  cover_artifact_ref TEXT,
  language_status TEXT NOT NULL CHECK (language_status IN ('ready', 'no_speech', 'unavailable')),
  primary_language_bcp47 TEXT,
  secondary_language_bcp47 TEXT,
  lyrics_explicitness TEXT NOT NULL CHECK (lyrics_explicitness IN ('not_explicit', 'explicit', 'no_lyrics', 'uncertain', 'unavailable')),
  analysis_badges JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (analysis_badges IN ('[]'::jsonb, '["reference_bound"]'::jsonb)),
  alignment TEXT NOT NULL DEFAULT 'pending' CHECK (alignment IN ('pending', 'ready', 'unavailable')),
  data_registration TEXT NOT NULL DEFAULT 'pending' CHECK (data_registration IN ('pending', 'registered', 'failed')),
  locked_delivery TEXT NOT NULL DEFAULT 'not_required' CHECK (locked_delivery IN ('not_required', 'preparing', 'ready', 'failed')),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  UNIQUE (community_id, actor_user_id, post_id),
  UNIQUE (community_id, actor_user_id, submission_id, operation_id)
);

CREATE TABLE media_timed_lyrics_artifacts (
  artifact_ref TEXT PRIMARY KEY CHECK (btrim(artifact_ref) <> ''),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  artifact_revision BIGINT NOT NULL CHECK (artifact_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact JSONB NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections (community_id, actor_user_id, post_id)
  ,UNIQUE (artifact_ref, artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256)
);

CREATE TABLE media_alignment_projections (
  submission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  alignment_revision BIGINT NOT NULL DEFAULT 0 CHECK (alignment_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable')),
  current_artifact_ref TEXT,
  current_artifact_revision BIGINT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'elevenlabs_key_missing', 'key_invalid', 'rate_limited',
    'provider_unavailable', 'timeout', 'invalid_response',
    'alignment_failed', 'lyrics_missing', 'audio_missing'
  )),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections (community_id, actor_user_id, post_id),
  FOREIGN KEY (current_artifact_ref) REFERENCES media_timed_lyrics_artifacts (artifact_ref),
  FOREIGN KEY (current_artifact_ref, current_artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256)
    REFERENCES media_timed_lyrics_artifacts (artifact_ref, artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256),
  CONSTRAINT media_alignment_artifact_pointer_shape CHECK ((current_artifact_ref IS NULL AND current_artifact_revision IS NULL) OR (current_artifact_ref IS NOT NULL AND current_artifact_revision > 0)),
  UNIQUE (community_id, actor_user_id, post_id)
  ,CONSTRAINT media_alignment_outcome_shape CHECK (
    (status = 'unavailable' AND failure_code IS NOT NULL AND current_artifact_ref IS NULL AND current_artifact_revision IS NULL)
    OR (status IN ('pending', 'ready') AND failure_code IS NULL)
  )
);

CREATE TABLE media_submission_outbox (
  outbox_event_id TEXT PRIMARY KEY CHECK (btrim(outbox_event_id) <> ''),
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  analysis_revision BIGINT NOT NULL CHECK (analysis_revision >= 0),
  workflow_revision BIGINT NOT NULL CHECK (workflow_revision > 0),
  workflow_instance_id TEXT NOT NULL CHECK (workflow_instance_id = 'media-' || operation_id || '-r' || workflow_revision::text),
  event_type TEXT NOT NULL CHECK (event_type IN ('analysis_launch', 'publication', 'alignment')),
  effect_identity TEXT NOT NULL CHECK (btrim(effect_identity) <> ''),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'delivered', 'failed', 'exhausted')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 3),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'provider_unavailable', 'provider_timeout', 'provider_invalid'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, actor_user_id, effect_identity),
  UNIQUE (community_id, actor_user_id, submission_id, workflow_revision, event_type),
  CONSTRAINT media_submission_outbox_state_shape CHECK (
    (state = 'pending' AND claim_owner IS NULL AND claim_fence = 0 AND delivery_attempts = 0 AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND delivered_at IS NULL AND failure_code IS NULL)
    OR (state = 'running' AND claim_owner IS NOT NULL AND claim_fence > 0 AND delivery_attempts BETWEEN 1 AND 3 AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL AND delivered_at IS NULL AND failure_code IS NULL)
    OR (state = 'failed' AND claim_owner IS NULL AND claim_fence > 0 AND delivery_attempts BETWEEN 1 AND 2 AND lease_expires_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL AND next_eligible_at IS NOT NULL)
    OR (state = 'delivered' AND claim_owner IS NULL AND claim_fence > 0 AND delivery_attempts BETWEEN 1 AND 3 AND lease_expires_at IS NULL AND next_eligible_at IS NULL AND delivered_at IS NOT NULL AND failure_code IS NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND claim_fence > 0 AND delivery_attempts = 3 AND lease_expires_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL AND next_eligible_at IS NULL)
  )
);
CREATE INDEX media_submission_outbox_claim_idx ON media_submission_outbox (state, next_eligible_at, lease_expires_at, created_at, outbox_event_id) WHERE state IN ('pending', 'running', 'failed');

CREATE FUNCTION validate_media_transcript_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment JSONB; previous_start NUMERIC := 0; start_value NUMERIC; end_value NUMERIC; start_ms BIGINT; end_ms BIGINT; total_segment_text BIGINT := 0;
BEGIN
  IF char_length(NEW.transcript_text) > 200000 OR encode(sha256(convert_to(NEW.transcript_text, 'UTF8')), 'hex') IS DISTINCT FROM NEW.transcript_sha256 THEN RAISE EXCEPTION 'transcript payload is not bounded or hashed'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.segments) LOOP
    IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(segment) AS key) IS DISTINCT FROM ARRAY['end_ms','start_ms','text']::TEXT[] OR jsonb_typeof(segment->'start_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'end_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'text') IS DISTINCT FROM 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'transcript segment shape is invalid'; END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN RAISE EXCEPTION 'transcript segment text aggregate exceeds 200000 characters'; END IF;
    start_value := (segment->>'start_ms')::numeric; end_value := (segment->>'end_ms')::numeric;
    IF start_value < 0 OR end_value < start_value OR end_value > 86400000 OR start_value <> trunc(start_value) OR end_value <> trunc(end_value) OR start_value < previous_start THEN RAISE EXCEPTION 'transcript segment timing is invalid'; END IF;
    start_ms := start_value::bigint; end_ms := end_value::bigint;
    previous_start := start_ms;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_transcript_artifact_shape_guard BEFORE INSERT ON media_transcript_artifacts FOR EACH ROW EXECUTE FUNCTION validate_media_transcript_artifact();

CREATE FUNCTION validate_media_timed_lyrics_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment JSONB; previous_start NUMERIC := 0; start_value NUMERIC; end_value NUMERIC; start_ms BIGINT; end_ms BIGINT; total_segment_text BIGINT := 0; publication media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO publication FROM media_publication_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
  IF publication.submission_id IS NULL OR publication.post_id IS DISTINCT FROM NEW.post_id OR publication.audio_revision IS DISTINCT FROM NEW.audio_revision OR publication.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR publication.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256 THEN RAISE EXCEPTION 'timed lyrics artifact lineage does not match publication'; END IF;
  IF encode(sha256(convert_to(NEW.artifact::text, 'UTF8')), 'hex') <> NEW.artifact_sha256 THEN RAISE EXCEPTION 'timed lyrics artifact hash does not match payload'; END IF;
  IF jsonb_typeof(NEW.artifact->'segments') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.artifact->'segments') > 10000 THEN RAISE EXCEPTION 'timed lyrics segment bounds are invalid'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.artifact->'segments') LOOP
    IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(segment) AS key) IS DISTINCT FROM ARRAY['end_ms','start_ms','text']::TEXT[] OR jsonb_typeof(segment->'start_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'end_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'text') IS DISTINCT FROM 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'timed lyrics segment shape is invalid'; END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN RAISE EXCEPTION 'timed lyrics segment text aggregate exceeds 200000 characters'; END IF;
    start_value := (segment->>'start_ms')::numeric; end_value := (segment->>'end_ms')::numeric;
    IF start_value < 0 OR end_value < start_value OR end_value > 86400000 OR start_value <> trunc(start_value) OR end_value <> trunc(end_value) OR start_value < previous_start THEN RAISE EXCEPTION 'timed lyrics segment timing is invalid'; END IF;
    start_ms := start_value::bigint; end_ms := end_value::bigint;
    previous_start := start_ms;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_timed_lyrics_artifact_shape_guard BEFORE INSERT ON media_timed_lyrics_artifacts FOR EACH ROW EXECUTE FUNCTION validate_media_timed_lyrics_artifact();

CREATE FUNCTION reject_media_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['media_immutable_objects','media_submission_terms','media_audio_revisions','media_reference_evidence','media_transcript_artifacts','media_analysis_evidence','media_publication_decisions','media_submission_events','media_submission_command_replays','media_timed_lyrics_artifacts','media_moderation_actions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change()', table_name || '_append_only', table_name);
  END LOOP;
END $$;

CREATE FUNCTION validate_media_submission_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE community_active BOOLEAN; membership_active BOOLEAN; reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  SELECT status = 'active' INTO community_active FROM communities WHERE community_id = NEW.community_id FOR SHARE;
  SELECT status = 'member' INTO membership_active FROM community_memberships WHERE community_id = NEW.community_id AND user_id = NEW.actor_user_id FOR SHARE;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.audio_reservation_id FOR UPDATE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE OR reservation_record.reservation_id IS NULL OR reservation_record.state <> 'issued' OR reservation_record.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'media submission requires active community membership and a live reservation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_submission_insert_authority_guard BEFORE INSERT ON media_post_submissions FOR EACH ROW EXECUTE FUNCTION validate_media_submission_authority();

CREATE FUNCTION validate_media_moderation_action_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN; submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT (c.status = 'active' AND m.status = 'member') INTO allowed
    FROM communities c
    JOIN community_memberships m ON m.community_id = c.community_id AND m.user_id = NEW.authority_actor_user_id
    WHERE c.community_id = NEW.community_id
    FOR SHARE;
  IF allowed IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'moderation action requires active community membership'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
      AND submission_id = NEW.submission_id AND operation_id = NEW.operation_id
    FOR UPDATE;
  IF submission_record.submission_id IS NULL OR submission_record.status <> 'manual_review'
     OR submission_record.held_revision IS DISTINCT FROM NEW.held_revision
     OR submission_record.review_ref IS NULL THEN
    RAISE EXCEPTION 'moderation action is not bound to a held review';
  END IF;
  IF NEW.held_revision IS DISTINCT FROM submission_record.held_revision THEN RAISE EXCEPTION 'moderation held revision does not match'; END IF;
  IF NEW.action_kind = 'approve' AND (NEW.decision_revision IS NULL OR NEW.decision_revision <> submission_record.decision_revision + 1 OR NEW.decision_snapshot IS DISTINCT FROM (SELECT decision_snapshot FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision)) THEN
    RAISE EXCEPTION 'moderation approval decision revision is not current';
  END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'inconclusive' AND (NEW.approval_kind IS DISTINCT FROM 'acr_override' OR NEW.reason_code IS DISTINCT FROM CASE WHEN submission_record.review_exhaustion_code = 'acr_exhausted' THEN 'acr_exhausted' ELSE 'acr_inconclusive' END) THEN RAISE EXCEPTION 'inconclusive ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'skipped' AND (NEW.approval_kind IS DISTINCT FROM 'acr_override' OR NEW.reason_code IS DISTINCT FROM 'acr_skipped') THEN RAISE EXCEPTION 'skipped ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'allow' AND (NEW.approval_kind IS DISTINCT FROM 'standard' OR NEW.reason_code IS NOT NULL) THEN RAISE EXCEPTION 'allow ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND NEW.reason_code = 'acr_exhausted' AND submission_record.review_exhaustion_code IS DISTINCT FROM 'acr_exhausted' THEN
    RAISE EXCEPTION 'ACR exhaustion override lacks its private exhaustion hold';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_moderation_action_authority_guard BEFORE INSERT ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION validate_media_moderation_action_insert();
CREATE TRIGGER media_moderation_action_append_only BEFORE UPDATE OR DELETE ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE FUNCTION guard_media_moderation_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id) THEN RAISE EXCEPTION 'moderation projection identity is immutable'; END IF;
  IF NEW.status = 'none' THEN RAISE EXCEPTION 'moderation projection cannot return to none'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL THEN RAISE EXCEPTION 'moderation projection submission is missing'; END IF;
  IF NEW.status = 'open' AND (OLD.status IS DISTINCT FROM 'none' OR submission_record.status <> 'manual_review' OR NEW.review_ref IS DISTINCT FROM submission_record.review_ref OR NEW.held_revision IS DISTINCT FROM submission_record.held_revision OR NEW.review_exhaustion_code IS DISTINCT FROM submission_record.review_exhaustion_code OR NEW.review_exhaustion_attempt_id IS DISTINCT FROM submission_record.review_exhaustion_attempt_id OR NEW.action_kind IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.action_evidence_ref IS NOT NULL) THEN RAISE EXCEPTION 'open moderation projection does not match its held submission'; END IF;
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status <> 'processing' OR submission_record.phase <> 'publish' OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.review_ref IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS DISTINCT FROM submission_record.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM submission_record.moderator_actor_id OR NEW.action_evidence_ref IS DISTINCT FROM submission_record.moderator_evidence_ref OR NEW.action_kind IS DISTINCT FROM 'approve') THEN RAISE EXCEPTION 'approved moderation projection does not match its submission action'; END IF;
  IF NEW.status = 'blocked' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status <> 'blocked' OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.review_ref IS DISTINCT FROM OLD.review_ref OR NEW.held_revision IS DISTINCT FROM OLD.held_revision OR NEW.review_ref IS NULL OR NEW.held_revision IS NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS DISTINCT FROM submission_record.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM submission_record.moderator_actor_id OR NEW.action_evidence_ref IS DISTINCT FROM submission_record.moderator_evidence_ref OR NEW.action_kind IS DISTINCT FROM 'block') THEN RAISE EXCEPTION 'blocked moderation projection does not match its submission action'; END IF;
  IF NEW.status = 'closed' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status NOT IN ('processing','action_required','manual_review') OR NEW.decision_revision IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.action_evidence_ref IS NOT NULL) THEN RAISE EXCEPTION 'closed moderation projection is not an exact supersession'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_moderation_projection_update_guard BEFORE UPDATE ON media_moderation_projections FOR EACH ROW EXECUTE FUNCTION guard_media_moderation_projection_update();

CREATE FUNCTION validate_media_moderation_projection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL
     OR NEW.status IS DISTINCT FROM 'none'
     OR NEW.decision_revision IS NOT NULL
     OR NEW.review_ref IS NOT NULL
     OR NEW.held_revision IS NOT NULL
     OR NEW.review_exhaustion_code IS NOT NULL
     OR NEW.review_exhaustion_attempt_id IS NOT NULL
     OR NEW.action_kind IS NOT NULL
     OR NEW.moderator_action_id IS NOT NULL
     OR NEW.moderator_actor_id IS NOT NULL
     OR NEW.action_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION 'initial moderation projection is not empty';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_moderation_projection_insert_guard BEFORE INSERT ON media_moderation_projections FOR EACH ROW EXECUTE FUNCTION validate_media_moderation_projection_insert();

CREATE FUNCTION guard_media_reservation_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF ROW(NEW.reservation_id, NEW.community_id, NEW.actor_user_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.expected_content_type, NEW.expected_size_bytes, NEW.expected_sha256, NEW.upload_url, NEW.upload_headers, NEW.expires_at, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.reservation_id, OLD.community_id, OLD.actor_user_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.expected_content_type, OLD.expected_size_bytes, OLD.expected_sha256, OLD.upload_url, OLD.upload_headers, OLD.expires_at, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media reservation authority is immutable'; END IF;
  IF OLD.state IN ('sealed', 'rejected', 'expired') OR NOT ((OLD.state = 'issued' AND NEW.state = 'claimed') OR (OLD.state = 'issued' AND NEW.state = 'expired' AND OLD.expires_at <= clock_timestamp()) OR (OLD.state = 'claimed' AND NEW.state IN ('sealed', 'rejected')) OR (OLD.state = 'claimed' AND NEW.state = 'expired' AND OLD.expires_at <= clock_timestamp())) OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media reservation transition is not allowed'; END IF;
  IF OLD.state = 'issued' AND NEW.state = 'claimed' AND (NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.terminal_reason IS NOT NULL OR NEW.terminal_evidence_ref IS NOT NULL OR NEW.terminal_evidence_digest IS NOT NULL OR NEW.terminal_at IS NOT NULL OR NEW.terminal_fence IS NOT NULL) THEN RAISE EXCEPTION 'media reservation claim fence is not exact'; END IF;
  IF OLD.state = 'claimed' AND (NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id) THEN RAISE EXCEPTION 'media reservation claim identity is immutable'; END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'rejected' THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence
       OR NEW.terminal_fence IS DISTINCT FROM submission_record.event_sequence
       OR NEW.terminal_at IS NULL
       OR NEW.terminal_evidence_ref IS NULL
       OR NEW.terminal_evidence_digest IS DISTINCT FROM encode(sha256(NEW.terminal_evidence_ref::bytea), 'hex')
       OR (submission_record.status = 'abandoned' AND NEW.terminal_reason IS DISTINCT FROM CASE submission_record.abandonment_reason WHEN 'upload_expectation_mismatch' THEN 'expectation_mismatch' WHEN 'upload_source_changed_before_finalize' THEN 'source_precondition_failed' ELSE NULL END)
       OR (submission_record.status = 'processing_failed' AND (NEW.terminal_reason IS DISTINCT FROM 'destination_conflict' OR submission_record.failure_code IS DISTINCT FROM 'upload_seal_conflict'))
       OR submission_record.status NOT IN ('abandoned', 'processing_failed')
       THEN
      RAISE EXCEPTION 'media reservation rejection is not bound to its terminal submission';
    END IF;
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'expired' THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR submission_record.status IS DISTINCT FROM 'abandoned'
       OR submission_record.abandonment_reason IS DISTINCT FROM 'reservation_expired'
       OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence
       OR NEW.submission_id IS NULL OR NEW.operation_id IS NULL
       OR NEW.terminal_reason IS NOT NULL OR NEW.terminal_evidence_ref IS NOT NULL
       OR NEW.terminal_evidence_digest IS NOT NULL OR NEW.terminal_at IS NOT NULL
       OR NEW.terminal_fence IS NOT NULL
       OR NEW.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'media reservation expiry is not bound to its terminal submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_reservation_update_guard BEFORE UPDATE ON media_upload_reservations FOR EACH ROW EXECUTE FUNCTION guard_media_reservation_update();

CREATE FUNCTION validate_media_immutable_object_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.reservation_id FOR UPDATE;
  IF reservation_record.reservation_id IS NULL OR reservation_record.submission_id <> NEW.submission_id OR reservation_record.operation_id <> NEW.operation_id OR reservation_record.state <> 'claimed' OR reservation_record.expires_at <= clock_timestamp() OR reservation_record.expected_content_type <> NEW.content_type OR reservation_record.expected_size_bytes <> NEW.size_bytes OR (reservation_record.expected_sha256 IS NOT NULL AND reservation_record.expected_sha256 <> NEW.canonical_sha256) THEN RAISE EXCEPTION 'sealed media facts do not match reservation expectations'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_immutable_object_insert_guard BEFORE INSERT ON media_immutable_objects FOR EACH ROW EXECUTE FUNCTION validate_media_immutable_object_insert();

CREATE FUNCTION guard_media_submission_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN := FALSE; community_active BOOLEAN; membership_active BOOLEAN; analysis_record media_analysis_evidence%ROWTYPE; decision_record media_publication_decisions%ROWTYPE; post_record posts%ROWTYPE; audio_record media_audio_revisions%ROWTYPE; terms_record media_submission_terms%ROWTYPE; moderation_action media_moderation_actions%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.title, NEW.song_type, NEW.start_input, NEW.audio_reservation_id, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.title, OLD.song_type, OLD.start_input, OLD.audio_reservation_id, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media submission authority is immutable'; END IF;
  IF NEW.event_sequence <> OLD.event_sequence + 1 OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media submission transition fence did not advance'; END IF;
  SELECT status = 'active' INTO community_active FROM communities WHERE community_id = NEW.community_id FOR SHARE;
  SELECT status = 'member' INTO membership_active FROM community_memberships WHERE community_id = NEW.community_id AND user_id = NEW.actor_user_id FOR SHARE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'media submission requires active community membership'; END IF;
  allowed :=
    (OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload'
      AND NEW.creation_revision = 1 AND NEW.audio_revision = 0 AND NEW.analysis_revision = 0 AND NEW.decision_revision = 0
      AND NEW.workflow_revision = 0 AND NEW.current_terms_revision IS NULL AND NEW.current_immutable_ref IS NULL
      AND NEW.current_analysis_revision IS NULL AND NEW.current_decision_revision IS NULL AND NEW.post_id IS NULL)
    OR ((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL))
      AND NEW.status = 'processing' AND NEW.phase = CASE WHEN OLD.audio_revision = 0 THEN 'awaiting_upload' ELSE 'analysis' END
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.current_terms_revision = NEW.creation_revision
      AND NEW.workflow_revision = OLD.workflow_revision AND NEW.post_id IS NULL
    OR (OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND OLD.audio_revision = 0 AND NEW.status = 'processing' AND NEW.phase = 'analysis'
      AND NEW.audio_revision = 1 AND NEW.analysis_revision = OLD.analysis_revision AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.creation_revision = OLD.creation_revision)
    OR (OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'processing' AND NEW.phase IN ('analysis', 'decision')
      AND NEW.analysis_revision = OLD.analysis_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'processing' AND NEW.phase = 'publish'
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('analysis', 'decision') AND NEW.status = 'manual_review' AND NEW.phase IS NULL
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'blocked' AND NEW.phase IS NULL
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.phase IS NULL
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision
      AND NEW.analysis_revision = OLD.analysis_revision AND NEW.review_ref IS NOT NULL AND NEW.review_exhaustion_code = 'acr_exhausted' AND NEW.review_exhaustion_attempt_id IS NOT NULL
      AND NEW.held_revision = OLD.creation_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' AND NEW.phase IS NULL
      AND NEW.action_kind = 'reference_required' AND NEW.action_expires_at > clock_timestamp() AND NEW.held_revision = OLD.creation_revision
      AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.post_id IS NULL)
    OR (OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.phase = 'analysis'
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision AND NEW.bound_reference_asset_id IS NOT NULL AND NEW.post_id IS NULL)
    OR (OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.phase = 'publish'
      AND NEW.creation_revision = OLD.creation_revision AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status = 'blocked' AND NEW.phase IS NULL
      AND NEW.creation_revision = OLD.creation_revision AND NEW.decision_revision = OLD.decision_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' AND NEW.phase IS NULL
      AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.post_id IS NOT NULL AND NEW.decision_revision = OLD.decision_revision AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision)
    OR (OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish') AND NEW.status = 'processing_failed' AND NEW.phase IS NULL
      AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision
      AND NEW.failure_code IS NOT NULL AND NEW.failure_retry_count IS NOT NULL AND NEW.last_safe_phase IS NOT NULL
      AND (NEW.failure_code IS DISTINCT FROM 'upload_seal_conflict' OR OLD.phase = 'finalize'))
    OR (OLD.status = 'processing_failed' AND OLD.phase IS NULL AND OLD.retryable = TRUE AND OLD.failure_retry_count < 3 AND OLD.retry_count < 3 AND NEW.status = 'processing' AND NEW.phase = OLD.last_safe_phase
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.retry_count = OLD.retry_count + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision)
    OR (OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'abandoned' AND NEW.phase IS NULL AND OLD.action_kind = 'reference_required'
      AND OLD.action_expires_at <= clock_timestamp() AND NEW.abandonment_reason = 'action_deadline_elapsed' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload') AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'author_cancelled' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'reservation_expired' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize') AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'upload_expectation_mismatch' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'finalize' AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'upload_source_changed_before_finalize' AND NEW.post_id IS NULL);
  IF allowed IS NOT TRUE THEN RAISE EXCEPTION 'media submission transition is not allowed'; END IF;
  IF OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload' THEN
    IF NEW.creation_revision IS DISTINCT FROM OLD.creation_revision OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision OR NEW.decision_revision IS DISTINCT FROM OLD.decision_revision OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_decision_revision IS DISTINCT FROM OLD.current_decision_revision OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.retry_count IS DISTINCT FROM OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.action_kind IS DISTINCT FROM OLD.action_kind OR NEW.action_reference_request_ref IS DISTINCT FROM OLD.action_reference_request_ref OR NEW.action_expires_at IS DISTINCT FROM OLD.action_expires_at OR NEW.held_revision IS DISTINCT FROM OLD.held_revision OR NEW.review_ref IS DISTINCT FROM OLD.review_ref OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code OR NEW.review_exhaustion_code IS DISTINCT FROM OLD.review_exhaustion_code OR NEW.review_exhaustion_attempt_id IS DISTINCT FROM OLD.review_exhaustion_attempt_id OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref OR NEW.moderator_approval_kind IS DISTINCT FROM OLD.moderator_approval_kind OR NEW.moderator_reason_code IS DISTINCT FROM OLD.moderator_reason_code OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'reservation issued transition evidence is not exact'; END IF;
  ELSIF (((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL)) AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.current_terms_revision = NEW.creation_revision) THEN
    SELECT * INTO terms_record FROM media_submission_terms WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND creation_revision=NEW.creation_revision FOR SHARE;
    IF terms_record.submission_id IS NULL OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL OR terms_record.license_preset IS NULL OR terms_record.access_mode <> 'public' THEN RAISE EXCEPTION 'terms transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND NEW.status = 'processing' AND NEW.audio_revision = OLD.audio_revision + 1 THEN
    SELECT * INTO audio_record FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision FOR SHARE;
    IF audio_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> OLD.decision_revision OR NEW.current_decision_revision IS DISTINCT FROM OLD.current_decision_revision OR NEW.workflow_revision <> OLD.workflow_revision + 1 OR NEW.current_immutable_ref IS DISTINCT FROM audio_record.immutable_ref OR NEW.phase <> 'analysis' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'audio transition evidence is not exact'; END IF;
    IF NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision + 1 OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'audio transition pointers are not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'processing' AND NEW.analysis_revision = OLD.analysis_revision + 1 THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.current_analysis_revision <> NEW.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.phase NOT IN ('analysis','decision') OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL OR analysis_record.audio_revision <> NEW.audio_revision OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) THEN RAISE EXCEPTION 'analysis transition evidence is not exact'; END IF;
    IF NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'analysis transition pointers are not exact'; END IF;
  ELSIF OLD.status = 'processing' AND (OLD.phase = 'decision' OR (OLD.phase = 'analysis' AND NEW.status = 'manual_review')) AND NEW.decision_revision = OLD.decision_revision + 1 THEN
    SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision FOR SHARE;
    IF decision_record.submission_id IS NULL
       OR NEW.creation_revision <> OLD.creation_revision
       OR NEW.audio_revision <> OLD.audio_revision
       OR NEW.analysis_revision <> OLD.analysis_revision
       OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps)
       OR NEW.workflow_revision <> OLD.workflow_revision
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count
       OR NEW.retryable IS DISTINCT FROM OLD.retryable
       OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase
       OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason
       OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition
       OR NEW.current_decision_revision <> NEW.decision_revision
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR decision_record.creation_revision <> NEW.creation_revision
       OR decision_record.audio_revision <> NEW.audio_revision
       OR decision_record.analysis_revision <> NEW.analysis_revision
       OR decision_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision)
       OR (decision_record.outcome = 'allow' AND (NEW.status <> 'processing' OR NEW.phase <> 'publish' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL))
       OR (decision_record.outcome = 'manual_review' AND (NEW.status <> 'manual_review' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NULL OR NEW.review_reason_code <> 'review_required' OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision <> NEW.creation_revision OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL))
       OR (decision_record.outcome = 'block' AND (NEW.status <> 'blocked' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL)) THEN RAISE EXCEPTION 'decision transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.decision_revision = 0 AND NEW.review_exhaustion_code = 'acr_exhausted' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR NOT EXISTS (SELECT 1 FROM media_submission_terms t WHERE t.community_id=NEW.community_id AND t.actor_user_id=NEW.actor_user_id AND t.submission_id=NEW.submission_id AND t.operation_id=NEW.operation_id AND t.creation_revision=NEW.creation_revision) OR analysis_record.acr_decision <> 'inconclusive' OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_decision_revision IS NOT NULL OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.review_exhaustion_attempt_id IS NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NOT EXISTS (SELECT 1 FROM media_processing_attempts a WHERE a.attempt_id=NEW.review_exhaustion_attempt_id AND a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.stage='acr' AND a.input_kind='audio' AND a.audio_revision=NEW.audio_revision AND a.analysis_revision=NEW.analysis_revision AND a.input_revision=NEW.audio_revision AND a.input_hash=(SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) AND a.state='exhausted' AND a.retryable=FALSE AND a.failure_code IS NOT NULL AND a.attempt_number=3 AND NOT EXISTS (SELECT 1 FROM media_processing_attempts later WHERE later.community_id=a.community_id AND later.actor_user_id=a.actor_user_id AND later.submission_id=a.submission_id AND later.operation_id=a.operation_id AND later.stage='acr' AND later.attempt_number>a.attempt_number)) THEN RAISE EXCEPTION 'ACR exhaustion evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR analysis_record.operation_id IS DISTINCT FROM NEW.operation_id OR analysis_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR analysis_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) OR analysis_record.finalized_audio_ref IS DISTINCT FROM NEW.current_immutable_ref OR analysis_record.acr_decision IS DISTINCT FROM 'requires_reference' OR analysis_record.acr_evidence_ref IS NULL OR analysis_record.acr_policy_revision IS NULL OR analysis_record.acr_adapter_revision IS NULL THEN RAISE EXCEPTION 'reference action analysis evidence is not exact'; END IF;
    IF NEW.phase IS NOT NULL OR NEW.action_kind IS DISTINCT FROM 'reference_required' OR NEW.action_expires_at <= clock_timestamp() OR NEW.held_revision <> OLD.creation_revision OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'reference action evidence is not exact'; END IF;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'reference action pointers are not exact'; END IF;
  ELSIF OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.bound_reference_asset_id IS NOT NULL THEN
    IF NEW.creation_revision <> OLD.creation_revision + 1 OR OLD.action_expires_at <= clock_timestamp() OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase <> 'analysis' OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.bound_reference_audio_revision <> NEW.audio_revision OR NEW.bound_reference_analysis_revision > NEW.analysis_revision THEN RAISE EXCEPTION 'bound reference transition evidence is not exact'; END IF;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'bound reference pointers are not exact'; END IF;
  ELSIF OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status IN ('processing','blocked') THEN
    SELECT * INTO moderation_action FROM media_moderation_actions WHERE action_id=NEW.moderator_action_id AND community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps)
       OR NEW.workflow_revision <> OLD.workflow_revision
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count
       OR NEW.retryable IS DISTINCT FROM OLD.retryable
       OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase
       OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason
       OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition
       OR moderation_action.action_id IS NULL
       OR moderation_action.authority_actor_user_id IS DISTINCT FROM NEW.moderator_actor_id
       OR moderation_action.held_revision IS DISTINCT FROM OLD.held_revision
       OR moderation_action.evidence_ref IS DISTINCT FROM NEW.moderator_evidence_ref
       OR (moderation_action.action_kind = 'approve' AND (NEW.status <> 'processing' OR NEW.phase <> 'publish' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR moderation_action.decision_revision IS DISTINCT FROM NEW.decision_revision OR moderation_action.approval_kind IS DISTINCT FROM NEW.moderator_approval_kind OR moderation_action.reason_code IS DISTINCT FROM NEW.moderator_reason_code OR moderation_action.decision_snapshot IS DISTINCT FROM (SELECT decision_snapshot FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision)))
       OR (moderation_action.action_kind = 'block' AND (NEW.status <> 'blocked' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS DISTINCT FROM 'policy_violation' OR moderation_action.decision_revision IS NOT NULL OR moderation_action.approval_kind IS NOT NULL OR moderation_action.reason_code IS DISTINCT FROM 'policy_violation' OR NEW.decision_revision <> OLD.decision_revision)) THEN RAISE EXCEPTION 'moderation action evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' THEN
    IF NEW.creation_revision <> OLD.creation_revision
       OR NEW.audio_revision <> OLD.audio_revision
       OR NEW.analysis_revision <> OLD.analysis_revision
       OR NEW.decision_revision <> OLD.decision_revision
       OR NEW.current_decision_revision IS DISTINCT FROM NEW.decision_revision
       OR NEW.workflow_revision <> OLD.workflow_revision + 1
       OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps)
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.failure_code IS NOT NULL
       OR NEW.failure_retry_count IS NOT NULL
       OR NEW.retryable IS NOT NULL
       OR NEW.last_safe_phase IS NOT NULL
       OR NEW.action_kind IS NOT NULL
       OR NEW.action_reference_request_ref IS NOT NULL
       OR NEW.action_expires_at IS NOT NULL
       OR NEW.review_ref IS NOT NULL
       OR NEW.review_reason_code IS NOT NULL
       OR NEW.review_exhaustion_code IS NOT NULL
       OR NEW.review_exhaustion_attempt_id IS NOT NULL
       OR NEW.held_revision IS NOT NULL
       OR NEW.abandonment_reason IS NOT NULL
       OR NEW.retention_disposition IS NOT NULL
       OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id
       OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id
       OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref
       OR NEW.moderator_approval_kind IS DISTINCT FROM OLD.moderator_approval_kind
       OR NEW.moderator_reason_code IS DISTINCT FROM OLD.moderator_reason_code
       OR NEW.post_id IS NULL THEN
      RAISE EXCEPTION 'publication transition evidence is not exact';
    END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish') AND NEW.status = 'processing_failed' THEN
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.retry_count <> OLD.retry_count OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref THEN RAISE EXCEPTION 'media failure pointers are not exact'; END IF;
    IF NEW.phase IS NOT NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.failure_code IS NULL OR NEW.failure_retry_count IS NULL OR NEW.last_safe_phase IS NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.abandonment_reason IS NOT NULL OR NEW.retention_disposition IS NOT NULL THEN RAISE EXCEPTION 'media failure evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing_failed' AND NEW.status = 'processing' THEN
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'retry transition pointers are not exact'; END IF;
    IF OLD.retryable IS DISTINCT FROM TRUE OR OLD.failure_retry_count IS NULL OR OLD.failure_retry_count >= 3 OR OLD.retry_count >= 3 OR NEW.creation_revision <> OLD.creation_revision + 1 OR NEW.retry_count <> OLD.retry_count + 1 OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'retry transition evidence is not exact'; END IF;
  END IF;
  IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_ref = NEW.bound_reference_evidence_ref AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'bound reference evidence is missing'; END IF;
  IF (NEW.status = 'processing' AND NEW.phase = 'publish') OR NEW.status = 'published' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision = NEW.analysis_revision FOR SHARE;
    SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision = NEW.decision_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR decision_record.submission_id IS NULL OR decision_record.outcome <> 'allow' OR decision_record.creation_revision <> NEW.creation_revision OR decision_record.audio_revision <> NEW.audio_revision OR decision_record.analysis_revision <> NEW.analysis_revision OR decision_record.canonical_audio_sha256 <> analysis_record.canonical_audio_sha256 OR analysis_record.media_safety <> 'allow' OR analysis_record.lyrics_safety NOT IN ('skipped', 'allow') OR analysis_record.speech_status = 'unavailable' OR analysis_record.explicitness NOT IN ('not_explicit', 'no_lyrics') OR (analysis_record.acr_decision = 'inconclusive' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.community_id=NEW.community_id AND m.actor_user_id=NEW.actor_user_id AND m.submission_id=NEW.submission_id AND m.operation_id=NEW.operation_id AND m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code IN ('acr_inconclusive','acr_exhausted'))) OR (analysis_record.acr_decision = 'skipped' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.community_id=NEW.community_id AND m.actor_user_id=NEW.actor_user_id AND m.submission_id=NEW.submission_id AND m.operation_id=NEW.operation_id AND m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code='acr_skipped')) OR (analysis_record.acr_decision = 'requires_reference' AND NEW.bound_reference_asset_id IS NULL) OR NOT EXISTS (SELECT 1 FROM media_submission_terms WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND creation_revision = NEW.creation_revision) THEN RAISE EXCEPTION 'media publication evidence is not ratified'; END IF;
  END IF;
  IF NEW.status = 'published' THEN
    SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
    IF post_record.post_id IS NULL OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title <> NEW.title THEN RAISE EXCEPTION 'media publication Post is not owned by submission'; END IF;
  END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' AND NOT EXISTS (SELECT 1 FROM media_upload_reservations r WHERE r.community_id=NEW.community_id AND r.actor_user_id=NEW.actor_user_id AND r.reservation_id=NEW.audio_reservation_id AND r.expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'reservation is not expired'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('author_cancelled', 'reservation_expired') AND NEW.retention_disposition IS DISTINCT FROM 'no_object' THEN RAISE EXCEPTION 'pre-finalize abandonment retention is not exact'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('upload_expectation_mismatch', 'upload_source_changed_before_finalize') AND NEW.retention_disposition IS DISTINCT FROM 'retain_for_reconciliation' THEN RAISE EXCEPTION 'upload precondition abandonment retention is not exact'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'action_deadline_elapsed' AND NEW.retention_disposition IS DISTINCT FROM (CASE WHEN NEW.audio_revision > 0 THEN 'retain_until_expiry' ELSE 'no_object' END) THEN RAISE EXCEPTION 'action deadline retention is not exact'; END IF;
  IF NEW.status = 'abandoned' THEN
    IF NEW.phase IS NOT NULL OR NEW.post_id IS NOT NULL OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'abandoned cleanup is not exact'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_submission_update_guard BEFORE UPDATE ON media_post_submissions FOR EACH ROW EXECUTE FUNCTION guard_media_submission_update();

CREATE FUNCTION validate_media_reference_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bound_reference_asset_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM media_reference_evidence r
       WHERE r.community_id=NEW.community_id
         AND r.actor_user_id=NEW.actor_user_id
         AND r.submission_id=NEW.submission_id
         AND r.operation_id=NEW.operation_id
         AND r.asset_id=NEW.bound_reference_asset_id
         AND r.evidence_ref=NEW.bound_reference_evidence_ref
         AND r.evidence_audio_revision=NEW.bound_reference_audio_revision
         AND r.evidence_analysis_revision=NEW.bound_reference_analysis_revision
         AND r.evidence_audio_sha256=NEW.bound_reference_audio_sha256
         AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps
     ) THEN
    RAISE EXCEPTION 'current reference binding lacks its immutable evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_reference_binding_pair AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_reference_binding();

CREATE FUNCTION validate_media_submission_event_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_event TEXT; event_record media_submission_events%ROWTYPE; reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  IF OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload' THEN expected_event := 'media_reservation_issued';
  ELSIF (((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL)) AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.current_terms_revision = NEW.creation_revision) THEN expected_event := 'song_terms_bound';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND NEW.audio_revision = OLD.audio_revision + 1 THEN expected_event := 'upload_finalized';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.analysis_revision = OLD.analysis_revision + 1 THEN expected_event := 'blocking_analysis_completed';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.decision_revision = OLD.decision_revision + 1 THEN expected_event := CASE NEW.status WHEN 'processing' THEN 'publication_allowed' WHEN 'manual_review' THEN 'review_required' WHEN 'blocked' THEN 'policy_blocked' ELSE NULL END;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.decision_revision = OLD.decision_revision + 1 THEN expected_event := 'review_required';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.review_exhaustion_code = 'acr_exhausted' THEN expected_event := 'review_exhaustion_recorded';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' THEN expected_event := 'reference_required';
  ELSIF OLD.status = 'action_required' AND NEW.status = 'processing' AND NEW.bound_reference_asset_id IS NOT NULL THEN expected_event := 'reference_bound';
  ELSIF OLD.status = 'manual_review' AND NEW.status = 'processing' THEN expected_event := 'moderator_approved';
  ELSIF OLD.status = 'manual_review' AND NEW.status = 'blocked' THEN expected_event := 'moderator_blocked';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' THEN expected_event := 'publication_committed';
  ELSIF OLD.status = 'processing_failed' AND NEW.status = 'processing' THEN expected_event := 'retry_authorized';
  ELSIF OLD.status = 'action_required' AND NEW.status = 'abandoned' THEN expected_event := 'action_deadline_elapsed';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'author_cancelled' THEN expected_event := 'author_cancelled';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' THEN expected_event := 'reservation_expired';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'upload_expectation_mismatch' THEN expected_event := 'upload_expectation_mismatch_recorded';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'upload_source_changed_before_finalize' THEN expected_event := 'upload_source_precondition_failed';
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing_failed' THEN expected_event := 'failure';
  ELSE RAISE EXCEPTION 'media submission event transition is not recognized';
  END IF;
  SELECT * INTO event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=NEW.event_sequence;
  IF event_record.submission_id IS NULL THEN RAISE EXCEPTION 'media submission transition requires its exact event'; END IF;
  IF event_record.community_id IS DISTINCT FROM NEW.community_id OR event_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR event_record.operation_id IS DISTINCT FROM NEW.operation_id OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision THEN RAISE EXCEPTION 'media submission event lineage does not match'; END IF;
  IF expected_event <> 'failure' AND event_record.event_kind IS DISTINCT FROM expected_event THEN RAISE EXCEPTION 'media submission transition requires its exact event'; END IF;
  IF event_record.evidence->>'event_kind' IS DISTINCT FROM event_record.event_kind OR (event_record.event_kind = 'review_exhaustion_recorded' AND event_record.evidence->>'exhaustion_attempt_id' IS DISTINCT FROM NEW.review_exhaustion_attempt_id) THEN RAISE EXCEPTION 'media submission event evidence does not match'; END IF;
  IF event_record.event_kind = 'moderator_blocked' AND event_record.evidence->>'reason_code' IS DISTINCT FROM 'policy_violation' THEN RAISE EXCEPTION 'moderator block event evidence is not exact'; END IF;
  IF expected_event = 'failure' AND event_record.event_kind NOT IN ('media_failure_recorded','technical_exhaustion_recorded','seal_conflict_recorded') THEN RAISE EXCEPTION 'media failure transition event is not exact'; END IF;
  IF NEW.failure_code IS NOT DISTINCT FROM 'upload_seal_conflict' AND (OLD.phase IS DISTINCT FROM 'finalize' OR event_record.event_kind IS DISTINCT FROM 'seal_conflict_recorded') THEN RAISE EXCEPTION 'seal conflict event evidence is not exact'; END IF;
  IF event_record.event_kind = 'seal_conflict_recorded' AND (OLD.phase IS DISTINCT FROM 'finalize' OR NEW.failure_code IS DISTINCT FROM 'upload_seal_conflict' OR NEW.retryable IS DISTINCT FROM FALSE) THEN RAISE EXCEPTION 'seal conflict event evidence is not exact'; END IF;
  IF (NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('upload_expectation_mismatch', 'upload_source_changed_before_finalize')) OR (NEW.status = 'processing_failed' AND NEW.failure_code = 'upload_seal_conflict') THEN
    SELECT * INTO reservation_record FROM media_upload_reservations
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND reservation_id=NEW.audio_reservation_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF reservation_record.reservation_id IS NULL
       OR reservation_record.state IS DISTINCT FROM 'rejected'
       OR reservation_record.terminal_fence IS DISTINCT FROM NEW.event_sequence
       OR reservation_record.terminal_at IS NULL
       OR reservation_record.terminal_evidence_ref IS NULL
       OR reservation_record.terminal_evidence_digest IS DISTINCT FROM encode(sha256(reservation_record.terminal_evidence_ref::bytea), 'hex')
       OR reservation_record.terminal_reason IS DISTINCT FROM (CASE
         WHEN NEW.abandonment_reason = 'upload_expectation_mismatch' THEN 'expectation_mismatch'
         WHEN NEW.abandonment_reason = 'upload_source_changed_before_finalize' THEN 'source_precondition_failed'
         ELSE 'destination_conflict'
       END) THEN
      RAISE EXCEPTION 'terminal upload reservation is not paired with its submission failure';
    END IF;
  END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' THEN
    SELECT * INTO reservation_record FROM media_upload_reservations
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND reservation_id=NEW.audio_reservation_id FOR SHARE;
    IF reservation_record.reservation_id IS NULL
       OR reservation_record.state IS DISTINCT FROM 'expired'
       OR reservation_record.submission_id IS DISTINCT FROM NEW.submission_id
       OR reservation_record.operation_id IS DISTINCT FROM NEW.operation_id
       OR reservation_record.claim_fence <= 0
       OR reservation_record.terminal_reason IS NOT NULL
       OR reservation_record.terminal_evidence_ref IS NOT NULL
       OR reservation_record.terminal_evidence_digest IS NOT NULL
       OR reservation_record.terminal_at IS NOT NULL
       OR reservation_record.terminal_fence IS NOT NULL THEN
      RAISE EXCEPTION 'expired upload reservation is not paired with its submission abandonment';
    END IF;
  END IF;
  IF expected_event = 'publication_committed' AND (
    NOT EXISTS (SELECT 1 FROM posts p WHERE p.community_id=NEW.community_id AND p.post_id=NEW.post_id AND p.author_user_id=NEW.actor_user_id AND p.post_type='song' AND p.status='published' AND p.visibility='public' AND p.title=NEW.title)
    OR NOT EXISTS (SELECT 1 FROM media_publication_projections p WHERE p.community_id=NEW.community_id AND p.actor_user_id=NEW.actor_user_id AND p.submission_id=NEW.submission_id AND p.operation_id=NEW.operation_id AND p.post_id=NEW.post_id AND p.creation_revision=NEW.creation_revision AND p.audio_revision=NEW.audio_revision AND p.analysis_revision=NEW.analysis_revision AND p.decision_revision=NEW.decision_revision AND p.canonical_audio_sha256=(SELECT canonical_sha256 FROM media_audio_revisions a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.audio_revision=NEW.audio_revision) AND p.alignment='pending')
    OR NOT EXISTS (SELECT 1 FROM media_alignment_projections a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.post_id=NEW.post_id AND a.audio_revision=NEW.audio_revision AND a.analysis_revision=NEW.analysis_revision AND a.canonical_audio_sha256=(SELECT canonical_sha256 FROM media_audio_revisions ar WHERE ar.community_id=NEW.community_id AND ar.actor_user_id=NEW.actor_user_id AND ar.submission_id=NEW.submission_id AND ar.operation_id=NEW.operation_id AND ar.audio_revision=NEW.audio_revision) AND a.status='pending' AND a.alignment_revision=0)
    OR NOT EXISTS (SELECT 1 FROM media_submission_outbox o WHERE o.community_id=NEW.community_id AND o.actor_user_id=NEW.actor_user_id AND o.submission_id=NEW.submission_id AND o.operation_id=NEW.operation_id AND o.event_type='publication' AND o.creation_revision=NEW.creation_revision AND o.audio_revision=NEW.audio_revision AND o.analysis_revision=NEW.analysis_revision AND o.workflow_revision=NEW.workflow_revision AND o.workflow_instance_id='media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text)
  ) THEN RAISE EXCEPTION 'publication commit is missing its owned projection, alignment, or outbox'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_submission_event_pair AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_submission_event_pair();

CREATE FUNCTION validate_media_submission_initial_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record media_submission_events%ROWTYPE; issued_event_record media_submission_events%ROWTYPE; reservation_record media_upload_reservations%ROWTYPE; moderation_record media_moderation_projections%ROWTYPE;
BEGIN
  SELECT * INTO event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=1;
  SELECT * INTO issued_event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=2;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND reservation_id=NEW.audio_reservation_id;
  SELECT * INTO moderation_record FROM media_moderation_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id;
  IF event_record.submission_id IS NULL OR event_record.event_kind IS DISTINCT FROM 'submission_reserved' OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'submission_reserved'
     OR issued_event_record.submission_id IS NULL OR issued_event_record.event_kind IS DISTINCT FROM 'media_reservation_issued' OR issued_event_record.creation_revision IS DISTINCT FROM 1 OR issued_event_record.audio_revision IS DISTINCT FROM 0 OR issued_event_record.analysis_revision IS DISTINCT FROM 0 OR issued_event_record.decision_revision IS DISTINCT FROM 0 OR issued_event_record.workflow_revision IS DISTINCT FROM 0 OR issued_event_record.evidence->>'event_kind' IS DISTINCT FROM 'media_reservation_issued'
     OR NEW.status IS DISTINCT FROM 'processing' OR NEW.phase IS DISTINCT FROM 'reserve'
     OR NEW.creation_revision IS DISTINCT FROM 1 OR NEW.audio_revision IS DISTINCT FROM 0 OR NEW.analysis_revision IS DISTINCT FROM 0 OR NEW.decision_revision IS DISTINCT FROM 0 OR NEW.workflow_revision IS DISTINCT FROM 0 OR NEW.event_sequence IS DISTINCT FROM 1
     OR NEW.current_terms_revision IS NOT NULL OR NEW.current_immutable_ref IS NOT NULL OR NEW.current_analysis_revision IS NOT NULL OR NEW.current_decision_revision IS NOT NULL
     OR NEW.bound_reference_asset_id IS NOT NULL OR NEW.bound_reference_evidence_ref IS NOT NULL OR NEW.bound_reference_audio_revision IS NOT NULL OR NEW.bound_reference_analysis_revision IS NOT NULL OR NEW.bound_reference_audio_sha256 IS NOT NULL OR NEW.bound_reference_upstream_share_bps IS NOT NULL
     OR NEW.post_id IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.retry_count IS DISTINCT FROM 0
     OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.abandonment_reason IS NOT NULL OR NEW.retention_disposition IS NOT NULL
     OR reservation_record.reservation_id IS NULL OR reservation_record.state IS DISTINCT FROM 'claimed' OR reservation_record.submission_id IS DISTINCT FROM NEW.submission_id OR reservation_record.operation_id IS DISTINCT FROM NEW.operation_id OR reservation_record.claim_fence IS DISTINCT FROM 1
     OR moderation_record.submission_id IS NULL OR moderation_record.community_id IS DISTINCT FROM NEW.community_id OR moderation_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR moderation_record.operation_id IS DISTINCT FROM NEW.operation_id OR moderation_record.status IS DISTINCT FROM 'none' OR moderation_record.decision_revision IS NOT NULL OR moderation_record.review_ref IS NOT NULL OR moderation_record.held_revision IS NOT NULL OR moderation_record.review_exhaustion_code IS NOT NULL OR moderation_record.review_exhaustion_attempt_id IS NOT NULL OR moderation_record.action_kind IS NOT NULL OR moderation_record.moderator_action_id IS NOT NULL OR moderation_record.moderator_actor_id IS NOT NULL OR moderation_record.action_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION 'media submission creation requires its exact submission_reserved event';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_submission_initial_event AFTER INSERT ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_submission_initial_event();

CREATE FUNCTION validate_media_reservation_claim_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; event_record media_submission_events%ROWTYPE; issued_event_record media_submission_events%ROWTYPE;
BEGIN
  IF NEW.state IN ('claimed', 'sealed', 'rejected', 'expired') AND NEW.submission_id IS NOT NULL THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND audio_reservation_id=NEW.reservation_id FOR SHARE;
    SELECT * INTO event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=1 FOR SHARE;
    SELECT * INTO issued_event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=2 FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR event_record.submission_id IS NULL
       OR NEW.claim_fence <> 1
       OR event_record.event_kind IS DISTINCT FROM 'submission_reserved'
       OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'submission_reserved'
       OR issued_event_record.submission_id IS NULL
       OR issued_event_record.event_kind IS DISTINCT FROM 'media_reservation_issued'
       OR issued_event_record.evidence->>'event_kind' IS DISTINCT FROM 'media_reservation_issued' THEN
      RAISE EXCEPTION 'media reservation claim is not paired with its exact submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_reservation_claim_pair AFTER INSERT OR UPDATE ON media_upload_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_reservation_claim_pair();

CREATE FUNCTION validate_media_lineage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL OR NEW.operation_id <> submission_record.operation_id THEN RAISE EXCEPTION 'media lineage does not match its submission'; END IF;
  IF TG_TABLE_NAME = 'media_submission_terms' THEN
    IF NEW.creation_revision <> submission_record.creation_revision + 1 THEN RAISE EXCEPTION 'terms revision is not current'; END IF;
  ELSIF TG_TABLE_NAME = 'media_audio_revisions' THEN
    IF NEW.audio_revision <> submission_record.audio_revision + 1 THEN RAISE EXCEPTION 'audio revision is not current'; END IF;
  ELSIF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF NEW.audio_revision <> submission_record.audio_revision OR NEW.analysis_revision <> submission_record.analysis_revision + 1 THEN RAISE EXCEPTION 'analysis revision is not current'; END IF;
    IF ROW(NEW.bound_reference_asset_id,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(submission_record.bound_reference_asset_id,submission_record.bound_reference_audio_revision,submission_record.bound_reference_analysis_revision,submission_record.bound_reference_audio_sha256,submission_record.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'analysis bound reference does not match submission'; END IF;
    IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'analysis bound reference evidence does not match'; END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF NEW.creation_revision <> submission_record.creation_revision OR NEW.audio_revision <> submission_record.audio_revision OR NEW.analysis_revision <> submission_record.analysis_revision OR NEW.decision_revision <> submission_record.decision_revision + 1 THEN RAISE EXCEPTION 'decision evidence is not current'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_terms_lineage_guard BEFORE INSERT ON media_submission_terms FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();
CREATE TRIGGER media_audio_lineage_guard BEFORE INSERT ON media_audio_revisions FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();
CREATE TRIGGER media_analysis_lineage_guard BEFORE INSERT ON media_analysis_evidence FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();
CREATE TRIGGER media_decision_lineage_guard BEFORE INSERT ON media_publication_decisions FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();

CREATE FUNCTION validate_media_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation JSONB; allocation_recipient TEXT; allocation_share NUMERIC; allocation_total NUMERIC := 0; allocation_count INTEGER := 0; distinct_recipient_count INTEGER := 0;
BEGIN
  IF TG_TABLE_NAME = 'media_submission_terms' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.terms_snapshot) AS key) IS DISTINCT FROM ARRAY['accessMode','commercialRemixShareBps','licensePreset','royaltyAllocations']::TEXT[] THEN
      RAISE EXCEPTION 'terms snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.terms_snapshot->'licensePreset') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.terms_snapshot->'accessMode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.terms_snapshot->'royaltyAllocations') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'terms snapshot scalar types are not exact';
    END IF;
    IF jsonb_typeof(NEW.terms_snapshot->'commercialRemixShareBps') IS DISTINCT FROM 'number'
       OR NEW.terms_snapshot->>'commercialRemixShareBps' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'terms commercial share type is not exact';
    END IF;
    IF NEW.terms_snapshot->>'licensePreset' IS DISTINCT FROM NEW.license_preset
       OR NEW.terms_snapshot->>'accessMode' IS DISTINCT FROM NEW.access_mode
       OR (NEW.terms_snapshot->>'commercialRemixShareBps')::numeric IS DISTINCT FROM NEW.commercial_remix_share_bps
       OR NEW.terms_snapshot->'royaltyAllocations' IS DISTINCT FROM NEW.royalty_allocations THEN
      RAISE EXCEPTION 'terms snapshot scalars do not match columns';
    END IF;
    IF jsonb_typeof(NEW.royalty_allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.royalty_allocations) < 1 THEN
      RAISE EXCEPTION 'royalty allocations must be a non-empty array';
    END IF;
    FOR allocation IN SELECT value FROM jsonb_array_elements(NEW.royalty_allocations) LOOP
      IF jsonb_typeof(allocation) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(allocation)) <> 2
         OR NOT (allocation ? 'recipientId')
         OR NOT (allocation ? 'shareBps')
         OR jsonb_typeof(allocation->'recipientId') IS DISTINCT FROM 'string'
         OR jsonb_typeof(allocation->'shareBps') IS DISTINCT FROM 'number'
         OR allocation->>'recipientId' IS NULL
         OR btrim(allocation->>'recipientId') = ''
         OR allocation->>'shareBps' IS NULL
         OR allocation->>'shareBps' !~ '^[0-9]+$'
         OR (allocation->>'shareBps')::numeric <= 0
         OR (allocation->>'shareBps')::numeric > 10000 THEN
        RAISE EXCEPTION 'royalty allocation shape is not exact';
      END IF;
      allocation_recipient := allocation->>'recipientId';
      allocation_share := (allocation->>'shareBps')::numeric;
      allocation_total := allocation_total + allocation_share;
      allocation_count := allocation_count + 1;
    END LOOP;
    SELECT count(DISTINCT value->>'recipientId') INTO distinct_recipient_count
      FROM jsonb_array_elements(NEW.royalty_allocations);
    IF distinct_recipient_count <> allocation_count OR allocation_total <> 10000
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.royalty_allocations) value WHERE value->>'recipientId' = NEW.actor_user_id) THEN
      RAISE EXCEPTION 'royalty allocations do not form an exact author-inclusive 10000 bps split';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.decision_snapshot) AS key) IS DISTINCT FROM ARRAY['analysisRevision','audioRevision','canonicalAudioSha256','creationRevision','decisionRevision','evidenceRef','outcome','policyRevision']::TEXT[] THEN
      RAISE EXCEPTION 'decision snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'canonicalAudioSha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'outcome') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'policyRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'evidenceRef') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'decision snapshot scalar types are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'decisionRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'decisionRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'creationRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'creationRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'audioRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'audioRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'analysisRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'analysisRevision' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'decision snapshot revision types are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'decisionRevision') IS DISTINCT FROM 'number'
       OR (NEW.decision_snapshot->>'decisionRevision')::numeric IS DISTINCT FROM NEW.decision_revision
       OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM NEW.outcome
       OR (NEW.decision_snapshot->>'creationRevision')::numeric IS DISTINCT FROM NEW.creation_revision
       OR (NEW.decision_snapshot->>'audioRevision')::numeric IS DISTINCT FROM NEW.audio_revision
       OR (NEW.decision_snapshot->>'analysisRevision')::numeric IS DISTINCT FROM NEW.analysis_revision
       OR NEW.decision_snapshot->>'canonicalAudioSha256' IS DISTINCT FROM NEW.canonical_audio_sha256
       OR NEW.decision_snapshot->>'policyRevision' IS DISTINCT FROM NEW.policy_revision
       OR NEW.decision_snapshot->>'evidenceRef' IS DISTINCT FROM NEW.evidence_ref THEN
      RAISE EXCEPTION 'decision snapshot scalars do not match columns';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot) AS key) IS DISTINCT FROM ARRAY['acr','analysisRevision','audioRevision','boundReference','canonicalAudioSha256','embeddedMetadata','finalizedAudioRef','lyricsSafety','mediaSafety','operationId','probeEvidenceRef','speechLyrics','version']::TEXT[] THEN
      RAISE EXCEPTION 'analysis snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'version') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'operationId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'canonicalAudioSha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'finalizedAudioRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'probeEvidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'lyricsSafety') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'mediaSafety') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'analysis snapshot scalar types are not exact';
    END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata') AS key) IS DISTINCT FROM ARRAY['adapterRevision','cover','evidenceRef','trackTitle']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'adapterRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover') IS DISTINCT FROM 'object'
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'trackTitle') IS DISTINCT FROM 'string' AND NEW.analysis_snapshot->'embeddedMetadata'->'trackTitle' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'embedded metadata snapshot shape is not exact';
    END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'acr') AS key) IS DISTINCT FROM ARRAY['adapterRevision','decision','evidenceRef','policyRevision']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'adapterRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'decision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'policyRevision') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'ACR snapshot shape is not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' = 'ready' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'speechLyrics') AS key) IS DISTINCT FROM ARRAY['adapterRevision','evidenceRef','explicitness','primaryLanguageBcp47','policyRevision','secondaryLanguageBcp47','status','transcriptArtifactRef','transcriptSha256']::TEXT[] THEN
      RAISE EXCEPTION 'ready speech snapshot keys are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' IN ('no_speech','unavailable') AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'speechLyrics') AS key) IS DISTINCT FROM ARRAY['adapterRevision','evidenceRef','explicitness','policyRevision','primaryLanguageBcp47','secondaryLanguageBcp47','status','transcriptArtifactRef','transcriptSha256']::TEXT[] THEN
      RAISE EXCEPTION 'non-ready speech snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'status') IS DISTINCT FROM 'string'
       OR NEW.analysis_snapshot->'speechLyrics'->>'status' NOT IN ('ready','no_speech','unavailable')
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'explicitness') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'policyRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'adapterRevision') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'speech snapshot discriminator types are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' = 'ready'
       AND (jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'transcriptArtifactRef') IS DISTINCT FROM 'string'
         OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'transcriptSha256') IS DISTINCT FROM 'string'
         OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'primaryLanguageBcp47') IS DISTINCT FROM 'string'
         OR (jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47') IS DISTINCT FROM 'string' AND NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb)) THEN
      RAISE EXCEPTION 'ready speech snapshot scalar types are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' IN ('no_speech','unavailable')
       AND (NEW.analysis_snapshot->'speechLyrics'->'transcriptArtifactRef' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'transcriptSha256' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'primaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'non-ready speech nullable fields must be explicit JSON null';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'analysisRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->>'analysisRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'audioRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->>'audioRevision' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'analysis snapshot revision types are not exact';
    END IF;
    IF NEW.cover_status = 'ready' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata'->'cover') AS key) IS DISTINCT FROM ARRAY['artifactRef','artifactSha256','height','mediaType','normalizationRevision','safetyPolicyRevision','status','width']::TEXT[] THEN
      RAISE EXCEPTION 'ready cover facts keys are not exact';
    END IF;
    IF NEW.cover_status IN ('absent','rejected') AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata'->'cover') AS key) IS DISTINCT FROM ARRAY['reasonCode','status']::TEXT[] THEN
      RAISE EXCEPTION 'non-ready cover facts keys are not exact';
    END IF;
    IF NEW.cover_status = 'ready' AND (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'artifactRef') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'artifactSha256') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'mediaType') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') IS DISTINCT FROM 'number' OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'width' !~ '^[0-9]+$' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') IS DISTINCT FROM 'number' OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'height' !~ '^[0-9]+$' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'normalizationRevision') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'safetyPolicyRevision') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'ready cover facts types are not exact';
    END IF;
    IF NEW.analysis_snapshot->>'version' IS DISTINCT FROM NEW.analysis_version
       OR NEW.analysis_snapshot->>'operationId' IS DISTINCT FROM NEW.operation_id
       OR (NEW.analysis_snapshot->>'analysisRevision')::numeric IS DISTINCT FROM NEW.analysis_revision
       OR (NEW.analysis_snapshot->>'audioRevision')::numeric IS DISTINCT FROM NEW.audio_revision
       OR NEW.analysis_snapshot->>'canonicalAudioSha256' IS DISTINCT FROM NEW.canonical_audio_sha256
       OR NEW.analysis_snapshot->>'finalizedAudioRef' IS DISTINCT FROM NEW.finalized_audio_ref
       OR NEW.analysis_snapshot->>'probeEvidenceRef' IS DISTINCT FROM NEW.probe_evidence_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'evidenceRef' IS DISTINCT FROM NEW.embedded_metadata_evidence_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'adapterRevision' IS DISTINCT FROM NEW.embedded_metadata_adapter_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'trackTitle' IS DISTINCT FROM NEW.embedded_title
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'status' IS DISTINCT FROM NEW.cover_status
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'artifactRef' IS DISTINCT FROM NEW.cover_artifact_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'artifactSha256' IS DISTINCT FROM NEW.cover_artifact_sha256
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'mediaType' IS DISTINCT FROM NEW.cover_media_type
       OR NEW.cover_facts IS DISTINCT FROM NEW.analysis_snapshot->'embeddedMetadata'->'cover'
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') = 'number' AND (NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'width')::numeric IS DISTINCT FROM NEW.cover_width)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') <> 'number' AND NEW.cover_width IS NOT NULL)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') = 'number' AND (NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'height')::numeric IS DISTINCT FROM NEW.cover_height)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') <> 'number' AND NEW.cover_height IS NOT NULL)
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'normalizationRevision' IS DISTINCT FROM NEW.cover_normalization_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'safetyPolicyRevision' IS DISTINCT FROM NEW.cover_safety_policy_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover' IS DISTINCT FROM NEW.cover_facts
       OR NEW.analysis_snapshot->'speechLyrics'->>'status' IS DISTINCT FROM NEW.speech_status
       OR NEW.analysis_snapshot->'speechLyrics'->>'transcriptArtifactRef' IS DISTINCT FROM NEW.transcript_artifact_ref
       OR NEW.analysis_snapshot->'speechLyrics'->>'transcriptSha256' IS DISTINCT FROM NEW.transcript_sha256
       OR NEW.analysis_snapshot->'speechLyrics'->>'explicitness' IS DISTINCT FROM NEW.explicitness
       OR NEW.analysis_snapshot->'speechLyrics'->>'primaryLanguageBcp47' IS DISTINCT FROM NEW.primary_language_bcp47
       OR NEW.analysis_snapshot->'speechLyrics'->>'secondaryLanguageBcp47' IS DISTINCT FROM NEW.secondary_language_bcp47
       OR NEW.analysis_snapshot->'speechLyrics'->>'evidenceRef' IS DISTINCT FROM NEW.speech_evidence_ref
       OR NEW.analysis_snapshot->'speechLyrics'->>'policyRevision' IS DISTINCT FROM NEW.speech_policy_revision
       OR NEW.analysis_snapshot->'speechLyrics'->>'adapterRevision' IS DISTINCT FROM NEW.speech_adapter_revision
       OR NEW.analysis_snapshot->'acr'->>'decision' IS DISTINCT FROM NEW.acr_decision
       OR NEW.analysis_snapshot->'acr'->>'evidenceRef' IS DISTINCT FROM NEW.acr_evidence_ref
       OR NEW.analysis_snapshot->'acr'->>'policyRevision' IS DISTINCT FROM NEW.acr_policy_revision
       OR NEW.analysis_snapshot->'acr'->>'adapterRevision' IS DISTINCT FROM NEW.acr_adapter_revision
       OR NEW.analysis_snapshot->>'lyricsSafety' IS DISTINCT FROM NEW.lyrics_safety
       OR NEW.analysis_snapshot->>'mediaSafety' IS DISTINCT FROM NEW.media_safety THEN
      RAISE EXCEPTION 'analysis snapshot scalars do not match columns';
    END IF;
    IF NEW.bound_reference_asset_id IS NULL THEN
      IF NOT (NEW.analysis_snapshot ? 'boundReference') OR NEW.analysis_snapshot->'boundReference' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'analysis snapshot bound reference does not match columns'; END IF;
    ELSIF NOT (NEW.analysis_snapshot ? 'boundReference')
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'boundReference') AS key) IS DISTINCT FROM ARRAY['assetId','evidenceAnalysisRevision','evidenceAudioRevision','evidenceAudioSha256','upstreamCommercialRevShareBps']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'assetId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAudioRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAnalysisRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAnalysisRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAudioSha256') IS DISTINCT FROM 'string'
       OR NOT (NEW.analysis_snapshot->'boundReference' ? 'upstreamCommercialRevShareBps')
       OR (jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps') IS DISTINCT FROM 'number' AND NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps' IS DISTINCT FROM 'null'::jsonb)
       OR (jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps') = 'number' AND NEW.analysis_snapshot->'boundReference'->>'upstreamCommercialRevShareBps' !~ '^[0-9]+$')
       OR NEW.analysis_snapshot->'boundReference'->>'assetId' IS DISTINCT FROM NEW.bound_reference_asset_id
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioRevision' IS DISTINCT FROM NEW.bound_reference_audio_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAnalysisRevision' IS DISTINCT FROM NEW.bound_reference_analysis_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioSha256' IS DISTINCT FROM NEW.bound_reference_audio_sha256
       OR NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps' IS DISTINCT FROM to_jsonb(NEW.bound_reference_upstream_share_bps) THEN
      RAISE EXCEPTION 'analysis snapshot bound reference does not match columns';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_terms_snapshot_guard BEFORE INSERT ON media_submission_terms FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();
CREATE TRIGGER media_analysis_snapshot_guard BEFORE INSERT ON media_analysis_evidence FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();
CREATE TRIGGER media_decision_snapshot_guard BEFORE INSERT ON media_publication_decisions FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();

CREATE FUNCTION validate_media_outbox_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys TEXT[]; expected TEXT[]; submission_record media_post_submissions%ROWTYPE;
BEGIN
  keys := ARRAY(SELECT jsonb_object_keys(NEW.payload) ORDER BY 1);
  IF NEW.event_type = 'analysis_launch' THEN expected := ARRAY['analysis_revision','audio_revision','kind','operation_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSIF NEW.event_type = 'publication' THEN expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSE expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision']; END IF;
  IF keys IS DISTINCT FROM expected THEN RAISE EXCEPTION 'media outbox payload is not a closed identifier union'; END IF;
  IF jsonb_typeof(NEW.payload->'kind') IS DISTINCT FROM 'string' OR NEW.payload->>'kind' IS DISTINCT FROM NEW.event_type THEN RAISE EXCEPTION 'media outbox payload kind does not match event type'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL OR NEW.operation_id IS DISTINCT FROM submission_record.operation_id OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision OR NEW.workflow_revision IS DISTINCT FROM submission_record.workflow_revision OR NEW.workflow_instance_id IS DISTINCT FROM 'media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text THEN RAISE EXCEPTION 'media outbox row lineage does not match submission'; END IF;
  IF NEW.event_type = 'analysis_launch' THEN
    IF jsonb_typeof(NEW.payload->'submission_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'operation_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'workflow_instance_id') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'submission_id') = '' OR btrim(NEW.payload->>'operation_id') = '' OR btrim(NEW.payload->>'workflow_instance_id') = '' OR jsonb_typeof(NEW.payload->'audio_revision') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.payload->'analysis_revision') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.payload->'workflow_revision') IS DISTINCT FROM 'number' OR NEW.payload->>'audio_revision' !~ '^[0-9]+$' OR NEW.payload->>'analysis_revision' !~ '^[0-9]+$' OR NEW.payload->>'workflow_revision' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'media analysis outbox payload types are not exact'; END IF;
    IF NEW.payload->>'submission_id' IS DISTINCT FROM NEW.submission_id OR NEW.payload->>'operation_id' IS DISTINCT FROM NEW.operation_id OR (NEW.payload->>'audio_revision')::BIGINT IS DISTINCT FROM NEW.audio_revision OR (NEW.payload->>'analysis_revision')::BIGINT IS DISTINCT FROM NEW.analysis_revision OR (NEW.payload->>'workflow_revision')::BIGINT IS DISTINCT FROM NEW.workflow_revision OR NEW.payload->>'workflow_instance_id' IS DISTINCT FROM NEW.workflow_instance_id OR NOT EXISTS (SELECT 1 FROM media_audio_revisions a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.audio_revision=NEW.audio_revision AND a.immutable_ref=submission_record.current_immutable_ref) THEN RAISE EXCEPTION 'media analysis outbox payload values do not match row'; END IF;
  ELSE
    IF jsonb_typeof(NEW.payload->'submission_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'operation_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'post_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'workflow_instance_id') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'submission_id') = '' OR btrim(NEW.payload->>'operation_id') = '' OR btrim(NEW.payload->>'post_id') = '' OR btrim(NEW.payload->>'workflow_instance_id') = '' OR jsonb_typeof(NEW.payload->'workflow_revision') IS DISTINCT FROM 'number' OR NEW.payload->>'workflow_revision' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'media publication outbox payload types are not exact'; END IF;
    IF NEW.payload->>'submission_id' IS DISTINCT FROM NEW.submission_id OR NEW.payload->>'operation_id' IS DISTINCT FROM NEW.operation_id OR NEW.payload->>'post_id' IS DISTINCT FROM submission_record.post_id OR (NEW.payload->>'workflow_revision')::BIGINT IS DISTINCT FROM NEW.workflow_revision OR NEW.payload->>'workflow_instance_id' IS DISTINCT FROM NEW.workflow_instance_id THEN RAISE EXCEPTION 'media publication outbox payload values do not match row'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_payload_guard BEFORE INSERT ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION validate_media_outbox_payload();

CREATE FUNCTION validate_media_publication_projection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; post_record posts%ROWTYPE; audio_record media_audio_revisions%ROWTYPE; analysis_record media_analysis_evidence%ROWTYPE; decision_record media_publication_decisions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
  SELECT * INTO audio_record FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision FOR SHARE;
  SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
  SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision FOR SHARE;
  IF analysis_record.submission_id IS NULL
     OR analysis_record.audio_revision IS DISTINCT FROM submission_record.audio_revision
     OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM audio_record.canonical_sha256 THEN
    RAISE EXCEPTION 'publication analysis bound reference lineage is not exact';
  END IF;
  IF submission_record.status <> 'published' OR submission_record.operation_id <> NEW.operation_id OR submission_record.post_id <> NEW.post_id OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title IS DISTINCT FROM submission_record.title OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.alignment <> 'pending' OR audio_record.submission_id IS NULL OR analysis_record.submission_id IS NULL OR decision_record.submission_id IS NULL OR decision_record.outcome <> 'allow' OR NEW.canonical_audio_sha256 IS DISTINCT FROM audio_record.canonical_sha256 OR NEW.title IS DISTINCT FROM submission_record.title OR NEW.audio_asset_ref IS DISTINCT FROM audio_record.immutable_ref OR NEW.cover_artifact_ref IS DISTINCT FROM (CASE WHEN analysis_record.cover_status='ready' THEN analysis_record.cover_artifact_ref ELSE NULL END) OR NEW.language_status IS DISTINCT FROM analysis_record.speech_status OR NEW.primary_language_bcp47 IS DISTINCT FROM analysis_record.primary_language_bcp47 OR NEW.secondary_language_bcp47 IS DISTINCT FROM analysis_record.secondary_language_bcp47 OR NEW.lyrics_explicitness IS DISTINCT FROM analysis_record.explicitness OR NEW.analysis_badges IS DISTINCT FROM (CASE WHEN submission_record.bound_reference_asset_id IS NULL THEN '[]'::jsonb ELSE '["reference_bound"]'::jsonb END) THEN RAISE EXCEPTION 'media publication projection is not owned by its operation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_insert_guard BEFORE INSERT ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION validate_media_publication_projection_insert();
CREATE FUNCTION guard_media_publication_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE alignment_record media_alignment_projections%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id,NEW.post_id,NEW.creation_revision,NEW.audio_revision,NEW.analysis_revision,NEW.decision_revision,NEW.canonical_audio_sha256,NEW.title,NEW.audio_asset_ref,NEW.cover_artifact_ref,NEW.language_status,NEW.primary_language_bcp47,NEW.secondary_language_bcp47,NEW.lyrics_explicitness,NEW.analysis_badges,NEW.data_registration,NEW.locked_delivery,NEW.projected_at) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id,OLD.post_id,OLD.creation_revision,OLD.audio_revision,OLD.analysis_revision,OLD.decision_revision,OLD.canonical_audio_sha256,OLD.title,OLD.audio_asset_ref,OLD.cover_artifact_ref,OLD.language_status,OLD.primary_language_bcp47,OLD.secondary_language_bcp47,OLD.lyrics_explicitness,OLD.analysis_badges,OLD.data_registration,OLD.locked_delivery,OLD.projected_at) THEN RAISE EXCEPTION 'media publication accepted evidence is immutable'; END IF;
  IF NEW.alignment IS DISTINCT FROM OLD.alignment THEN
    SELECT * INTO alignment_record FROM media_alignment_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
    IF alignment_record.submission_id IS NULL OR alignment_record.status IS DISTINCT FROM NEW.alignment OR alignment_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR alignment_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR alignment_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256 THEN
      RAISE EXCEPTION 'publication alignment is not owned by the exact alignment projection';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_update_guard BEFORE UPDATE ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION guard_media_publication_projection_update();

CREATE FUNCTION guard_media_processing_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.audio_revision, NEW.analysis_revision, NEW.stage, NEW.attempt_number, NEW.input_hash, NEW.provider_idempotency_key, NEW.input_kind, NEW.input_revision, NEW.policy_revision, NEW.adapter_revision, NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.audio_revision, OLD.analysis_revision, OLD.stage, OLD.attempt_number, OLD.input_hash, OLD.provider_idempotency_key, OLD.input_kind, OLD.input_revision, OLD.policy_revision, OLD.adapter_revision, OLD.created_at) THEN RAISE EXCEPTION 'media processing attempt identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media processing attempt timestamp must advance'; END IF;
  IF NEW.state = 'retry_wait' AND NEW.attempt_number >= 3 THEN RAISE EXCEPTION 'media processing attempt retry bound is exhausted'; END IF;
  IF OLD.state = 'retry_wait' AND (OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt retry is not yet eligible'; END IF;
  IF (OLD.state = 'pending' OR OLD.state = 'retry_wait') AND (NEW.state <> 'running' OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('succeeded', 'retry_wait', 'exhausted') AND (OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL) THEN RAISE EXCEPTION 'media processing attempt completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'retry_wait', 'running') THEN RAISE EXCEPTION 'media processing attempt is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_processing_attempt_update_guard BEFORE UPDATE ON media_processing_attempts FOR EACH ROW EXECUTE FUNCTION guard_media_processing_attempt_update();

CREATE FUNCTION guard_media_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.outbox_event_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.creation_revision, NEW.audio_revision, NEW.analysis_revision, NEW.workflow_revision, NEW.workflow_instance_id, NEW.event_type, NEW.effect_identity, NEW.payload, NEW.created_at) IS DISTINCT FROM ROW(OLD.outbox_event_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.creation_revision, OLD.audio_revision, OLD.analysis_revision, OLD.workflow_revision, OLD.workflow_instance_id, OLD.event_type, OLD.effect_identity, OLD.payload, OLD.created_at) THEN RAISE EXCEPTION 'media outbox effect identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.claim_fence < OLD.claim_fence OR NEW.delivery_attempts < OLD.delivery_attempts OR NEW.delivery_attempts > 3 THEN RAISE EXCEPTION 'media outbox fence must advance'; END IF;
  IF (OLD.state = 'pending' AND (OLD.delivery_attempts >= 3 OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF (OLD.state = 'failed' AND (OLD.delivery_attempts >= 3 OR OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp() OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.delivery_attempts <> CASE WHEN OLD.delivery_attempts < 3 THEN OLD.delivery_attempts + 1 ELSE OLD.delivery_attempts END OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media outbox reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') AND (NEW.delivery_attempts <> OLD.delivery_attempts OR OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL OR (NEW.state = 'exhausted' AND OLD.delivery_attempts <> 3) OR (NEW.state = 'failed' AND OLD.delivery_attempts >= 3) OR (NEW.state = 'failed' AND NEW.next_eligible_at IS NULL) OR (NEW.state = 'exhausted' AND NEW.next_eligible_at IS NOT NULL)) THEN RAISE EXCEPTION 'media outbox completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'failed', 'running') THEN RAISE EXCEPTION 'media outbox is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_update_guard BEFORE UPDATE ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION guard_media_outbox_update();

CREATE FUNCTION validate_media_alignment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; publication_record media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  SELECT * INTO publication_record FROM media_publication_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
  IF submission_record.status IS DISTINCT FROM 'published'
     OR submission_record.post_id IS DISTINCT FROM NEW.post_id
     OR submission_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR submission_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR submission_record.current_immutable_ref IS NULL
     OR publication_record.submission_id IS NULL
     OR publication_record.alignment IS DISTINCT FROM 'pending'
     OR publication_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR publication_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR publication_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256
     OR NEW.alignment_revision <> 0
     OR NEW.status <> 'pending'
     OR NEW.current_artifact_ref IS NOT NULL
     OR NEW.current_artifact_revision IS NOT NULL
     OR NEW.failure_code IS NOT NULL THEN
    RAISE EXCEPTION 'alignment projection must begin as the current published pending projection';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_alignment_insert_guard BEFORE INSERT ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_insert();

CREATE FUNCTION validate_media_alignment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.post_id, NEW.audio_revision, NEW.analysis_revision, NEW.canonical_audio_sha256) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.post_id, OLD.audio_revision, OLD.analysis_revision, OLD.canonical_audio_sha256) THEN RAISE EXCEPTION 'alignment ownership is immutable'; END IF;
  IF NEW.status NOT IN ('ready', 'unavailable') OR NEW.updated_at <= OLD.updated_at OR NEW.alignment_revision <> OLD.alignment_revision + 1 THEN RAISE EXCEPTION 'alignment transition is not allowed'; END IF;
  IF NEW.status = 'ready' AND (NEW.current_artifact_ref IS NULL OR NEW.current_artifact_revision IS NULL OR NEW.current_artifact_revision <= COALESCE(OLD.current_artifact_revision, 0)) THEN RAISE EXCEPTION 'ready alignment requires a new immutable artifact revision'; END IF;
  IF NEW.status = 'unavailable' AND NEW.current_artifact_ref IS NOT NULL THEN RAISE EXCEPTION 'unavailable alignment cannot point to an artifact'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_alignment_update_guard BEFORE UPDATE ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_update();
