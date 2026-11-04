-- Outside proposal, NO ordinal/grant/activation. One candidate per owning short
-- transaction avoids holding components/edges of multiple owners out of order.
-- System expiry authority derives solely from retained DB facts; no browser proof,
-- provider, object storage, financial entry, caller owner-array or clock is used.
SELECT pg_advisory_xact_lock(83000003,1);
CREATE FUNCTION release_next_guest_study_resource_remainder_v1()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate guest_resource_session_reservations%ROWTYPE;
 terminal TEXT; release_result JSONB;
BEGIN
 PERFORM require_guest_study_composition_v1();
 -- Shared topology, then GLOBAL. Native release subsequently acquires original
 -- EDGE -> complete C-sorted owner component -> reservation/session in order.
 PERFORM 1 FROM guest_resource_global_lock WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'resource global anchor unavailable' USING ERRCODE='GP006'; END IF;
 SELECT r.* INTO candidate FROM guest_resource_session_reservations r
  WHERE r.state='active' AND (
   EXISTS(SELECT 1 FROM study_sessions_v2 s WHERE s.session_id=r.session_id
     AND s.participation_owner_id=r.source_owner_id AND s.participation_owner_kind='guest'
     AND s.guest_resource_reservation_id=r.reservation_id
     AND (s.status='completed' OR s.expires_at<=clock_timestamp()))
   OR (r.reservation_expires_at<=clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM study_sessions_v2 s WHERE s.session_id=r.session_id)
     AND EXISTS(SELECT 1 FROM guest_participation_operations o
       WHERE o.source_owner_id=r.source_owner_id AND o.operation_kind='study_start'
        AND o.idempotency_key=r.idempotency_key AND o.request_hash=r.request_hash
        AND o.state='known_aborted')))
  ORDER BY r.reservation_expires_at,r.reservation_id COLLATE "C" LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','idle'); END IF;
 -- This is only a proposed terminal word. Native0251 independently locks and
 -- rechecks the actual captured completed/expired session or exact abort witness.
 SELECT CASE WHEN s.status='completed' THEN 'completed' ELSE 'expired' END INTO terminal
  FROM study_sessions_v2 s WHERE s.session_id=candidate.session_id
   AND s.participation_owner_id=candidate.source_owner_id AND s.participation_owner_kind='guest'
   AND s.guest_resource_reservation_id=candidate.reservation_id;
 terminal:=COALESCE(terminal,'expired');
 release_result:=release_guest_resource_session_v1(candidate.source_owner_id,
  jsonb_build_object('sourceOwnerId',candidate.source_owner_id,'kind','study_start',
   'idempotencyKey',candidate.idempotency_key,'requestHash',candidate.request_hash),
  candidate.session_id,candidate.reservation_id,terminal);
 IF release_result->>'state' IS DISTINCT FROM 'completed'
   OR release_result->>'outcome_id' IS NULL THEN
  RAISE EXCEPTION 'native resource release receipt unavailable' USING ERRCODE='GP006'; END IF;
 -- Do not mark the lesson expired/aborted, mutate an original operation/clock,
 -- delete a receipt or settle/refund any reserved/unknown provider call. A late
 -- accepted checkpoint must still use its original captured continuation.
 RETURN jsonb_build_object('state','released','terminalState',terminal);
END $$;
DO $private_guest_study_resource_expiry$
DECLARE trusted_schema TEXT; expected_owner OID; grantee_name TEXT;
BEGIN
 SELECT n.nspname,c.relowner INTO STRICT trusted_schema,expected_owner
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='participation_owners'::regclass;
 IF trusted_schema='pg_catalog' OR trusted_schema ~ '^pg_temp'
  OR (SELECT proowner FROM pg_proc WHERE oid='release_next_guest_study_resource_remainder_v1()'::regprocedure)<>expected_owner THEN
  RAISE EXCEPTION 'trusted expiry routine owner required'; END IF;
 EXECUTE format('ALTER FUNCTION release_next_guest_study_resource_remainder_v1() SET search_path TO pg_catalog,%I,pg_temp',trusted_schema);
 REVOKE ALL ON FUNCTION release_next_guest_study_resource_remainder_v1() FROM PUBLIC;
 FOR grantee_name IN SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc f
  CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
  WHERE f.oid='release_next_guest_study_resource_remainder_v1()'::regprocedure AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION release_next_guest_study_resource_remainder_v1() FROM %I',grantee_name);
 END LOOP;
END $private_guest_study_resource_expiry$;
