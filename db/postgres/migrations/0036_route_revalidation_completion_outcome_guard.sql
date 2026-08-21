-- Forward-only completion correction for route revalidation.
--
-- Migration 0035 made every consumed attempt terminal and therefore could not
-- represent the ratified semantic-contradiction path. This migration keeps
-- 0035 immutable, admits a consumed nonterminal contradiction, and freezes
-- the target-owned 14-member terminal-result preimage for terminal writes.

ALTER TABLE community_route_revalidation_completion_attempts
  ADD COLUMN terminal_result_document TEXT,
  ADD COLUMN terminal_observed_expires_at TIMESTAMPTZ;

ALTER TABLE community_route_revalidation_completion_attempts
  DROP CONSTRAINT community_route_revalidation_attempts_result_shape,
  ADD CONSTRAINT community_route_revalidation_attempts_result_shape CHECK (
    (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND terminal_at IS NOT NULL
      AND (
        (
          consumption_kind = 'challenge_mismatch'
          AND result_hash IS NULL
          AND terminal_result_document IS NULL
        )
        OR (
          result_hash IS NOT NULL
          AND terminal_result_document IS NOT NULL
          AND (
            (consumption_kind = 'database_time_expired'
             AND terminal_observed_expires_at IS NOT NULL)
            OR (consumption_kind <> 'database_time_expired'
                AND terminal_observed_expires_at IS NULL)
          )
        )
      )
    )
    OR (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
      AND result_hash IS NULL
      AND terminal_result_document IS NULL
      AND terminal_observed_expires_at IS NULL
      AND terminal_at IS NULL
    )
  ) NOT VALID;

-- Existing terminal 0035 rows cannot be replayed under the frozen byte ABI.
-- Fail closed instead of blessing hash-only history or fabricating documents.
DO $$
DECLARE
  violation RECORD;
BEGIN
  FOR violation IN
    SELECT
      session.revalidation_session_id,
      session.status,
      COALESCE(
        string_agg(DISTINCT attempt.consumption_kind, ',' ORDER BY attempt.consumption_kind),
        '<none>'
      ) AS consumption_kinds,
      count(attempt.route_revalidation_attempt_id)::integer AS consumed_count
    FROM community_route_revalidation_sessions AS session
    LEFT JOIN community_route_revalidation_completion_attempts AS attempt
      ON attempt.route_revalidation_id = session.route_revalidation_id
     AND attempt.revalidation_session_id = session.revalidation_session_id
     AND attempt.state = 'consumed'
    GROUP BY session.revalidation_session_id, session.status
    HAVING
      (
        session.status = 'pending'
        AND bool_or(
          attempt.route_revalidation_attempt_id IS NOT NULL
          AND (
            attempt.consumption_kind <> 'challenge_mismatch'
            OR attempt.result_hash IS NOT NULL
            OR attempt.terminal_result_document IS NOT NULL
          )
        )
      )
      OR (session.status IN ('completed', 'expired', 'failed')
          AND count(attempt.route_revalidation_attempt_id) <> 1)
      OR COALESCE(bool_or(
        attempt.result_hash IS NOT NULL AND attempt.terminal_result_document IS NULL
      ), false)
      OR (session.status = 'completed'
          AND COALESCE(bool_or(attempt.consumption_kind <> 'verified'), false))
      OR (session.status = 'expired'
          AND COALESCE(bool_or(attempt.consumption_kind <> 'session_expired'), false))
      OR (session.status = 'failed'
          AND COALESCE(bool_or(attempt.consumption_kind NOT IN (
            'missing_root', 'control_failed', 'challenge_mismatch',
            'insufficient_expiry', 'disputed', 'revoked',
            'database_time_expired', 'stale_cas'
          )), false))
      OR (session.status IN ('expired', 'failed') AND (
        EXISTS (
          SELECT 1
            FROM community_route_revalidation_evidence_snapshots AS snapshot
           WHERE snapshot.route_revalidation_id = session.route_revalidation_id
             AND snapshot.revalidation_session_id = session.revalidation_session_id
        )
        OR EXISTS (
          SELECT 1
            FROM community_route_ownership_evidence AS evidence
            JOIN community_route_revalidation_completion_attempts AS evidence_attempt
              ON evidence_attempt.route_revalidation_attempt_id = evidence.route_revalidation_attempt_id
           WHERE evidence.origin = 'route_revalidation'
             AND evidence_attempt.route_revalidation_id = session.route_revalidation_id
             AND evidence_attempt.revalidation_session_id = session.revalidation_session_id
        )
      ))
  LOOP
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        '0036 preflight abort: route-revalidation session %s has status %s with %s consumed attempt(s) [%s]',
        violation.revalidation_session_id,
        violation.status,
        violation.consumed_count,
        violation.consumption_kinds
      ),
      DETAIL = '0036 is forward-only. Repair incompatible durable state through a reviewed migration before retrying.';
  END LOOP;
END;
$$;

ALTER TABLE community_route_revalidation_completion_attempts
  VALIDATE CONSTRAINT community_route_revalidation_attempts_result_shape;

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_terminal_document(
  document_text TEXT,
  expected_result_hash TEXT,
  expected_status TEXT,
  expected_route_revalidation_id TEXT,
  expected_session_id TEXT,
  expected_attempt_id TEXT,
  expected_binding_id TEXT,
  expected_generation BIGINT,
  expected_idempotency_key TEXT,
  expected_completion_request_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  document JSONB;
  canonical_document TEXT;
  ownership TEXT;
  lifecycle TEXT;
BEGIN
  IF document_text IS NULL OR expected_result_hash IS NULL THEN RETURN FALSE; END IF;
  IF octet_length(document_text) NOT BETWEEN 1 AND 8192 THEN RETURN FALSE; END IF;
  document := document_text::jsonb;
  IF jsonb_typeof(document) <> 'array' OR jsonb_array_length(document) <> 14 THEN
    RETURN FALSE;
  END IF;
  SELECT '[' || string_agg(value::TEXT, ',' ORDER BY ordinal) || ']'
    INTO canonical_document
    FROM jsonb_array_elements(document) WITH ORDINALITY AS item(value, ordinal);
  IF document_text IS DISTINCT FROM canonical_document THEN RETURN FALSE; END IF;
  IF jsonb_typeof(document -> 0) <> 'string'
     OR document ->> 0 <> 'pirate-hns-route-revalidation-result-v1'
     OR jsonb_typeof(document -> 1) <> 'string'
     OR document ->> 1 IS DISTINCT FROM expected_route_revalidation_id
     OR jsonb_typeof(document -> 2) <> 'string'
     OR document ->> 2 IS DISTINCT FROM expected_session_id
     OR jsonb_typeof(document -> 3) <> 'string'
     OR document ->> 3 IS DISTINCT FROM expected_attempt_id
     OR jsonb_typeof(document -> 4) <> 'string'
     OR document ->> 4 IS DISTINCT FROM expected_binding_id
     OR jsonb_typeof(document -> 5) <> 'number'
     OR (document -> 5)::text !~ '^(0|[1-9][0-9]*)$'
     OR (document ->> 5)::bigint IS DISTINCT FROM expected_generation
     OR jsonb_typeof(document -> 6) <> 'string'
     OR document ->> 6 IS DISTINCT FROM expected_idempotency_key
     OR jsonb_typeof(document -> 7) <> 'string'
     OR document ->> 7 IS DISTINCT FROM expected_completion_request_hash
     OR jsonb_typeof(document -> 8) <> 'string'
     OR document ->> 8 IS DISTINCT FROM expected_status
  THEN RETURN FALSE; END IF;

  IF jsonb_typeof(document -> 9) = 'null'
     AND jsonb_typeof(document -> 10) = 'null'
     AND jsonb_typeof(document -> 11) = 'null'
  THEN
    NULL;
  ELSIF jsonb_typeof(document -> 9) = 'string'
     AND jsonb_typeof(document -> 10) = 'string'
     AND jsonb_typeof(document -> 11) = 'string'
     AND document ->> 9 ~ '^[^[:cntrl:]]+$'
     AND document ->> 10 ~ '^[0-9a-f]{64}$'
     AND document ->> 11 ~ '^[0-9a-f]{64}$'
  THEN
    NULL;
  ELSE
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(document -> 12) = 'null'
     AND jsonb_typeof(document -> 13) = 'null'
  THEN
    ownership := NULL;
    lifecycle := NULL;
  ELSIF jsonb_typeof(document -> 12) = 'string'
     AND jsonb_typeof(document -> 13) = 'string'
  THEN
    ownership := document ->> 12;
    lifecycle := document ->> 13;
  ELSE
    RETURN FALSE;
  END IF;

  IF expected_status = 'verified' THEN
    IF jsonb_typeof(document -> 9) <> 'string'
       OR jsonb_typeof(document -> 10) <> 'string'
       OR jsonb_typeof(document -> 11) <> 'string'
       OR ownership <> 'verified' OR lifecycle <> 'active'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('missing_root', 'revoked') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'revoked' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('control_failed', 'challenge_mismatch', 'disputed') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'disputed' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('insufficient_expiry', 'database_time_expired') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'expired' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('session_expired', 'stale_cas') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership IS NOT NULL OR lifecycle IS NOT NULL
    THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;
  RETURN encode(sha256(convert_to(document_text, 'UTF8')), 'hex') = expected_result_hash;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION guard_community_route_revalidation_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ;
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
  semantic_contradiction BOOLEAN;
BEGIN
  db_now := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation completion attempts cannot be deleted';
  END IF;
  SELECT * INTO session_record
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = COALESCE(NEW.route_revalidation_id, OLD.route_revalidation_id)
     AND revalidation_session_id = COALESCE(NEW.revalidation_session_id, OLD.revalidation_session_id)
   FOR UPDATE;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation completion attempt lacks its session';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT count(*)::integer INTO consumed_count
      FROM community_route_revalidation_completion_attempts
     WHERE route_revalidation_id = NEW.route_revalidation_id AND state = 'consumed';
    IF session_record.status <> 'pending'
      OR session_record.expires_at <= db_now
      OR NEW.route_binding_id IS DISTINCT FROM session_record.route_binding_id
      OR NEW.expected_binding_generation IS DISTINCT FROM session_record.expected_binding_generation
      OR NEW.expected_verified_evidence_ref IS DISTINCT FROM session_record.expected_verified_evidence_ref
      OR NEW.attempt_number IS DISTINCT FROM consumed_count + 1
      OR consumed_count >= 3
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR NEW.lease_expires_at > db_now + INTERVAL '16 seconds'
      OR NEW.lease_expires_at > session_record.expires_at
      OR NEW.terminal_result_document IS NOT NULL
      OR NEW.terminal_observed_expires_at IS NOT NULL
    THEN RAISE EXCEPTION 'route revalidation completion attempt is not admissible'; END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_attempt_id, NEW.route_revalidation_id,
    NEW.revalidation_session_id, NEW.route_binding_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.attempt_number, NEW.idempotency_key, NEW.completion_request_hash,
    NEW.evidence_ref, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_attempt_id, OLD.route_revalidation_id,
    OLD.revalidation_session_id, OLD.route_binding_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.attempt_number, OLD.idempotency_key, OLD.completion_request_hash,
    OLD.evidence_ref, OLD.created_at
  ) THEN RAISE EXCEPTION 'route revalidation completion attempt authority is immutable'; END IF;

  IF OLD.state = 'leased' AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL AND NEW.terminal_at IS NULL
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  IF OLD.state IN ('released', 'leased') AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND NEW.lease_expires_at <= db_now + INTERVAL '16 seconds'
    AND NEW.lease_expires_at <= session_record.expires_at
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.consumption_kind IS NULL AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL AND NEW.terminal_at IS NULL
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;

  semantic_contradiction := OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.consumption_kind = 'challenge_mismatch' AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL
    AND session_record.status = 'pending';
  IF semantic_contradiction THEN
    IF NEW.fence_token <> OLD.fence_token OR NEW.lease_expires_at <> OLD.lease_expires_at
       OR OLD.lease_expires_at <= db_now OR NEW.terminal_at IS NULL OR NEW.terminal_at > db_now
    THEN RAISE EXCEPTION 'semantic contradiction attempt transition is not allowed'; END IF;
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;

  IF OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NOT NULL AND NEW.result_hash IS NOT NULL
    AND NEW.terminal_result_document IS NOT NULL AND NEW.terminal_at IS NOT NULL
    AND (
      (NEW.consumption_kind = 'database_time_expired'
       AND NEW.terminal_observed_expires_at IS NOT NULL
       AND NEW.terminal_observed_expires_at <= db_now)
      OR (NEW.consumption_kind <> 'database_time_expired'
          AND NEW.terminal_observed_expires_at IS NULL)
    )
    AND NEW.terminal_at <= db_now
    AND ((NEW.consumption_kind <> 'session_expired' AND OLD.lease_expires_at > db_now
          AND session_record.status = 'pending' AND session_record.expires_at > db_now)
      OR (NEW.consumption_kind = 'session_expired' AND session_record.expires_at <= db_now))
    AND validate_community_route_revalidation_terminal_document(
      NEW.terminal_result_document, NEW.result_hash, NEW.consumption_kind,
      NEW.route_revalidation_id, NEW.revalidation_session_id,
      NEW.route_revalidation_attempt_id, NEW.route_binding_id,
      NEW.expected_binding_generation, NEW.idempotency_key,
      NEW.completion_request_hash)
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  RAISE EXCEPTION 'route revalidation completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_attempt_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
  leased_exists BOOLEAN;
  invalid_pending_consumption BOOLEAN;
  mismatched_terminal BOOLEAN;
BEGIN
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation attempt has no session';
  END IF;
  SELECT count(*) FILTER (WHERE state = 'consumed' AND NOT (
           consumption_kind = 'challenge_mismatch'
           AND result_hash IS NULL
           AND terminal_result_document IS NULL
           AND terminal_observed_expires_at IS NULL
         ))::integer,
         COALESCE(bool_or(state = 'leased'), false),
         COALESCE(bool_or(state = 'consumed' AND NOT (
           consumption_kind = 'challenge_mismatch'
           AND result_hash IS NULL
           AND terminal_result_document IS NULL
           AND terminal_observed_expires_at IS NULL
         ) AND (
           consumption_kind <> 'challenge_mismatch'
           OR result_hash IS NOT NULL OR terminal_result_document IS NOT NULL
           OR terminal_observed_expires_at IS NOT NULL
         )), false),
         COALESCE(bool_or(state = 'consumed' AND (
           (session_record.status = 'completed' AND consumption_kind <> 'verified')
           OR (session_record.status = 'expired' AND consumption_kind <> 'session_expired')
           OR (session_record.status = 'failed' AND consumption_kind NOT IN (
             'missing_root', 'control_failed', 'challenge_mismatch',
             'insufficient_expiry', 'disputed', 'revoked',
             'database_time_expired', 'stale_cas'
           ))
         )), false)
    INTO consumed_count, leased_exists, invalid_pending_consumption, mismatched_terminal
    FROM community_route_revalidation_completion_attempts
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.status <> 'pending' AND leased_exists THEN
    RAISE EXCEPTION 'terminal route revalidation session cannot retain a lease';
  END IF;
  IF session_record.status = 'pending' AND invalid_pending_consumption THEN
    RAISE EXCEPTION 'pending route revalidation session has a terminal consumed attempt';
  END IF;
  IF session_record.status IN ('completed', 'failed', 'expired') AND consumed_count <> 1 THEN
    RAISE EXCEPTION 'terminal route revalidation session requires exactly one consumed attempt';
  END IF;
  IF mismatched_terminal THEN
    RAISE EXCEPTION 'route revalidation session status contradicts its consumed outcome';
  END IF;
  RETURN NULL;
END;
$$;
