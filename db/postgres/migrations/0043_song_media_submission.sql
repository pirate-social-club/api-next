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
  retryable BOOLEAN,
  last_safe_phase TEXT CHECK (last_safe_phase IS NULL OR last_safe_phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  action_kind TEXT CHECK (action_kind IS NULL OR action_kind = 'reference_required'),
  action_reference_request_ref TEXT,
  action_expires_at TIMESTAMPTZ,
  held_revision BIGINT,
  review_ref TEXT,
  review_reason_code TEXT CHECK (review_reason_code IS NULL OR review_reason_code IN ('review_required', 'moderation_unavailable')),
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  moderator_evidence_ref TEXT,
  moderator_reason_code TEXT CHECK (moderator_reason_code IS NULL OR moderator_reason_code IN ('acr_inconclusive', 'acr_exhausted', 'acr_skipped')),
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
    OR (status = 'manual_review' AND phase IS NULL AND review_ref IS NOT NULL AND held_revision = creation_revision AND post_id IS NULL)
    OR (status = 'published' AND phase IS NULL AND post_id IS NOT NULL AND failure_code IS NULL)
    OR (status = 'blocked' AND phase IS NULL AND post_id IS NULL)
    OR (status = 'processing_failed' AND phase IS NULL AND failure_code IS NOT NULL AND last_safe_phase IS NOT NULL AND post_id IS NULL)
    OR (status = 'abandoned' AND phase IS NULL AND post_id IS NULL)
  ),
  CONSTRAINT media_post_submissions_revision_shape CHECK (
    (audio_revision = 0 AND current_immutable_ref IS NULL)
    OR (audio_revision > 0 AND current_immutable_ref IS NOT NULL)
  ),
  CONSTRAINT media_post_submissions_reference_shape CHECK (
    (bound_reference_asset_id IS NULL AND bound_reference_audio_revision IS NULL AND bound_reference_analysis_revision IS NULL AND bound_reference_audio_sha256 IS NULL AND bound_reference_upstream_share_bps IS NULL)
    OR (bound_reference_asset_id IS NOT NULL AND bound_reference_audio_revision = audio_revision AND bound_reference_analysis_revision > 0 AND bound_reference_audio_sha256 ~ '^[0-9a-f]{64}$' AND bound_reference_upstream_share_bps BETWEEN 0 AND 10000)
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
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, audio_revision),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, immutable_ref) REFERENCES media_immutable_objects (community_id, immutable_ref),
  UNIQUE (submission_id, audio_revision, canonical_sha256, immutable_ref),
  UNIQUE (submission_id, audio_revision, canonical_sha256)
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
  transcript_text TEXT,
  segments JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256)
    REFERENCES media_audio_revisions (submission_id, audio_revision, canonical_sha256)
);

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
  embedded_title TEXT,
  embedded_title_provenance TEXT NOT NULL CHECK (embedded_title_provenance IN ('embedded', 'absent')),
  cover_status TEXT NOT NULL CHECK (cover_status IN ('ready', 'absent', 'rejected')),
  cover_artifact_ref TEXT,
  cover_artifact_sha256 TEXT CHECK (cover_artifact_sha256 IS NULL OR cover_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  cover_media_type TEXT,
  cover_width INTEGER,
  cover_height INTEGER,
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
  CONSTRAINT media_analysis_title_shape CHECK ((embedded_title_provenance = 'embedded' AND embedded_title IS NOT NULL) OR (embedded_title_provenance = 'absent' AND embedded_title IS NULL)),
  CONSTRAINT media_analysis_cover_shape CHECK ((cover_status = 'ready' AND cover_artifact_ref IS NOT NULL AND cover_artifact_sha256 IS NOT NULL AND cover_media_type IN ('image/jpeg', 'image/png', 'image/webp') AND cover_width > 0 AND cover_height > 0) OR (cover_status IN ('absent', 'rejected') AND cover_artifact_ref IS NULL AND cover_artifact_sha256 IS NULL AND cover_media_type IS NULL AND cover_width IS NULL AND cover_height IS NULL)),
  CONSTRAINT media_analysis_speech_shape CHECK (
    (speech_status = 'ready' AND transcript_artifact_ref IS NOT NULL AND transcript_sha256 IS NOT NULL AND explicitness IN ('not_explicit', 'explicit', 'uncertain') AND primary_language_bcp47 IS NOT NULL AND secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47)
    OR (speech_status = 'no_speech' AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL AND explicitness = 'no_lyrics' AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL)
    OR (speech_status = 'unavailable' AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL AND explicitness = 'uncertain' AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL)
  ),
  CONSTRAINT media_analysis_reference_shape CHECK ((bound_reference_asset_id IS NULL AND bound_reference_audio_revision IS NULL AND bound_reference_analysis_revision IS NULL AND bound_reference_audio_sha256 IS NULL AND bound_reference_upstream_share_bps IS NULL) OR (bound_reference_asset_id IS NOT NULL AND bound_reference_audio_revision = audio_revision AND bound_reference_analysis_revision > 0 AND bound_reference_audio_sha256 = canonical_audio_sha256 AND bound_reference_upstream_share_bps BETWEEN 0 AND 10000))
);

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
  event_kind TEXT NOT NULL CHECK (event_kind IN ('submission_reserved', 'terms_bound', 'audio_finalized', 'analysis_accepted', 'decision_recorded', 'reference_required', 'reference_bound', 'review_required', 'moderator_approved', 'moderator_blocked', 'publication_committed', 'technical_exhaustion_recorded', 'retry_authorized', 'submission_abandoned')),
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
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'retry_wait', 'succeeded', 'exhausted')),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  retryable BOOLEAN,
  failure_code TEXT,
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
    OR (state = 'claimed' AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL)
    OR (state = 'retry_wait' AND claim_owner IS NULL AND lease_expires_at IS NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL)
    OR (state = 'succeeded' AND claim_owner IS NULL AND lease_expires_at IS NULL AND evidence_ref IS NOT NULL AND result IS NOT NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND lease_expires_at IS NULL AND retryable = FALSE AND failure_code IS NOT NULL)
  )
);
CREATE INDEX media_processing_attempts_claim_idx ON media_processing_attempts (state, next_eligible_at, lease_expires_at, attempt_id) WHERE state IN ('pending', 'claimed', 'retry_wait');

CREATE TABLE media_moderation_projections (
  submission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('none', 'open', 'approved', 'blocked', 'closed')),
  decision_revision BIGINT,
  review_ref TEXT,
  moderator_action_id TEXT,
  moderator_actor_id TEXT,
  action_evidence_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, actor_user_id, submission_id, operation_id)
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
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact JSONB NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections (community_id, actor_user_id, post_id)
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
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'unavailable')),
  current_artifact_ref TEXT,
  failure_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections (community_id, actor_user_id, post_id),
  FOREIGN KEY (current_artifact_ref) REFERENCES media_timed_lyrics_artifacts (artifact_ref),
  UNIQUE (community_id, actor_user_id, post_id)
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
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'delivered', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id, operation_id),
  UNIQUE (community_id, actor_user_id, effect_identity),
  UNIQUE (community_id, actor_user_id, submission_id, workflow_revision, event_type),
  CONSTRAINT media_submission_outbox_state_shape CHECK (
    (state = 'pending' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
    OR (state = 'claimed' AND claim_owner IS NOT NULL AND claim_fence > 0 AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
    OR (state = 'failed' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND failure_code IS NOT NULL AND next_eligible_at IS NOT NULL)
    OR (state = 'delivered' AND claim_owner IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
  )
);
CREATE INDEX media_submission_outbox_claim_idx ON media_submission_outbox (state, next_eligible_at, lease_expires_at, created_at, outbox_event_id) WHERE state IN ('pending', 'claimed', 'failed');

CREATE FUNCTION reject_media_append_only_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['media_immutable_objects','media_submission_terms','media_audio_revisions','media_transcript_artifacts','media_analysis_evidence','media_publication_decisions','media_submission_events','media_submission_command_replays','media_timed_lyrics_artifacts'] LOOP
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
DECLARE allowed BOOLEAN := FALSE; community_active BOOLEAN; membership_active BOOLEAN;
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.title, NEW.song_type, NEW.start_input, NEW.audio_reservation_id, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.title, OLD.song_type, OLD.start_input, OLD.audio_reservation_id, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media submission authority is immutable'; END IF;
  IF NEW.event_sequence <> OLD.event_sequence + 1 OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media submission transition fence did not advance'; END IF;
  allowed := (OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision)
    OR (OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.audio_revision = OLD.audio_revision + 1 AND NEW.workflow_revision = OLD.workflow_revision + 1)
    OR (OLD.status = 'processing' AND NEW.status = 'processing' AND NEW.analysis_revision = OLD.analysis_revision + 1)
    OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'manual_review', 'blocked') AND NEW.decision_revision = OLD.decision_revision + 1)
    OR (OLD.status = 'processing' AND NEW.status = 'action_required' AND NEW.action_kind = 'reference_required')
    OR (OLD.status = 'action_required' AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1)
    OR (OLD.status = 'manual_review' AND NEW.status IN ('processing', 'blocked'))
    OR (OLD.status = 'processing' AND NEW.status = 'published' AND NEW.workflow_revision = OLD.workflow_revision + 1)
    OR (OLD.status = 'processing' AND NEW.status = 'processing_failed' AND NEW.failure_code IS NOT NULL)
    OR (OLD.status = 'processing_failed' AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.retry_count = OLD.retry_count + 1)
    OR (OLD.status = 'action_required' AND NEW.status = 'abandoned')
    OR (OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.audio_revision = OLD.audio_revision);
  IF NOT allowed THEN RAISE EXCEPTION 'media submission transition is not allowed'; END IF;
  IF NEW.status = 'published' THEN
    SELECT status = 'active' INTO community_active FROM communities WHERE community_id = NEW.community_id FOR SHARE;
    SELECT status = 'member' INTO membership_active FROM community_memberships WHERE community_id = NEW.community_id AND user_id = NEW.actor_user_id FOR SHARE;
    IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'media publication requires active community membership'; END IF;
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

CREATE FUNCTION validate_media_outbox_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys TEXT[]; expected TEXT[];
BEGIN
  keys := ARRAY(SELECT jsonb_object_keys(NEW.payload) ORDER BY 1);
  IF NEW.event_type = 'analysis_launch' THEN expected := ARRAY['analysis_revision','audio_revision','kind','operation_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSIF NEW.event_type = 'publication' THEN expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSE expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision']; END IF;
  IF keys IS DISTINCT FROM expected THEN RAISE EXCEPTION 'media outbox payload is not a closed identifier union'; END IF;
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
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id,NEW.post_id,NEW.creation_revision,NEW.audio_revision,NEW.analysis_revision,NEW.decision_revision,NEW.canonical_audio_sha256,NEW.title,NEW.audio_asset_ref,NEW.cover_artifact_ref,NEW.language_status,NEW.primary_language_bcp47,NEW.secondary_language_bcp47,NEW.lyrics_explicitness,NEW.projected_at) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id,OLD.post_id,OLD.creation_revision,OLD.audio_revision,OLD.analysis_revision,OLD.decision_revision,OLD.canonical_audio_sha256,OLD.title,OLD.audio_asset_ref,OLD.cover_artifact_ref,OLD.language_status,OLD.primary_language_bcp47,OLD.secondary_language_bcp47,OLD.lyrics_explicitness,OLD.projected_at) THEN RAISE EXCEPTION 'media publication accepted evidence is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_update_guard BEFORE UPDATE ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION guard_media_publication_projection_update();

CREATE FUNCTION guard_media_processing_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.audio_revision, NEW.analysis_revision, NEW.stage, NEW.attempt_number, NEW.input_hash, NEW.provider_idempotency_key, NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.audio_revision, OLD.analysis_revision, OLD.stage, OLD.attempt_number, OLD.input_hash, OLD.provider_idempotency_key, OLD.created_at) THEN RAISE EXCEPTION 'media processing attempt identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media processing attempt timestamp must advance'; END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state = 'claimed') OR (OLD.state = 'claimed' AND NEW.state IN ('succeeded', 'retry_wait', 'exhausted')) OR (OLD.state = 'claimed' AND NEW.state = 'claimed' AND NEW.claim_fence = OLD.claim_fence + 1) OR (OLD.state = 'retry_wait' AND NEW.state = 'claimed')) THEN RAISE EXCEPTION 'media processing attempt transition is not allowed'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_processing_attempt_update_guard BEFORE UPDATE ON media_processing_attempts FOR EACH ROW EXECUTE FUNCTION guard_media_processing_attempt_update();

CREATE FUNCTION guard_media_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.outbox_event_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.creation_revision, NEW.audio_revision, NEW.analysis_revision, NEW.workflow_revision, NEW.workflow_instance_id, NEW.event_type, NEW.effect_identity, NEW.payload, NEW.created_at) IS DISTINCT FROM ROW(OLD.outbox_event_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.creation_revision, OLD.audio_revision, OLD.analysis_revision, OLD.workflow_revision, OLD.workflow_instance_id, OLD.event_type, OLD.effect_identity, OLD.payload, OLD.created_at) THEN RAISE EXCEPTION 'media outbox effect identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.claim_fence < OLD.claim_fence THEN RAISE EXCEPTION 'media outbox fence must advance'; END IF;
  IF NOT ((OLD.state IN ('pending', 'failed') AND NEW.state = 'claimed') OR (OLD.state = 'claimed' AND NEW.state = 'claimed' AND NEW.claim_fence = OLD.claim_fence + 1) OR (OLD.state = 'claimed' AND NEW.state IN ('delivered', 'failed') AND NEW.claim_fence = OLD.claim_fence)) THEN RAISE EXCEPTION 'media outbox transition is not allowed'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_update_guard BEFORE UPDATE ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION guard_media_outbox_update();

CREATE FUNCTION validate_media_alignment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.post_id, NEW.audio_revision, NEW.analysis_revision, NEW.canonical_audio_sha256) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.post_id, OLD.audio_revision, OLD.analysis_revision, OLD.canonical_audio_sha256) THEN RAISE EXCEPTION 'alignment ownership is immutable'; END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('ready', 'unavailable') OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'alignment transition is not allowed'; END IF;
  IF NEW.status = 'ready' AND NEW.current_artifact_ref IS NULL THEN RAISE EXCEPTION 'ready alignment requires immutable artifact'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_alignment_update_guard BEFORE UPDATE ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_update();
