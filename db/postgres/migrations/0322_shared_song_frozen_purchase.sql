-- A future shared-song prospectus is conditional on its actual initialized
-- drawing. Preserve the original snapshot and refuse changed dates/prices or
-- the original purchase deadline. No profile, budget or admission is changed.
CREATE FUNCTION load_shared_song_frozen_plan_v2(p_leg TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE leg song_reward_offer_legs; offer song_reward_offers; plans JSONB;
BEGIN
  IF p_leg IS NULL OR length(p_leg) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'frozen plan identity required' USING ERRCODE='PCV07'; END IF;
  SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id=p_leg;
  IF NOT FOUND OR leg.qualification_family_v2 IS DISTINCT FROM 'shared_song' THEN RETURN NULL; END IF;
  SELECT * INTO STRICT offer FROM song_reward_offers WHERE offer_id=leg.offer_id;
  SELECT jsonb_agg(candidate.packet) INTO plans FROM (
    SELECT jsonb_build_object('target',c.state->'receipt'->'target',
      'terms',leg.shared_song_terms_v2,'originContext',s.context) packet
    FROM song_megapot_contributions_v2 c
    JOIN reward_funding_leg_snapshots_v2 s ON s.snapshot_id=c.snapshot_id AND s.profile_id=c.profile_id
    JOIN reward_funding_schedule_witnesses_v2 w ON w.witness_id=s.witness_id AND w.profile_id=s.profile_id
    WHERE c.pool_leg_id=leg.leg_id AND c.community_id=offer.community_id AND c.post_id=offer.post_id
      AND c.profile_id=leg.shared_song_terms_v2->>'profile_id'
      AND c.state->'receipt'->'committed_terms'=leg.shared_song_terms_v2
      AND c.state->'receipt'->'target'->>'offer_id'=leg.offer_id
      AND c.state->'receipt'->>'accepted_prospective_terms_hash'=leg.shared_song_terms_v2->>'origin_prospective_terms_hash'
      AND s.context->'target'->>'kind'='empty' AND s.context->'target'->>'slot_id'=s.slot_id
      AND s.context->'quote'->>'kind'='prospective'
      AND s.context->'quote'->>'prospective_terms_hash'=leg.shared_song_terms_v2->>'origin_prospective_terms_hash'
      AND s.context->'quote'->'prospective_terms'->>'planned_schedule_hash'=leg.shared_song_terms_v2->>'planned_schedule_hash'
      AND s.context->'quote'->'prospective_terms'->'planned_drawing_ids'=leg.shared_song_terms_v2->'planned_drawing_ids'
      AND s.context->'quote'->'prospective_terms'->>'fixed_ends_at'=leg.shared_song_terms_v2->>'ends_at'
      AND s.context->>'context_hash'=s.context_hash
      AND s.context->'context_ref'->>'schedule_witness_id'=w.witness_id
      AND s.context->'schedule'->>'schedule_witness_id'=w.witness_id
      AND s.context->'actor'->>'account_id'=c.account_id
      AND s.context->'actor'->>'persona_id'=c.state->'owner'->>'persona_id'
      AND s.context->'actor'->>'wallet_assignment_id'=c.state->'receipt'->'instruction'->>'wallet_assignment_id'
    ORDER BY c.created_at,c.contribution_id LIMIT 2
  ) candidate;
  IF jsonb_array_length(plans) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'original frozen shared-song plan unavailable' USING ERRCODE='PCV05'; END IF;
  RETURN plans->0;
END $$;

CREATE FUNCTION guard_shared_song_frozen_purchase_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE leg song_reward_offer_legs; observed megapot_drawing_observations; plan JSONB; frozen JSONB;
BEGIN
  IF TG_RELID<>'megapot_pool_drawings'::REGCLASS OR TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'invalid frozen purchase trigger'; END IF;
  SELECT * INTO STRICT leg FROM song_reward_offer_legs WHERE leg_id=NEW.pool_leg_id FOR SHARE;
  IF leg.qualification_family_v2 IS DISTINCT FROM 'shared_song' THEN RETURN NEW; END IF;
  plan:=load_shared_song_frozen_plan_v2(leg.leg_id);
  SELECT value INTO STRICT frozen FROM jsonb_array_elements(plan->'originContext'->'schedule'->'rows')
    WHERE value->>'drawing_id'=NEW.drawing_id::TEXT;
  SELECT * INTO STRICT observed FROM megapot_drawing_observations
    WHERE observation_id=NEW.observation_id FOR SHARE;
  IF (leg.status='active' AND observed.attestation_id=leg.attestation_id
    AND observed.drawing_id=NEW.drawing_id AND NOT observed.drawing_locked
    AND observed.expires_at>clock_timestamp()
    AND plan->'terms'->'planned_drawing_ids' @> jsonb_build_array(NEW.drawing_id::TEXT)
    AND (frozen->>'drawing_time')::TIMESTAMPTZ=observed.drawing_time
    AND (frozen->>'price_atomic')::NUMERIC=observed.ticket_price_atomic
    AND (frozen->>'entry_cutoff_at')::TIMESTAMPTZ=NEW.entry_cutoff_at
    AND NEW.entry_cutoff_at=observed.drawing_time-make_interval(secs=>leg.entry_cutoff_seconds)
    AND (frozen->>'purchase_deadline_at')::TIMESTAMPTZ>clock_timestamp()) IS NOT TRUE THEN
    RAISE EXCEPTION 'frozen shared-song drawing changed or purchase deadline passed' USING ERRCODE='PCV05'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_song_frozen_purchase_guard_v2 BEFORE INSERT ON megapot_pool_drawings
  FOR EACH ROW EXECUTE FUNCTION guard_shared_song_frozen_purchase_v2();

-- One read-only purpose; raw private funding tables remain denied.
CREATE OR REPLACE FUNCTION grant_shared_song_funding_runtime_v2(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target OID; owner OID; signature TEXT; allowed TEXT[];
BEGIN
 SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=p_role AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls;
 SELECT relowner INTO owner FROM pg_class WHERE oid='reward_shared_song_templates_v2'::REGCLASS;
 IF session_user<>pg_get_userbyid(owner) THEN RAISE EXCEPTION 'funding runtime binding requires owner custody' USING ERRCODE='42501'; END IF;
 IF pg_has_role(target,owner,'MEMBER') THEN RAISE EXCEPTION 'runtime inherits funding owner' USING ERRCODE='42501'; END IF;
 allowed:=CASE p_purpose WHEN 'account' THEN ARRAY[
  'load_shared_song_reward_template_v2(text,text)','instantiate_shared_song_reward_policy_v2(jsonb,text,text,text,jsonb,text)',
  'bind_initial_shared_song_pot_v2(jsonb,text,jsonb)','read_shared_song_megapot_summary_v2(text,text,text)']
 WHEN 'context_worker' THEN ARRAY['claim_next_shared_song_context_v2(text)',
  'persist_shared_song_context_v2(text,text,jsonb,jsonb,jsonb,boolean)','finish_shared_song_context_failure_v2(text,text,text)']
 WHEN 'safe_purchase' THEN ARRAY['load_shared_song_frozen_plan_v2(text)'] END;
 IF allowed IS NULL THEN RAISE EXCEPTION 'explicit funding purpose required' USING ERRCODE='42501'; END IF;
 FOREACH signature IN ARRAY allowed LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature::regprocedure,p_role);
 END LOOP;
END $$;

DO $frozen_purchase_acl$
DECLARE trusted TEXT:=current_schema(); r RECORD; signature TEXT; target OID;
BEGIN
 FOREACH signature IN ARRAY ARRAY['load_shared_song_frozen_plan_v2(text)',
   'guard_shared_song_frozen_purchase_v2()','grant_shared_song_funding_runtime_v2(text,text)'] LOOP
  target:=signature::REGPROCEDURE;
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path TO pg_catalog,%I,pg_temp',trusted,signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',trusted,signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=target AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I CASCADE',trusted,signature,r.name);
  END LOOP;
 END LOOP;
END $frozen_purchase_acl$;
