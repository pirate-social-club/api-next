-- Read-only scheduling candidates let Jobs wait for chain progress before
-- charging another finite discovery attempt. Existing claims and limits remain.
CREATE FUNCTION list_song_funding_candidates_v2(n INTEGER,cursor BIGINT DEFAULT 0) RETURNS SETOF JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF (n BETWEEN 1 AND 1000 AND cursor BETWEEN 0 AND 9007199254740991) IS NOT TRUE THEN
  RAISE EXCEPTION 'bounded candidate limit and cursor required' USING ERRCODE='PCV07'; END IF;
 RETURN QUERY SELECT song_funding_work_packet_v2(w)
 FROM reward_funding_work_envelopes_v2 w JOIN reward_funding_profiles_v2 p USING(profile_id)
 WHERE w.scope='reconciliation' AND p.accepted AND p.valid_until>clock_timestamp()
  AND p.policy->'reconciliation' IS NOT NULL
  AND coalesce(w.payload->>'status','pending') NOT IN ('complete','exhausted')
  AND (w.payload->>'leaseUntil' IS NULL OR (w.payload->>'leaseUntil')::TIMESTAMPTZ<=clock_timestamp())
 -- Rotate each scheduled minute: waiting work cannot monopolize a bounded batch.
 ORDER BY mod(row_number() OVER(ORDER BY w.work_id)-1+cursor,count(*) OVER()) LIMIT n;
END $$;

CREATE OR REPLACE FUNCTION bind_reward_contribution_purpose_v2(role_name TEXT,purpose TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[]; signature TEXT; trusted TEXT:=current_schema(); target OID; owner OID;
BEGIN
  SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=role_name AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls;
  SELECT relowner INTO STRICT owner FROM pg_class WHERE oid='song_megapot_contributions_v2'::regclass;
  IF pg_has_role(target,owner,'MEMBER') THEN RAISE EXCEPTION 'runtime owns money authority' USING ERRCODE='42501'; END IF;
  CASE purpose
    WHEN 'http_commands' THEN allowed:=ARRAY[
      'read_song_contribution_context_v2(jsonb,text)','read_song_contribution_command_v2(jsonb,text,text)','read_owned_song_contribution_current_v2(jsonb)',
      'load_song_contribution_command_v2(text,text,text)','load_owned_song_contribution_v2(jsonb)',
      'lock_song_contribution_context_v2(jsonb,text)','create_song_contribution_v2(jsonb,jsonb,text)',
      'update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)','enqueue_song_contribution_reconciliation_v2(jsonb,jsonb,jsonb)',
      'load_song_contribution_recovery_v2(jsonb)','lock_reward_wallet_nonce_sender_v2(bigint,text)',
      'reward_wallet_nonce_context_v2(bigint,text,text)','reserve_reward_funding_wallet_nonce_v2(jsonb)',
      'load_reward_funding_wallet_nonce_owner_v2(jsonb)','record_song_contribution_refusal_v2(jsonb,text,text)'];
    WHEN 'incoming_observer' THEN allowed:=ARRAY['load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    WHEN 'funding_recovery_jobs' THEN allowed:=ARRAY[
      'invalidate_song_recovery_evidence_v2(text,text,text)','require_song_funding_work_lease_v2(text,text)','list_song_funding_work_v2(integer)','list_song_funding_candidates_v2(integer,bigint)','claim_song_funding_work_v2(text,text)',
      'record_song_recovery_evidence_v2(text,text,jsonb)','finish_song_funding_work_v2(text,text,jsonb)',
      'load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    WHEN 'cohort_evidence' THEN allowed:=ARRAY['record_reward_pool_cohort_v2(text,text,text,jsonb)'];
    ELSE RAISE EXCEPTION 'unrecognized funding purpose' USING ERRCODE='42501';
  END CASE;
  FOREACH signature IN ARRAY allowed LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',trusted,signature,role_name);
  END LOOP;
END $$;

DO $candidate_acl$
DECLARE trusted TEXT:=current_schema(); r RECORD; signature TEXT; target OID;
BEGIN
 FOREACH signature IN ARRAY ARRAY['list_song_funding_candidates_v2(integer,bigint)'] LOOP
  target:=signature::REGPROCEDURE;
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',trusted,signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',trusted,signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=target AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I CASCADE',trusted,signature,r.name);
  END LOOP;
 END LOOP;
END $candidate_acl$;
