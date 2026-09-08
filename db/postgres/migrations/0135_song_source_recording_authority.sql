CREATE TABLE song_source_recording_registrations (
  registration_id TEXT PRIMARY KEY CHECK (registration_id <> '' AND length(registration_id) <= 512),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  author_persona_id TEXT NOT NULL,
  asset_id TEXT NOT NULL UNIQUE,
  submission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  audio_revision INTEGER NOT NULL CHECK (audio_revision > 0),
  analysis_revision INTEGER NOT NULL CHECK (analysis_revision > 0),
  publication_revision INTEGER NOT NULL CHECK (publication_revision > 0),
  terms_revision INTEGER NOT NULL CHECK (terms_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  immutable_audio_ref TEXT NOT NULL CHECK (immutable_audio_ref <> ''),
  verification_sample JSONB NOT NULL CHECK (
    jsonb_typeof(verification_sample) = 'object'
    AND verification_sample ?& ARRAY['objectKey','contentType','byteLength']
    AND verification_sample->>'contentType' IN ('audio/mpeg','audio/wav')
    AND (verification_sample->>'byteLength')::BIGINT > 0
  ),
  provider TEXT NOT NULL CHECK (provider = 'acrcloud'),
  bucket_id TEXT NOT NULL CHECK (bucket_id ~ '^[1-9][0-9]*$'),
  opaque_title TEXT NOT NULL UNIQUE CHECK (opaque_title <> '' AND length(opaque_title) <= 512),
  license_preset TEXT NOT NULL CHECK (license_preset = 'commercial-remix'),
  commercial_remix_share_bps INTEGER NOT NULL CHECK (
    commercial_remix_share_bps BETWEEN 0 AND 10000
  ),
  state TEXT NOT NULL DEFAULT 'pending_upload' CHECK (state IN (
    'pending_upload','provider_outcome_unknown','provider_processing','ready','failed',
    'deletion_pending','deleted'
  )),
  provider_file_id TEXT,
  provider_match_id TEXT,
  upload_evidence_digest TEXT CHECK (
    upload_evidence_digest IS NULL OR upload_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  identification_evidence JSONB,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'catalog_configuration_invalid','catalog_upload_rejected','catalog_record_ambiguous',
    'catalog_record_invalid','catalog_processing_failed','verification_rejected',
    'verification_mismatch'
  )),
  failure_evidence_ref TEXT,
  ready_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, actor_user_id, submission_id)
    REFERENCES media_post_submissions (community_id, actor_user_id, submission_id),
  FOREIGN KEY (community_id, asset_id) REFERENCES posts (community_id, post_id),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CHECK (state NOT IN ('provider_processing','ready') OR
    (provider_file_id IS NOT NULL AND provider_match_id IS NOT NULL)),
  CHECK ((failure_code IS NULL) = (failure_evidence_ref IS NULL))
);

CREATE UNIQUE INDEX song_source_recording_provider_identity_uq
  ON song_source_recording_registrations (provider,bucket_id,provider_match_id)
  WHERE provider_match_id IS NOT NULL;

CREATE TABLE song_source_recording_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (outbox_id <> '' AND length(outbox_id) <= 768),
  registration_id TEXT NOT NULL UNIQUE REFERENCES song_source_recording_registrations,
  effect_identity TEXT NOT NULL UNIQUE CHECK (effect_identity <> ''),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','delivered')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
  lease_expires_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'running') = (claim_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX song_source_recording_outbox_eligible_idx
  ON song_source_recording_outbox (next_eligible_at,created_at,outbox_id)
  WHERE state IN ('pending','running');

CREATE TABLE song_source_recording_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (attempt_id <> '' AND length(attempt_id) <= 1024),
  registration_id TEXT NOT NULL REFERENCES song_source_recording_registrations,
  claim_fence BIGINT NOT NULL CHECK (claim_fence > 0),
  event TEXT NOT NULL CHECK (event IN (
    'provider_file_accepted','provider_outcome_unknown','authority_ready','authority_failed'
  )),
  evidence_ref TEXT NOT NULL CHECK (evidence_ref <> ''),
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION guard_song_source_recording_registration() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.registration_id,NEW.community_id,NEW.actor_user_id,NEW.author_persona_id,
         NEW.asset_id,NEW.submission_id,NEW.operation_id,NEW.audio_revision,
         NEW.analysis_revision,NEW.publication_revision,NEW.terms_revision,
         NEW.canonical_audio_sha256,NEW.immutable_audio_ref,NEW.verification_sample,
         NEW.provider,NEW.bucket_id,NEW.opaque_title,NEW.license_preset,
         NEW.commercial_remix_share_bps,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.registration_id,OLD.community_id,OLD.actor_user_id,OLD.author_persona_id,
         OLD.asset_id,OLD.submission_id,OLD.operation_id,OLD.audio_revision,
         OLD.analysis_revision,OLD.publication_revision,OLD.terms_revision,
         OLD.canonical_audio_sha256,OLD.immutable_audio_ref,OLD.verification_sample,
         OLD.provider,OLD.bucket_id,OLD.opaque_title,OLD.license_preset,
         OLD.commercial_remix_share_bps,OLD.created_at)
  THEN RAISE EXCEPTION 'song source recording identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'song source recording transition did not advance';
  END IF;
  IF OLD.state = 'pending_upload' AND NEW.state NOT IN
      ('provider_outcome_unknown','provider_processing','failed') THEN
    RAISE EXCEPTION 'invalid song source pending transition';
  ELSIF OLD.state = 'provider_outcome_unknown' AND NEW.state NOT IN
      ('provider_processing','failed') THEN
    RAISE EXCEPTION 'invalid song source reconciliation transition';
  ELSIF OLD.state = 'provider_processing' AND NEW.state NOT IN
      ('provider_processing','ready','failed') THEN
    RAISE EXCEPTION 'invalid song source processing transition';
  ELSIF OLD.state IN ('ready','failed','deleted') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'terminal song source recording state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER song_source_recording_registration_guard
BEFORE UPDATE ON song_source_recording_registrations
FOR EACH ROW EXECUTE FUNCTION guard_song_source_recording_registration();
