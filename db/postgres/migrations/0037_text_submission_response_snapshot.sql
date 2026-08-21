-- Order 5 text runtime additions. Terminal-only migration: no reservation
-- rows, legacy reads, or historical backfill are permitted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM text_content_submissions)
    OR EXISTS (SELECT 1 FROM text_content_held_revisions)
    OR EXISTS (SELECT 1 FROM text_moderation_cases)
    OR EXISTS (SELECT 1 FROM text_moderation_evidence)
    OR EXISTS (
      SELECT 1 FROM home_feed_projection AS feed
      JOIN text_content_submissions AS submission
        ON submission.community_id = feed.community_id
       AND submission.published_post_id = feed.post_id
    )
  THEN
    RAISE EXCEPTION
      '0037 text runtime requires empty text tables and dependents; no backfill is permitted';
  END IF;
END;
$$;

ALTER TABLE text_content_submissions
  DROP CONSTRAINT IF EXISTS text_content_submissions_evidence_fk,
  ADD COLUMN operation_id TEXT NOT NULL,
  ADD CONSTRAINT text_content_submissions_operation_id_not_blank CHECK (
    btrim(operation_id) <> '' AND operation_id = btrim(operation_id)
  ),
  ADD CONSTRAINT text_content_submissions_operation_id_unique UNIQUE (operation_id),
  ADD COLUMN response_snapshot_bytes BYTEA NOT NULL,
  ADD COLUMN response_snapshot_sha256 TEXT NOT NULL
    CHECK (response_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT text_content_submissions_response_snapshot_nonempty
    CHECK (octet_length(response_snapshot_bytes) > 0),
  ADD CONSTRAINT text_content_submissions_response_snapshot_hash
    CHECK (encode(sha256(response_snapshot_bytes), 'hex') = response_snapshot_sha256);

COMMENT ON COLUMN text_content_submissions.operation_id IS
  'Internal spec-013 posting operation identity; never exposed publicly.';
COMMENT ON COLUMN text_content_submissions.response_snapshot_bytes IS
  'Immutable UTF-8 JSON bytes of the original TextContentSubmissionV1 creation response.';
COMMENT ON COLUMN text_content_submissions.response_snapshot_sha256 IS
  'SHA-256 of response_snapshot_bytes; replay returns those bytes.';

CREATE OR REPLACE FUNCTION guard_text_content_submission_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.submission_id, NEW.operation_id, NEW.actor_user_id,
    NEW.surface, NEW.idempotency_key, NEW.request_hash, NEW.moderation_decision,
    NEW.policy_revision_id, NEW.policy_hash, NEW.input_sha256,
    NEW.internal_reason_codes, NEW.evidence_ref, NEW.created_at,
    NEW.response_snapshot_bytes, NEW.response_snapshot_sha256
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.submission_id, OLD.operation_id, OLD.actor_user_id,
    OLD.surface, OLD.idempotency_key, OLD.request_hash, OLD.moderation_decision,
    OLD.policy_revision_id, OLD.policy_hash, OLD.input_sha256,
    OLD.internal_reason_codes, OLD.evidence_ref, OLD.created_at,
    OLD.response_snapshot_bytes, OLD.response_snapshot_sha256
  ) THEN
    RAISE EXCEPTION 'text content submission evidence and creation snapshot are immutable';
  END IF;
  IF OLD.status <> 'manual_review' OR NEW.status NOT IN ('published', 'blocked') THEN
    RAISE EXCEPTION 'text content submission transition is not allowed: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text content submission updated_at must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_text_content_submission_response_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.response_snapshot_bytes IS DISTINCT FROM OLD.response_snapshot_bytes
    OR NEW.response_snapshot_sha256 IS DISTINCT FROM OLD.response_snapshot_sha256
  THEN
    RAISE EXCEPTION 'text content submission response snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS text_content_submission_response_snapshot_guard ON text_content_submissions;
CREATE TRIGGER text_content_submission_response_snapshot_guard
BEFORE UPDATE ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_response_snapshot();
