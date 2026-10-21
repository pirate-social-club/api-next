-- Prospective CP1/CP2 source. Applied history is untouched. No policies,
-- budgets, credentials, flags or financial authority are selected/enabled here.
CREATE TABLE reward_shared_song_templates_v2 (
 template_id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities,
 profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2,
 template_hash TEXT NOT NULL UNIQUE CHECK(template_hash ~ '^[a-f0-9]{64}$'),
 attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations,
 reward_policy JSONB NOT NULL CHECK(jsonb_typeof(reward_policy)='object'),
 compiled_plan JSONB NOT NULL CHECK(jsonb_typeof(compiled_plan)='object'),
 qualification_templates JSONB NOT NULL CHECK(jsonb_typeof(qualification_templates)='array' AND jsonb_array_length(qualification_templates)=3),
 operational_profile JSONB NOT NULL CHECK(jsonb_typeof(operational_profile)='object'),
 accepted_by TEXT NOT NULL CHECK(btrim(accepted_by)<>''), accepted_receipt_hash TEXT NOT NULL CHECK(accepted_receipt_hash ~ '^[a-f0-9]{64}$'),
 valid_from TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL CHECK(valid_until>valid_from),
 CHECK((reward_policy->>'version'='shared_song_megapot_v2'
   AND reward_policy->>'pool_entry'='qualifying_account'
   AND reward_policy->>'claim_verification'='megapot_claim_time_verification_v1') IS TRUE),
 CHECK((operational_profile ?& ARRAY['disclosureVersion','feePolicyId','scheduleRuleId','scheduleRuleHash','priceRuleHash','finalityPolicyId','cadenceSeconds','entryCutoffSeconds','purchaseLeadSeconds','maximumContextAttempts','contextLeaseMs','inboundRequiredGasWei','legalActivationGate','initializedDrawingIds','maximumContextWorkPerAccount','maximumContextWorkGlobal','contextWorkPerAttempt','refundEnvelopeMinimumWei']) IS TRUE),
 UNIQUE(community_id,template_id)
);
CREATE TRIGGER shared_song_template_immutable BEFORE UPDATE OR DELETE ON reward_shared_song_templates_v2
 FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TRIGGER shared_song_template_no_truncate BEFORE TRUNCATE ON reward_shared_song_templates_v2
 FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TABLE reward_shared_song_template_admissions_v2 (
 community_id TEXT PRIMARY KEY REFERENCES communities,
 template_id TEXT NOT NULL, accepted BOOLEAN NOT NULL,
 admission_hash TEXT NOT NULL CHECK(admission_hash ~ '^[a-f0-9]{64}$'),
 accepted_by TEXT NOT NULL CHECK(btrim(accepted_by)<>''),
 effective_at TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL CHECK(valid_until>effective_at),
 FOREIGN KEY(community_id,template_id) REFERENCES reward_shared_song_templates_v2(community_id,template_id)
);

-- Stable metadata only: no offer, leg, budget, nonce or GET-time allocation.
CREATE FUNCTION initialize_shared_song_slot_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.post_type='song' AND NEW.status='published' THEN
   INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status)
    VALUES('song-slot:'||encode(sha256(convert_to(jsonb_build_array(NEW.community_id,NEW.post_id)::TEXT,'UTF8')),'hex'),
      NEW.community_id,NEW.post_id,0,NULL,NULL,FALSE,'open') ON CONFLICT(community_id,post_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_song_slot_metadata AFTER INSERT OR UPDATE OF post_type,status ON posts
 FOR EACH ROW EXECUTE FUNCTION initialize_shared_song_slot_v2();
INSERT INTO reward_song_slots_v2(slot_id,community_id,post_id,generation,target,terms,reward_policy_ready,status)
 SELECT 'song-slot:'||encode(sha256(convert_to(jsonb_build_array(p.community_id,p.post_id)::TEXT,'UTF8')),'hex'),
 p.community_id,p.post_id,0,NULL,NULL,FALSE,'open' FROM posts p WHERE p.post_type='song' AND p.status='published'
 ON CONFLICT(community_id,post_id) DO NOTHING;

-- Unapplied V2 extends this discriminant, never a fabricated numeric Dance floor.
ALTER TABLE song_reward_offer_legs ADD COLUMN qualification_family_v2 TEXT NOT NULL DEFAULT 'numeric'
 CHECK(qualification_family_v2 IN('numeric','shared_song'));
ALTER TABLE song_reward_offer_legs ADD COLUMN shared_song_terms_v2 JSONB;
ALTER TABLE song_reward_offer_legs ADD CONSTRAINT shared_song_leg_family_v2 CHECK((
 (qualification_family_v2='numeric' AND shared_song_terms_v2 IS NULL)
 OR (qualification_family_v2='shared_song' AND kind='megapot_pool' AND min_score_bps IS NULL
   AND empty_pool_policy='no_purchase' AND funding_source='leg_budget'
   AND eligible_activities=ARRAY['study','karaoke','dance']::TEXT[]
   AND jsonb_typeof(shared_song_terms_v2)='object'
   AND shared_song_terms_v2->>'version'='shared-song-megapot-v2'
   AND shared_song_terms_v2->>'terms_hash'=substring(leg_terms_hash FROM 3))) IS TRUE);
-- Retain the original kind/asset constraints. NULL min_score on a shared leg is
-- made explicit by its new discriminant and strict family constraint above.
CREATE OR REPLACE FUNCTION freeze_reward_leg_qualification_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE activities TEXT[]; binding JSONB; frozen JSONB;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.qualification_policies IS DISTINCT FROM OLD.qualification_policies
     OR NEW.qualification_family_v2 IS DISTINCT FROM OLD.qualification_family_v2
     OR NEW.shared_song_terms_v2 IS DISTINCT FROM OLD.shared_song_terms_v2 THEN
     RAISE EXCEPTION 'reward qualification terms are immutable';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.leg_terms_hash IS NULL OR NEW.leg_terms_hash !~ '^0x[0-9a-f]{64}$' THEN
   RAISE EXCEPTION 'reward base terms hash must be canonical'; END IF;
 IF NEW.qualification_family_v2='shared_song' THEN
   IF (jsonb_typeof(NEW.shared_song_terms_v2->'qualification_bindings')='array'
      AND jsonb_array_length(NEW.shared_song_terms_v2->'qualification_bindings')=3) IS NOT TRUE THEN
     RAISE EXCEPTION 'three immutable shared objectives required' USING ERRCODE='PCV05'; END IF;
   FOR binding IN SELECT value FROM jsonb_array_elements(NEW.shared_song_terms_v2->'qualification_bindings') LOOP
     IF (binding->>'leg_id'=NEW.leg_id AND binding->>'offer_id'=NEW.offer_id
       AND EXISTS(SELECT 1 FROM qualification_policy_versions q JOIN activity_registry registry USING(activity_key)
         WHERE q.qualification_policy_version_id=binding->>'qualification_policy_id'
           AND q.activity_key=binding->>'activity' AND registry.status='active'
           AND ((q.activity_key='dance' AND q.policy_kind='dance_owner_verdict_v1'
             AND binding->>'grading_family'='moderator_verdict' AND binding->'numeric_floor_bps'='null'::JSONB
             AND binding->>'choreography_scope'='any_policy_accepted')
             OR (q.activity_key IN('study','karaoke') AND binding->>'grading_family'='numeric'
               AND jsonb_typeof(binding->'numeric_floor_bps')='number')))) IS NOT TRUE THEN
       RAISE EXCEPTION 'actual admitted shared qualification policy required' USING ERRCODE='PCV05'; END IF;
   END LOOP;
   IF (SELECT count(DISTINCT value->>'activity') FROM jsonb_array_elements(NEW.shared_song_terms_v2->'qualification_bindings'))<>3 THEN
     RAISE EXCEPTION 'one objective per shared activity required' USING ERRCODE='PCV05'; END IF;
   SELECT jsonb_agg(jsonb_build_object('activity',value->>'activity','policy',
      jsonb_build_object('qualification_policy_version_id',value->>'qualification_policy_id')) ORDER BY value->>'activity')
     INTO frozen FROM jsonb_array_elements(NEW.shared_song_terms_v2->'qualification_bindings');
   NEW.qualification_policies:=frozen;
   RETURN NEW;
 END IF;
 activities:=CASE WHEN NEW.kind='megapot_pool' THEN NEW.eligible_activities ELSE ARRAY['study','karaoke']::TEXT[] END;
 PERFORM activity_key FROM activity_registry WHERE activity_key=ANY(activities) ORDER BY activity_key FOR SHARE;
 NEW.qualification_policies:=reward_current_qualification_policies(activities);
 IF NEW.qualification_policies IS NULL THEN RAISE EXCEPTION 'reward qualification policy unavailable'; END IF;
 NEW.leg_terms_hash:='0x'||encode(sha256(convert_to(jsonb_build_array('reward_qualification_terms_v1',NEW.leg_terms_hash,NEW.qualification_policies)::TEXT,'UTF8')),'hex');
 RETURN NEW;
END $$;
ALTER TABLE song_reward_offer_legs DROP CONSTRAINT song_reward_leg_qualification_shape;
ALTER TABLE song_reward_offer_legs ADD CONSTRAINT song_reward_leg_qualification_shape CHECK(
 qualification_policies IS NULL OR (jsonb_typeof(qualification_policies)='array'
   AND ((qualification_family_v2='numeric' AND jsonb_array_length(qualification_policies) BETWEEN 1 AND 2)
        OR (qualification_family_v2='shared_song' AND jsonb_array_length(qualification_policies)=3))));

CREATE FUNCTION shared_song_qualification_templates_ready_v2(p_template TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM reward_shared_song_templates_v2 t WHERE t.template_id=p_template
  AND jsonb_array_length(t.qualification_templates)=3
  AND (SELECT count(DISTINCT value->>'activity') FROM jsonb_array_elements(t.qualification_templates))=3
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.qualification_templates) b WHERE NOT EXISTS(
    SELECT 1 FROM qualification_policy_versions q JOIN activity_registry registry USING(activity_key)
    WHERE q.qualification_policy_version_id=b->>'qualification_policy_id' AND q.activity_key=b->>'activity'
      AND registry.status='active' AND registry.current_policy_version_id=q.qualification_policy_version_id
      AND ((q.activity_key IN('study','karaoke') AND b->>'grading_family'='numeric' AND jsonb_typeof(b->'numeric_floor_bps')='number')
       OR (q.activity_key='dance' AND b->>'grading_family'='moderator_verdict' AND b->'numeric_floor_bps'='null'::JSONB
        AND q.policy_kind='dance_owner_verdict_v1' AND q.policy_document->>'policy_hash'=b->>'qualification_policy_hash'
        AND EXISTS(SELECT 1 FROM dance_review_policy_admissions_v1 admission JOIN dance_review_policy_versions_v1 p USING(policy_id)
          WHERE admission.community_id=t.community_id AND admission.accepted AND admission.effective_at<=clock_timestamp()
            AND admission.valid_until>clock_timestamp() AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
            AND p.qualification_policy_version_id=q.qualification_policy_version_id
            AND p.review_policy->>'qualificationHash'=b->>'qualification_policy_hash' AND p.review_policy->>'admission'='money_admitted'))))))
$$;

CREATE FUNCTION load_shared_song_reward_template_v2(p_snapshot TEXT,p_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE snapshot reward_funding_leg_snapshots_v2; template reward_shared_song_templates_v2;
BEGIN
 SELECT * INTO STRICT snapshot FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=p_snapshot;
 SELECT t.* INTO template FROM reward_shared_song_templates_v2 t
 JOIN reward_shared_song_template_admissions_v2 admission USING(community_id,template_id)
 WHERE t.community_id=snapshot.context->'target'->>'community_id' AND t.template_hash=p_hash AND t.profile_id=snapshot.profile_id
   AND t.valid_from<=clock_timestamp() AND t.valid_until>clock_timestamp() AND admission.accepted
   AND admission.effective_at<=clock_timestamp() AND admission.valid_until>clock_timestamp() FOR SHARE OF t,admission;
 IF NOT FOUND OR NOT shared_song_qualification_templates_ready_v2(template.template_id) OR snapshot.context->'quote'->>'kind'<>'prospective'
   OR snapshot.context->'quote'->'prospective_terms'->>'reward_policy_template_hash' IS DISTINCT FROM p_hash THEN
   RAISE EXCEPTION 'current shared policy template unavailable' USING ERRCODE='PCV05'; END IF;
 RETURN to_jsonb(template);
END $$;
CREATE FUNCTION instantiate_shared_song_reward_policy_v2(p_identity JSONB,p_snapshot TEXT,p_offer TEXT,p_template TEXT,p_policy JSONB,p_hash TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE template JSONB; policy_id TEXT:='shared-policy:'||p_offer; prior policy_versions;
BEGIN
 template:=load_shared_song_reward_template_v2(p_snapshot,p_template);
 IF (p_hash ~ '^[a-f0-9]{64}$' AND p_policy=template->'reward_policy'||jsonb_build_object(
   'community_id',p_identity->>'communityId','offer_id',p_offer,
   'uniqueness',jsonb_build_object('kind','single_authority','authority_id',p_offer))) IS NOT TRUE THEN
   RAISE EXCEPTION 'actual shared policy binding mismatch' USING ERRCODE='PCV05'; END IF;
 SELECT * INTO prior FROM policy_versions WHERE policy_version_id=policy_id;
 IF FOUND THEN
   IF prior.policy_hash IS DISTINCT FROM p_hash OR prior.policy IS DISTINCT FROM p_policy
      OR prior.community_id IS DISTINCT FROM p_identity->>'communityId' THEN
     RAISE EXCEPTION 'shared policy identity conflict' USING ERRCODE='PCV03'; END IF;
   RETURN prior.policy_hash;
 END IF;
 INSERT INTO reward_uniqueness_authorities(campaign_id,issuer,method,scope_kind,issuer_rp_scope)
   VALUES(p_offer,'https://verify.very.org','palm_web','issuer_rp_scope','pirate-social');
 INSERT INTO policy_versions(policy_version_id,community_id,policy_key,revision,policy_hash,policy,compiled_plan,compiler_version,
   uniqueness_model,created_by_user_id,published_at,policy_purpose,uniqueness_authority_id)
 VALUES(policy_id,p_identity->>'communityId','shared-song:'||p_offer,1,p_hash,p_policy,template->'compiled_plan',
   'shared_song_megapot_v2',jsonb_build_object('kind','single_authority','authority_id',p_offer),
   p_identity->>'accountId',clock_timestamp(),'reward',p_offer);
 RETURN p_hash;
END $$;

CREATE FUNCTION bind_initial_shared_song_pot_v2(p_identity JSONB,p_snapshot TEXT,p_state JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
<<binding>>
DECLARE snapshot reward_funding_leg_snapshots_v2; slot reward_song_slots_v2; template JSONB;
 r JSONB:=p_state->'receipt'; terms JSONB:=r->'committed_terms'; target JSONB:=r->'target'; prospectus JSONB;
 asset reward_asset_whitelist; policy_head song_owner_policies; transition_at TIMESTAMPTZ;
BEGIN
 SELECT * INTO STRICT snapshot FROM reward_funding_leg_snapshots_v2 WHERE snapshot_id=p_snapshot;
 SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snapshot.slot_id FOR UPDATE;
 IF slot.target IS NOT NULL THEN
   IF slot.target IS DISTINCT FROM target OR slot.terms IS DISTINCT FROM terms THEN
     RAISE EXCEPTION 'shared slot already bound differently' USING ERRCODE='PCV06'; END IF;
   RETURN;
 END IF;
 prospectus:=snapshot.context->'quote'->'prospective_terms';
 template:=load_shared_song_reward_template_v2(p_snapshot,prospectus->>'reward_policy_template_hash');
 IF (slot.status='open' AND snapshot.context->'actor'=p_state->'owner'
   AND slot.community_id=p_identity->>'communityId' AND slot.post_id=p_identity->>'postId'
   AND snapshot.context->'actor'->>'account_id'=p_identity->>'accountId'
   AND (terms->>'origin_slot_generation')::BIGINT=slot.generation
   AND terms->>'origin_prospective_terms_hash'=snapshot.context->'quote'->>'prospective_terms_hash'
   AND terms->>'starts_at'=r->>'created_at' AND terms->>'ends_at'=prospectus->>'fixed_ends_at'
   AND terms->'planned_drawing_ids'=prospectus->'planned_drawing_ids'
   AND terms->>'profile_id'=snapshot.profile_id AND terms->>'profile_hash'=prospectus->>'profile_hash'
   AND terms->>'funding_policy_hash'=prospectus->>'funding_policy_hash'
   AND target->>'kind'='committed' AND target->>'community_id'=slot.community_id AND target->>'post_id'=slot.post_id
   AND target->>'canonical_song_id'=prospectus->'target'->>'canonical_song_id'
   AND target->'audio_revision'=prospectus->'target'->'audio_revision'
   AND (terms->>'starts_at')::TIMESTAMPTZ<=clock_timestamp() AND (terms->>'ends_at')::TIMESTAMPTZ>clock_timestamp()) IS NOT TRUE THEN
   RAISE EXCEPTION 'immutable initial pot provenance required' USING ERRCODE='PCV06'; END IF;
 IF EXISTS(SELECT 1 FROM song_reward_offers offer WHERE offer.community_id=slot.community_id AND offer.post_id=slot.post_id
    AND offer.status IN('draft','active','paused','operational_hold')) THEN
   RAISE EXCEPTION 'existing pool cannot be converted or displaced' USING ERRCODE='PCV06'; END IF;
 SELECT * INTO STRICT policy_head FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id FOR SHARE;
 IF terms->>'funding_policy_hash' IS DISTINCT FROM snapshot.context->'context_ref'->>'funding_policy_hash'
   OR terms->'funding_policy_revision' IS DISTINCT FROM prospectus->'funding_policy_revision'
   OR policy_head.audio_revision IS DISTINCT FROM (target->>'audio_revision')::BIGINT THEN
   RAISE EXCEPTION 'song revision or open funding policy changed' USING ERRCODE='PCV06'; END IF;
 -- third_party_reward_legs and pool_leg are historical V1 fields, never V2
 -- funding permission. Derivative-video rights retain their independent guard.
 SELECT * INTO STRICT asset FROM reward_asset_whitelist WHERE chain_id=(r->'instruction'->>'chain_id')::BIGINT
   AND token_address=r->'instruction'->>'to_token' AND status='active' AND asset_kind='settlement_usdc' FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM policy_versions WHERE policy_version_id='shared-policy:'||(target->>'offer_id')
    AND policy_hash=terms->>'reward_policy_hash' AND community_id=slot.community_id) THEN
   RAISE EXCEPTION 'instantiated shared policy required' USING ERRCODE='PCV05'; END IF;
 INSERT INTO song_reward_offers(offer_id,community_id,post_id,audio_revision,created_by_account_id,status,starts_at,ends_at,
   owner_policy_snapshot,terms_hash,reward_policy_version_id,created_at,updated_at)
 VALUES(target->>'offer_id',slot.community_id,slot.post_id,(target->>'audio_revision')::BIGINT,p_identity->>'accountId','draft',
   (terms->>'starts_at')::TIMESTAMPTZ,(terms->>'ends_at')::TIMESTAMPTZ,
   jsonb_build_object('policy_revision',policy_head.current_policy_revision,'policy_hash',policy_head.current_policy_hash),
   terms->>'terms_hash','shared-policy:'||(target->>'offer_id'),clock_timestamp(),clock_timestamp());
 INSERT INTO song_reward_offer_legs(leg_id,offer_id,kind,status,funder_account_id,refund_policy,leg_terms_hash,participation_starts_at,
   chain_id,token_address,token_decimals,tickets_per_drawing,max_ticket_price_atomic,entry_cutoff_seconds,beneficiary_algorithm_version,
   ticket_selection_version,attestation_id,participation_starts_drawing_id,eligible_activities,min_score_bps,empty_pool_policy,funding_source,
   legal_activation_gate,owner_policy_kind,owner_policy_revision,owner_policy_hash,qualification_family_v2,shared_song_terms_v2)
 VALUES(target->>'pool_leg_id',target->>'offer_id','megapot_pool','draft',p_identity->>'accountId','refund_to_funders_pro_rata',
   '0x'||(terms->>'terms_hash'),(terms->>'starts_at')::TIMESTAMPTZ,(r->'instruction'->>'chain_id')::BIGINT,
   r->'instruction'->>'to_token',asset.decimals,1,(terms->>'ticket_price_ceiling_atomic')::NUMERIC,
   (template->'operational_profile'->>'entryCutoffSeconds')::INTEGER,'equal_v1','keccak_packed_v1',r->'instruction'->>'attestation_id',
   (terms->>'first_drawing_id')::NUMERIC,ARRAY['study','karaoke','dance'],NULL,'no_purchase','leg_budget',
   template->'operational_profile'->>'legalActivationGate','frozen_policy',policy_head.current_policy_revision,policy_head.current_policy_hash,'shared_song',terms);
 transition_at:=clock_timestamp();
 UPDATE song_reward_offers SET status='active',updated_at=transition_at WHERE offer_id=target->>'offer_id';
 UPDATE song_reward_offer_legs SET status='funding',updated_at=transition_at WHERE leg_id=target->>'pool_leg_id';
 -- The explicitly allocated empty-slot work budget is the SAME leg envelope.
 UPDATE reward_funding_work_envelopes_v2 SET scope_key=target->>'pool_leg_id'
   WHERE scope='leg' AND scope_key='empty-slot:'||slot.slot_id AND profile_id=snapshot.profile_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'selected leg work envelope unavailable' USING ERRCODE='PCV04'; END IF;
 UPDATE reward_song_slots_v2 SET target=binding.target,terms=binding.terms,generation=generation+1,reward_policy_ready=TRUE WHERE slot_id=slot.slot_id;
END $$;

-- Account-wide and global paid-read work survives expiry, unknown outcomes
-- and template changes. Only a separately accepted profile version can renew it.
CREATE TABLE reward_context_work_counters_v2 (
 profile_id TEXT NOT NULL REFERENCES reward_funding_profiles_v2, account_id TEXT NOT NULL,
 maximum_units BIGINT NOT NULL CHECK(maximum_units>0), used_units BIGINT NOT NULL CHECK(used_units>0 AND used_units<=maximum_units),
 PRIMARY KEY(profile_id,account_id)
);
CREATE TABLE reward_song_context_work_v2 (
 work_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES reward_song_slots_v2,
 assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments, template_id TEXT NOT NULL REFERENCES reward_shared_song_templates_v2,
 attempts BIGINT NOT NULL CHECK(attempts>0), token TEXT NOT NULL, lease_until TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL CHECK(status IN('running','completed','unknown','unavailable')),
 last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(slot_id,assignment_id,template_id)
);
CREATE FUNCTION claim_next_shared_song_context_v2(p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; work reward_song_context_work_v2; slot reward_song_slots_v2;
 t reward_shared_song_templates_v2; profile reward_funding_profiles_v2; deployment megapot_deployment_attestations;
 wallet persona_wallet_assignments; song_policy song_owner_policies; leg song_reward_offer_legs;
 actor JSONB; target JSONB; budget JSONB; total NUMERIC; reserved NUMERIC; now_ms BIGINT;
 max_attempts BIGINT; lease_ms BIGINT; capacity_revision BIGINT; work_key TEXT; units BIGINT; affected INTEGER;
BEGIN
 PERFORM require_reward_run_authority_v1();
 IF (SELECT paused FROM reward_operations_control WHERE singleton) IS DISTINCT FROM FALSE THEN RETURN NULL; END IF;
 -- One bounded candidate, ordered by prior attempt rather than a lossy watermark.
 -- Non-members' own community-bound personas use this exact same path.
 SELECT s.slot_id,a.assignment_id,template.template_id INTO candidate
 FROM reward_shared_song_template_admissions_v2 admission JOIN reward_shared_song_templates_v2 template USING(community_id,template_id)
 JOIN reward_funding_profiles_v2 p ON p.profile_id=template.profile_id
 JOIN reward_song_slots_v2 s ON s.community_id=template.community_id AND s.status='open'
 JOIN persona_community_bindings binding ON binding.community_id=s.community_id
 JOIN personas persona USING(persona_id,account_id)
 JOIN persona_wallet_assignments a ON a.persona_id=persona.persona_id AND a.account_id=persona.account_id
 JOIN users account ON account.user_id=persona.account_id
 LEFT JOIN reward_song_context_work_v2 prior ON prior.slot_id=s.slot_id AND prior.assignment_id=a.assignment_id AND prior.template_id=template.template_id
 WHERE admission.accepted AND admission.effective_at<=clock_timestamp() AND admission.valid_until>clock_timestamp()
   AND shared_song_qualification_templates_ready_v2(template.template_id)
   AND template.valid_from<=clock_timestamp() AND template.valid_until>clock_timestamp() AND p.accepted AND p.valid_until>clock_timestamp()
   AND account.status='active' AND persona.status='active' AND a.status='active' AND a.chain_account_kind='evm'
   AND can_account_access_activity_song(account.user_id,s.community_id,s.post_id)
   AND (s.target IS NOT NULL OR NOT EXISTS(SELECT 1 FROM song_reward_offers existing WHERE existing.community_id=s.community_id AND existing.post_id=s.post_id
     AND existing.status IN('draft','active','paused','operational_hold')))
   AND ((template.operational_profile->>'maximumContextAttempts')::BIGINT>0
     AND (template.operational_profile->>'contextLeaseMs')::BIGINT>0)
   AND (prior.work_id IS NULL OR (prior.attempts<(template.operational_profile->>'maximumContextAttempts')::BIGINT
     AND (prior.status<>'running' OR prior.lease_until<=clock_timestamp())
     AND NOT EXISTS(SELECT 1 FROM reward_funding_leg_snapshots_v2 fresh WHERE fresh.slot_id=s.slot_id
       AND fresh.profile_id=p.profile_id AND fresh.context->'actor'->>'wallet_assignment_id'=a.assignment_id
       AND (fresh.context->>'context_expires_at')::TIMESTAMPTZ>clock_timestamp()
       AND fresh.context->'context_ref'->'slot_generation'=to_jsonb(s.generation)
       AND fresh.refusal IS NULL)))
 ORDER BY prior.updated_at NULLS FIRST,s.slot_id,a.assignment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('song-context:'||candidate.slot_id||':'||candidate.assignment_id,0));
 SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=candidate.slot_id FOR SHARE;
 SELECT * INTO STRICT t FROM reward_shared_song_templates_v2 WHERE template_id=candidate.template_id FOR SHARE;
 SELECT * INTO STRICT profile FROM reward_funding_profiles_v2 WHERE profile_id=t.profile_id FOR SHARE;
 SELECT * INTO STRICT wallet FROM persona_wallet_assignments WHERE assignment_id=candidate.assignment_id AND status='active' FOR SHARE;
 SELECT * INTO STRICT deployment FROM megapot_deployment_attestations WHERE attestation_id=t.attestation_id AND status='active' AND retired_at IS NULL FOR SHARE;
 SELECT * INTO STRICT song_policy FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM reward_shared_song_template_admissions_v2 a WHERE a.community_id=slot.community_id AND a.template_id=t.template_id
   AND a.accepted AND a.effective_at<=clock_timestamp() AND a.valid_until>clock_timestamp()) OR NOT profile.accepted OR profile.valid_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'shared context policy changed' USING ERRCODE='PCV05'; END IF;
 max_attempts:=(t.operational_profile->>'maximumContextAttempts')::BIGINT; lease_ms:=(t.operational_profile->>'contextLeaseMs')::BIGINT;
 IF max_attempts<=0 OR lease_ms<=0 THEN RAISE EXCEPTION 'finite context work profile required' USING ERRCODE='PCV04'; END IF;
 work_key:='context:'||encode(sha256(convert_to(jsonb_build_array(slot.slot_id,wallet.assignment_id,t.template_id)::TEXT,'UTF8')),'hex');
 INSERT INTO reward_song_context_work_v2(work_id,slot_id,assignment_id,template_id,attempts,token,lease_until,status)
 VALUES(work_key,slot.slot_id,wallet.assignment_id,t.template_id,1,p_token,clock_timestamp()+lease_ms*interval '1 millisecond','running')
 ON CONFLICT(slot_id,assignment_id,template_id) DO UPDATE SET attempts=reward_song_context_work_v2.attempts+1,token=p_token,
   lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',status='running',last_error=NULL,updated_at=clock_timestamp()
 WHERE reward_song_context_work_v2.attempts<max_attempts AND (reward_song_context_work_v2.status<>'running' OR reward_song_context_work_v2.lease_until<=clock_timestamp())
 RETURNING * INTO work;
 IF NOT FOUND THEN RETURN NULL; END IF;
 units:=(t.operational_profile->>'contextWorkPerAttempt')::BIGINT;
 IF units<=0 OR (t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT<units
    OR (t.operational_profile->>'maximumContextWorkGlobal')::BIGINT<units THEN
   RAISE EXCEPTION 'positive finite context work budget required' USING ERRCODE='PCV04'; END IF;
 INSERT INTO reward_context_work_counters_v2(profile_id,account_id,maximum_units,used_units)
 SELECT profile.profile_id,v.account_id,v.maximum_units,units FROM (VALUES
   (''::TEXT,(t.operational_profile->>'maximumContextWorkGlobal')::BIGINT),
   (wallet.account_id,(t.operational_profile->>'maximumContextWorkPerAccount')::BIGINT)) v(account_id,maximum_units)
 ORDER BY v.account_id
 ON CONFLICT(profile_id,account_id) DO UPDATE SET used_units=reward_context_work_counters_v2.used_units+excluded.used_units
 WHERE reward_context_work_counters_v2.maximum_units=excluded.maximum_units
   AND reward_context_work_counters_v2.used_units+excluded.used_units<=reward_context_work_counters_v2.maximum_units;
 GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>2 THEN RAISE EXCEPTION 'context work budget exhausted' USING ERRCODE='PCV04'; END IF;
 actor:=jsonb_build_object('account_id',wallet.account_id,'persona_id',wallet.persona_id,'community_id',slot.community_id,
   'wallet_assignment_id',wallet.assignment_id,'wallet_index',wallet.hd_wallet_index,'sender_address',wallet.address);
 target:=coalesce(slot.target,jsonb_build_object('kind','empty','community_id',slot.community_id,'post_id',slot.post_id,
   'canonical_song_id',slot.post_id,'audio_revision',song_policy.audio_revision,'slot_id',slot.slot_id,'slot_generation',slot.generation,'offer_id',NULL,'pool_leg_id',NULL));
 SELECT * INTO leg FROM song_reward_offer_legs WHERE leg_id=slot.target->>'pool_leg_id';
 SELECT coalesce(sum(r.amount_atomic),0) INTO total FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id)
   WHERE c.pool_leg_id=leg.leg_id AND r.category='pool_principal';
 SELECT coalesce(sum(amount_atomic),0) INTO reserved FROM reward_contribution_reservations_v2 WHERE pool_leg_id=leg.leg_id AND disposition='held';
 budget:=jsonb_build_object('funded',total::TEXT,'spent',coalesce(leg.spent_atomic,0)::TEXT,
   'committedPurchases',coalesce(leg.reserved_atomic,0)::TEXT,'refunded',coalesce(leg.refunded_atomic,0)::TEXT,
   'otherObligations',coalesce(leg.fulfilled_atomic,0)::TEXT,'liveInboundReservations',reserved::TEXT);
 SELECT count(*) INTO capacity_revision FROM song_megapot_contributions_v2 WHERE pool_leg_id=leg.leg_id;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 RETURN jsonb_build_object('workId',work.work_id,'token',work.token,'attempt',work.attempts,'templateHash',t.template_hash,
   'profileId',profile.profile_id,'validUntil',to_char(least(profile.valid_until,t.valid_until) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'noncePolicy',profile.nonce_policy,'operations',t.operational_profile,
   'qualificationDocuments',(SELECT jsonb_agg(jsonb_build_object('policyId',q.qualification_policy_version_id,'activity',q.activity_key,
      'kind',q.policy_kind,'document',q.policy_document) ORDER BY q.activity_key)
    FROM jsonb_array_elements(t.qualification_templates) b JOIN qualification_policy_versions q ON q.qualification_policy_version_id=b->>'qualification_policy_id'),
   'drawingStates',coalesce((SELECT jsonb_agg(jsonb_build_object('drawingId',d.drawing_id::TEXT,
      'state',CASE WHEN d.actual_ticket_cost_atomic>0 THEN 'settled'
        WHEN d.reserved_ticket_cost_atomic>0 THEN 'committed'
        WHEN d.status='entry_open' THEN 'uncommitted' ELSE 'cancelled' END,
      'reservedCostAtomic',CASE WHEN d.actual_ticket_cost_atomic=0 AND d.reserved_ticket_cost_atomic>0 THEN d.reserved_ticket_cost_atomic ELSE 0 END::TEXT,
      'entryCutoffAtMs',floor(extract(epoch FROM d.entry_cutoff_at)*1000)::BIGINT) ORDER BY d.drawing_id)
      FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id),'[]'::JSONB),
   'deployment',jsonb_build_object('attestationId',deployment.attestation_id,'environment',deployment.environment,'chainId',deployment.chain_id,
     'jackpotAddress',deployment.jackpot_address,'ticketNftAddress',deployment.ticket_nft_address,'usdcAddress',deployment.usdc_address,
     'custodyAddress',deployment.custody_address,'referrerAddress',deployment.referrer_address,'jackpotCodeHash',deployment.jackpot_code_hash,
     'ticketNftCodeHash',deployment.ticket_nft_code_hash,'usdcCodeHash',deployment.usdc_code_hash),
   'attestationBlock',deployment.attestation_block_number::TEXT,'attestationBlockHash',deployment.attestation_block_hash,
   'facts',jsonb_build_object('slot',target,'slotId',slot.slot_id,'slotGeneration',slot.generation,'committedTerms',slot.terms,
     'legSnapshotId',CASE WHEN slot.target IS NULL THEN NULL ELSE work.work_id||':'||work.attempts::TEXT END,
     'actor',actor,'walletAssignmentRevision',floor(extract(epoch FROM wallet.updated_at)*1000)::BIGINT,'lifecycleRevision',slot.generation,
     'capacityRevision',capacity_revision,'profileId',profile.profile_id,'profileHash',profile.profile_hash,
     'capacityProfile',profile.capacity_profile,'limitsPolicy',profile.policy-ARRAY['reconciliation'],
     'budget',budget,'costsReconciled',slot.target IS NULL OR (total=leg.funded_atomic
       AND leg.reserved_atomic=(SELECT coalesce(sum(d.reserved_ticket_cost_atomic),0) FROM megapot_pool_drawings d
         WHERE d.pool_leg_id=leg.leg_id AND d.actual_ticket_cost_atomic=0 AND d.reserved_ticket_cost_atomic>0)
       AND leg.spent_atomic=(SELECT coalesce(sum(d.actual_ticket_cost_atomic),0) FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id)
       AND NOT EXISTS(SELECT 1 FROM megapot_pool_drawings d WHERE d.pool_leg_id=leg.leg_id AND d.status='operational_hold')),
     'fundingPolicyRevision',song_policy.current_policy_revision,'fundingPolicyHash',song_policy.current_policy_hash,
     'rewardPolicyTemplateHash',t.template_hash,'qualificationTemplates',t.qualification_templates,
     'disclosureVersion',t.operational_profile->>'disclosureVersion','feePolicyId',t.operational_profile->>'feePolicyId',
     'chainId',deployment.chain_id,'tokenAddress',deployment.usdc_address,'custodyAddress',deployment.custody_address,'attestationId',deployment.attestation_id,
     -- Refund capacity is a selected, unexpired work envelope, not a claim that
     -- a missing custody/outbound interpreter has completed any obligation.
     'gasReady',EXISTS(SELECT 1 FROM reward_funding_work_envelopes_v2 envelope
       WHERE envelope.scope='global' AND envelope.scope_key='funding' AND envelope.profile_id=profile.profile_id
         AND envelope.valid_until>clock_timestamp() AND envelope.allocated-envelope.used-envelope.reserved>=(profile.policy->>'workPerInstruction')::BIGINT),
     'remainingEffects',greatest(0,(profile.policy->>'maxLegLiabilities')::BIGINT-capacity_revision),
     'pendingAccountSlots',greatest(0,(profile.policy->>'maxActiveAccount')::BIGINT-(SELECT count(*) FROM song_megapot_contributions_v2 c
       WHERE c.account_id=wallet.account_id AND NOT(c.state->>'nonceFinalized')::BOOLEAN))));
END $$;

CREATE FUNCTION persist_shared_song_context_v2(p_work TEXT,p_token TEXT,p_context JSONB,p_witness JSONB,p_budget JSONB,p_costs BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work reward_song_context_work_v2; slot reward_song_slots_v2; profile reward_funding_profiles_v2;
 t reward_shared_song_templates_v2; wallet persona_wallet_assignments; snapshot_id TEXT;
BEGIN
 PERFORM require_reward_run_authority_v1();
 SELECT * INTO STRICT work FROM reward_song_context_work_v2 WHERE work_id=p_work AND token=p_token AND status='running'
   AND lease_until>clock_timestamp() FOR UPDATE;
 SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=work.slot_id FOR UPDATE;
 SELECT * INTO STRICT t FROM reward_shared_song_templates_v2 WHERE template_id=work.template_id FOR SHARE;
 SELECT * INTO STRICT profile FROM reward_funding_profiles_v2 WHERE profile_id=t.profile_id FOR SHARE;
 SELECT * INTO STRICT wallet FROM persona_wallet_assignments WHERE assignment_id=work.assignment_id AND status='active' FOR SHARE;
 IF (p_context->>'readiness'='ready' AND p_context->'context_ref'->>'slot_id'=slot.slot_id
   AND p_context->'context_ref'->'slot_generation'=to_jsonb(slot.generation)
   AND p_context->'actor'->>'wallet_assignment_id'=wallet.assignment_id AND p_context->'actor'->>'account_id'=wallet.account_id
   AND p_context->'actor'->>'sender_address'=wallet.address AND p_context->>'context_hash' ~ '^[a-f0-9]{64}$'
   AND p_context->'context_ref'->>'profile_hash'=profile.profile_hash AND profile.accepted AND profile.valid_until>clock_timestamp()
   AND p_context->'schedule'->>'schedule_witness_id'=p_witness->>'witnessId'
   AND p_context->'schedule'->'anchor'->>'block_hash'='0x'||(p_witness->'nonce'->'confirmed'->>'blockHash')
   AND p_context->'actor'->>'sender_address'=p_witness->'nonce'->>'senderAddress'
   AND p_witness->'nonce'->'confirmed'->>'nonce'=p_witness->'nonce'->'pending'->>'nonce'
   AND (p_witness->'nonce'->>'observedAtMs')::NUMERIC<=extract(epoch FROM clock_timestamp())*1000
   AND extract(epoch FROM clock_timestamp())*1000-(p_witness->'nonce'->>'observedAtMs')::NUMERIC<=(profile.nonce_policy->>'maxAgeMs')::NUMERIC
   AND (p_context->>'context_expires_at')::TIMESTAMPTZ>clock_timestamp()
   AND EXISTS(SELECT 1 FROM users WHERE user_id=wallet.account_id AND status='active')
   AND active_activity_persona(wallet.account_id,wallet.persona_id,slot.community_id)
   AND can_account_access_activity_song(wallet.account_id,slot.community_id,slot.post_id)) IS NOT TRUE THEN
   RAISE EXCEPTION 'current context provenance changed' USING ERRCODE='PCV06'; END IF;
 IF slot.target IS NOT NULL AND (slot.target IS DISTINCT FROM p_context->'target' OR slot.terms IS DISTINCT FROM p_context->'quote'->'committed_terms') THEN
   RAISE EXCEPTION 'context target changed during observation' USING ERRCODE='PCV06'; END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_shared_song_template_admissions_v2 a WHERE a.template_id=t.template_id AND a.community_id=slot.community_id
   AND a.accepted AND a.effective_at<=clock_timestamp() AND a.valid_until>clock_timestamp()) THEN
   RAISE EXCEPTION 'context admission revoked' USING ERRCODE='PCV05'; END IF;
 -- Validate current deployment again after provider work; no I/O in this transaction.
 IF NOT EXISTS(SELECT 1 FROM megapot_deployment_attestations a WHERE a.attestation_id=p_context->>'attestation_id'
   AND a.status='active' AND a.retired_at IS NULL AND a.chain_id=(p_context->>'chain_id')::BIGINT
   AND a.usdc_address=p_context->>'token_address' AND a.custody_address=p_context->>'custody_address') THEN
   RAISE EXCEPTION 'context attestation retired' USING ERRCODE='PCV05'; END IF;
 snapshot_id:=work.work_id||':'||work.attempts::TEXT;
 INSERT INTO reward_funding_schedule_witnesses_v2(witness_id,profile_id,witness_hash,schedule,nonce_witness,valid_until)
 VALUES(p_witness->>'witnessId',profile.profile_id,p_witness->>'hash',p_witness->'schedule',p_witness->'nonce',(p_context->>'context_expires_at')::TIMESTAMPTZ);
 INSERT INTO reward_funding_leg_snapshots_v2(snapshot_id,slot_id,profile_id,witness_id,context_hash,context,budget,costs_reconciled,refusal,recovery_authority)
 VALUES(snapshot_id,slot.slot_id,profile.profile_id,p_witness->>'witnessId',p_context->>'context_hash',p_context,p_budget,p_costs,NULL,
  jsonb_build_object('policy',NULL,'attestationId',p_context->>'attestation_id','attestationHash',p_context->'schedule'->'anchor'->>'attestation_hash',
    'attestationValidUntil',p_context->>'context_expires_at','originalWalletStillOwned',TRUE,'currentSigningRefusal',NULL,'boundedWorkAvailable',FALSE));
 UPDATE reward_song_slots_v2 SET reward_policy_ready=TRUE WHERE slot_id=slot.slot_id;
 UPDATE reward_song_context_work_v2 SET status='completed',updated_at=clock_timestamp() WHERE work_id=work.work_id;
END $$;
CREATE FUNCTION finish_shared_song_context_failure_v2(p_work TEXT,p_token TEXT,p_error TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 UPDATE reward_song_context_work_v2 SET status=CASE WHEN p_error='outcome_unknown' THEN 'unknown' ELSE 'unavailable' END,
   last_error=p_error,updated_at=clock_timestamp() WHERE work_id=p_work AND token=p_token AND status='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'context producer lease fenced' USING ERRCODE='PCV06'; END IF;
END $$;

-- Existing transaction/idempotency/account/nonce fences retained.
CREATE OR REPLACE FUNCTION lock_song_contribution_context_v2(i JSONB,h TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE snap reward_funding_leg_snapshots_v2; slot reward_song_slots_v2; p reward_funding_profiles_v2;
  w reward_funding_schedule_witnesses_v2; counters JSONB; work JSONB; leg TEXT; principal JSONB; paused BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('funding-account-v2',i->>'accountId')::text,0));
  SELECT * INTO STRICT snap FROM reward_funding_leg_snapshots_v2 WHERE context_hash=h;
  SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snap.slot_id FOR UPDATE;
  IF slot.community_id<>i->>'communityId' OR slot.post_id<>i->>'postId' OR snap.context->'actor'->>'account_id'<>i->>'accountId' THEN
    RAISE EXCEPTION 'private contribution context' USING ERRCODE='PCV02'; END IF;
  PERFORM lock_reward_wallet_nonce_sender_v2((snap.context->>'chain_id')::BIGINT,snap.context->'actor'->>'sender_address');
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id FOR SHARE;
  SELECT * INTO STRICT w FROM reward_funding_schedule_witnesses_v2 WHERE witness_id=snap.witness_id;
  SELECT x.paused INTO paused FROM reward_operations_control x WHERE singleton FOR SHARE;
  IF paused IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001'; END IF;
  PERFORM 1 FROM megapot_deployment_attestations WHERE attestation_id=snap.context->>'attestation_id'
    AND status='active' AND retired_at IS NULL AND verified_at<=clock_timestamp()
    AND chain_id=(snap.context->>'chain_id')::BIGINT AND usdc_address=snap.context->>'token_address'
    AND custody_address=snap.context->>'custody_address' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current funding attestation unavailable' USING ERRCODE='PCV05'; END IF;
  leg:=coalesce(slot.target->>'pool_leg_id','empty-slot:'||slot.slot_id);
  -- Missing envelopes never create a budget. They are admitted operational inputs.
  PERFORM 1 FROM reward_funding_work_envelopes_v2 WHERE (scope,scope_key) IN
    (('account',i->>'accountId'),('leg',leg),('global','funding')) ORDER BY scope,scope_key FOR UPDATE;
  SELECT jsonb_object_agg(scope,allocated-used-reserved) INTO work FROM reward_funding_work_envelopes_v2
    WHERE profile_id=p.profile_id AND valid_until>clock_timestamp() AND (scope,scope_key) IN
    (('account',i->>'accountId'),('leg',leg),('global','funding'));
  SELECT jsonb_build_object(
    'activeAccount',count(*) FILTER(WHERE account_id=i->>'accountId' AND NOT (state->>'nonceFinalized')::BOOLEAN)+(SELECT count(*) FROM song_reward_leg_funding_effects WHERE funder_account_id=i->>'accountId' AND state IN ('planned','confirming','reconciliation_required','reclaimable_failed')),
    'activeAccountLeg',count(*) FILTER(WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND NOT (state->>'nonceFinalized')::BOOLEAN),
    'legLiabilities',count(*) FILTER(WHERE pool_leg_id=leg AND state->>'fundingState'<>'nonce_closed_no_principal'),
    'admittedLeg',count(*) FILTER(WHERE pool_leg_id=leg AND state->>'fundingState'='pool_credited'),
    'admittedAccountLeg',count(*) FILTER(WHERE account_id=i->>'accountId' AND pool_leg_id=leg AND state->>'fundingState'='pool_credited'))
    INTO counters FROM song_megapot_contributions_v2 WHERE account_id=i->>'accountId' OR pool_leg_id=leg;
  SELECT jsonb_build_object('funded',coalesce((SELECT sum(r.amount_atomic) FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id) WHERE c.pool_leg_id=leg AND r.category='pool_principal'),0)::TEXT,
    'reserved',coalesce((SELECT sum(amount_atomic) FROM reward_contribution_reservations_v2 WHERE pool_leg_id=leg AND disposition='held'),0)::TEXT) INTO principal;
  RETURN jsonb_build_object('snapshot',to_jsonb(snap),'slot',to_jsonb(slot),'profile',to_jsonb(p),'witness',to_jsonb(w),'counts',counters,'work',work,'principal',principal);
END $$;


-- Project only actual finalized incoming principal. The original receipt and
-- nonce interpreter remains accept_reward_funding_principal_v2. Terminal legs
-- do not reopen; their later-discovered money remains in the V2 cohort/liability
-- authority for the independently held outbound integration.
CREATE FUNCTION project_shared_song_confirmed_principal_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE leg song_reward_offer_legs; amount NUMERIC;
BEGIN
 IF NEW.category<>'pool_principal' THEN RETURN NEW; END IF;
 SELECT l.* INTO leg FROM song_reward_offer_legs l JOIN song_megapot_contributions_v2 c ON c.pool_leg_id=l.leg_id
 WHERE c.contribution_id=NEW.contribution_id AND l.qualification_family_v2='shared_song' FOR UPDATE OF l;
 IF NOT FOUND OR leg.status IN('ended','exhausted') THEN RETURN NEW; END IF;
 SELECT sum(r.amount_atomic) INTO amount FROM reward_incoming_receipts_v2 r JOIN song_megapot_contributions_v2 c USING(contribution_id)
 WHERE c.pool_leg_id=leg.leg_id AND r.category='pool_principal';
 IF amount<leg.funded_atomic OR amount>115792089237316195423570985008687907853269984665640564039457584007913129639935 THEN
   RAISE EXCEPTION 'confirmed shared principal conservation' USING ERRCODE='PCV11'; END IF;
 UPDATE song_reward_offer_legs SET funded_atomic=amount,
   status=CASE WHEN status='funding' AND amount>0 THEN 'active' ELSE status END,
   activated_at=CASE WHEN status='funding' AND amount>0 THEN clock_timestamp() ELSE activated_at END,
   updated_at=clock_timestamp() WHERE leg_id=leg.leg_id;
 RETURN NEW;
END $$;
CREATE TRIGGER shared_song_confirmed_principal AFTER INSERT ON reward_incoming_receipts_v2
 FOR EACH ROW EXECUTE FUNCTION project_shared_song_confirmed_principal_v2();

-- No inherited/default/PUBLIC table capabilities or EXECUTE are admitted.
DO $acl$
DECLARE item RECORD; recipient RECORD; fn REGPROCEDURE;
BEGIN
 FOR item IN SELECT oid,relowner FROM pg_class WHERE relnamespace=current_schema()::regnamespace
   AND relname=ANY(ARRAY['reward_shared_song_templates_v2','reward_shared_song_template_admissions_v2','reward_song_context_work_v2','reward_context_work_counters_v2']) LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC CASCADE',item.oid::regclass);
  FOR recipient IN SELECT DISTINCT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=item.oid AND a.grantee<>0 AND a.grantee<>item.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %I CASCADE',item.oid::regclass,pg_get_userbyid(recipient.grantee));
  END LOOP;
 END LOOP;
 FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY(ARRAY[
   'initialize_shared_song_slot_v2','freeze_reward_leg_qualification_terms','shared_song_qualification_templates_ready_v2','load_shared_song_reward_template_v2',
   'instantiate_shared_song_reward_policy_v2','bind_initial_shared_song_pot_v2','claim_next_shared_song_context_v2',
   'persist_shared_song_context_v2','finish_shared_song_context_failure_v2','project_shared_song_confirmed_principal_v2']) LOOP
  EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path TO %I, pg_catalog, pg_temp',fn,current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',fn);
  FOR recipient IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=fn::OID AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',fn,pg_get_userbyid(recipient.grantee));
  END LOOP;
 END LOOP;
END $acl$;

CREATE FUNCTION grant_shared_song_funding_runtime_v2(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
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
  'persist_shared_song_context_v2(text,text,jsonb,jsonb,jsonb,boolean)','finish_shared_song_context_failure_v2(text,text,text)'] END;
 IF allowed IS NULL THEN RAISE EXCEPTION 'explicit funding purpose required' USING ERRCODE='42501'; END IF;
 FOREACH signature IN ARRAY allowed LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature::regprocedure,p_role);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION grant_shared_song_funding_runtime_v2(TEXT,TEXT) FROM PUBLIC;

-- GET remains a private read, including before any background quote exists.
CREATE OR REPLACE FUNCTION read_song_contribution_context_v2(i JSONB,persona TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE snap reward_funding_leg_snapshots_v2; slot reward_song_slots_v2;
  p reward_funding_profiles_v2; w reward_funding_schedule_witnesses_v2;
  refusal TEXT; funded NUMERIC; reserved NUMERIC; paused BOOLEAN; owned BOOLEAN; fallback_target JSONB; fallback_audio BIGINT;
BEGIN
  IF NOT can_account_access_activity_song(i->>'accountId',i->>'communityId',i->>'postId') OR NOT EXISTS(
    SELECT 1 FROM personas p JOIN persona_community_bindings b USING(persona_id,account_id)
      JOIN users u ON u.user_id=p.account_id AND u.status='active'
    WHERE p.account_id=i->>'accountId' AND p.persona_id=persona AND b.community_id=i->>'communityId'
      AND p.status IN('active','pending_wallet')) THEN
    RAISE EXCEPTION 'private owned funding context required' USING ERRCODE='PCV02'; END IF;
  SELECT s.* INTO snap FROM reward_funding_leg_snapshots_v2 s JOIN reward_song_slots_v2 l USING(slot_id)
    WHERE l.community_id=i->>'communityId' AND l.post_id=i->>'postId'
      AND s.context->'actor'->>'account_id'=i->>'accountId' AND s.context->'actor'->>'persona_id'=persona
    ORDER BY s.created_at DESC,s.snapshot_id DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO slot FROM reward_song_slots_v2 WHERE community_id=i->>'communityId' AND post_id=i->>'postId';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT audio_revision INTO fallback_audio FROM song_owner_policies WHERE community_id=slot.community_id AND post_id=slot.post_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    fallback_target:=coalesce(slot.target,jsonb_build_object('kind','empty','community_id',slot.community_id,'post_id',slot.post_id,
      'canonical_song_id',slot.post_id,'audio_revision',fallback_audio,'slot_id',slot.slot_id,'slot_generation',slot.generation,'offer_id',NULL,'pool_leg_id',NULL));
    refusal:=CASE WHEN NOT EXISTS(SELECT 1 FROM persona_wallet_assignments a WHERE a.account_id=i->>'accountId' AND a.persona_id=persona AND a.status='active')
      THEN 'wallet_not_ready' WHEN slot.target IS NULL AND EXISTS(SELECT 1 FROM song_reward_offers o WHERE o.community_id=slot.community_id
        AND o.post_id=slot.post_id AND o.status IN('draft','active','paused','operational_hold')) THEN 'legacy_pool_incompatible' ELSE 'policy_unavailable' END;
    RETURN jsonb_build_object('object','song_megapot_funding_context','version',2,'readiness','unavailable',
      'target',fallback_target,'persona_id',persona,'reason',refusal,'retry_after_seconds',NULL,'own_recovery_href',NULL);
  END IF;
  SELECT * INTO STRICT slot FROM reward_song_slots_v2 WHERE slot_id=snap.slot_id;
  SELECT * INTO STRICT p FROM reward_funding_profiles_v2 WHERE profile_id=snap.profile_id;
  SELECT * INTO STRICT w FROM reward_funding_schedule_witnesses_v2 WHERE witness_id=snap.witness_id;
  SELECT x.paused INTO paused FROM reward_operations_control x WHERE singleton;
  SELECT EXISTS(SELECT 1 FROM persona_wallet_assignments a JOIN personas v USING(persona_id,account_id)
    JOIN persona_community_bindings b USING(persona_id,account_id)
    WHERE a.assignment_id=snap.context->'actor'->>'wallet_assignment_id' AND a.account_id=i->>'accountId'
      AND a.persona_id=persona AND a.status='active' AND v.status='active' AND b.community_id=slot.community_id
      AND a.address=snap.context->'actor'->>'sender_address') INTO owned;
  SELECT coalesce(sum(r.amount_atomic),0) INTO funded FROM reward_incoming_receipts_v2 r
    JOIN song_megapot_contributions_v2 c USING(contribution_id)
    WHERE c.pool_leg_id=slot.target->>'pool_leg_id' AND r.category='pool_principal';
  SELECT coalesce(sum(amount_atomic),0) INTO reserved FROM reward_contribution_reservations_v2
    WHERE pool_leg_id=slot.target->>'pool_leg_id' AND disposition='held';
  refusal:=CASE
    WHEN NOT owned THEN 'wallet_not_ready'
    WHEN paused IS DISTINCT FROM FALSE THEN 'paused'
    WHEN NOT p.accepted OR p.valid_until<=statement_timestamp() THEN 'policy_unavailable'
    WHEN NOT EXISTS(SELECT 1 FROM megapot_deployment_attestations a WHERE a.attestation_id=snap.context->>'attestation_id'
      AND a.status='active' AND a.retired_at IS NULL AND a.verified_at<=statement_timestamp()
      AND a.chain_id=(snap.context->>'chain_id')::BIGINT AND a.usdc_address=snap.context->>'token_address'
      AND a.custody_address=snap.context->>'custody_address') THEN 'attestation_unavailable'
    WHEN reward_wallet_nonce_ownership_open_v2((snap.context->>'chain_id')::BIGINT,snap.context->'actor'->>'sender_address') THEN 'wallet_nonce_busy'
    WHEN NOT slot.reward_policy_ready THEN 'mixed_objective_unavailable'
    WHEN slot.status<>'open' THEN 'recovery_required'
    WHEN w.valid_until<=statement_timestamp() OR (snap.context->>'context_expires_at')::TIMESTAMPTZ<=statement_timestamp() THEN 'observation_stale'
    WHEN snap.context->'context_ref'->>'profile_hash' IS DISTINCT FROM p.profile_hash
      OR snap.context->'context_ref'->>'schedule_witness_id' IS DISTINCT FROM w.witness_id
      OR (snap.context->'context_ref'->>'slot_generation')::BIGINT<>slot.generation
      OR (slot.target IS NOT NULL AND (snap.context->'target' IS DISTINCT FROM slot.target OR snap.context->'quote'->'committed_terms' IS DISTINCT FROM slot.terms))
      THEN 'recovery_required'
    WHEN NOT snap.costs_reconciled OR (snap.budget->>'funded')::NUMERIC IS DISTINCT FROM funded
      OR (snap.budget->>'liveInboundReservations')::NUMERIC IS DISTINCT FROM reserved THEN 'recovery_required'
    WHEN snap.refusal IS NOT NULL THEN 'recovery_required'
    ELSE NULL END;
  IF refusal IS NULL THEN RETURN snap.context; END IF;
  RETURN jsonb_build_object('object','song_megapot_funding_context','version',2,'readiness','unavailable',
    'target',coalesce(slot.target,snap.context->'target'),'persona_id',persona,'reason',refusal,
    'retry_after_seconds',NULL,'own_recovery_href',NULL);
END $$;


CREATE FUNCTION guard_shared_context_work_counter_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'context work history is retained' USING ERRCODE='PCV01'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.profile_id,NEW.account_id,NEW.maximum_units) IS DISTINCT FROM ROW(OLD.profile_id,OLD.account_id,OLD.maximum_units)
   OR NEW.used_units<=OLD.used_units) THEN RAISE EXCEPTION 'consumed context work cannot be restored' USING ERRCODE='PCV04'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER context_work_counter_guard BEFORE UPDATE OR DELETE ON reward_context_work_counters_v2
 FOR EACH ROW EXECUTE FUNCTION guard_shared_context_work_counter_v2();
CREATE TRIGGER context_work_counter_no_truncate BEFORE TRUNCATE ON reward_context_work_counters_v2
 FOR EACH STATEMENT EXECUTE FUNCTION guard_shared_context_work_counter_v2();
CREATE TRIGGER context_work_no_delete BEFORE DELETE ON reward_song_context_work_v2
 FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TRIGGER context_work_no_truncate BEFORE TRUNCATE ON reward_song_context_work_v2
 FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2();
REVOKE ALL ON FUNCTION guard_shared_context_work_counter_v2() FROM PUBLIC;
