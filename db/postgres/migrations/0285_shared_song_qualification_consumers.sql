-- Prospective shared-pot admission. Same eligibility/share/drawing authorities;
-- no payout, refund, signer, provider or independent qualification interpreter.
CREATE TABLE reward_activity_objective_captures_v2 (
 source_family TEXT NOT NULL CHECK(source_family IN('study_v1','study_v2','karaoke','dance')),
 source_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES users, persona_id TEXT NOT NULL,
 community_id TEXT NOT NULL, post_id TEXT NOT NULL, audio_revision BIGINT NOT NULL CHECK(audio_revision>0),
 bindings JSONB NOT NULL CHECK(jsonb_typeof(bindings)='array'),
 captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_family,source_id), FOREIGN KEY(account_id,persona_id) REFERENCES personas(account_id,persona_id)
);
CREATE TRIGGER activity_objective_captures_immutable BEFORE UPDATE OR DELETE ON reward_activity_objective_captures_v2
 FOR EACH ROW EXECUTE FUNCTION reject_reward_contribution_history_v2();
CREATE TRIGGER activity_objective_captures_no_truncate BEFORE TRUNCATE ON reward_activity_objective_captures_v2
 FOR EACH STATEMENT EXECUTE FUNCTION reject_reward_contribution_history_v2();

CREATE FUNCTION current_shared_song_objectives_v2(p_account TEXT,p_community TEXT,p_post TEXT,p_audio BIGINT,p_activity TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(binding.value ORDER BY binding.value->>'binding_id'),'[]'::JSONB)
 FROM song_reward_offers offer JOIN song_reward_offer_legs leg USING(offer_id)
 JOIN reward_song_slots_v2 slot ON slot.community_id=offer.community_id AND slot.post_id=offer.post_id AND slot.status='open'
   AND slot.target->>'offer_id'=offer.offer_id AND slot.target->>'pool_leg_id'=leg.leg_id
 CROSS JOIN LATERAL jsonb_array_elements(leg.shared_song_terms_v2->'qualification_bindings') binding(value)
 JOIN activity_registry registry ON registry.activity_key=binding.value->>'activity' AND registry.status='active'
   AND registry.current_policy_version_id=binding.value->>'qualification_policy_id'
 WHERE offer.community_id=p_community AND offer.post_id=p_post AND offer.audio_revision=p_audio AND offer.status='active'
   AND leg.qualification_family_v2='shared_song' AND leg.status='active'
   AND clock_timestamp()>=offer.starts_at AND clock_timestamp()<offer.ends_at
   AND binding.value->>'activity'=p_activity AND can_account_access_activity_song(p_account,p_community,p_post)
   AND EXISTS(SELECT 1 FROM users WHERE user_id=p_account AND status='active')
   AND (SELECT paused FROM reward_operations_control WHERE singleton) IS FALSE
$$;
CREATE FUNCTION capture_shared_song_activity_objectives_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE family TEXT; activity TEXT; source TEXT; post_id_value TEXT; audio BIGINT; bindings JSONB;
  moderated_policy dance_review_policy_versions_v1;
BEGIN
 IF TG_OP<>'INSERT' OR TG_WHEN<>'AFTER' OR TG_TABLE_SCHEMA<>current_schema() THEN
   RAISE EXCEPTION 'actual activity capture trigger required' USING ERRCODE='PCV02'; END IF;
 IF TG_RELID='study_sessions'::REGCLASS THEN family:='study_v1'; activity:='study'; source:=NEW.session_id; post_id_value:=NEW.post_id; audio:=NEW.audio_revision;
 ELSIF TG_RELID='study_sessions_v2'::REGCLASS THEN family:='study_v2'; activity:='study'; source:=NEW.session_id; post_id_value:=NEW.post_id; audio:=NEW.audio_revision;
 ELSIF TG_RELID='karaoke_sessions'::REGCLASS THEN family:='karaoke'; activity:='karaoke'; source:=NEW.session_id; post_id_value:=NEW.post_id; audio:=NEW.audio_revision;
 ELSIF TG_RELID='dance_moderated_sessions_v1'::REGCLASS THEN
   family:='dance'; activity:='dance'; source:=NEW.session_id; post_id_value:=NEW.song_post_id;
   SELECT policy.* INTO STRICT moderated_policy FROM dance_review_policy_versions_v1 policy WHERE policy_id=NEW.policy_id;
   audio:=(NEW.terms->'capture'->>'audioRevision')::BIGINT;
 ELSE RAISE EXCEPTION 'unknown activity capture source' USING ERRCODE='PCV02'; END IF;
 bindings:=current_shared_song_objectives_v2(NEW.account_id,NEW.community_id,post_id_value,audio,activity);
 IF family='dance' AND (moderated_policy.review_policy->>'admission') IS DISTINCT FROM 'money_admitted' THEN bindings:='[]'; END IF;
 INSERT INTO reward_activity_objective_captures_v2(source_family,source_id,account_id,persona_id,community_id,post_id,audio_revision,bindings)
 VALUES(family,source,NEW.account_id,NEW.persona_id,NEW.community_id,post_id_value,audio,bindings);
 RETURN NEW;
END $$;
CREATE TRIGGER shared_song_study_v1_capture AFTER INSERT ON study_sessions FOR EACH ROW EXECUTE FUNCTION capture_shared_song_activity_objectives_v2();
CREATE TRIGGER shared_song_study_v2_capture AFTER INSERT ON study_sessions_v2 FOR EACH ROW EXECUTE FUNCTION capture_shared_song_activity_objectives_v2();
CREATE TRIGGER shared_song_karaoke_capture AFTER INSERT ON karaoke_sessions FOR EACH ROW EXECUTE FUNCTION capture_shared_song_activity_objectives_v2();
CREATE TRIGGER shared_song_dance_capture AFTER INSERT ON dance_moderated_sessions_v1 FOR EACH ROW EXECUTE FUNCTION capture_shared_song_activity_objectives_v2();

CREATE FUNCTION shared_song_accepts_qualification_v2(p_leg TEXT,p_qualification TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(
  SELECT 1 FROM song_reward_offer_legs leg JOIN song_reward_offers offer USING(offer_id)
  JOIN activity_qualifications q ON q.qualification_id=p_qualification
  LEFT JOIN dance_moderated_reviews_v1 review ON review.review_id=q.dance_review_id
  CROSS JOIN LATERAL jsonb_array_elements(leg.shared_song_terms_v2->'qualification_bindings') binding(value)
  JOIN reward_activity_objective_captures_v2 capture ON capture.source_id=CASE
    WHEN q.activity_key='study' THEN q.study_session_id WHEN q.activity_key='karaoke' THEN q.karaoke_session_id ELSE review.session_id END
   AND capture.source_family=CASE WHEN q.activity_key='study' THEN CASE WHEN EXISTS(SELECT 1 FROM study_sessions_v2 WHERE session_id=q.study_session_id) THEN 'study_v2' ELSE 'study_v1' END
     WHEN q.activity_key='karaoke' THEN 'karaoke' ELSE 'dance' END
   AND capture.account_id=q.account_id AND capture.persona_id=q.persona_id AND capture.community_id=q.community_id
   AND capture.post_id=q.post_id AND capture.audio_revision=q.audio_revision
  WHERE leg.leg_id=p_leg AND leg.qualification_family_v2='shared_song'
    AND binding.value->>'activity'=q.activity_key AND binding.value->>'qualification_policy_id'=q.qualification_policy_version_id
    AND capture.bindings @> jsonb_build_array(binding.value)
    AND q.community_id=offer.community_id AND q.post_id=offer.post_id AND q.audio_revision=offer.audio_revision
    AND q.qualified_at>=capture.captured_at AND can_account_access_activity_song(q.account_id,q.community_id,q.post_id)
    AND EXISTS(SELECT 1 FROM users WHERE user_id=q.account_id AND status='active')
    AND (SELECT paused FROM reward_operations_control WHERE singleton) IS FALSE
    AND ((q.activity_key IN('study','karaoke') AND q.grading_mode='numeric' AND q.score_bps IS NOT NULL
       AND binding.value->>'grading_family'='numeric' AND jsonb_typeof(binding.value->'numeric_floor_bps')='number'
       AND q.score_bps>=(binding.value->>'numeric_floor_bps')::INTEGER)
     OR (q.activity_key='dance' AND q.grading_mode='moderator_verdict' AND q.categorical_verdict='passed'
       AND q.score_bps IS NULL AND q.calibration_id IS NULL AND q.numeric_floor_bps IS NULL
       AND binding.value->>'grading_family'='moderator_verdict' AND binding.value->'numeric_floor_bps'='null'::JSONB
       AND review.status='reviewed' AND review.state->>'verdict'='passed'
       AND review.state->'capture'->>'rewardMode'='reward_eligible' AND review.state->'capture'->'policy'->>'admission'='money_admitted'
       AND review.state->'attestation'->>'cue'='affirmed'
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(review.state->'capture'->'objectives') objective
         WHERE objective->>'id'=binding.value->>'objective_id'
           AND objective->>'version'=binding.value->>'qualification_policy_id'
           AND objective->>'termsHash'=leg.shared_song_terms_v2->>'terms_hash'
           AND objective->>'fundingPolicyHash'=leg.shared_song_terms_v2->>'funding_policy_hash'
           AND objective->>'gradingMode'='moderator_verdict')))
 ),FALSE)
$$;

-- Original legacy identity/eligibility/drawing guard retained, with the new
-- nullable family handled explicitly rather than SQL UNKNOWN accepting it.
CREATE OR REPLACE FUNCTION guard_megapot_pool_share() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  drawing_record megapot_pool_drawings%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  qualification_record activity_qualifications%ROWTYPE;
  eligibility_record reward_eligibility_decisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot pool shares are append-only';
  END IF;
  SELECT * INTO drawing_record FROM megapot_pool_drawings
   WHERE pool_leg_id = NEW.pool_leg_id AND drawing_id = NEW.drawing_id FOR UPDATE;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = NEW.pool_leg_id FOR SHARE;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = leg_record.offer_id FOR SHARE;
  SELECT * INTO qualification_record FROM activity_qualifications
   WHERE qualification_id = NEW.qualification_id FOR SHARE;
  SELECT * INTO eligibility_record FROM reward_eligibility_decisions
   WHERE eligibility_decision_id = NEW.eligibility_decision_id FOR SHARE;
  IF leg_record.qualification_family_v2='shared_song' AND shared_song_accepts_qualification_v2(NEW.pool_leg_id,NEW.qualification_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'exact captured categorical/numeric shared objective required' USING ERRCODE='PCV05';
  END IF;
  IF leg_record.qualification_family_v2='numeric' AND qualification_record.score_bps IS NULL THEN
    RAISE EXCEPTION 'numeric legacy leg requires actual numeric evidence' USING ERRCODE='PCV05';
  END IF;
  IF drawing_record.status <> 'entry_open'
     OR clock_timestamp() >= drawing_record.entry_cutoff_at
     OR qualification_record.account_id <> NEW.account_id
     OR qualification_record.persona_id <> NEW.persona_id
     OR qualification_record.community_id <> offer_record.community_id
     OR qualification_record.post_id <> offer_record.post_id
     OR qualification_record.audio_revision <> offer_record.audio_revision
     OR NOT qualification_record.activity_key = ANY(leg_record.eligible_activities)
     OR qualification_record.score_bps < leg_record.min_score_bps
     OR qualification_record.qualified_at >= drawing_record.entry_cutoff_at
     OR qualification_record.qualified_at < leg_record.participation_starts_at
     OR NEW.qualified_at <> qualification_record.qualified_at
     OR eligibility_record.leg_id <> NEW.pool_leg_id
     OR eligibility_record.account_id <> NEW.account_id
     OR eligibility_record.persona_id <> NEW.persona_id
     OR eligibility_record.purpose <> 'pool_share'
     OR eligibility_record.qualification_id <> NEW.qualification_id
     OR eligibility_record.drawing_id <> NEW.drawing_id
     OR eligibility_record.outcome <> 'eligible'
     OR eligibility_record.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Megapot pool share is not exact eligible qualification output';
  END IF;
  RETURN NEW;
END
$$;

-- Same accepted eligibility/share authority and account/drawing uniqueness,
-- dedicated only to the new immutable mixed family. Legacy projector unchanged.
CREATE FUNCTION project_shared_song_pool_share_v2() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate RECORD;
  decided_at TIMESTAMPTZ := clock_timestamp();
  decision_id TEXT;
  eligibility_id TEXT;
  identity_digest TEXT;
  admission_hash TEXT;
BEGIN
  -- Lock-capable reward roles keep the original single candidate snapshot.
  -- A restricted ordinary role skips the lock only when no candidate exists.
  IF NOT pg_catalog.has_any_column_privilege(current_user, 'megapot_pool_drawings'::regclass, 'UPDATE') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM song_reward_offers offer
      JOIN song_reward_offer_legs leg ON leg.offer_id = offer.offer_id
      JOIN megapot_pool_drawings drawing ON drawing.pool_leg_id = leg.leg_id
      JOIN policy_versions policy
        ON policy.community_id = offer.community_id
       AND policy.policy_version_id = offer.reward_policy_version_id
       AND policy.policy_purpose = 'reward'
       AND policy.uniqueness_authority_id = offer.offer_id
     WHERE offer.community_id = NEW.community_id
       AND offer.post_id = NEW.post_id
       AND offer.audio_revision = NEW.audio_revision
       AND offer.status = 'active'
       AND NEW.qualified_at >= offer.starts_at
       AND NEW.qualified_at < offer.ends_at
       AND leg.kind = 'megapot_pool' AND leg.qualification_family_v2='shared_song'
       AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id)
       AND leg.status = 'active'
       AND NEW.qualified_at >= leg.participation_starts_at
       AND NEW.activity_key = ANY(leg.eligible_activities)
       AND shared_song_accepts_qualification_v2(leg.leg_id,NEW.qualification_id)
       AND drawing.status = 'entry_open'
       AND (leg.shared_song_terms_v2->'planned_drawing_ids') @> jsonb_build_array(drawing.drawing_id::TEXT)
       AND drawing.drawing_id >= leg.participation_starts_drawing_id
       AND NEW.qualified_at < drawing.entry_cutoff_at
       AND decided_at < drawing.entry_cutoff_at
       AND NOT EXISTS (
         SELECT 1 FROM megapot_pool_shares share
          WHERE share.pool_leg_id = leg.leg_id
            AND share.drawing_id = drawing.drawing_id
            AND share.account_id = NEW.account_id
       )
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT leg.leg_id, leg.offer_id, drawing.drawing_id, drawing.entry_cutoff_at,
         offer.community_id, offer.reward_policy_version_id,
         policy.policy_hash
    INTO candidate
    FROM song_reward_offers offer
    JOIN song_reward_offer_legs leg ON leg.offer_id = offer.offer_id
    JOIN megapot_pool_drawings drawing ON drawing.pool_leg_id = leg.leg_id
    JOIN policy_versions policy
      ON policy.community_id = offer.community_id
     AND policy.policy_version_id = offer.reward_policy_version_id
     AND policy.policy_purpose = 'reward'
     AND policy.uniqueness_authority_id = offer.offer_id
   WHERE offer.community_id = NEW.community_id
     AND offer.post_id = NEW.post_id
     AND offer.audio_revision = NEW.audio_revision
     AND offer.status = 'active'
     AND NEW.qualified_at >= offer.starts_at
     AND NEW.qualified_at < offer.ends_at
     AND leg.kind = 'megapot_pool' AND leg.qualification_family_v2='shared_song'
     AND reward_leg_accepts_qualification(leg.leg_id, NEW.activity_key, NEW.qualification_policy_version_id)
     AND leg.status = 'active'
     AND NEW.qualified_at >= leg.participation_starts_at
     AND NEW.activity_key = ANY(leg.eligible_activities)
     AND shared_song_accepts_qualification_v2(leg.leg_id,NEW.qualification_id)
     AND drawing.status = 'entry_open'
       AND (leg.shared_song_terms_v2->'planned_drawing_ids') @> jsonb_build_array(drawing.drawing_id::TEXT)
     AND drawing.drawing_id >= leg.participation_starts_drawing_id
     AND NEW.qualified_at < drawing.entry_cutoff_at
     AND decided_at < drawing.entry_cutoff_at
     AND NOT EXISTS (
       SELECT 1 FROM megapot_pool_shares share
        WHERE share.pool_leg_id = leg.leg_id
          AND share.drawing_id = drawing.drawing_id
          AND share.account_id = NEW.account_id
     )
   ORDER BY drawing.drawing_id DESC
   LIMIT 1
   FOR UPDATE OF drawing;

  IF candidate.leg_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The drawing lock serializes producers that qualify the same account
  -- concurrently; recheck so only the first commit emits a decision and share.
  IF EXISTS (
    SELECT 1 FROM megapot_pool_shares share
     WHERE share.pool_leg_id = candidate.leg_id
       AND share.drawing_id = candidate.drawing_id
       AND share.account_id = NEW.account_id
  ) THEN
    RETURN NEW;
  END IF;

  identity_digest := md5(
    NEW.qualification_id || chr(31) || candidate.leg_id || chr(31) || candidate.drawing_id::text
  );
  decision_id := 'reward_decision_' || identity_digest;
  eligibility_id := 'reward_eligibility_' || identity_digest;
  -- The admitted facts, not provider evidence: entry requires none.
  admission_hash := encode(sha256(convert_to(jsonb_build_object(
    'admission', 'megapot_claim_time_verification_v1',
    'qualification_id', NEW.qualification_id,
    'pool_leg_id', candidate.leg_id,
    'drawing_id', candidate.drawing_id::text,
    'policy_hash', candidate.policy_hash
  )::text, 'UTF8')), 'hex');

  INSERT INTO decision_records (
    decision_record_id,community_id,user_id,policy_version_id,policy_hash,
    evaluation_mode,outcome,winning_witness,trace,request_id,created_at
  ) VALUES (
    decision_id,candidate.community_id,NEW.account_id,candidate.reward_policy_version_id,
    candidate.policy_hash,'enforce','pass',
    -- A pass must name its witness: the qualification and admitted terms.
    jsonb_build_array(jsonb_build_object(
      'admission','megapot_claim_time_verification_v1',
      'qualification_id',NEW.qualification_id,
      'pool_leg_id',candidate.leg_id,
      'drawing_id',candidate.drawing_id::text
    )),
    jsonb_build_array(jsonb_build_object(
      'result','eligible','admission','megapot_claim_time_verification_v1'
    )),
    'pool-share:' || identity_digest,decided_at
  );
  INSERT INTO reward_eligibility_decisions (
    eligibility_decision_id,leg_id,account_id,persona_id,purpose,qualification_id,
    drawing_id,decision_record_id,outcome,policy_version,evidence_hash,decided_at,expires_at
  ) VALUES (
    eligibility_id,candidate.leg_id,NEW.account_id,NEW.persona_id,'pool_share',
    NEW.qualification_id,candidate.drawing_id,decision_id,'eligible',
    candidate.reward_policy_version_id,admission_hash,decided_at,
    candidate.entry_cutoff_at
  );
  INSERT INTO megapot_pool_shares (
    pool_leg_id,drawing_id,account_id,persona_id,qualification_id,
    eligibility_decision_id,qualified_at
  ) VALUES (
    candidate.leg_id,candidate.drawing_id,NEW.account_id,NEW.persona_id,
    NEW.qualification_id,eligibility_id,NEW.qualified_at
  ) ON CONFLICT (account_id,pool_leg_id,drawing_id) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER shared_song_pool_qualification_projection AFTER INSERT ON activity_qualifications
 FOR EACH ROW EXECUTE FUNCTION project_shared_song_pool_share_v2();
DO $acl$
DECLARE fn REGPROCEDURE; grant_row RECORD; owned_table REGCLASS;
BEGIN
 FOR fn IN SELECT oid::REGPROCEDURE FROM pg_proc WHERE pronamespace=current_schema()::REGNAMESPACE AND proname=ANY(ARRAY[
  'current_shared_song_objectives_v2','capture_shared_song_activity_objectives_v2','shared_song_accepts_qualification_v2','project_shared_song_pool_share_v2']) LOOP
  EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path TO %I, pg_catalog, pg_temp',fn,current_schema());
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_proc f CROSS JOIN LATERAL aclexplode(f.proacl) acl
    WHERE f.oid=fn::OID AND acl.grantee<>0 AND acl.grantee<>f.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn,pg_get_userbyid(grant_row.grantee));
  END LOOP;
 END LOOP;
 owned_table:='reward_activity_objective_captures_v2'::REGCLASS;
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',owned_table);
 FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid=owned_table AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
  EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',owned_table,pg_get_userbyid(grant_row.grantee));
 END LOOP;
END $acl$;
