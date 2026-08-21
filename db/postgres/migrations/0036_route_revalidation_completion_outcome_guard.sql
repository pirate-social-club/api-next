-- Correct the deferred route-revalidation completion/session guard.
--
-- Migration 0035 accidentally rejected every failed terminal session.  This
-- forward-only correction is deliberately a guard replacement: it does not
-- rewrite rows or backfill a result.  A failed or expired terminal may never
-- carry route-evidence authority.

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
      (session.status = 'pending' AND count(attempt.route_revalidation_attempt_id) > 0)
      OR (session.status IN ('completed', 'expired', 'failed')
          AND count(attempt.route_revalidation_attempt_id) <> 1)
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
      OR (session.status IN ('completed', 'expired', 'failed')
          AND COALESCE(bool_or(attempt.result_hash IS NULL), false))
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
      DETAIL = 'Migration 0036 is forward-only and performs no backfill. Repair the durable state through a reviewed migration before retrying.';
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_attempt_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
  invalid_consumption BOOLEAN;
  missing_result_hash BOOLEAN;
  has_evidence BOOLEAN;
BEGIN
  SELECT * INTO session_record
    FROM community_route_revalidation_sessions
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation attempt has no session';
  END IF;

  SELECT count(*)::integer,
         COALESCE(bool_or(
           consumption_kind IS NULL
           OR result_hash IS NULL
           OR (
             session_record.status = 'completed'
             AND consumption_kind <> 'verified'
           )
           OR (
             session_record.status = 'expired'
             AND consumption_kind <> 'session_expired'
           )
           OR (
             session_record.status = 'failed'
             AND consumption_kind NOT IN (
               'missing_root', 'control_failed', 'challenge_mismatch',
               'insufficient_expiry', 'disputed', 'revoked',
               'database_time_expired', 'stale_cas'
             )
           )
         ), false),
         COALESCE(bool_or(result_hash IS NULL), false)
    INTO consumed_count, invalid_consumption, missing_result_hash
    FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_id = session_record.route_revalidation_id
     AND revalidation_session_id = session_record.revalidation_session_id
     AND state = 'consumed';

  SELECT EXISTS (
    SELECT 1
      FROM community_route_revalidation_evidence_snapshots AS snapshot
     WHERE snapshot.route_revalidation_id = session_record.route_revalidation_id
       AND snapshot.revalidation_session_id = session_record.revalidation_session_id
  ) OR EXISTS (
    SELECT 1
      FROM community_route_ownership_evidence AS evidence
      JOIN community_route_revalidation_completion_attempts AS evidence_attempt
        ON evidence_attempt.route_revalidation_attempt_id = evidence.route_revalidation_attempt_id
     WHERE evidence.origin = 'route_revalidation'
       AND evidence_attempt.route_revalidation_id = session_record.route_revalidation_id
       AND evidence_attempt.revalidation_session_id = session_record.revalidation_session_id
  ) INTO has_evidence;

  IF session_record.status = 'pending' THEN
    IF consumed_count <> 0 THEN
      RAISE EXCEPTION 'pending route revalidation session cannot retain a consumed attempt';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.status = 'completed' THEN
    IF consumed_count <> 1 OR invalid_consumption OR missing_result_hash THEN
      RAISE EXCEPTION 'completed route revalidation session requires exactly one verified attempt with a result hash';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.status = 'expired' THEN
    IF consumed_count <> 1 OR invalid_consumption OR missing_result_hash OR has_evidence THEN
      RAISE EXCEPTION 'expired route revalidation session requires one session_expired attempt with no evidence';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.status = 'failed' THEN
    IF consumed_count <> 1 OR invalid_consumption OR missing_result_hash OR has_evidence THEN
      RAISE EXCEPTION 'failed route revalidation session requires one closed negative attempt with no evidence';
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'unknown route revalidation session status: %', session_record.status;
END;
$$;
