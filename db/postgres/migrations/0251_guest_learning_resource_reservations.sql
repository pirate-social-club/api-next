-- Guest resource reservations. No runtime grants, paid invocation or activation.
-- Serialize topology before any DDL and install phase/history closure atomically.
SELECT pg_advisory_xact_lock(83000003,1);

CREATE TABLE guest_resource_global_lock(singleton BOOLEAN PRIMARY KEY CHECK(singleton));
INSERT INTO guest_resource_global_lock VALUES(TRUE);
CREATE TABLE guest_resource_edge_locks(
 fingerprint TEXT PRIMARY KEY CHECK(char_length(fingerprint) BETWEEN 1 AND 256)
);
CREATE TABLE guest_resource_policy_snapshots(
 policy_version TEXT PRIMARY KEY CHECK(char_length(policy_version) BETWEEN 1 AND 128),
 policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object')
);
CREATE TABLE guest_resource_cost_policy_snapshots(
 cost_policy_version TEXT PRIMARY KEY CHECK(char_length(cost_policy_version) BETWEEN 1 AND 128),
 maximum_provider_cost_micros NUMERIC NOT NULL
  CHECK(maximum_provider_cost_micros>0 AND scale(maximum_provider_cost_micros)=0)
);
CREATE TABLE guest_resource_session_reservations(
 reservation_id TEXT PRIMARY KEY,
 source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind='study_start'),
 idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 128),
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 session_id TEXT NOT NULL CHECK(char_length(session_id) BETWEEN 1 AND 128),
 edge_fingerprint TEXT NOT NULL REFERENCES guest_resource_edge_locks(fingerprint),
 policy_version TEXT NOT NULL REFERENCES guest_resource_policy_snapshots(policy_version),
 cost_policy_version TEXT NOT NULL REFERENCES guest_resource_cost_policy_snapshots(cost_policy_version),
 initial_units INTEGER NOT NULL CHECK(initial_units BETWEEN 0 AND 20),
 remaining_units INTEGER NOT NULL CHECK(remaining_units BETWEEN 0 AND initial_units),
 unit_hold_micros NUMERIC NOT NULL CHECK(unit_hold_micros>0 AND scale(unit_hold_micros)=0),
 worst_case_cost_micros NUMERIC NOT NULL CHECK(worst_case_cost_micros>=0 AND scale(worst_case_cost_micros)=0),
 state TEXT NOT NULL CHECK(state IN('active','refused','completed','expired')),
 original_result JSONB NOT NULL CHECK(jsonb_typeof(original_result)='object'),
 created_at TIMESTAMPTZ NOT NULL,
 reservation_expires_at TIMESTAMPTZ NOT NULL,
 released_at TIMESTAMPTZ,
 UNIQUE(source_owner_id,operation_kind,idempotency_key),
 UNIQUE(reservation_id,source_owner_id,session_id),
 CHECK(worst_case_cost_micros=initial_units*unit_hold_micros),
 CHECK(reservation_expires_at=created_at+INTERVAL '24 hours'),
 CHECK((state='active' AND released_at IS NULL)
   OR (state='refused' AND remaining_units=0 AND released_at IS NULL)
   OR (state IN('completed','expired') AND remaining_units=0 AND released_at IS NOT NULL))
);
CREATE INDEX guest_resource_owner_sessions ON guest_resource_session_reservations(source_owner_id,state);
CREATE INDEX guest_resource_edge_admissions ON guest_resource_session_reservations(edge_fingerprint,created_at)
 WHERE state<>'refused';
CREATE TABLE guest_resource_provider_calls(
 call_id TEXT PRIMARY KEY,
 source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind='study_answer'),
 idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 128),
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 reservation_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 units INTEGER NOT NULL CHECK(units=1),
 cost_policy_version TEXT NOT NULL REFERENCES guest_resource_cost_policy_snapshots(cost_policy_version),
 maximum_provider_cost_micros NUMERIC NOT NULL
  CHECK(maximum_provider_cost_micros>0 AND scale(maximum_provider_cost_micros)=0),
 held_cost_micros NUMERIC NOT NULL CHECK(held_cost_micros>=maximum_provider_cost_micros AND scale(held_cost_micros)=0),
 disposition TEXT NOT NULL CHECK(disposition IN('reserved','unknown','completed','failed','not_invoked')),
 checkpoint_id TEXT,
 actual_cost_micros NUMERIC,
 created_at TIMESTAMPTZ NOT NULL,
 resolved_at TIMESTAMPTZ,
 FOREIGN KEY(reservation_id,source_owner_id,session_id)
  REFERENCES guest_resource_session_reservations(reservation_id,source_owner_id,session_id),
 UNIQUE(source_owner_id,operation_kind,idempotency_key),
 CHECK((disposition IN('reserved','unknown') AND checkpoint_id IS NULL AND actual_cost_micros IS NULL AND resolved_at IS NULL)
  OR (disposition='completed' AND checkpoint_id IS NOT NULL AND actual_cost_micros>=0
      AND actual_cost_micros<=maximum_provider_cost_micros AND scale(actual_cost_micros)=0 AND resolved_at IS NOT NULL)
  OR (disposition IN('failed','not_invoked') AND checkpoint_id IS NULL AND actual_cost_micros IS NULL AND resolved_at IS NOT NULL)),
 CHECK(resolved_at IS NULL OR resolved_at>=created_at)
);
CREATE INDEX guest_resource_call_owner ON guest_resource_provider_calls(source_owner_id,disposition,resolved_at);
CREATE TABLE guest_resource_release_receipts(
 receipt_id TEXT PRIMARY KEY,
 source_owner_id TEXT NOT NULL REFERENCES participation_owners(owner_id),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN('study_start','study_answer')),
 idempotency_key TEXT NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 128),
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 reservation_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 terminal_state TEXT NOT NULL CHECK(terminal_state IN('completed','expired')),
 created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(reservation_id,source_owner_id,session_id)
  REFERENCES guest_resource_session_reservations(reservation_id,source_owner_id,session_id),
 UNIQUE(source_owner_id,operation_kind,idempotency_key)
);

-- Deliberately closed until the independently accepted successful-checkpoint
-- schema supplies exact source/call/reservation/cost lineage. An arbitrary
-- checkpoint locator cannot make a held provider budget settled.
CREATE FUNCTION require_guest_resource_success_checkpoint_v1(
 p_checkpoint_id TEXT,p_call_id TEXT,p_reservation_id TEXT,p_source_owner_id TEXT,p_actual_cost NUMERIC
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN RAISE EXCEPTION 'successful checkpoint closure unavailable' USING ERRCODE='GP006'; END $$;

CREATE FUNCTION guard_guest_resource_session_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'resource history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','remaining_units','released_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','remaining_units','released_at'])
  OR (OLD.state<>'active' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  OR (OLD.state='active' AND NEW.state NOT IN('active','completed','expired'))
 THEN RAISE EXCEPTION 'resource identity or terminal receipt is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_resource_session_guard BEFORE UPDATE OR DELETE ON guest_resource_session_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_guest_resource_session_v1();
CREATE FUNCTION guard_guest_resource_provider_call_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider accounting history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['disposition','checkpoint_id','actual_cost_micros','resolved_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['disposition','checkpoint_id','actual_cost_micros','resolved_at'])
  OR (OLD.disposition IN('completed','failed','not_invoked') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  OR (OLD.disposition='unknown' AND NEW.disposition='reserved')
 THEN RAISE EXCEPTION 'provider identity or terminal accounting is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guest_resource_provider_call_guard BEFORE UPDATE OR DELETE ON guest_resource_provider_calls
 FOR EACH ROW EXECUTE FUNCTION guard_guest_resource_provider_call_v1();
CREATE TRIGGER guest_resource_release_immutable BEFORE UPDATE OR DELETE ON guest_resource_release_receipts
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_resource_policy_immutable BEFORE UPDATE OR DELETE ON guest_resource_policy_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_resource_cost_policy_immutable BEFORE UPDATE OR DELETE ON guest_resource_cost_policy_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_resource_edge_immutable BEFORE UPDATE OR DELETE ON guest_resource_edge_locks
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();
CREATE TRIGGER guest_resource_global_immutable BEFORE UPDATE OR DELETE ON guest_resource_global_lock
 FOR EACH ROW EXECUTE FUNCTION reject_guest_immutable_mutation_v1();

CREATE FUNCTION validate_guest_resource_operation_v1(p_source_id TEXT,p_operation JSONB,p_expected_kind TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF p_source_id IS NULL OR char_length(p_source_id) NOT BETWEEN 1 AND 128
  OR p_expected_kind IS NULL OR p_expected_kind NOT IN('study_start','study_answer')
  OR p_operation IS NULL OR jsonb_typeof(p_operation)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_operation))<>4
  OR NOT(p_operation ?& ARRAY['sourceOwnerId','kind','idempotencyKey','requestHash'])
  OR jsonb_typeof(p_operation->'sourceOwnerId')<>'string'
  OR jsonb_typeof(p_operation->'kind')<>'string'
  OR p_operation->>'sourceOwnerId' IS DISTINCT FROM p_source_id
  OR p_operation->>'kind' IS DISTINCT FROM p_expected_kind
  OR jsonb_typeof(p_operation->'idempotencyKey')<>'string'
  OR char_length(p_operation->>'idempotencyKey') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(p_operation->'requestHash')<>'string'
  OR p_operation->>'requestHash' !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'invalid resource operation' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION validate_guest_resource_policy_v1(p_policy JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE field_name TEXT; amount NUMERIC;
BEGIN
 IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object'
  OR (SELECT count(*) FROM jsonb_object_keys(p_policy))<>11
  OR NOT(p_policy ?& ARRAY['version','costPolicyVersion','maximumOwnerActiveSessions',
   'maximumOwnerReservedPaidCallsPerRollingDay','maximumGlobalActiveSessions',
   'maximumGlobalPaidCallsPerRollingDay','maximumGlobalCostMicrosPerRollingDay',
   'maximumOwnerCostMicrosPerRollingDay','maximumTrustedEdgeSessionsPerWindow',
   'trustedEdgeWindowSeconds','maximumProviderCallCostMicros'])
  OR p_policy->'maximumOwnerActiveSessions' IS DISTINCT FROM '2'::JSONB
  OR p_policy->'maximumOwnerReservedPaidCallsPerRollingDay' IS DISTINCT FROM '60'::JSONB
 THEN RAISE EXCEPTION 'resource policy unavailable' USING ERRCODE='GP006'; END IF;
 FOREACH field_name IN ARRAY ARRAY['version','costPolicyVersion'] LOOP
  IF jsonb_typeof(p_policy->field_name)<>'string' OR char_length(p_policy->>field_name) NOT BETWEEN 1 AND 128
   THEN RAISE EXCEPTION 'resource policy unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
 FOREACH field_name IN ARRAY ARRAY['maximumGlobalActiveSessions','maximumGlobalPaidCallsPerRollingDay',
  'maximumTrustedEdgeSessionsPerWindow','trustedEdgeWindowSeconds'] LOOP
  IF jsonb_typeof(p_policy->field_name)<>'number' THEN RAISE EXCEPTION 'resource policy unavailable' USING ERRCODE='GP006'; END IF;
  amount:=(p_policy->>field_name)::NUMERIC;
  IF amount<1 OR amount>9007199254740991 OR trunc(amount)<>amount
   THEN RAISE EXCEPTION 'resource policy unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
 FOREACH field_name IN ARRAY ARRAY['maximumGlobalCostMicrosPerRollingDay',
  'maximumOwnerCostMicrosPerRollingDay','maximumProviderCallCostMicros'] LOOP
  IF jsonb_typeof(p_policy->field_name)<>'string' OR p_policy->>field_name !~ '^[1-9][0-9]{0,77}$'
   THEN RAISE EXCEPTION 'resource policy unavailable' USING ERRCODE='GP006'; END IF;
 END LOOP;
END $$;

-- GLOBAL -> EDGE -> complete owner component. Caller topology barrier FIRST.
-- Source identity is captured guest identity, not a caller-selected alias root.
CREATE FUNCTION lock_guest_resource_budget_v1(p_source_id TEXT,p_fingerprint TEXT)
RETURNS TEXT[] LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE component_ids TEXT[]; root_id TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(83000003,1);
 PERFORM 1 FROM guest_resource_global_lock WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource global anchor unavailable' USING ERRCODE='GP006'; END IF;
 IF p_fingerprint IS NULL OR char_length(p_fingerprint) NOT BETWEEN 1 AND 256
  THEN RAISE EXCEPTION 'trusted edge unavailable' USING ERRCODE='GP006'; END IF;
 INSERT INTO guest_resource_edge_locks VALUES(p_fingerprint) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM guest_resource_edge_locks WHERE guest_resource_edge_locks.fingerprint=lock_guest_resource_budget_v1.p_fingerprint FOR UPDATE;
 SELECT resolve_guest_empty_owner_root_v1(p_source_id) INTO root_id;
 IF root_id IS DISTINCT FROM p_source_id THEN RAISE EXCEPTION 'owner mismatch' USING ERRCODE='GP002'; END IF;
 WITH RECURSIVE component(owner_id) AS (
  SELECT root_id UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a JOIN component c ON a.canonical_owner_id=c.owner_id
 ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO component_ids FROM component;
 PERFORM 1 FROM participation_owners WHERE owner_id=ANY(component_ids) ORDER BY owner_id COLLATE "C" FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=p_source_id AND kind='guest' AND state<>'aliased_empty')
  THEN RAISE EXCEPTION 'owner mismatch' USING ERRCODE='GP002'; END IF;
 RETURN component_ids;
END $$;

-- No held allowance ages out. Only settled calls use the conservative DB
-- resolution-clock rolling window; a timeout never proves no invocation.
CREATE FUNCTION guest_resource_usage_v1(p_component_ids TEXT[],p_observed_at TIMESTAMPTZ)
RETURNS TABLE(owner_active BIGINT,global_active BIGINT,owner_calls NUMERIC,global_calls NUMERIC,owner_cost NUMERIC,global_cost NUMERIC)
LANGUAGE sql STABLE AS $$
 WITH remaining AS (
  SELECT source_owner_id,remaining_units AS units,remaining_units*unit_hold_micros AS cost
   FROM guest_resource_session_reservations WHERE state='active'
 ), calls AS (
  SELECT source_owner_id,units,CASE WHEN disposition='completed' THEN actual_cost_micros ELSE held_cost_micros END AS cost
   FROM guest_resource_provider_calls WHERE disposition IN('reserved','unknown')
    OR (disposition IN('completed','failed') AND resolved_at>p_observed_at-INTERVAL '24 hours')
 ), charges AS (SELECT * FROM remaining UNION ALL SELECT * FROM calls)
 SELECT (SELECT count(*) FROM guest_resource_session_reservations WHERE state='active' AND source_owner_id=ANY(p_component_ids)),
  (SELECT count(*) FROM guest_resource_session_reservations WHERE state='active'),
  COALESCE(sum(units) FILTER(WHERE source_owner_id=ANY(p_component_ids)),0),COALESCE(sum(units),0),
  COALESCE(sum(cost) FILTER(WHERE source_owner_id=ANY(p_component_ids)),0),COALESCE(sum(cost),0) FROM charges
$$;

CREATE FUNCTION reserve_guest_resource_session_v1(p_source_id TEXT,p_operation JSONB,p_session_id TEXT,
 p_worst_units INTEGER,p_worst_cost TEXT,p_fingerprint TEXT,p_policy JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE component_ids TEXT[]; existing guest_resource_session_reservations%ROWTYPE;
 use_now TIMESTAMPTZ; usage RECORD; edge_count BIGINT; unit_cost NUMERIC; stored_policy JSONB;
 stored_unit_cost NUMERIC; receipt_id TEXT; result JSONB; refused BOOLEAN:=FALSE;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source_id,p_operation,'study_start');
 component_ids:=lock_guest_resource_budget_v1(p_source_id,p_fingerprint);
 SELECT * INTO existing FROM guest_resource_session_reservations r WHERE r.source_owner_id=p_source_id
  AND r.operation_kind='study_start' AND r.idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  -- p_session_id is a fresh server-generated candidate, never a client request
  -- identity. Same-key replay recovers the stored original candidate instead
  -- of rejecting a fresh ID draw or allocating a replacement session.
  IF ROW(existing.request_hash,existing.initial_units,existing.worst_case_cost_micros::TEXT)
    IS DISTINCT FROM ROW(p_operation->>'requestHash',p_worst_units,p_worst_cost)
   THEN RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state','completed','outcome_id',existing.reservation_id,'result',existing.original_result);
 END IF;
 PERFORM validate_guest_resource_policy_v1(p_policy);
 IF p_session_id IS NULL OR char_length(p_session_id) NOT BETWEEN 1 AND 128 OR p_worst_units IS NULL OR p_worst_units NOT BETWEEN 0 AND 20
  OR p_worst_cost IS NULL OR p_worst_cost !~ '^(0|[1-9][0-9]{0,77})$'
  THEN RAISE EXCEPTION 'invalid worst case' USING ERRCODE='22023'; END IF;
 unit_cost:=(p_policy->>'maximumProviderCallCostMicros')::NUMERIC;
 IF p_worst_cost::NUMERIC<>p_worst_units*unit_cost THEN RAISE EXCEPTION 'unreserved worst case' USING ERRCODE='GP006'; END IF;
 INSERT INTO guest_resource_policy_snapshots VALUES(p_policy->>'version',p_policy) ON CONFLICT DO NOTHING;
 SELECT s.policy INTO STRICT stored_policy FROM guest_resource_policy_snapshots s WHERE policy_version=p_policy->>'version';
 IF stored_policy IS DISTINCT FROM p_policy THEN RAISE EXCEPTION 'policy version changed' USING ERRCODE='GP006'; END IF;
 INSERT INTO guest_resource_cost_policy_snapshots VALUES(p_policy->>'costPolicyVersion',unit_cost) ON CONFLICT DO NOTHING;
 SELECT maximum_provider_cost_micros INTO STRICT stored_unit_cost FROM guest_resource_cost_policy_snapshots WHERE cost_policy_version=p_policy->>'costPolicyVersion';
 IF stored_unit_cost<>unit_cost THEN RAISE EXCEPTION 'cost policy version changed' USING ERRCODE='GP006'; END IF;
 use_now:=clock_timestamp();
 SELECT * INTO STRICT usage FROM guest_resource_usage_v1(component_ids,use_now);
 SELECT count(*) INTO edge_count FROM guest_resource_session_reservations r WHERE edge_fingerprint=p_fingerprint
  AND state<>'refused' AND created_at>use_now-make_interval(secs=>(p_policy->>'trustedEdgeWindowSeconds')::DOUBLE PRECISION);
 IF usage.owner_active>=2 OR usage.global_active>=(p_policy->>'maximumGlobalActiveSessions')::NUMERIC
  OR edge_count>=(p_policy->>'maximumTrustedEdgeSessionsPerWindow')::NUMERIC THEN
  result:=jsonb_build_object('state','rate_limited','retryAfterSeconds',NULL);refused:=TRUE;
 ELSIF usage.owner_calls+p_worst_units>60 OR usage.global_calls+p_worst_units>(p_policy->>'maximumGlobalPaidCallsPerRollingDay')::NUMERIC
  OR usage.owner_cost+p_worst_cost::NUMERIC>(p_policy->>'maximumOwnerCostMicrosPerRollingDay')::NUMERIC
  OR usage.global_cost+p_worst_cost::NUMERIC>(p_policy->>'maximumGlobalCostMicrosPerRollingDay')::NUMERIC THEN
  result:=jsonb_build_object('state','budget_refused','retryAfterSeconds',NULL);refused:=TRUE;
 END IF;
 receipt_id:='gr_'||gen_random_uuid()::TEXT;
 IF NOT refused THEN result:=jsonb_build_object('state','reserved','reservationId',receipt_id,'sourceOwnerId',p_source_id,
  'operation',p_operation,'remainingUnits',p_worst_units,'policyVersion',p_policy->>'version','costPolicyVersion',p_policy->>'costPolicyVersion'); END IF;
 INSERT INTO guest_resource_session_reservations VALUES(receipt_id,p_source_id,'study_start',p_operation->>'idempotencyKey',p_operation->>'requestHash',
  p_session_id,p_fingerprint,p_policy->>'version',p_policy->>'costPolicyVersion',p_worst_units,CASE WHEN refused THEN 0 ELSE p_worst_units END,
  unit_cost,p_worst_cost::NUMERIC,CASE WHEN refused THEN 'refused' ELSE 'active' END,result,use_now,use_now+INTERVAL '24 hours',NULL);
 IF NOT refused THEN UPDATE participation_owners SET state='established' WHERE owner_id=p_source_id AND state='empty'; END IF;
 RETURN jsonb_build_object('state','completed','outcome_id',receipt_id,'result',result);
END $$;

CREATE FUNCTION reserve_guest_provider_call_v1(p_source_id TEXT,p_operation JSONB,p_session_id TEXT,p_reservation_id TEXT,
 p_units INTEGER,p_maximum_cost TEXT,p_cost_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE reservation guest_resource_session_reservations%ROWTYPE; prior guest_resource_provider_calls%ROWTYPE;
 component_ids TEXT[]; call_id TEXT; use_now TIMESTAMPTZ;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source_id,p_operation,'study_answer');
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=reserve_guest_provider_call_v1.p_reservation_id AND r.source_owner_id=p_source_id;
 component_ids:=lock_guest_resource_budget_v1(p_source_id,reservation.edge_fingerprint);
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=reserve_guest_provider_call_v1.p_reservation_id FOR UPDATE;
 SELECT * INTO prior FROM guest_resource_provider_calls c WHERE c.source_owner_id=p_source_id
  AND operation_kind='study_answer' AND idempotency_key=p_operation->>'idempotencyKey' FOR UPDATE;
 IF FOUND THEN
  IF ROW(prior.request_hash,prior.session_id,prior.reservation_id,prior.units,prior.maximum_provider_cost_micros::TEXT,prior.cost_policy_version)
   IS DISTINCT FROM ROW(p_operation->>'requestHash',p_session_id,p_reservation_id,p_units,p_maximum_cost,p_cost_version)
   THEN RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='GP005'; END IF;
  IF prior.disposition='completed' THEN RETURN jsonb_build_object('state','completed','outcome_id',prior.call_id,
   'result',jsonb_build_object('state','completed','callId',prior.call_id,'checkpointId',prior.checkpoint_id)); END IF;
  IF prior.disposition IN('not_invoked','failed') THEN RETURN jsonb_build_object('state','known_aborted'); END IF;
  -- Existing reserved receipt might already have dispatched. NEVER reissue
  -- dispatch authority by replaying an original reserved result snapshot.
  RETURN jsonb_build_object('state','completed','outcome_id',prior.call_id,
   'result',jsonb_build_object('state','unknown','callId',prior.call_id,'reservationId',prior.reservation_id));
 END IF;
 IF p_units IS DISTINCT FROM 1 OR p_maximum_cost IS NULL OR p_maximum_cost !~ '^[1-9][0-9]{0,77}$'
  OR p_maximum_cost::NUMERIC>reservation.unit_hold_micros OR p_cost_version IS DISTINCT FROM reservation.cost_policy_version
  THEN RAISE EXCEPTION 'provider ceiling unavailable' USING ERRCODE='GP006'; END IF;
 use_now:=clock_timestamp();
 IF reservation.session_id IS DISTINCT FROM p_session_id OR reservation.state<>'active'
  OR reservation.reservation_expires_at<=use_now OR reservation.remaining_units<1
  THEN RAISE EXCEPTION 'resource reservation unavailable' USING ERRCODE='GP006'; END IF;
 call_id:='gpc_'||gen_random_uuid()::TEXT;
 UPDATE guest_resource_session_reservations r SET remaining_units=remaining_units-1 WHERE r.reservation_id=reservation.reservation_id;
 INSERT INTO guest_resource_provider_calls VALUES(call_id,p_source_id,'study_answer',p_operation->>'idempotencyKey',p_operation->>'requestHash',
  reservation.reservation_id,p_session_id,1,p_cost_version,p_maximum_cost::NUMERIC,reservation.unit_hold_micros,'reserved',NULL,NULL,use_now,NULL);
 RETURN jsonb_build_object('state','completed','outcome_id',call_id,'result',jsonb_build_object('state','reserved','callId',call_id,
  'reservationId',reservation.reservation_id,'maximumCostMicros',p_maximum_cost));
END $$;

CREATE FUNCTION complete_guest_provider_call_v1(p_source_id TEXT,p_operation JSONB,p_reservation_id TEXT,p_call_id TEXT,
 p_disposition TEXT,p_checkpoint_id TEXT DEFAULT NULL,p_actual_cost TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE reservation guest_resource_session_reservations%ROWTYPE; call_record guest_resource_provider_calls%ROWTYPE; component_ids TEXT[]; use_now TIMESTAMPTZ;
BEGIN
 PERFORM validate_guest_resource_operation_v1(p_source_id,p_operation,'study_answer');
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=complete_guest_provider_call_v1.p_reservation_id AND r.source_owner_id=p_source_id;
 component_ids:=lock_guest_resource_budget_v1(p_source_id,reservation.edge_fingerprint);
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=complete_guest_provider_call_v1.p_reservation_id FOR UPDATE;
 SELECT * INTO STRICT call_record FROM guest_resource_provider_calls c WHERE c.call_id=complete_guest_provider_call_v1.p_call_id FOR UPDATE;
 IF ROW(call_record.source_owner_id,call_record.reservation_id,call_record.idempotency_key,call_record.request_hash)
   IS DISTINCT FROM ROW(p_source_id,p_reservation_id,p_operation->>'idempotencyKey',p_operation->>'requestHash')
  THEN RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='GP005'; END IF;
 IF p_disposition IS NULL OR p_disposition NOT IN('completed','failed','not_invoked','unknown')
  OR (p_disposition='completed' AND (p_checkpoint_id IS NULL OR char_length(p_checkpoint_id) NOT BETWEEN 1 AND 128
    OR p_actual_cost IS NULL OR p_actual_cost !~ '^(0|[1-9][0-9]{0,77})$' OR p_actual_cost::NUMERIC>call_record.maximum_provider_cost_micros))
  OR (p_disposition<>'completed' AND (p_checkpoint_id IS NOT NULL OR p_actual_cost IS NOT NULL))
  THEN RAISE EXCEPTION 'invalid provider disposition' USING ERRCODE='22023'; END IF;
 IF call_record.disposition IN('completed','failed','not_invoked') THEN
  IF ROW(call_record.disposition,call_record.checkpoint_id,call_record.actual_cost_micros::TEXT)
   IS DISTINCT FROM ROW(p_disposition,p_checkpoint_id,p_actual_cost) THEN RAISE EXCEPTION 'terminal provider conflict' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state','completed','outcome_id',call_record.call_id);
 END IF;
 IF p_disposition='completed' THEN PERFORM require_guest_resource_success_checkpoint_v1(
  p_checkpoint_id,call_record.call_id,call_record.reservation_id,p_source_id,p_actual_cost::NUMERIC); END IF;
 use_now:=clock_timestamp();
 IF p_disposition='not_invoked' AND reservation.state='active' AND reservation.reservation_expires_at>use_now THEN
  -- Return the SAME full planned hold to the unspent plan. No global/owner
  -- budget increase occurs; another deliberate command may use that allowance.
  UPDATE guest_resource_session_reservations r SET remaining_units=remaining_units+1 WHERE r.reservation_id=reservation.reservation_id;
 END IF;
 UPDATE guest_resource_provider_calls c SET disposition=complete_guest_provider_call_v1.p_disposition,
  checkpoint_id=complete_guest_provider_call_v1.p_checkpoint_id,actual_cost_micros=CASE WHEN p_actual_cost IS NULL THEN NULL ELSE p_actual_cost::NUMERIC END,
  resolved_at=CASE WHEN complete_guest_provider_call_v1.p_disposition='unknown' THEN NULL ELSE use_now END WHERE c.call_id=call_record.call_id;
 RETURN jsonb_build_object('state','completed','outcome_id',call_record.call_id);
END $$;

CREATE FUNCTION guest_resource_component_has_history_v1(p_component_ids TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS(SELECT 1 FROM guest_resource_session_reservations WHERE source_owner_id=ANY(p_component_ids))
  OR EXISTS(SELECT 1 FROM guest_resource_provider_calls WHERE source_owner_id=ANY(p_component_ids))
  OR EXISTS(SELECT 1 FROM guest_resource_release_receipts WHERE source_owner_id=ANY(p_component_ids))
$$;



CREATE FUNCTION release_guest_resource_session_v1(p_source_id TEXT,p_operation JSONB,p_session_id TEXT,p_reservation_id TEXT,p_terminal_state TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE reservation guest_resource_session_reservations%ROWTYPE; prior guest_resource_release_receipts%ROWTYPE;
 component_ids TEXT[]; use_now TIMESTAMPTZ; receipt_id TEXT;
BEGIN
 IF p_operation->>'kind' NOT IN('study_start','study_answer') THEN RAISE EXCEPTION 'invalid release operation' USING ERRCODE='22023'; END IF;
 PERFORM validate_guest_resource_operation_v1(p_source_id,p_operation,p_operation->>'kind');
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=release_guest_resource_session_v1.p_reservation_id AND r.source_owner_id=p_source_id;
 component_ids:=lock_guest_resource_budget_v1(p_source_id,reservation.edge_fingerprint);
 SELECT * INTO STRICT reservation FROM guest_resource_session_reservations r WHERE r.reservation_id=release_guest_resource_session_v1.p_reservation_id FOR UPDATE;
 SELECT * INTO prior FROM guest_resource_release_receipts r WHERE r.source_owner_id=p_source_id
  AND operation_kind=p_operation->>'kind' AND idempotency_key=p_operation->>'idempotencyKey';
 IF FOUND THEN
  IF ROW(prior.request_hash,prior.session_id,prior.reservation_id,prior.terminal_state)
   IS DISTINCT FROM ROW(p_operation->>'requestHash',p_session_id,p_reservation_id,p_terminal_state)
   THEN RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='GP005'; END IF;
  RETURN jsonb_build_object('state','completed','outcome_id',prior.receipt_id);
 END IF;
 use_now:=clock_timestamp();
 IF reservation.session_id IS DISTINCT FROM p_session_id OR p_terminal_state IS NULL OR p_terminal_state NOT IN('completed','expired') OR reservation.state='refused'
  THEN RAISE EXCEPTION 'invalid terminal resource' USING ERRCODE='22023'; END IF;
 -- Caller words are not terminal authority. Inspect retained actual session.
 PERFORM 1 FROM study_sessions_v2 s WHERE s.session_id=release_guest_resource_session_v1.p_session_id
  AND s.participation_owner_id=p_source_id AND s.participation_owner_kind='guest'
  AND ((p_terminal_state='completed' AND s.status='completed') OR (p_terminal_state='expired' AND s.expires_at<=use_now)) FOR UPDATE;
 IF NOT FOUND THEN
  -- No session alone is NOT an abort witness. An expired uncaptured plan may
  -- release only after a durable known-aborted main start with exact identity.
  IF p_terminal_state<>'expired' OR reservation.reservation_expires_at>use_now OR NOT EXISTS(
   SELECT 1 FROM guest_participation_operations o WHERE o.source_owner_id=p_source_id AND o.operation_kind='study_start'
    AND o.idempotency_key=reservation.idempotency_key AND o.request_hash=reservation.request_hash AND o.state='known_aborted')
   THEN RAISE EXCEPTION 'authoritative terminal state required' USING ERRCODE='GP006'; END IF;
 END IF;
 IF reservation.state='active' THEN UPDATE guest_resource_session_reservations r SET state=p_terminal_state,remaining_units=0,released_at=use_now WHERE r.reservation_id=reservation.reservation_id; END IF;
 -- Provider reserved/unknown holds stay intact even when lesson remainder ends.
 receipt_id:='grr_'||gen_random_uuid()::TEXT;
 INSERT INTO guest_resource_release_receipts VALUES(receipt_id,p_source_id,p_operation->>'kind',p_operation->>'idempotencyKey',p_operation->>'requestHash',p_reservation_id,p_session_id,p_terminal_state,use_now);
 RETURN jsonb_build_object('state','completed','outcome_id',receipt_id);
END $$;

DO $private_guest_resource_packet$
DECLARE relation_name TEXT; signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted resource schema required'; END IF;
 FOREACH relation_name IN ARRAY ARRAY['guest_resource_global_lock','guest_resource_edge_locks',
  'guest_resource_policy_snapshots','guest_resource_cost_policy_snapshots','guest_resource_session_reservations',
  'guest_resource_provider_calls','guest_resource_release_receipts'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',relation_name);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_class c
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=to_regclass(relation_name) AND a.grantee<>0 AND a.grantee<>c.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',relation_name,grantee_name);
  END LOOP;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY[
  'require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)',
  'guard_guest_resource_session_v1()','guard_guest_resource_provider_call_v1()',
  'validate_guest_resource_operation_v1(text,jsonb,text)','validate_guest_resource_policy_v1(jsonb)',
  'lock_guest_resource_budget_v1(text,text)','guest_resource_usage_v1(text[],timestamptz)',
  'reserve_guest_resource_session_v1(text,jsonb,text,integer,text,text,jsonb)',
  'reserve_guest_provider_call_v1(text,jsonb,text,text,integer,text,text)',
  'complete_guest_provider_call_v1(text,jsonb,text,text,text,text,text)',
  'release_guest_resource_session_v1(text,jsonb,text,text,text)',
  'guest_resource_component_has_history_v1(text[])'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $private_guest_resource_packet$;

-- ROOT MUST ADOPT AS ONE PACKET, not run partial SQL:
-- (1) immutable/update-transition guards above + all inherited ACL revocations;
-- (2) trusted search_path on every helper/routine, helpers EXECUTE denied;
-- (3) phase literal practice_only_owner_resource_history_v2;
-- (4) phase13 whitelist adds exact three owner-resource relations (session,
--     provider calls, release receipts), never discovered by catalogue;
-- (5) converge ALL5 history check additionally rejects any component row in
--     ALL3 owner-resource relations. Old phase must NOT permit new producers.
-- The MD includes exact transition guards/integration requirements and fixtures.

-- Exact closed phase/convergence replacement; copy-bound to inspected0250.
DO $require_old_guest_resource_phase$
BEGIN
 IF (SELECT count(*) FROM guest_learning_schema_phase WHERE singleton AND phase='practice_only_owner_history_v1')<>1
 THEN RAISE EXCEPTION 'positive prior guest schema phase required'; END IF;
END $require_old_guest_resource_phase$;
ALTER TABLE guest_learning_schema_phase DROP CONSTRAINT guest_learning_schema_phase_phase_check;
UPDATE guest_learning_schema_phase SET phase='practice_only_owner_resource_history_v2' WHERE singleton AND phase='practice_only_owner_history_v1';
ALTER TABLE guest_learning_schema_phase ADD CONSTRAINT guest_learning_schema_phase_phase_check CHECK(phase='practice_only_owner_resource_history_v2');
CREATE OR REPLACE FUNCTION require_guest_practice_only_schema_phase_v1()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE trusted_namespace OID; trusted_owner OID;
BEGIN
  SELECT relnamespace,relowner INTO STRICT trusted_namespace,trusted_owner
    FROM pg_class WHERE oid='participation_owners'::regclass;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='guest_learning_schema_phase'::regclass
      AND relnamespace=trusted_namespace AND relowner=trusted_owner)
    OR (SELECT count(*) FROM guest_learning_schema_phase
      WHERE singleton AND phase='practice_only_owner_resource_history_v2')<>1
    OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relnamespace=trusted_namespace AND c.relkind IN ('r','p','f','v','m')
        AND a.attnum>0 AND NOT a.attisdropped
        -- Guest source IDs; ordinary account/policy/lease owner fields have
        -- separate accepted authorities and do not reference guest identities.
        AND a.attname ~ '(^|_)owner_id$'
        AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases',
          'participation_owner_clocks','guest_learning_preferences',
          'guest_participation_operations','guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts'))
    OR EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE fk.contype='f' AND fk.confrelid=ANY(ARRAY[
          'participation_owners'::regclass,'guest_credentials'::regclass,
          'guest_empty_owner_aliases'::regclass,'participation_owner_clocks'::regclass,
          'guest_learning_preferences'::regclass,'guest_participation_operations'::regclass,
          'guest_secret_issuance_operations'::regclass,'guest_attachment_intents'::regclass])
        AND c.relnamespace=trusted_namespace AND c.relname NOT IN (
          'participation_owners','guest_credentials','guest_empty_owner_aliases','participation_owner_clocks',
          'guest_learning_preferences','guest_participation_operations',
          'guest_secret_issuance_operations','guest_attachment_intents',
          'study_sessions_v2','study_review_items','study_session_items_v2',
          'study_spoken_answer_commands','learner_audio_artifacts',
          'guest_resource_session_reservations','guest_resource_provider_calls','guest_resource_release_receipts'))
    OR EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=trusted_namespace
      AND relname IN ('guest_owner_associations','participation_eligibility_decisions',
        'megapot_owner_shares','megapot_owner_snapshot_leaves','megapot_owner_allocations',
        'reward_credit_persona_bindings','reward_credit_recipient_selections'))
  THEN RAISE EXCEPTION 'owner history closure unavailable' USING ERRCODE='GP003'; END IF;
END $$;

CREATE OR REPLACE FUNCTION converge_proved_empty_guest_sources_v1(expected_origin TEXT,proved_ids TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE roots TEXT[]; component_ids TEXT[]; canonical TEXT; source_id TEXT;
BEGIN
  SELECT array_agg(DISTINCT resolve_guest_empty_owner_root_v1(c.owner_id)) INTO roots
    FROM guest_credentials c WHERE c.credential_id=ANY(proved_ids) AND c.origin=expected_origin
      AND (c.state='confirmed' OR
        (c.state IN ('pending_bootstrap','pending_successor') AND c.pending_expires_at>clock_timestamp()));
  IF COALESCE(cardinality(roots),0)<=1 THEN RETURN; END IF;
  PERFORM require_guest_practice_only_schema_phase_v1();
  WITH RECURSIVE component(owner_id) AS (
    SELECT unnest(roots)
    UNION SELECT a.source_owner_id FROM guest_empty_owner_aliases a
      JOIN component c ON a.canonical_owner_id=c.owner_id
  ) SELECT array_agg(owner_id ORDER BY owner_id COLLATE "C") INTO component_ids FROM component;
  IF EXISTS(SELECT 1 FROM study_sessions_v2 WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_review_items WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_session_items_v2 WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM study_spoken_answer_commands WHERE participation_owner_id=ANY(component_ids))
    OR EXISTS(SELECT 1 FROM learner_audio_artifacts WHERE participation_owner_id=ANY(component_ids))
    OR guest_resource_component_has_history_v1(component_ids)
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  IF EXISTS(SELECT 1 FROM participation_owners WHERE owner_id=ANY(roots) AND state<>'empty') THEN
    RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  IF EXISTS(SELECT 1 FROM guest_participation_operations operation
      JOIN participation_owners source_owner ON source_owner.owner_id=operation.source_owner_id
      WHERE operation.operation_kind='study_start' AND operation.state<>'known_aborted'
        AND CASE WHEN source_owner.kind='guest' THEN
          resolve_guest_empty_owner_root_v1(operation.source_owner_id) END=ANY(roots))
     OR EXISTS(SELECT 1 FROM guest_attachment_intents intent
      WHERE intent.state IN ('awaiting_account','awaiting_confirmation') AND intent.expires_at>clock_timestamp()
        AND resolve_guest_empty_owner_root_v1(intent.owner_id)=ANY(roots))
  THEN RAISE EXCEPTION 'authority-conflict' USING ERRCODE='GP003'; END IF;
  SELECT owner_id INTO STRICT canonical FROM participation_owners WHERE owner_id=ANY(roots)
    ORDER BY created_at,owner_id COLLATE "C" LIMIT 1;
  FOR source_id IN SELECT owner_id FROM participation_owners WHERE owner_id=ANY(roots) AND owner_id<>canonical
      ORDER BY owner_id COLLATE "C" LOOP
    INSERT INTO guest_empty_owner_aliases(source_owner_id,canonical_owner_id,origin,created_at)
      VALUES(source_id,canonical,expected_origin,clock_timestamp());
    UPDATE participation_owners SET state='aliased_empty' WHERE owner_id=source_id;
  END LOOP;
END $$;
DO $rebind_guest_resource_closure$
DECLARE signature TEXT; grantee_name TEXT; trusted_schema TEXT:=current_schema();
BEGIN
 IF trusted_schema IS NULL OR trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp' THEN RAISE EXCEPTION 'trusted resource schema required'; END IF;
 FOREACH signature IN ARRAY ARRAY['require_guest_practice_only_schema_phase_v1()',
  'converge_proved_empty_guest_sources_v1(text,text[])'] LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',signature,trusted_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
   CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
   WHERE f.oid=signature::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,grantee_name);
  END LOOP;
 END LOOP;
END $rebind_guest_resource_closure$;
-- Explicit0250 search_path/ACL configuration is rebound after replacements.
-- Runtime role grants remain absent. Release/exact checkpoint/body mapper acceptance
-- is mandatory before admission; source proposal success is not deployment authority.
