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
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_upload_reservations_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT media_upload_reservations_state_shape CHECK (
    (state IN ('issued', 'expired') AND submission_id IS NULL AND operation_id IS NULL)
    OR (state IN ('claimed', 'sealed', 'rejected') AND submission_id IS NOT NULL AND operation_id IS NOT NULL)
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
  phase TEXT DEFAULT 'awaiting_upload' CHECK (phase IS NULL OR phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
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
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  moderator_evidence_ref TEXT,
  moderator_approval_kind TEXT CHECK (moderator_approval_kind IS NULL OR moderator_approval_kind IN ('standard', 'acr_override')),
  moderator_reason_code TEXT CHECK (moderator_reason_code IS NULL OR moderator_reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped')),
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
    OR (status = 'abandoned' AND phase IS NULL AND post_id IS NULL AND abandonment_reason IS NOT NULL AND retention_disposition IS NOT NULL)
  ),
  CONSTRAINT media_post_submissions_review_exhaustion_shape CHECK (review_exhaustion_code IS NULL OR status = 'manual_review'),
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
    community_id, actor_user_id, submission_id, operation_id
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
  CONSTRAINT media_analysis_title_shape CHECK ((embedded_title_provenance = 'embedded' AND embedded_title IS NOT NULL) OR (embedded_title_provenance = 'absent' AND embedded_title IS NULL)),
  CONSTRAINT media_analysis_cover_shape CHECK ((cover_status = 'ready' AND cover_artifact_ref IS NOT NULL AND cover_artifact_sha256 IS NOT NULL AND cover_media_type IN ('image/jpeg', 'image/png', 'image/webp') AND cover_width > 0 AND cover_height > 0 AND btrim(cover_normalization_revision) <> '' AND btrim(cover_safety_policy_revision) <> '') OR (cover_status IN ('absent', 'rejected') AND cover_artifact_ref IS NULL AND cover_artifact_sha256 IS NULL AND cover_media_type IS NULL AND cover_width IS NULL AND cover_height IS NULL AND cover_normalization_revision IS NULL AND cover_safety_policy_revision IS NULL)),
  CONSTRAINT media_analysis_speech_shape CHECK (
    (speech_status = 'ready' AND transcript_artifact_ref IS NOT NULL AND transcript_sha256 IS NOT NULL AND explicitness IN ('not_explicit', 'explicit', 'uncertain') AND primary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$' AND (secondary_language_bcp47 IS NULL OR (secondary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$' AND secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47)) AND lyrics_safety IN ('skipped', 'allow'))
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
  PRIMARY KEY (submission_id, event_sequence),
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
    (state = 'pending' AND claim_owner IS NULL AND lease_expires_at IS NULL AND next_eligible_at IS NULL)
    OR (state = 'running' AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL)
    OR (state = 'retry_wait' AND claim_owner IS NULL AND lease_expires_at IS NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL)
    OR (state = 'succeeded' AND claim_owner IS NULL AND lease_expires_at IS NULL AND evidence_ref IS NOT NULL AND result IS NOT NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND lease_expires_at IS NULL AND retryable = FALSE AND failure_code IS NOT NULL)
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
  action_kind TEXT CHECK (action_kind IS NULL OR action_kind IN ('approve', 'block')),
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  action_evidence_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, actor_user_id, submission_id, operation_id),
  CONSTRAINT media_moderation_projection_exhaustion_shape CHECK (review_exhaustion_code IS NULL OR (status = 'open' AND held_revision IS NOT NULL))
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
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped')),
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
    (action_kind = 'approve' AND approval_kind IS NOT NULL AND decision_revision IS NOT NULL AND decision_snapshot IS NOT NULL AND jsonb_typeof(decision_snapshot) = 'object')
    OR (action_kind = 'block' AND approval_kind IS NULL AND reason_code IS NULL AND decision_revision IS NULL AND decision_snapshot IS NULL)
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
    (state = 'pending' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
    OR (state = 'running' AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
    OR (state = 'failed' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL AND next_eligible_at IS NOT NULL)
    OR (state = 'delivered' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL AND next_eligible_at IS NULL AND delivery_attempts = 3)
  )
);
CREATE INDEX media_submission_outbox_claim_idx ON media_submission_outbox (state, next_eligible_at, lease_expires_at, created_at, outbox_event_id) WHERE state IN ('pending', 'running', 'failed');

CREATE FUNCTION validate_media_transcript_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment JSONB; previous_start BIGINT := 0; start_ms BIGINT; end_ms BIGINT; total_segment_text BIGINT := 0;
BEGIN
  IF encode(sha256(convert_to(NEW.transcript_text, 'UTF8')), 'hex') <> NEW.transcript_sha256 THEN RAISE EXCEPTION 'transcript hash does not match payload'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.segments) LOOP
    IF jsonb_typeof(segment) <> 'object' OR jsonb_typeof(segment->'start_ms') <> 'number' OR jsonb_typeof(segment->'end_ms') <> 'number' OR jsonb_typeof(segment->'text') <> 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'transcript segment shape is invalid'; END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN RAISE EXCEPTION 'transcript segment text aggregate exceeds 200000 characters'; END IF;
    start_ms := (segment->>'start_ms')::numeric; end_ms := (segment->>'end_ms')::numeric;
    IF start_ms < 0 OR end_ms < start_ms OR end_ms > 86400000 OR start_ms <> trunc(start_ms) OR end_ms <> trunc(end_ms) OR start_ms < previous_start THEN RAISE EXCEPTION 'transcript segment timing is invalid'; END IF;
    previous_start := start_ms;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_transcript_artifact_shape_guard BEFORE INSERT ON media_transcript_artifacts FOR EACH ROW EXECUTE FUNCTION validate_media_transcript_artifact();

CREATE FUNCTION validate_media_timed_lyrics_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment JSONB; previous_start BIGINT := 0; start_ms BIGINT; end_ms BIGINT;
BEGIN
  IF encode(sha256(convert_to(NEW.artifact::text, 'UTF8')), 'hex') <> NEW.artifact_sha256 THEN RAISE EXCEPTION 'timed lyrics artifact hash does not match payload'; END IF;
  IF jsonb_typeof(NEW.artifact->'segments') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.artifact->'segments') > 10000 THEN RAISE EXCEPTION 'timed lyrics segment bounds are invalid'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.artifact->'segments') LOOP
    IF jsonb_typeof(segment) <> 'object' OR jsonb_typeof(segment->'start_ms') <> 'number' OR jsonb_typeof(segment->'end_ms') <> 'number' OR jsonb_typeof(segment->'text') <> 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'timed lyrics segment shape is invalid'; END IF;
    start_ms := (segment->>'start_ms')::numeric; end_ms := (segment->>'end_ms')::numeric;
    IF start_ms < 0 OR end_ms < start_ms OR end_ms > 86400000 OR start_ms <> trunc(start_ms) OR end_ms <> trunc(end_ms) OR start_ms < previous_start THEN RAISE EXCEPTION 'timed lyrics segment timing is invalid'; END IF;
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
  IF NEW.reason_code = 'acr_exhausted' AND submission_record.review_exhaustion_code IS DISTINCT FROM 'acr_exhausted' THEN
    RAISE EXCEPTION 'ACR exhaustion override lacks its private exhaustion hold';
  END IF;
  IF NEW.action_kind = 'approve' AND (NEW.decision_revision IS NULL OR NEW.decision_revision <> submission_record.decision_revision + 1) THEN
    RAISE EXCEPTION 'moderation approval decision revision is not current';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_moderation_action_authority_guard BEFORE INSERT ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION validate_media_moderation_action_insert();
CREATE TRIGGER media_moderation_action_append_only BEFORE UPDATE OR DELETE ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE FUNCTION guard_media_reservation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.reservation_id, NEW.community_id, NEW.actor_user_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.expected_content_type, NEW.expected_size_bytes, NEW.expected_sha256, NEW.upload_url, NEW.upload_headers, NEW.expires_at, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.reservation_id, OLD.community_id, OLD.actor_user_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.expected_content_type, OLD.expected_size_bytes, OLD.expected_sha256, OLD.upload_url, OLD.upload_headers, OLD.expires_at, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media reservation authority is immutable'; END IF;
  IF OLD.state IN ('sealed', 'rejected', 'expired') OR NOT ((OLD.state = 'issued' AND NEW.state IN ('claimed', 'expired')) OR (OLD.state = 'claimed' AND NEW.state IN ('sealed', 'rejected'))) OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media reservation transition is not allowed'; END IF;
  IF OLD.state = 'claimed' AND (NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id) THEN RAISE EXCEPTION 'media reservation claim identity is immutable'; END IF;
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
  allowed := (OLD.status IN ('processing', 'action_required', 'manual_review') AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.current_terms_revision = NEW.creation_revision)
    OR (OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.audio_revision = OLD.audio_revision + 1 AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.current_immutable_ref IS NOT NULL)
    OR (OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.analysis_revision = OLD.analysis_revision + 1 AND NEW.current_analysis_revision = NEW.analysis_revision)
    OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'manual_review', 'blocked') AND NEW.decision_revision = OLD.decision_revision + 1)
    OR (OLD.status = 'processing' AND NEW.status = 'manual_review' AND NEW.review_ref IS NOT NULL AND NEW.held_revision = OLD.creation_revision AND NEW.creation_revision = OLD.creation_revision AND NEW.decision_revision = 0)
    OR (OLD.status = 'processing' AND NEW.status = 'action_required' AND NEW.action_kind = 'reference_required' AND NEW.held_revision = OLD.creation_revision AND NEW.action_expires_at IS NOT NULL)
    OR (OLD.status IN ('action_required', 'manual_review') AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.bound_reference_asset_id IS NOT NULL)
    OR (OLD.status = 'manual_review' AND NEW.status = 'processing' AND NEW.moderator_action_id IS NOT NULL AND NEW.moderator_actor_id IS NOT NULL AND NEW.decision_revision = OLD.decision_revision + 1)
    OR (OLD.status = 'manual_review' AND NEW.status = 'blocked' AND NEW.moderator_action_id IS NOT NULL AND NEW.moderator_actor_id IS NOT NULL)
    OR (OLD.status = 'processing' AND NEW.status = 'published' AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.post_id IS NOT NULL AND NEW.decision_revision > 0)
    OR (OLD.status = 'processing' AND NEW.status = 'processing_failed' AND NEW.failure_code IS NOT NULL AND NEW.last_safe_phase IS NOT NULL)
    OR (OLD.status = 'processing_failed' AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.retry_count = OLD.retry_count + 1)
    OR (OLD.status = 'action_required' AND NEW.status = 'abandoned' AND OLD.action_kind = 'reference_required' AND NEW.abandonment_reason = 'action_deadline_elapsed')
    OR (OLD.status = 'processing' AND NEW.status = 'abandoned' AND OLD.audio_revision = 0 AND OLD.phase IN ('reserve', 'awaiting_upload', 'finalize') AND NEW.abandonment_reason IN ('author_cancelled', 'reservation_expired'));
  IF NOT allowed THEN RAISE EXCEPTION 'media submission transition is not allowed'; END IF;
  IF OLD.status IN ('processing', 'action_required', 'manual_review') AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.current_terms_revision = NEW.creation_revision THEN
    SELECT * INTO terms_record FROM media_submission_terms WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND creation_revision=NEW.creation_revision FOR SHARE;
    IF terms_record.submission_id IS NULL OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.bound_reference_asset_id IS DISTINCT FROM OLD.bound_reference_asset_id OR NEW.review_exhaustion_code IS NOT NULL OR NEW.post_id IS NOT NULL OR terms_record.license_preset IS NULL OR terms_record.access_mode <> 'public' THEN RAISE EXCEPTION 'terms transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.audio_revision = OLD.audio_revision + 1 THEN
    SELECT * INTO audio_record FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision FOR SHARE;
    IF audio_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> OLD.decision_revision OR NEW.workflow_revision <> OLD.workflow_revision + 1 OR NEW.current_immutable_ref IS DISTINCT FROM audio_record.immutable_ref OR NEW.phase <> 'analysis' OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'audio transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.analysis_revision = OLD.analysis_revision + 1 THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.current_analysis_revision <> NEW.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.phase NOT IN ('analysis','decision') OR analysis_record.audio_revision <> NEW.audio_revision OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE submission_id=NEW.submission_id AND audio_revision=NEW.audio_revision) THEN RAISE EXCEPTION 'analysis transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND NEW.decision_revision = OLD.decision_revision + 1 THEN
    SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision FOR SHARE;
    IF decision_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.current_decision_revision <> NEW.decision_revision OR decision_record.creation_revision <> NEW.creation_revision OR decision_record.audio_revision <> NEW.audio_revision OR decision_record.analysis_revision <> NEW.analysis_revision OR decision_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE submission_id=NEW.submission_id AND audio_revision=NEW.audio_revision) THEN RAISE EXCEPTION 'decision transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'action_required' THEN
    IF NEW.phase IS NOT NULL OR NEW.action_kind <> 'reference_required' OR NEW.action_expires_at <= clock_timestamp() OR NEW.held_revision <> OLD.creation_revision OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'reference action evidence is not exact'; END IF;
  ELSIF OLD.status IN ('action_required','manual_review') AND NEW.status = 'processing' AND NEW.bound_reference_asset_id IS NOT NULL THEN
    IF NEW.creation_revision <> OLD.creation_revision + 1 OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase <> 'analysis' OR NEW.bound_reference_audio_revision <> NEW.audio_revision OR NEW.bound_reference_analysis_revision > NEW.analysis_revision THEN RAISE EXCEPTION 'bound reference transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'manual_review' AND NEW.status IN ('processing','blocked') THEN
    IF NEW.moderator_action_id IS NULL OR NOT EXISTS (SELECT 1 FROM media_moderation_actions WHERE action_id=NEW.moderator_action_id AND community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id) THEN RAISE EXCEPTION 'moderation action evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing_failed' THEN
    IF NEW.phase IS NOT NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> OLD.decision_revision OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.failure_code IS NULL OR NEW.failure_retry_count IS NULL OR NEW.last_safe_phase IS NULL THEN RAISE EXCEPTION 'media failure evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing_failed' AND NEW.status = 'processing' THEN
    IF NEW.creation_revision <> OLD.creation_revision + 1 OR NEW.retry_count <> OLD.retry_count + 1 OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase IS NULL OR NEW.failure_code IS NOT NULL THEN RAISE EXCEPTION 'retry transition evidence is not exact'; END IF;
  END IF;
  IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_ref = NEW.bound_reference_evidence_ref AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'bound reference evidence is missing'; END IF;
  IF (NEW.status = 'processing' AND NEW.phase = 'publish') OR NEW.status = 'published' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE submission_id = NEW.submission_id AND analysis_revision = NEW.analysis_revision FOR SHARE;
    SELECT * INTO decision_record FROM media_publication_decisions WHERE submission_id = NEW.submission_id AND decision_revision = NEW.decision_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR decision_record.submission_id IS NULL OR decision_record.outcome <> 'allow' OR decision_record.creation_revision <> NEW.creation_revision OR decision_record.audio_revision <> NEW.audio_revision OR decision_record.analysis_revision <> NEW.analysis_revision OR decision_record.canonical_audio_sha256 <> analysis_record.canonical_audio_sha256 OR analysis_record.media_safety <> 'allow' OR analysis_record.lyrics_safety NOT IN ('skipped', 'allow') OR analysis_record.speech_status = 'unavailable' OR analysis_record.explicitness NOT IN ('not_explicit', 'no_lyrics') OR (analysis_record.acr_decision = 'inconclusive' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code IN ('acr_inconclusive','acr_exhausted'))) OR (analysis_record.acr_decision = 'skipped' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code='acr_skipped')) OR (analysis_record.acr_decision = 'requires_reference' AND NEW.bound_reference_asset_id IS NULL) OR NOT EXISTS (SELECT 1 FROM media_submission_terms WHERE submission_id = NEW.submission_id AND creation_revision = NEW.creation_revision) THEN RAISE EXCEPTION 'media publication evidence is not ratified'; END IF;
  END IF;
  IF NEW.status = 'published' THEN
    SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
    IF post_record.post_id IS NULL OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title <> NEW.title THEN RAISE EXCEPTION 'media publication Post is not owned by submission'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_submission_update_guard BEFORE UPDATE ON media_post_submissions FOR EACH ROW EXECUTE FUNCTION guard_media_submission_update();

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
    IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_ref = NEW.analysis_snapshot->'boundReference'->>'evidenceRef' AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'analysis bound reference evidence does not match'; END IF;
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
BEGIN
  IF TG_TABLE_NAME = 'media_submission_terms' THEN
    IF NEW.terms_snapshot->>'licensePreset' IS DISTINCT FROM NEW.license_preset
       OR NEW.terms_snapshot->>'accessMode' IS DISTINCT FROM NEW.access_mode
       OR jsonb_typeof(NEW.terms_snapshot->'commercialRemixShareBps') <> 'number'
       OR (NEW.terms_snapshot->>'commercialRemixShareBps')::numeric IS DISTINCT FROM NEW.commercial_remix_share_bps
       OR NEW.terms_snapshot->'royaltyAllocations' IS DISTINCT FROM NEW.royalty_allocations THEN
      RAISE EXCEPTION 'terms snapshot scalars do not match columns';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF jsonb_typeof(NEW.decision_snapshot->'decisionRevision') <> 'number'
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
      IF NEW.analysis_snapshot->'boundReference' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'analysis snapshot bound reference does not match columns'; END IF;
    ELSIF NEW.analysis_snapshot->'boundReference'->>'assetId' IS DISTINCT FROM NEW.bound_reference_asset_id
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioRevision' IS DISTINCT FROM NEW.bound_reference_audio_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAnalysisRevision' IS DISTINCT FROM NEW.bound_reference_analysis_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioSha256' IS DISTINCT FROM NEW.bound_reference_audio_sha256
       OR NEW.analysis_snapshot->'boundReference'->>'upstreamCommercialRevShareBps' IS DISTINCT FROM NEW.bound_reference_upstream_share_bps::text
       OR NEW.analysis_snapshot->'boundReference'->>'inheritedLicensePreset' IS DISTINCT FROM (SELECT inherited_license_preset FROM media_reference_evidence r WHERE r.community_id=NEW.community_id AND r.actor_user_id=NEW.actor_user_id AND r.submission_id=NEW.submission_id AND r.operation_id=NEW.operation_id AND r.asset_id=NEW.bound_reference_asset_id AND r.evidence_audio_revision=NEW.bound_reference_audio_revision AND r.evidence_analysis_revision=NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256=NEW.bound_reference_audio_sha256)
       OR NEW.analysis_snapshot->'boundReference'->>'inheritedCommercialRevShareBps' IS DISTINCT FROM (SELECT inherited_commercial_rev_share_bps::text FROM media_reference_evidence r WHERE r.community_id=NEW.community_id AND r.actor_user_id=NEW.actor_user_id AND r.submission_id=NEW.submission_id AND r.operation_id=NEW.operation_id AND r.asset_id=NEW.bound_reference_asset_id AND r.evidence_audio_revision=NEW.bound_reference_audio_revision AND r.evidence_analysis_revision=NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256=NEW.bound_reference_audio_sha256)
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceRef' IS DISTINCT FROM (SELECT evidence_ref FROM media_reference_evidence r WHERE r.community_id=NEW.community_id AND r.actor_user_id=NEW.actor_user_id AND r.submission_id=NEW.submission_id AND r.operation_id=NEW.operation_id AND r.asset_id=NEW.bound_reference_asset_id AND r.evidence_audio_revision=NEW.bound_reference_audio_revision AND r.evidence_analysis_revision=NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256=NEW.bound_reference_audio_sha256) THEN
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
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL OR NEW.operation_id <> submission_record.operation_id OR NEW.creation_revision <> submission_record.creation_revision OR NEW.audio_revision <> submission_record.audio_revision OR NEW.analysis_revision <> submission_record.analysis_revision OR NEW.workflow_revision <= 0 OR NEW.workflow_instance_id <> 'media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text THEN RAISE EXCEPTION 'media outbox row lineage does not match submission'; END IF;
  IF NEW.event_type = 'analysis_launch' AND ((NEW.payload->>'submission_id') <> NEW.submission_id OR (NEW.payload->>'operation_id') <> NEW.operation_id OR (NEW.payload->>'audio_revision')::bigint <> NEW.audio_revision OR (NEW.payload->>'analysis_revision')::bigint <> NEW.analysis_revision OR (NEW.payload->>'workflow_revision')::bigint <> NEW.workflow_revision OR (NEW.payload->>'workflow_instance_id') <> NEW.workflow_instance_id) THEN RAISE EXCEPTION 'media analysis outbox payload values do not match row'; END IF;
  IF NEW.event_type IN ('publication', 'alignment') AND ((NEW.payload->>'submission_id') <> NEW.submission_id OR (NEW.payload->>'operation_id') <> NEW.operation_id OR (NEW.payload->>'post_id') IS NULL OR (NEW.payload->>'post_id') <> submission_record.post_id OR (NEW.payload->>'workflow_revision')::bigint <> NEW.workflow_revision OR (NEW.payload->>'workflow_instance_id') <> NEW.workflow_instance_id) THEN RAISE EXCEPTION 'media publication outbox payload values do not match row'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_payload_guard BEFORE INSERT ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION validate_media_outbox_payload();

CREATE FUNCTION validate_media_publication_projection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; post_record posts%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
  IF submission_record.status <> 'published' OR submission_record.operation_id <> NEW.operation_id OR submission_record.post_id <> NEW.post_id OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title IS DISTINCT FROM submission_record.title THEN RAISE EXCEPTION 'media publication projection is not owned by its operation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_insert_guard BEFORE INSERT ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION validate_media_publication_projection_insert();
CREATE FUNCTION guard_media_publication_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id,NEW.post_id,NEW.creation_revision,NEW.audio_revision,NEW.analysis_revision,NEW.decision_revision,NEW.canonical_audio_sha256,NEW.title,NEW.audio_asset_ref,NEW.cover_artifact_ref,NEW.language_status,NEW.primary_language_bcp47,NEW.secondary_language_bcp47,NEW.lyrics_explicitness,NEW.analysis_badges,NEW.projected_at) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id,OLD.post_id,OLD.creation_revision,OLD.audio_revision,OLD.analysis_revision,OLD.decision_revision,OLD.canonical_audio_sha256,OLD.title,OLD.audio_asset_ref,OLD.cover_artifact_ref,OLD.language_status,OLD.primary_language_bcp47,OLD.secondary_language_bcp47,OLD.lyrics_explicitness,OLD.analysis_badges,OLD.projected_at) THEN RAISE EXCEPTION 'media publication accepted evidence is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_update_guard BEFORE UPDATE ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION guard_media_publication_projection_update();

CREATE FUNCTION guard_media_processing_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.audio_revision, NEW.analysis_revision, NEW.stage, NEW.attempt_number, NEW.input_hash, NEW.provider_idempotency_key, NEW.input_kind, NEW.input_revision, NEW.policy_revision, NEW.adapter_revision, NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.audio_revision, OLD.analysis_revision, OLD.stage, OLD.attempt_number, OLD.input_hash, OLD.provider_idempotency_key, OLD.input_kind, OLD.input_revision, OLD.policy_revision, OLD.adapter_revision, OLD.created_at) THEN RAISE EXCEPTION 'media processing attempt identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media processing attempt timestamp must advance'; END IF;
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
  IF (OLD.state IN ('pending', 'failed') AND (NEW.state <> 'running' OR NEW.delivery_attempts <> CASE WHEN OLD.delivery_attempts < 3 THEN OLD.delivery_attempts + 1 ELSE OLD.delivery_attempts END OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.delivery_attempts <> CASE WHEN OLD.delivery_attempts < 3 THEN OLD.delivery_attempts + 1 ELSE OLD.delivery_attempts END OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media outbox reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') AND (NEW.delivery_attempts <> OLD.delivery_attempts OR OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL) THEN RAISE EXCEPTION 'media outbox completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'failed', 'running') THEN RAISE EXCEPTION 'media outbox is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_update_guard BEFORE UPDATE ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION guard_media_outbox_update();

CREATE FUNCTION validate_media_alignment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.post_id, NEW.audio_revision, NEW.analysis_revision, NEW.canonical_audio_sha256) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.post_id, OLD.audio_revision, OLD.analysis_revision, OLD.canonical_audio_sha256) THEN RAISE EXCEPTION 'alignment ownership is immutable'; END IF;
  IF NEW.status NOT IN ('ready', 'unavailable') OR NEW.updated_at <= OLD.updated_at OR NEW.alignment_revision <> OLD.alignment_revision + 1 THEN RAISE EXCEPTION 'alignment transition is not allowed'; END IF;
  IF NEW.status = 'ready' AND NEW.current_artifact_ref IS NULL THEN RAISE EXCEPTION 'ready alignment requires immutable artifact'; END IF;
  IF NEW.status = 'unavailable' AND NEW.current_artifact_ref IS NOT NULL THEN RAISE EXCEPTION 'unavailable alignment cannot point to an artifact'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_alignment_update_guard BEFORE UPDATE ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_update();
