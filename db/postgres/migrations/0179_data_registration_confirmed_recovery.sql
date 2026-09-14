-- Confirmed DATA recovery. A confirmed receipt observation now persists the
-- terms a song attached, so terminal reconciliation can complete a
-- registration without a provider read or another submission. The publication
-- projection guard distinguishes media kinds so a video registration can
-- complete through the same confirmation fence. An observation that predates
-- this evidence stays escalation-only, and an operator-authorized resume
-- re-arms observation for that row; the resume is durable only together with
-- its exact audit, attempt and fresh launch.

-- 1. The terms a confirmed song attached, stored with the observation that
-- carries the registration. The attachment coordinates are the confirming
-- transaction's own; a video or non-confirmed observation stores none.
ALTER TABLE data_registration_receipt_observations
  ADD COLUMN attached_license_template TEXT,
  ADD COLUMN attached_license_terms_id TEXT,
  ADD COLUMN attached_license_preset TEXT,
  ADD COLUMN attached_commercial_rev_share_bps INTEGER,
  ADD COLUMN terms_attachment_transaction_hash TEXT,
  ADD COLUMN terms_attachment_block_number BIGINT,
  ADD COLUMN terms_attachment_block_hash TEXT,
  ADD COLUMN terms_attachment_log_index INTEGER;

ALTER TABLE data_registration_receipt_observations
  ADD CONSTRAINT data_registration_receipt_attached_license_shape CHECK (
    (
      attached_license_template IS NULL
      AND attached_license_terms_id IS NULL
      AND attached_license_preset IS NULL
      AND attached_commercial_rev_share_bps IS NULL
      AND terms_attachment_transaction_hash IS NULL
      AND terms_attachment_block_number IS NULL
      AND terms_attachment_block_hash IS NULL
      AND terms_attachment_log_index IS NULL
    )
    OR (
      outcome = 'confirmed'
      AND attached_license_template ~ '^0x[0-9a-f]{40}$'
      AND attached_license_terms_id ~ '^[1-9][0-9]{0,77}$'
      AND attached_license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
      AND (attached_license_preset = 'commercial-remix')
          = (attached_commercial_rev_share_bps IS NOT NULL)
      AND attached_commercial_rev_share_bps <= 10000
      AND terms_attachment_transaction_hash = transaction_hash
      AND terms_attachment_block_number >= 0
      AND terms_attachment_block_hash ~ '^0x[0-9a-f]{64}$'
      AND terms_attachment_log_index >= 0
      AND attached_license_template IS NOT NULL
      AND attached_license_terms_id IS NOT NULL
      AND attached_license_preset IS NOT NULL
      AND terms_attachment_transaction_hash IS NOT NULL
      AND terms_attachment_block_number IS NOT NULL
      AND terms_attachment_block_hash IS NOT NULL
      AND terms_attachment_log_index IS NOT NULL
    )
  );

-- 2. The publication projection guard compares the operation against the
-- projection that owns it. A video projection carries no canonical audio
-- digest, so the comparison must follow the media kind and still refuse a
-- projection whose kind does not own the registration.
DO $data_projection_guard$
DECLARE
  definition TEXT;
  audio_needle CONSTANT TEXT := 'registration_record.publication_audio_revision IS DISTINCT FROM NEW.audio_revision';
  audio_replacement CONSTANT TEXT := '(NEW.media_kind = ''song'' AND registration_record.publication_audio_revision IS DISTINCT FROM NEW.audio_revision)';
  canonical_needle CONSTANT TEXT := 'registration_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256';
  canonical_replacement CONSTANT TEXT := '(NEW.media_kind = ''song'' AND registration_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256) OR registration_record.media_kind IS DISTINCT FROM NEW.media_kind';
BEGIN
  SELECT pg_get_functiondef('guard_media_publication_projection_update()'::regprocedure)
    INTO definition;
  IF position('registration_record.media_kind IS DISTINCT FROM NEW.media_kind' in definition) = 0 THEN
    IF position(audio_needle in definition) = 0 OR position(canonical_needle in definition) = 0 THEN
      RAISE EXCEPTION 'publication projection DATA guard markers not found';
    END IF;
    definition := replace(definition, audio_needle, audio_replacement);
    definition := replace(definition, canonical_needle, canonical_replacement);
    EXECUTE definition;
  END IF;
END
$data_projection_guard$;

-- 3. Operator resume audit. A reconciliation_required registration returns to
-- observation only through an authorized action whose audit row commits with
-- the exact resumed attempt, advanced workflow revision and fresh launch.
CREATE TABLE data_operator_resume_actions (
    registration_operation_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    operator_principal_id TEXT NOT NULL CHECK (operator_principal_id <> ''),
    idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    reason_code TEXT NOT NULL CHECK (
      reason_code IN ('receipt_inconclusive', 'terms_evidence_unavailable')
    ),
    evidence_ref TEXT NOT NULL CHECK (evidence_ref <> ''),
    expected_workflow_revision BIGINT NOT NULL CHECK (expected_workflow_revision > 0),
    resulting_workflow_revision BIGINT NOT NULL,
    resumed_attempt_id TEXT NOT NULL,
    outbox_id TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (registration_operation_id, resulting_workflow_revision),
    UNIQUE (registration_operation_id, idempotency_key),
    CHECK (resulting_workflow_revision = expected_workflow_revision + 1)
);

CREATE TRIGGER data_operator_resume_actions_append_only
  BEFORE UPDATE OR DELETE ON data_operator_resume_actions
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();

-- Leaving reconciliation_required, or moving its workflow revision, requires
-- the audit row that the operator action inserted in the same transaction.
CREATE FUNCTION require_data_operator_resume_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'reconciliation_required'
     AND (
       NEW.state IN ('broadcast', 'confirming')
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision
     ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM data_operator_resume_actions action
      WHERE action.registration_operation_id = NEW.registration_operation_id
        AND action.expected_workflow_revision = OLD.workflow_revision
        AND action.resumed_attempt_id = NEW.current_attempt_id
        AND action.community_id = NEW.community_id
        AND action.actor_user_id = NEW.actor_user_id
        AND action.submission_id = NEW.submission_id
    ) THEN
      RAISE EXCEPTION 'operator resume requires its exact audit';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_registration_operator_resume_guard
  BEFORE UPDATE ON data_registration_operations
  FOR EACH ROW EXECUTE FUNCTION require_data_operator_resume_audit();

-- The audit is durable only with the resumed attempt, the advanced revision,
-- the matching instance and the pending replacement launch.
CREATE FUNCTION validate_data_operator_resume_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM data_registration_operations operation
      JOIN data_registration_signing_attempts attempt
        ON attempt.submission_attempt_id = NEW.resumed_attempt_id
       AND attempt.registration_operation_id = operation.registration_operation_id
      JOIN data_registration_outbox launch
        ON launch.outbox_id = NEW.outbox_id
       AND launch.registration_operation_id = operation.registration_operation_id
     WHERE operation.registration_operation_id = NEW.registration_operation_id
       AND operation.community_id = NEW.community_id
       AND operation.actor_user_id = NEW.actor_user_id
       AND operation.submission_id = NEW.submission_id
       AND operation.workflow_revision = NEW.resulting_workflow_revision
       AND operation.workflow_instance_id = 'data-registration-workflow:'
           || operation.registration_operation_id || ':r' || operation.workflow_revision::text
       AND operation.current_attempt_id = NEW.resumed_attempt_id
       AND operation.state = CASE WHEN attempt.state = 'mined' THEN 'confirming' ELSE 'broadcast' END
       AND attempt.state IN ('broadcast', 'mined')
       AND launch.event_type = 'workflow_replacement'
       AND launch.workflow_revision = NEW.resulting_workflow_revision
       AND launch.workflow_instance_id = operation.workflow_instance_id
       AND launch.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'operator resume lacks its exact transition, attempt or launch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER data_operator_resume_action_transition
  AFTER INSERT ON data_operator_resume_actions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_data_operator_resume_action();
