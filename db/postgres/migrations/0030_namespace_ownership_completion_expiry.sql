-- Complete the namespace poll lease/expiry contract without rewriting 0029.
-- An expiry observed before reservation has no completion attempt, while an
-- expiry after reservation consumes that exact fence. Expired leases may be
-- released or reacquired, but a repository still decides whether late
-- provider output is eligible to consume a live attempt.

ALTER TABLE community_creation_ceremony_results
  DROP CONSTRAINT community_creation_ceremony_results_outcome_shape;

ALTER TABLE community_creation_ceremony_results
  ADD CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND proof_session_id IS NOT NULL
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND proof_session_id IS NULL
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND evidence_receipt_id IS NULL
        )
      )
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND namespace_session_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND (
            completion_attempt_id IS NOT NULL
            OR outcome_status = 'expired'
          )
        )
      )
    )
  );

ALTER TABLE namespace_ownership_completion_attempts
  ADD COLUMN consumption_kind TEXT;

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'verified'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'satisfied'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
        AND result.evidence_ref = attempt.evidence_ref
   )
   AND EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
        AND snapshot.evidence_ref = attempt.evidence_ref
   );

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'rejected'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'failed'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
   )
   AND NOT EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
   );

UPDATE namespace_ownership_completion_attempts AS attempt
   SET consumption_kind = 'expired'
 WHERE attempt.state = 'consumed'
   AND EXISTS (
     SELECT 1
      FROM community_creation_ceremony_results AS result
     WHERE result.completion_attempt_id = attempt.completion_attempt_id
        AND result.outcome_status = 'expired'
        AND result.callback_idempotency_key = attempt.idempotency_key
        AND result.callback_request_hash = attempt.completion_request_hash
   )
   AND NOT EXISTS (
     SELECT 1
       FROM namespace_ownership_evidence_snapshots AS snapshot
      WHERE snapshot.completion_attempt_id = attempt.completion_attempt_id
   );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE state = 'consumed' AND consumption_kind IS NULL
  ) THEN
    RAISE EXCEPTION 'existing consumed namespace attempts have ambiguous authority';
  END IF;
END;
$$;

ALTER TABLE namespace_ownership_completion_attempts
  ADD CONSTRAINT namespace_ownership_completion_attempts_consumption_shape CHECK (
    (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND consumption_kind IN ('semantic_contradiction', 'verified', 'rejected', 'expired')
    )
    OR (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
    )
  );

CREATE OR REPLACE FUNCTION guard_namespace_ownership_completion_attempt_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  transition_at TIMESTAMPTZ;
BEGIN
  transition_at := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership completion attempts are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := transition_at;
    NEW.updated_at := transition_at;
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT ci.* INTO intent_record
      FROM community_creation_intents AS ci
     WHERE ci.actor_id = NEW.actor_id
       AND ci.intent_id = (
         SELECT ns0.creation_intent_id
           FROM namespace_ownership_sessions AS ns0
          WHERE ns0.namespace_session_id = NEW.namespace_session_id
            AND ns0.actor_id = NEW.actor_id
       )
     FOR SHARE;
    SELECT crs.* INTO state_record
      FROM community_creation_requirement_states AS crs
     WHERE crs.actor_id = NEW.actor_id
       AND crs.intent_id = intent_record.intent_id
       AND crs.requirement_kind = 'namespace_ownership'
     FOR SHARE;
    SELECT ns.* INTO session_record
      FROM namespace_ownership_sessions AS ns
     WHERE ns.namespace_session_id = NEW.namespace_session_id
       AND ns.actor_id = NEW.actor_id
     FOR UPDATE;
    IF session_record.namespace_session_id IS NULL
      OR intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR session_record.status <> 'pending'
      OR session_record.expires_at <= transition_at
      OR NEW.state <> 'leased'
      OR NEW.consumption_kind IS NOT NULL
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= transition_at
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt requires a live pending session';
    END IF;
    IF NEW.lease_expires_at > session_record.expires_at THEN
      RAISE EXCEPTION 'completion lease exceeds its namespace session expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.completion_attempt_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.idempotency_key, NEW.completion_request_hash, NEW.evidence_ref,
    NEW.submission_channel, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.completion_attempt_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.idempotency_key, OLD.completion_request_hash, OLD.evidence_ref,
    OLD.submission_channel, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership completion attempt identity is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
    AND OLD.consumption_kind IS NOT DISTINCT FROM NEW.consumption_kind
    AND OLD.updated_at = NEW.updated_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  IF session_record.namespace_session_id IS NULL
    OR session_record.status NOT IN ('pending', 'expired')
  THEN
    RAISE EXCEPTION 'completion attempt requires its pending or expired session';
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND OLD.consumption_kind IS NULL
  THEN
    IF NEW.consumption_kind IN ('semantic_contradiction', 'verified', 'rejected') THEN
      IF session_record.status = 'pending'
        AND OLD.lease_expires_at > transition_at
        AND session_record.expires_at > transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.consumption_kind = 'expired' THEN
      IF session_record.status IN ('pending', 'expired')
        AND session_record.expires_at <= transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
  END IF;

  IF OLD.state IN ('released', 'leased')
    AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at <= session_record.expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
      AND NEW.lease_expires_at > transition_at
      AND (
        OLD.state = 'released'
        OR OLD.lease_expires_at <= transition_at
      )
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'namespace ownership completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_attempt_session_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  leased_attempt_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_completion_attempts' THEN
    SELECT * INTO attempt_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = NEW.completion_attempt_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id;

    IF session_record.namespace_session_id IS NULL
      OR attempt_record.completion_attempt_id IS NULL
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt has no session';
    END IF;

    IF attempt_record.state = 'leased'
      AND (
        session_record.status <> 'pending'
        OR session_record.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'leased namespace ownership attempt requires a live pending session';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  SELECT EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
       AND state = 'leased'
  ) INTO leased_attempt_exists;

  IF session_record.namespace_session_id IS NULL THEN
    RAISE EXCEPTION 'namespace ownership session has no completion attempt parent';
  END IF;

  IF session_record.status <> 'pending' AND leased_attempt_exists THEN
    RAISE EXCEPTION 'terminal namespace ownership session cannot retain a leased attempt';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind IS DISTINCT FROM 'verified'
    OR attempt_record.lease_expires_at <= attempt_record.updated_at
    OR session_record.expires_at <= attempt_record.updated_at
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its consumed verified fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NEW.challenge_name <> '_pirate.' || NEW.root_label THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;
 
CREATE OR REPLACE FUNCTION validate_namespace_ownership_consumed_attempt_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  result_record community_creation_ceremony_results%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  IF NEW.state <> 'consumed' THEN RETURN NULL; END IF;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE completion_attempt_id = NEW.completion_attempt_id;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE completion_attempt_id = NEW.completion_attempt_id;

  IF NEW.consumption_kind = 'semantic_contradiction' THEN
    IF result_record.ceremony_intent_id IS NOT NULL
      OR snapshot_record.evidence_ref IS NOT NULL
    THEN
      RAISE EXCEPTION 'semantic contradiction cannot carry terminal namespace authority';
    END IF;
    RETURN NULL;
  END IF;

  IF result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id <> NEW.namespace_session_id
    OR result_record.callback_idempotency_key <> NEW.idempotency_key
    OR result_record.callback_request_hash <> NEW.completion_request_hash
    OR (
      NEW.consumption_kind = 'verified'
      AND (
        result_record.outcome_status <> 'satisfied'
        OR snapshot_record.evidence_ref IS NULL
        OR snapshot_record.evidence_ref <> NEW.evidence_ref
        OR snapshot_record.namespace_session_id <> NEW.namespace_session_id
      )
    )
    OR (
      NEW.consumption_kind = 'rejected'
      AND (
        result_record.outcome_status <> 'failed'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
    OR (
      NEW.consumption_kind = 'expired'
      AND (
        result_record.outcome_status <> 'expired'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'consumed namespace attempt lacks its matching terminal authority';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_consumed_attempt_coherence
AFTER UPDATE OF state, consumption_kind ON namespace_ownership_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_consumed_attempt_coherence();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
  THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
      OR (NEW.outcome_status <> 'expired' AND NEW.completion_attempt_id IS NULL)
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion authority';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NEW.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO completion_record
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = NEW.completion_attempt_id
       FOR SHARE;
    END IF;
    IF session_record.namespace_session_id IS NULL
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR (
        NEW.completion_attempt_id IS NOT NULL
        AND (
          completion_record.completion_attempt_id IS NULL
          OR completion_record.namespace_session_id <> session_record.namespace_session_id
          OR completion_record.actor_id <> NEW.actor_id
          OR completion_record.submission_channel <> 'poll_result'
          OR completion_record.state <> 'consumed'
          OR completion_record.consumption_kind IS DISTINCT FROM CASE NEW.outcome_status
            WHEN 'satisfied' THEN 'verified'
            WHEN 'failed' THEN 'rejected'
            WHEN 'expired' THEN 'expired'
            ELSE NULL
          END
          OR NEW.callback_idempotency_key <> completion_record.idempotency_key
          OR NEW.callback_request_hash <> completion_record.completion_request_hash
        )
      )
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL
  THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version
    THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest
    THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
