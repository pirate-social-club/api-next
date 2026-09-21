-- One audited extra launch, before any signing or transaction evidence exists.
CREATE TABLE data_operator_additional_workflow_attempt_actions (
  registration_operation_id TEXT PRIMARY KEY REFERENCES data_registration_operations (registration_operation_id),
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  operator_principal_id TEXT NOT NULL CHECK (btrim(operator_principal_id) <> ''),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code = 'explicit_additional_workflow_attempt'),
  reviewed_workflow_disposition TEXT NOT NULL CHECK (reviewed_workflow_disposition IN ('finished','missing')),
  evidence_ref TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  expected_workflow_revision BIGINT NOT NULL CHECK (expected_workflow_revision = 4),
  resulting_workflow_revision BIGINT NOT NULL CHECK (resulting_workflow_revision = 5),
  reviewed_outbox_id TEXT NOT NULL UNIQUE,
  outbox_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (reviewed_outbox_id = registration_operation_id || ':outbox:r4'),
  CHECK (outbox_id = registration_operation_id || ':outbox:r5')
);

CREATE TRIGGER data_operator_additional_workflow_attempt_actions_append_only
  BEFORE UPDATE OR DELETE ON data_operator_additional_workflow_attempt_actions
  FOR EACH ROW EXECUTE FUNCTION guard_data_registration_append_only();

CREATE FUNCTION require_data_workflow_ceiling_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_revision IS NOT DISTINCT FROM OLD.workflow_revision OR OLD.workflow_revision < 4 THEN
    RETURN NEW;
  END IF;
  -- Existing transaction-bearing recovery only resumes observation.
  IF EXISTS (
    SELECT 1 FROM data_operator_resume_actions action
     WHERE action.registration_operation_id=NEW.registration_operation_id
       AND action.community_id=NEW.community_id AND action.actor_user_id=NEW.actor_user_id
       AND action.submission_id=NEW.submission_id
       AND action.expected_workflow_revision=OLD.workflow_revision
       AND action.resulting_workflow_revision=NEW.workflow_revision
       AND action.resumed_attempt_id=NEW.current_attempt_id
       AND action.outbox_id=NEW.registration_operation_id || ':outbox:r' || NEW.workflow_revision::text
  ) THEN RETURN NEW; END IF;
  IF OLD.workflow_revision=4 AND NEW.workflow_revision=5
     AND OLD.state='pending' AND NEW.state='pending'
     AND OLD.current_attempt_id IS NULL AND NEW.current_attempt_id IS NULL
     AND EXISTS (
       SELECT 1 FROM data_operator_additional_workflow_attempt_actions action
        WHERE action.registration_operation_id=NEW.registration_operation_id
          AND action.community_id=NEW.community_id AND action.actor_user_id=NEW.actor_user_id
          AND action.submission_id=NEW.submission_id
          AND action.expected_workflow_revision=OLD.workflow_revision
          AND action.resulting_workflow_revision=NEW.workflow_revision
     ) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DATA workflow revision ceiling requires an exact operator action';
END;
$$;

CREATE TRIGGER data_registration_workflow_ceiling_guard
  BEFORE UPDATE ON data_registration_operations
  FOR EACH ROW EXECUTE FUNCTION require_data_workflow_ceiling_audit();

CREATE FUNCTION validate_data_additional_workflow_attempt_action() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM data_registration_operations operation
      JOIN data_registration_outbox reviewed
        ON reviewed.outbox_id=NEW.reviewed_outbox_id
       AND reviewed.registration_operation_id=operation.registration_operation_id
      JOIN data_registration_outbox replacement
        ON replacement.outbox_id=NEW.outbox_id
       AND replacement.registration_operation_id=operation.registration_operation_id
     WHERE operation.registration_operation_id=NEW.registration_operation_id
       AND operation.community_id=NEW.community_id AND operation.actor_user_id=NEW.actor_user_id
       AND operation.submission_id=NEW.submission_id AND operation.state='pending'
       AND operation.workflow_revision=NEW.resulting_workflow_revision
       AND operation.workflow_instance_id='data-registration-workflow:' || operation.registration_operation_id || ':r5'
       AND operation.current_attempt_id IS NULL AND operation.registered_ip_id IS NULL
       AND operation.confirmed_transaction_hash IS NULL AND operation.confirmed_block_number IS NULL
       AND operation.confirmed_block_hash IS NULL AND operation.confirmed_log_index IS NULL
       AND operation.confirmed_at IS NULL AND operation.failure_code IS NULL
       AND operation.failure_evidence_ref IS NULL
       AND reviewed.workflow_revision=NEW.expected_workflow_revision
       AND reviewed.workflow_instance_id='data-registration-workflow:' || operation.registration_operation_id || ':r4'
       AND reviewed.event_type='workflow_replacement' AND reviewed.state IN ('delivered','exhausted')
       AND replacement.workflow_revision=NEW.resulting_workflow_revision
       AND replacement.workflow_instance_id=operation.workflow_instance_id
       AND replacement.event_type='workflow_replacement' AND replacement.state='pending'
       AND NOT EXISTS (SELECT 1 FROM data_registration_signing_attempts WHERE registration_operation_id=operation.registration_operation_id)
       AND NOT EXISTS (SELECT 1 FROM data_registration_attempt_transitions WHERE registration_operation_id=operation.registration_operation_id)
       AND NOT EXISTS (SELECT 1 FROM data_registration_receipt_observations WHERE registration_operation_id=operation.registration_operation_id)
  ) THEN
    RAISE EXCEPTION 'additional DATA workflow attempt lacks its exact no-effect transition or launch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER data_additional_workflow_attempt_action_transition
  AFTER INSERT ON data_operator_additional_workflow_attempt_actions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_data_additional_workflow_attempt_action();
