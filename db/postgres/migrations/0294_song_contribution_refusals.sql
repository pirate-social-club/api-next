-- Source only. A terminal Create refusal shares the successful command's key.
-- The caller rolls all attempted creation writes back to its savepoint while
-- retaining the original command fence, then commits this resolution alone.
-- No role, financial policy, credential or serving configuration is selected.
ALTER TABLE song_megapot_contribution_commands_v2
  ALTER COLUMN contribution_id DROP NOT NULL,
  ADD COLUMN refusal_code TEXT,
  ADD CONSTRAINT song_contribution_resolution_v2 CHECK ((
    (refusal_code IS NULL AND contribution_id IS NOT NULL)
    OR (operation='CreateSongMegapotContributionV2' AND contribution_id IS NULL
      AND preparation_revision IS NULL
      AND refusal_code IN (
        'invalid_request','not_found','context_stale','terms_mismatch','lifecycle_changed',
        'persona_not_owned','persona_wrong_community','wallet_not_ready','wallet_nonce_busy',
        'quota_exhausted','account_excluded','policy_unavailable','mixed_objective_unavailable',
        'legacy_pool_incompatible','schedule_unproven','observation_stale','price_changed',
        'cutoff_passed','amount_below_minimum','capacity_exhausted','effect_limit','attempt_limit',
        'rate_limited','work_budget_exhausted','gas_budget_unavailable','paused',
        'attestation_unavailable','recovery_required','quote_expired','quote_mismatch',
        'quote_reference_invalid')
      AND receipt=jsonb_build_object('command_id',command_id,'request_hash',request_hash,
        'allocation','none','instruction_issued',FALSE))
  ) IS TRUE);

CREATE OR REPLACE FUNCTION load_song_contribution_command_v2(a TEXT,o TEXT,k TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT CASE WHEN refusal_code IS NULL THEN
    jsonb_build_object('requestHash',request_hash,'receipt',receipt)
  ELSE jsonb_build_object('accountId',account_id,'communityId',community_id,'postId',post_id,
    'operation',operation,'key',idempotency_key,'requestHash',request_hash,
    'refusal',jsonb_build_object('code',refusal_code,'receipt',receipt)) END
  FROM song_megapot_contribution_commands_v2
  WHERE account_id=a AND operation=o AND idempotency_key=k
$$;

CREATE OR REPLACE FUNCTION read_song_contribution_command_v2(i JSONB,o TEXT,k TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT jsonb_build_object('accountId',account_id,'communityId',community_id,'postId',post_id,
    'operation',operation,'key',idempotency_key,'requestHash',request_hash)
    || CASE WHEN refusal_code IS NULL THEN jsonb_build_object('receipt',receipt)
       ELSE jsonb_build_object('refusal',jsonb_build_object('code',refusal_code,'receipt',receipt)) END
  FROM song_megapot_contribution_commands_v2 WHERE account_id=i->>'accountId'
    AND community_id=i->>'communityId' AND post_id=i->>'postId'
    AND operation=o AND idempotency_key=k
$$;

CREATE FUNCTION record_song_contribution_refusal_v2(i JSONB,reason TEXT,command TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE receipt JSONB;
BEGIN
  IF (i->>'operation'='CreateSongMegapotContributionV2'
    AND i->'contributionId'='null'::JSONB AND i->>'accountId' IS NOT NULL
    AND i->>'communityId' IS NOT NULL AND i->>'postId' IS NOT NULL
    AND i->>'key' IS NOT NULL AND i->>'hash' ~ '^[a-f0-9]{64}$'
    AND command IS NOT NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid original creation identity' USING ERRCODE='PCV07';
  END IF;
  -- The existing unique key forbids both a receipt and a refusal, including
  -- concurrent old-Worker inserts. Append-only guards retain that fence.
  receipt:=jsonb_build_object('command_id',command,'request_hash',i->>'hash',
    'allocation','none','instruction_issued',FALSE);
  INSERT INTO song_megapot_contribution_commands_v2(
    command_id,account_id,operation,idempotency_key,request_hash,community_id,post_id,
    contribution_id,receipt,refusal_code)
  VALUES(command,i->>'accountId',i->>'operation',i->>'key',i->>'hash',
    i->>'communityId',i->>'postId',NULL,receipt,reason);
  RETURN load_song_contribution_command_v2(i->>'accountId',i->>'operation',i->>'key');
END $$;

DO $acl$
DECLARE trusted TEXT:=current_schema(); r RECORD;
  fn REGPROCEDURE:='record_song_contribution_refusal_v2(jsonb,text,text)'::REGPROCEDURE;
BEGIN
  EXECUTE format('ALTER FUNCTION load_song_contribution_command_v2(text,text,text) SET search_path TO %I,pg_catalog,pg_temp',trusted);
  EXECUTE format('ALTER FUNCTION read_song_contribution_command_v2(jsonb,text,text) SET search_path TO %I,pg_catalog,pg_temp',trusted);
  EXECUTE format('ALTER FUNCTION %s SET search_path TO %I,pg_catalog,pg_temp',fn,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
  FOR r IN SELECT DISTINCT acl.grantee FROM pg_proc f
    CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl
    WHERE f.oid=fn::OID AND acl.grantee<>0 AND acl.grantee<>f.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',fn,pg_get_userbyid(r.grantee));
  END LOOP;
END $acl$;

-- Preserve the existing owner-only, invoker binding boundary. Existing managed
-- runtime identities must be rebound by the reviewed release permission plan.
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
      'invalidate_song_recovery_evidence_v2(text,text,text)','require_song_funding_work_lease_v2(text,text)','list_song_funding_work_v2(integer)','claim_song_funding_work_v2(text,text)',
      'record_song_recovery_evidence_v2(text,text,jsonb)','finish_song_funding_work_v2(text,text,jsonb)',
      'load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    WHEN 'cohort_evidence' THEN allowed:=ARRAY['record_reward_pool_cohort_v2(text,text,text,jsonb)'];
    ELSE RAISE EXCEPTION 'unrecognized funding purpose' USING ERRCODE='42501';
  END CASE;
  FOREACH signature IN ARRAY allowed LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',trusted,signature,role_name);
  END LOOP;
END $$;
