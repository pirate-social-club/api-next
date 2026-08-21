-- Text-post runtime persistence owns the reservation and exact original command response.
-- The bytes are retained separately from the mutable current-state columns:
-- replay returns these bytes without rebuilding a response from current rows.

CREATE TABLE text_post_reservations (
  community_id TEXT NOT NULL,
  submission_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface = 'text_post'),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  title TEXT,
  body TEXT,
  policy_revision_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT text_post_reservations_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT text_post_reservations_policy_fk
    FOREIGN KEY (policy_revision_id, policy_hash)
    REFERENCES text_moderation_policy_revisions (policy_revision_id, policy_hash),
  CONSTRAINT text_post_reservations_identifiers_not_blank CHECK (
    btrim(submission_id) <> ''
    AND submission_id = btrim(submission_id)
    AND btrim(actor_user_id) <> ''
    AND actor_user_id = btrim(actor_user_id)
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND ((title IS NOT NULL AND btrim(title) <> '') OR (body IS NOT NULL AND btrim(body) <> ''))
  ),
  CONSTRAINT text_post_reservations_actor_idempotency_unique
    UNIQUE (community_id, actor_user_id, surface, idempotency_key)
);

CREATE INDEX text_post_reservations_actor_created_idx
  ON text_post_reservations (actor_user_id, created_at DESC, submission_id);

ALTER TABLE text_content_submissions
  ADD COLUMN response_snapshot_bytes BYTEA NOT NULL,
  ADD COLUMN response_snapshot_sha256 TEXT NOT NULL
    CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT text_content_submissions_response_snapshot_nonempty
    CHECK (octet_length(response_snapshot_bytes) > 0),
  ADD CONSTRAINT text_content_submissions_response_snapshot_hash
    CHECK (
      encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256
    );

COMMENT ON COLUMN text_content_submissions.response_snapshot_bytes IS
  'Immutable UTF-8 JSON bytes of the original TextContentSubmissionV1 creation response.';

COMMENT ON COLUMN text_content_submissions.response_snapshot_sha256 IS
  'SHA-256 of response_snapshot_bytes; the response bytes are the replay authority.';

CREATE OR REPLACE FUNCTION guard_text_content_submission_response_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.response_snapshot_bytes IS DISTINCT FROM OLD.response_snapshot_bytes
    OR NEW.response_snapshot_sha256 IS DISTINCT FROM OLD.response_snapshot_sha256
  THEN
    RAISE EXCEPTION 'text content submission response snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER text_content_submission_response_snapshot_guard
BEFORE UPDATE ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_response_snapshot();
