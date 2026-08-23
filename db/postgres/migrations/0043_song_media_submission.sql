-- Spec 013 song-media persistence.  This migration is intentionally additive:
-- no provider, Queue, Workflow, or object-store call belongs in these rows.

CREATE TABLE media_upload_reservations (
  reservation_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/media-upload-reservations'
    CHECK (endpoint_template = '/communities/:communityId/media-upload-reservations'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  track TEXT NOT NULL CHECK (track = 'song'),
  slot TEXT NOT NULL CHECK (slot = 'primary_audio'),
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
  CONSTRAINT media_upload_reservations_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  CONSTRAINT media_upload_reservations_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id),
  CONSTRAINT media_upload_reservations_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT media_upload_reservations_time_check CHECK (updated_at >= created_at),
  CONSTRAINT media_upload_reservations_terminal_shape CHECK (
    (state = 'issued' AND submission_id IS NULL AND operation_id IS NULL)
    OR (state = 'expired')
    OR (state IN ('claimed', 'sealed', 'rejected') AND submission_id IS NOT NULL AND operation_id IS NOT NULL)
  ),
  CONSTRAINT media_upload_reservations_identity_unique UNIQUE (actor_user_id, endpoint_template, idempotency_key)
);

CREATE INDEX media_upload_reservations_expiry_idx
  ON media_upload_reservations (state, expires_at, reservation_id)
  WHERE state IN ('issued', 'claimed');

CREATE TABLE media_immutable_objects (
  immutable_ref TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL UNIQUE CHECK (btrim(destination_ref) <> ''),
  etag TEXT NOT NULL CHECK (btrim(etag) <> ''),
  object_version TEXT NOT NULL CHECK (btrim(object_version) <> ''),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  content_type TEXT NOT NULL CHECK (
    content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'
  ),
  canonical_sha256 TEXT CHECK (canonical_sha256 IS NULL OR canonical_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_immutable_objects_reservation_fk FOREIGN KEY (reservation_id) REFERENCES media_upload_reservations(reservation_id),
  CONSTRAINT media_immutable_objects_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  CONSTRAINT media_immutable_objects_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id),
  CONSTRAINT media_immutable_objects_identity_unique UNIQUE (reservation_id),
  CONSTRAINT media_immutable_objects_operation_unique UNIQUE (operation_id)
);

CREATE TABLE media_post_submissions (
  submission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/media-post-submissions'
    CHECK (endpoint_template = '/communities/:communityId/media-post-submissions'),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  track TEXT NOT NULL CHECK (track = 'song'),
  author_input JSONB NOT NULL CHECK (jsonb_typeof(author_input) = 'object'),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  lyrics TEXT,
  rights_kind TEXT NOT NULL CHECK (rights_kind IN ('original', 'derivative')),
  upstream_asset_id TEXT,
  license_preset TEXT NOT NULL CHECK (license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')),
  commercial_rev_share_bps INTEGER NOT NULL CHECK (commercial_rev_share_bps BETWEEN 0 AND 10000),
  royalty_allocations JSONB NOT NULL CHECK (jsonb_typeof(royalty_allocations) = 'array'),
  access_mode TEXT NOT NULL CHECK (access_mode = 'public'),
  audio_reservation_id TEXT NOT NULL,
  immutable_ref TEXT,
  creation_revision BIGINT NOT NULL DEFAULT 1 CHECK (creation_revision > 0),
  workflow_revision BIGINT NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'action_required', 'manual_review', 'published', 'blocked', 'processing_failed', 'abandoned')),
  phase TEXT CHECK (phase IS NULL OR phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  reason_code TEXT,
  retryable BOOLEAN,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 3),
  last_safe_phase TEXT CHECK (last_safe_phase IS NULL OR last_safe_phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  action_expires_at TIMESTAMPTZ,
  reference_request_ref TEXT,
  review_ref TEXT,
  held_revision BIGINT,
  post_id TEXT,
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_post_submissions_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  CONSTRAINT media_post_submissions_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id),
  CONSTRAINT media_post_submissions_reservation_fk FOREIGN KEY (audio_reservation_id) REFERENCES media_upload_reservations(reservation_id),
  CONSTRAINT media_post_submissions_object_fk FOREIGN KEY (immutable_ref) REFERENCES media_immutable_objects(immutable_ref),
  CONSTRAINT media_post_submissions_response_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  ),
  CONSTRAINT media_post_submissions_time_check CHECK (updated_at >= created_at),
  CONSTRAINT media_post_submissions_key_unique UNIQUE (actor_user_id, endpoint_template, idempotency_key),
  CONSTRAINT media_post_submissions_phase_shape CHECK (
    (status = 'processing' AND phase IS NOT NULL)
    OR status <> 'processing'
  ),
  CONSTRAINT media_post_submissions_status_shape CHECK (
    (status = 'published' AND post_id IS NOT NULL AND phase IS NULL AND retryable IS NULL)
    OR (status = 'manual_review' AND review_ref IS NOT NULL AND held_revision IS NOT NULL AND post_id IS NULL)
    OR (status = 'action_required' AND action_expires_at IS NOT NULL AND reference_request_ref IS NOT NULL AND post_id IS NULL)
    OR (status = 'processing_failed' AND reason_code IS NOT NULL AND retryable IS NOT NULL AND post_id IS NULL)
    OR (status = 'blocked' AND post_id IS NULL AND held_revision IS NULL)
    OR (status = 'abandoned' AND reason_code IS NOT NULL AND post_id IS NULL)
    OR (status = 'processing')
  )
);

CREATE INDEX media_post_submissions_author_idx
  ON media_post_submissions (actor_user_id, updated_at DESC, submission_id);

CREATE TABLE media_submission_command_replays (
  actor_user_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  response_snapshot_bytes BYTEA NOT NULL,
  response_snapshot_sha256 TEXT NOT NULL CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, endpoint_template, idempotency_key),
  CONSTRAINT media_submission_command_replays_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(user_id),
  CONSTRAINT media_submission_command_replays_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_submission_command_replays_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_submission_command_replays_hash CHECK (
    octet_length(response_snapshot_bytes) > 0
    AND encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
  )
);

CREATE TABLE media_submission_revisions (
  submission_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish')),
  status TEXT NOT NULL CHECK (status IN ('processing', 'action_required', 'manual_review', 'published', 'blocked', 'processing_failed', 'abandoned')),
  event TEXT NOT NULL CHECK (btrim(event) <> ''),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, creation_revision),
  CONSTRAINT media_submission_revisions_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_submission_revisions_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_submission_revisions_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
);

CREATE TABLE media_processing_attempts (
  attempt_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  stage TEXT NOT NULL CHECK (stage IN ('probe', 'hash', 'transform', 'acr', 'lyrics_safety', 'media_safety', 'publication')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'retry_wait', 'succeeded', 'exhausted')),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  policy_revision TEXT,
  adapter_revision TEXT,
  lease_owner TEXT,
  fence_token BIGINT,
  provider_idempotency_key TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0 AND attempt_number <= 3),
  retryable BOOLEAN,
  failure_code TEXT,
  next_eligible_at TIMESTAMPTZ,
  evidence_ref TEXT,
  result JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_processing_attempts_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_processing_attempts_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_processing_attempts_identity_unique UNIQUE (operation_id, creation_revision, stage, attempt_number),
  CONSTRAINT media_processing_attempts_state_shape CHECK (
    (state = 'pending' AND started_at IS NULL AND completed_at IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND lease_owner IS NOT NULL AND fence_token IS NOT NULL)
    OR (state = 'retry_wait' AND completed_at IS NOT NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL)
    OR (state = 'succeeded' AND completed_at IS NOT NULL AND result IS NOT NULL AND evidence_ref IS NOT NULL)
    OR (state = 'exhausted' AND completed_at IS NOT NULL AND failure_code IS NOT NULL AND retryable = FALSE)
  )
);

CREATE INDEX media_processing_attempts_work_idx
  ON media_processing_attempts (state, next_eligible_at, created_at, attempt_id)
  WHERE state IN ('pending', 'retry_wait', 'running');

CREATE TABLE media_moderation_projections (
  submission_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('none', 'open', 'approved', 'blocked', 'closed')),
  held_revision BIGINT,
  review_ref TEXT,
  reason_code TEXT,
  moderator_actor_id TEXT,
  action_id TEXT,
  action_evidence_ref TEXT,
  action_created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_moderation_projections_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_moderation_projections_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_moderation_projections_action_shape CHECK (
    (status IN ('none', 'open') AND moderator_actor_id IS NULL AND action_id IS NULL)
    OR status IN ('approved', 'blocked', 'closed')
  )
);

CREATE TABLE media_publication_projections (
  submission_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  audio_asset_ref TEXT NOT NULL,
  analysis_badges JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (analysis_badges IN ('[]'::jsonb, '["reference_bound"]'::jsonb)),
  language_detection TEXT NOT NULL DEFAULT 'pending' CHECK (language_detection IN ('pending', 'ready', 'unavailable')),
  alignment TEXT NOT NULL CHECK (alignment IN ('pending', 'ready', 'unavailable')),
  data_registration TEXT NOT NULL DEFAULT 'pending' CHECK (data_registration IN ('pending', 'registered', 'failed')),
  locked_delivery TEXT NOT NULL DEFAULT 'not_required' CHECK (locked_delivery IN ('not_required', 'preparing', 'ready', 'failed')),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_publication_projections_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_publication_projections_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_publication_projections_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id),
  CONSTRAINT media_publication_projections_post_unique UNIQUE (community_id, post_id)
);

CREATE TABLE media_submission_outbox (
  outbox_event_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  workflow_revision BIGINT NOT NULL CHECK (workflow_revision > 0),
  workflow_instance_id TEXT NOT NULL CHECK (btrim(workflow_instance_id) <> ''),
  event_type TEXT NOT NULL CHECK (event_type IN ('analysis_launch', 'publication', 'reference_wakeup', 'retry_wakeup')),
  effect_identity TEXT NOT NULL UNIQUE CHECK (btrim(effect_identity) <> ''),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'delivered', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  claimed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_submission_outbox_submission_fk FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
  CONSTRAINT media_submission_outbox_operation_fk FOREIGN KEY (operation_id) REFERENCES media_post_submissions(operation_id),
  CONSTRAINT media_submission_outbox_effect_shape CHECK (
    (state = 'delivered' AND delivered_at IS NOT NULL)
    OR (state IN ('pending', 'claimed', 'failed') AND delivered_at IS NULL)
  )
);

CREATE INDEX media_submission_outbox_pending_idx
  ON media_submission_outbox (state, created_at, outbox_event_id)
  WHERE state IN ('pending', 'claimed', 'failed');

CREATE OR REPLACE FUNCTION guard_media_upload_reservation_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.reservation_id, NEW.community_id, NEW.actor_user_id, NEW.endpoint_template,
    NEW.idempotency_key, NEW.request_hash, NEW.track, NEW.slot,
    NEW.expected_content_type, NEW.expected_size_bytes, NEW.expected_sha256,
    NEW.upload_url, NEW.upload_headers, NEW.expires_at, NEW.response_snapshot_bytes,
    NEW.response_snapshot_sha256, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.reservation_id, OLD.community_id, OLD.actor_user_id, OLD.endpoint_template,
    OLD.idempotency_key, OLD.request_hash, OLD.track, OLD.slot,
    OLD.expected_content_type, OLD.expected_size_bytes, OLD.expected_sha256,
    OLD.upload_url, OLD.upload_headers, OLD.expires_at, OLD.response_snapshot_bytes,
    OLD.response_snapshot_sha256, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'media upload reservation authority is immutable';
  END IF;
  IF OLD.state IN ('sealed', 'rejected', 'expired') THEN
    RAISE EXCEPTION 'terminal media upload reservation is immutable';
  END IF;
  IF NEW.state NOT IN ('issued', 'claimed', 'sealed', 'rejected', 'expired') THEN
    RAISE EXCEPTION 'invalid media upload reservation state';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'media upload reservation updated_at must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_upload_reservation_update_guard
BEFORE UPDATE ON media_upload_reservations
FOR EACH ROW EXECUTE FUNCTION guard_media_upload_reservation_update();

CREATE OR REPLACE FUNCTION guard_media_immutable_object_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media immutable object is immutable';
END;
$$;

CREATE TRIGGER media_immutable_object_update_guard
BEFORE UPDATE ON media_immutable_objects
FOR EACH ROW EXECUTE FUNCTION guard_media_immutable_object_update();

CREATE OR REPLACE FUNCTION guard_media_submission_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id,
    NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.track,
    NEW.author_input, NEW.title, NEW.lyrics, NEW.rights_kind, NEW.upstream_asset_id,
    NEW.license_preset, NEW.commercial_rev_share_bps, NEW.royalty_allocations,
    NEW.access_mode, NEW.audio_reservation_id, NEW.response_snapshot_bytes,
    NEW.response_snapshot_sha256, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id,
    OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.track,
    OLD.author_input, OLD.title, OLD.lyrics, OLD.rights_kind, OLD.upstream_asset_id,
    OLD.license_preset, OLD.commercial_rev_share_bps, OLD.royalty_allocations,
    OLD.access_mode, OLD.audio_reservation_id, OLD.response_snapshot_bytes,
    OLD.response_snapshot_sha256, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'media submission authority and creation snapshot are immutable';
  END IF;
  IF OLD.status IN ('published', 'blocked', 'abandoned') THEN
    RAISE EXCEPTION 'terminal media submission is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'media submission updated_at must advance';
  END IF;
  IF NEW.creation_revision < OLD.creation_revision THEN
    RAISE EXCEPTION 'media submission creation revision must not decrease';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_submission_update_guard
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW EXECUTE FUNCTION guard_media_submission_update();

CREATE OR REPLACE FUNCTION guard_media_processing_attempt_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.operation_id, NEW.creation_revision, NEW.stage,
         NEW.attempt_number, NEW.input_hash, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.attempt_id, OLD.submission_id, OLD.operation_id, OLD.creation_revision,
         OLD.stage, OLD.attempt_number, OLD.input_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'media processing attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_processing_attempt_update_guard
BEFORE UPDATE ON media_processing_attempts
FOR EACH ROW EXECUTE FUNCTION guard_media_processing_attempt_update();

CREATE OR REPLACE FUNCTION guard_media_command_replay_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media command replay is immutable';
END;
$$;

CREATE TRIGGER media_command_replay_update_guard
BEFORE UPDATE ON media_submission_command_replays
FOR EACH ROW EXECUTE FUNCTION guard_media_command_replay_update();
