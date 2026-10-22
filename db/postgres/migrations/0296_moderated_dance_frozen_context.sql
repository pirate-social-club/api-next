-- Additive private context reads. No admission, role grant, provider action or
-- modification to an existing closed reply. Application decoding verifies the
-- complete original capture/policy/disclosure hashes before wire projection.
CREATE FUNCTION project_owned_moderated_dance_capture_context_v1(
 p_actor TEXT,p_community TEXT,p_session TEXT
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object(
  'terms',s.terms,'session',project_moderated_dance_session_v1(s.session_id),
  'disclosure',disclosure.disclosure,
  'reference',jsonb_build_object(
   'reference_post_id',reference.reference_post_id,'video_render_revision',reference.video_render_revision,
   'reference_terms_hash',reference.terms_hash,'reference_digest',reference.reference_digest,
   'segment_terms_hash',segment.segment_terms_hash,
   'normalization_hash',reference.alignment_evidence->>'normalization_hash',
   'canonical_song_start_ms',segment.start_ms,'canonical_song_end_ms',segment.end_ms,
   'reference_body_start_ms',reference.alignment_evidence->'reference_body_start_ms',
   'reference_body_end_ms',reference.alignment_evidence->'reference_body_end_ms'),
  -- LEFT joins preserve every captured tuple. Missing or ambiguous retained
  -- authority fails strict decoding; it can never become an empty practice set.
  'objectives',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'target',jsonb_build_object('kind','committed','community_id',offer.community_id,
      'post_id',offer.post_id,'canonical_song_id',offer.post_id,'audio_revision',offer.audio_revision,
      'offer_id',offer.offer_id,'pool_leg_id',leg.leg_id),
    'terms',leg.shared_song_terms_v2,'binding',binding.value,
    'chain_id',leg.chain_id,'token_address',leg.token_address,'token_decimals',leg.token_decimals,
    'qualification_document',qualification.policy_document) ORDER BY objective.ordinality)
   FROM jsonb_array_elements(s.terms->'capture'->'objectives') WITH ORDINALITY objective(value,ordinality)
   LEFT JOIN song_reward_offer_legs leg ON leg.qualification_family_v2='shared_song'
    AND leg.kind='megapot_pool' AND leg.funding_source='leg_budget' AND leg.empty_pool_policy='no_purchase'
    AND leg.shared_song_terms_v2->>'terms_hash'=objective.value->>'termsHash'
    AND leg.shared_song_terms_v2->>'funding_policy_hash'=objective.value->>'fundingPolicyHash'
    AND leg.leg_terms_hash='0x'||(leg.shared_song_terms_v2->>'terms_hash') AND leg.min_score_bps IS NULL
   LEFT JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id AND offer.community_id=s.community_id
    AND offer.post_id=s.song_post_id AND offer.audio_revision=(s.terms->'capture'->>'audioRevision')::BIGINT
   LEFT JOIN LATERAL jsonb_array_elements(leg.shared_song_terms_v2->'qualification_bindings') binding(value)
    ON binding.value->>'objective_id'=objective.value->>'id' AND binding.value->>'activity'='dance'
    AND binding.value->>'qualification_policy_id'=objective.value->>'version'
    AND binding.value->>'offer_id'=offer.offer_id AND binding.value->>'leg_id'=leg.leg_id
   LEFT JOIN qualification_policy_versions qualification
    ON qualification.qualification_policy_version_id=binding.value->>'qualification_policy_id'
    AND qualification.activity_key='dance' AND qualification.policy_kind='dance_owner_verdict_v1'
   WHERE EXISTS(SELECT 1 FROM megapot_deployment_attestations deployment WHERE deployment.attestation_id=leg.attestation_id
     AND deployment.chain_id=leg.chain_id AND deployment.usdc_address=leg.token_address AND leg.token_decimals=6)
    AND EXISTS(SELECT 1 FROM policy_versions reward WHERE reward.policy_version_id=offer.reward_policy_version_id
     AND reward.community_id=s.community_id AND reward.policy_purpose='reward' AND reward.uniqueness_authority_id=offer.offer_id
     AND reward.policy_hash=leg.shared_song_terms_v2->>'reward_policy_hash')
   ),'[]'::JSONB))
 FROM dance_moderated_sessions_v1 s
 JOIN dance_review_policy_versions_v1 policy ON policy.policy_id=s.policy_id
  AND policy.review_policy=s.terms->'capture'->'policy' AND policy.policy_hash=s.terms->'capture'->'policy'->>'hash'
  AND policy.operational_profile=s.terms->'profile' AND policy.disposition_profile=s.terms->'disposition'
 JOIN dance_moderated_policy_disclosures_v1 disclosure ON disclosure.policy_id=s.policy_id
  AND disclosure.safety_policy_snapshot=s.terms->'safety_policy'
 JOIN dance_moderator_reference_revisions_v1 reference ON reference.choreography_id=s.choreography_id
  AND reference.revision=s.choreography_revision AND reference.community_id=s.community_id AND reference.song_post_id=s.song_post_id
  AND reference.audio_revision=(s.terms->'capture'->>'audioRevision')::BIGINT
  AND reference.segment_id=s.terms->'capture'->>'segmentId'
 JOIN dance_song_segments segment ON segment.segment_id=reference.segment_id AND segment.community_id=s.community_id
  AND segment.song_post_id=s.song_post_id AND segment.audio_revision=reference.audio_revision
 JOIN users actor ON actor.user_id=s.account_id AND actor.status='active'
 JOIN communities community ON community.community_id=s.community_id AND community.status='active'
 JOIN personas persona ON persona.persona_id=s.persona_id AND persona.account_id=s.account_id AND persona.status='active'
 JOIN persona_community_bindings persona_binding ON persona_binding.persona_id=s.persona_id AND persona_binding.community_id=s.community_id
 JOIN dance_review_account_fences_v1 fence ON fence.account_id=s.account_id AND NOT fence.erasing
  AND fence.revision=s.capture_account_fence
 JOIN posts song ON song.community_id=s.community_id AND song.post_id=s.song_post_id
  AND song.post_type='song' AND song.status='published' AND song.visibility='public'
 WHERE s.account_id=p_actor AND s.community_id=p_community AND s.session_id=p_session
  AND moderated_dance_account_runtime_v1() AND can_account_view_content_rating_v1(p_actor,song.content_rating) IS TRUE
$$;

CREATE FUNCTION project_moderated_dance_owner_rubric_v1(
 p_actor TEXT,p_community TEXT,p_review TEXT
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object('terms',s.terms,'disclosure',disclosure.disclosure,
  'community_id',r.community_id,'review_id',r.review_id,'review_revision',r.revision,
  'session_terms_hash',r.state->'capture'->>'termsHash')
 FROM dance_moderated_reviews_v1 r JOIN dance_moderated_sessions_v1 s USING(session_id)
 JOIN dance_review_policy_versions_v1 policy ON policy.policy_id=s.policy_id
  AND policy.review_policy=s.terms->'capture'->'policy' AND policy.policy_hash=s.terms->'capture'->'policy'->>'hash'
  AND policy.operational_profile=s.terms->'profile' AND policy.disposition_profile=s.terms->'disposition'
 JOIN dance_moderated_policy_disclosures_v1 disclosure ON disclosure.policy_id=s.policy_id
  AND disclosure.safety_policy_snapshot=s.terms->'safety_policy'
 WHERE r.review_id=p_review AND r.community_id=p_community AND moderated_dance_account_runtime_v1()
  AND can_owner_read_moderated_dance_v1(p_actor,p_review)
  AND r.review_deadline>clock_timestamp()
  AND r.state->'capture'->'policy'=s.terms->'capture'->'policy'
  AND r.state->'capture'->>'termsHash'=s.terms_hash
  AND r.state->'capture'->>'reviewId'=s.review_id
  AND r.state->'capture'->>'sessionId'=s.session_id
$$;

-- Charging changes usage. These wrappers deliberately remain VOLATILE; their
-- final STABLE projector rechecks authorization and all facts in one snapshot
-- after any usage-row lock wait, including owner changes and erasure.
CREATE FUNCTION read_owned_moderated_dance_capture_context_v1(
 p_actor TEXT,p_community TEXT,p_session TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE packet JSONB;
BEGIN
 packet:=project_owned_moderated_dance_capture_context_v1(p_actor,p_community,p_session);
 IF packet IS NULL THEN RAISE EXCEPTION 'private Dance context unavailable' USING ERRCODE='DRV02'; END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,packet->'terms'->'profile',TRUE,FALSE) THEN
  RAISE EXCEPTION 'private Dance read limit reached' USING ERRCODE='DRV07';
 END IF;
 packet:=project_owned_moderated_dance_capture_context_v1(p_actor,p_community,p_session);
 IF packet IS NULL THEN RAISE EXCEPTION 'private Dance context unavailable' USING ERRCODE='DRV02'; END IF;
 RETURN packet;
END $$;
CREATE FUNCTION read_moderated_dance_owner_rubric_v1(
 p_actor TEXT,p_community TEXT,p_review TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE packet JSONB;
BEGIN
 packet:=project_moderated_dance_owner_rubric_v1(p_actor,p_community,p_review);
 IF packet IS NULL THEN RAISE EXCEPTION 'private Dance rubric unavailable' USING ERRCODE='DRV02'; END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,packet->'terms'->'profile',TRUE,FALSE) THEN
  RAISE EXCEPTION 'private Dance read limit reached' USING ERRCODE='DRV07';
 END IF;
 packet:=project_moderated_dance_owner_rubric_v1(p_actor,p_community,p_review);
 IF packet IS NULL THEN RAISE EXCEPTION 'private Dance rubric unavailable' USING ERRCODE='DRV02'; END IF;
 RETURN packet;
END $$;
DO $acl$
DECLARE f RECORD; grantee RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p
  WHERE p.pronamespace=trusted::regnamespace AND p.proname IN(
   'project_owned_moderated_dance_capture_context_v1','project_moderated_dance_owner_rubric_v1',
   'read_owned_moderated_dance_capture_context_v1','read_moderated_dance_owner_rubric_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name
   FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(0,f.proowner) LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
  END LOOP;
 END LOOP;
END $acl$;
