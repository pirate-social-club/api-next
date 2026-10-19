-- SOURCE ONLY. No roles/credentials are created or guessed. Every new object
-- starts migration-owner only, including inherited/default grants. The parent
-- must bind exact existing runtime roles after independent migration review.
DO $acl$
DECLARE t RECORD; r RECORD; f RECORD; trusted TEXT:=current_schema();
BEGIN
  FOR t IN SELECT c.oid,c.relname,c.relowner FROM pg_class c WHERE c.relnamespace=to_regnamespace(trusted) AND c.relname IN (
    'reward_funding_profiles_v2','reward_funding_schedule_witnesses_v2','reward_song_slots_v2','reward_funding_leg_snapshots_v2',
    'song_megapot_contributions_v2','song_megapot_contribution_commands_v2','reward_funding_submission_claims_v2',
    'reward_contribution_reservations_v2','reward_funding_account_counters_v2','reward_funding_work_envelopes_v2',
    'reward_funding_scan_checkpoints_v2','reward_incoming_receipts_v2','reward_pool_cohort_seals_v2',
    'reward_pool_cohort_members_v2','reward_late_principal_liabilities_v2') LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC CASCADE',trusted,t.relname);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=t.oid AND a.grantee<>0 AND a.grantee<>t.relowner LOOP
      EXECUTE format('REVOKE ALL ON %I.%I FROM %I CASCADE',trusted,t.relname,r.name);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace=to_regnamespace(trusted) AND p.proname IN (
    'invalidate_song_recovery_evidence_v2','require_song_funding_work_lease_v2','song_funding_work_packet_v2','list_song_funding_work_v2','claim_song_funding_work_v2','record_song_recovery_evidence_v2','finish_song_funding_work_v2','reject_reward_contribution_history_v2','guard_reward_funding_scan_checkpoint_v2','guard_reward_song_slot_v2','load_song_contribution_command_v2','load_owned_song_contribution_v2','project_song_contribution_state_v2',
    'lock_song_contribution_context_v2','insert_song_contribution_command_v2','charge_reward_funding_work_v2','assert_reward_contribution_capacity_v2',
    'create_song_contribution_v2','update_song_contribution_command_v2','enqueue_song_contribution_reconciliation_v2',
    'load_song_contribution_recovery_v2','accept_reward_funding_principal_v2','record_reward_pool_cohort_v2','canonical_reward_funding_array_v2') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog,%I,pg_temp',f.signature,trusted);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
    FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f.oid AND a.grantee<>0 AND a.grantee<>f.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name);
    END LOOP;
  END LOOP;
  -- CREATE OR REPLACE retained the original274 grants. Restore the secure path
  -- without revoking the accepted winner roles' existing context capability.
  EXECUTE format('ALTER FUNCTION reward_wallet_nonce_context_v2(bigint,text,text) SET search_path TO pg_catalog,%I,pg_temp',trusted);
END $acl$;

CREATE FUNCTION bind_reward_contribution_purpose_v2(role_name TEXT,purpose TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE allowed TEXT[]; signature TEXT; trusted TEXT:=current_schema(); target OID; owner OID;
BEGIN
  -- SECURITY INVOKER and owner-only EXECUTE: no runtime can bind itself.
  SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=role_name AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls;
  SELECT relowner INTO STRICT owner FROM pg_class WHERE oid='song_megapot_contributions_v2'::regclass;
  IF pg_has_role(target,owner,'MEMBER') THEN RAISE EXCEPTION 'runtime owns money authority' USING ERRCODE='42501'; END IF;
  CASE purpose
    WHEN 'http_commands' THEN allowed:=ARRAY[
      'load_song_contribution_command_v2(text,text,text)','load_owned_song_contribution_v2(jsonb)',
      'lock_song_contribution_context_v2(jsonb,text)','create_song_contribution_v2(jsonb,jsonb,text)',
      'update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)','enqueue_song_contribution_reconciliation_v2(jsonb,jsonb,jsonb)',
      'load_song_contribution_recovery_v2(jsonb)','lock_reward_wallet_nonce_sender_v2(bigint,text)',
      'reward_wallet_nonce_context_v2(bigint,text,text)','reserve_reward_funding_wallet_nonce_v2(jsonb)',
      'load_reward_funding_wallet_nonce_owner_v2(jsonb)'];
    WHEN 'incoming_observer' THEN allowed:=ARRAY['load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    WHEN 'funding_recovery_jobs' THEN allowed:=ARRAY[
      'invalidate_song_recovery_evidence_v2(text,text,text)','require_song_funding_work_lease_v2(text,text)','list_song_funding_work_v2(integer)','claim_song_funding_work_v2(text,text)',
      'record_song_recovery_evidence_v2(text,text,jsonb)','finish_song_funding_work_v2(text,text,jsonb)',
      'load_owned_song_contribution_v2(jsonb)','accept_reward_funding_principal_v2(jsonb)'];
    -- Evidence-only seal storage does not grant outgoing/refund completion.
    WHEN 'cohort_evidence' THEN allowed:=ARRAY['record_reward_pool_cohort_v2(text,text,text,jsonb)'];
    ELSE RAISE EXCEPTION 'unrecognized funding purpose' USING ERRCODE='42501';
  END CASE;
  FOREACH signature IN ARRAY allowed LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',trusted,signature,role_name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION bind_reward_contribution_purpose_v2(TEXT,TEXT) FROM PUBLIC;
DO $binding_acl$
DECLARE r RECORD; f OID:='bind_reward_contribution_purpose_v2(text,text)'::regprocedure;
BEGIN
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) AS name FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=f AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION bind_reward_contribution_purpose_v2(text,text) FROM %I CASCADE',r.name);
  END LOOP;
END $binding_acl$;
