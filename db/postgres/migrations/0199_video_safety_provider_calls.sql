-- Durable at-most-one automatic dispatch fence for per-frame video image moderation.
CREATE TABLE media_video_safety_provider_calls (
  operation_id TEXT NOT NULL CHECK (btrim(operation_id) <> ''),
  submission_id TEXT NOT NULL CHECK (btrim(submission_id) <> ''),
  community_id TEXT NOT NULL CHECK (btrim(community_id) <> ''),
  video_revision BIGINT NOT NULL CHECK (video_revision > 0),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 0),
  frame_role TEXT NOT NULL CHECK (frame_role IN ('poster', 'first', 'midpoint')),
  frame_artifact_ref TEXT NOT NULL CHECK (btrim(frame_artifact_ref) <> ''),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
  requested_timestamp_ms BIGINT CHECK (requested_timestamp_ms IS NULL OR requested_timestamp_ms >= 0),
  request_id TEXT NOT NULL UNIQUE CHECK (btrim(request_id) <> ''),
  claim_token TEXT NOT NULL UNIQUE CHECK (
    claim_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  state TEXT NOT NULL CHECK (state IN ('sending', 'succeeded', 'failed')),
  provider_result JSONB,
  provider_failure JSONB,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (operation_id, video_revision, creation_revision, frame_role),
  FOREIGN KEY (community_id, submission_id, operation_id)
    REFERENCES media_post_submissions (community_id, submission_id, operation_id),
  CONSTRAINT media_video_safety_provider_calls_result_shape CHECK (
    (state = 'sending' AND provider_result IS NULL AND provider_failure IS NULL AND resolved_at IS NULL)
    OR COALESCE((
      state = 'succeeded'
      AND provider_result IS NOT NULL
      AND provider_failure IS NULL
      AND resolved_at IS NOT NULL
      AND resolved_at >= claimed_at
      AND jsonb_typeof(provider_result) = 'object'
      AND octet_length(provider_result::text) <= 12288
      AND provider_result ?& ARRAY[
        'provider_id', 'requested_model', 'returned_model', 'input_sha256',
        'matched_categories', 'evidence'
      ]
      AND provider_result - 'provider_id' - 'requested_model' - 'returned_model'
        - 'input_sha256' - 'matched_categories' - 'evidence' = '{}'::jsonb
      AND jsonb_typeof(provider_result->'provider_id') = 'string'
      AND btrim(provider_result->>'provider_id') <> ''
      AND jsonb_typeof(provider_result->'requested_model') = 'string'
      AND btrim(provider_result->>'requested_model') <> ''
      AND jsonb_typeof(provider_result->'returned_model') = 'string'
      AND btrim(provider_result->>'returned_model') <> ''
      AND provider_result->>'input_sha256' = input_sha256
      AND jsonb_typeof(provider_result->'matched_categories') = 'array'
      AND jsonb_typeof(provider_result->'evidence') = 'object'
      AND provider_result->'evidence' ?& ARRAY[
        'input_sha256', 'categories', 'scores', 'applied_input_types'
      ]
      AND (provider_result->'evidence') - 'input_sha256' - 'categories' - 'scores'
        - 'applied_input_types' = '{}'::jsonb
      AND provider_result->'evidence'->>'input_sha256' = input_sha256
      AND jsonb_typeof(provider_result->'evidence'->'categories') = 'object'
      AND jsonb_typeof(provider_result->'evidence'->'scores') = 'object'
      AND jsonb_typeof(provider_result->'evidence'->'applied_input_types') = 'object'
    ), FALSE)
    OR COALESCE((
      state = 'failed'
      AND provider_result IS NULL
      AND provider_failure IS NOT NULL
      AND resolved_at IS NOT NULL
      AND resolved_at >= claimed_at
      AND jsonb_typeof(provider_failure) = 'object'
      AND octet_length(provider_failure::text) <= 512
      AND provider_failure ?& ARRAY['provider_id', 'outcome', 'reason', 'status']
      AND provider_failure - 'provider_id' - 'outcome' - 'reason' - 'status' = '{}'::jsonb
      AND provider_failure->>'provider_id' = 'openai'
      AND provider_failure->>'outcome' = 'non_success'
      AND provider_failure->>'reason' = 'unavailable'
      AND jsonb_typeof(provider_failure->'status') = 'number'
      AND provider_failure->>'status' ~ '^[0-9]{3}$'
      AND (provider_failure->>'status')::integer BETWEEN 300 AND 599
    ), FALSE)
  )
);

CREATE FUNCTION guard_media_video_safety_provider_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
    OR OLD.community_id IS DISTINCT FROM NEW.community_id
    OR OLD.video_revision IS DISTINCT FROM NEW.video_revision
    OR OLD.creation_revision IS DISTINCT FROM NEW.creation_revision
    OR OLD.frame_role IS DISTINCT FROM NEW.frame_role
    OR OLD.frame_artifact_ref IS DISTINCT FROM NEW.frame_artifact_ref
    OR OLD.input_sha256 IS DISTINCT FROM NEW.input_sha256
    OR OLD.timestamp_ms IS DISTINCT FROM NEW.timestamp_ms
    OR OLD.requested_timestamp_ms IS DISTINCT FROM NEW.requested_timestamp_ms
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.claim_token IS DISTINCT FROM NEW.claim_token
    OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
    OR OLD.state <> 'sending'
    OR NEW.state NOT IN ('succeeded', 'failed')
    OR OLD.provider_result IS NOT NULL
    OR OLD.provider_failure IS NOT NULL
    OR OLD.resolved_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'video safety provider call is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER media_video_safety_provider_call_guard
  BEFORE UPDATE ON media_video_safety_provider_calls
  FOR EACH ROW EXECUTE FUNCTION guard_media_video_safety_provider_call();
