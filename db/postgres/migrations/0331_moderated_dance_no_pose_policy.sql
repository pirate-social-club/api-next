-- Prospective no-pose policy only. Captured v1 terms, hash preimages,
-- histories and receipts are never updated. No policy or runtime is activated.
CREATE FUNCTION moderated_dance_capture_mode_valid_v2(c JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE c->'policy'->>'version'
 WHEN 'moderator-review-policy-v1' THEN
  (c->>'cueStartMs')::NUMERIC>=0 AND (c->>'cueEndMs')::NUMERIC>(c->>'cueStartMs')::NUMERIC
  AND (c->>'cueEndMs')::NUMERIC<=(c->>'bodyStartMs')::NUMERIC
  AND (c->>'cueHoldMs')::NUMERIC>0
  AND (c->>'cueHoldMs')::NUMERIC<=(c->>'cueEndMs')::NUMERIC-(c->>'cueStartMs')::NUMERIC
 WHEN 'moderator-review-policy-v2' THEN c->>'cueId'='none'
  AND c->'cueStartMs'='0'::JSONB AND c->'cueEndMs'='0'::JSONB
  AND c->'cueHoldMs'='0'::JSONB AND c->'bodyStartMs'='0'::JSONB
 ELSE FALSE END
$$;
CREATE FUNCTION moderated_dance_policy_profile_matches_v2(policy JSONB,profile JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE policy->>'version'
 WHEN 'moderator-review-policy-v1' THEN profile->>'version'='dance-moderated-intake-profile-v1'
 WHEN 'moderator-review-policy-v2' THEN profile->>'version'='dance-moderated-intake-profile-v2'
  AND profile->'cueStartMs'='0'::JSONB AND profile->'cueEndMs'='0'::JSONB
  AND profile->'cueHoldMs'='0'::JSONB AND profile->'bodyStartMs'='0'::JSONB
 ELSE FALSE END
$$;
-- Replace only the former envelope-version constraint; keep all other checks.
DO $policy_constraint$ DECLARE c RECORD; matches INTEGER:=0; BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid='dance_review_policy_versions_v1'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%moderator-review-policy-v1%' LOOP
  EXECUTE format('ALTER TABLE dance_review_policy_versions_v1 DROP CONSTRAINT %I',c.conname);
  matches:=matches+1;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION 'exact former Dance policy version constraint required'; END IF;
END $policy_constraint$;
ALTER TABLE dance_review_policy_versions_v1 ADD CONSTRAINT dance_review_policy_version_v2
 CHECK((review_policy->>'version' IN('moderator-review-policy-v1','moderator-review-policy-v2')) IS TRUE);


CREATE OR REPLACE FUNCTION publish_moderated_dance_policy_v1(p_input JSONB) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE policy JSONB:=p_input->'policy'; existing dance_review_policy_versions_v1;
 profile JSONB:=p_input->'profile'; disposition JSONB:=p_input->'disposition'; q qualification_policy_versions;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_review_policy_versions_v1'::regclass)) THEN RAISE EXCEPTION 'policy publication requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 IF (p_input->>'version'='dance-moderated-policy-publication-v1' AND length(p_input->>'accepted_by')>0
 AND length(p_input->>'acceptance_ref')>0 AND p_input->>'acceptance_hash'~'^[a-f0-9]{64}$'
 AND moderated_dance_policy_profile_matches_v2(policy,profile) AND policy->>'hash'~'^[a-f0-9]{64}$'
 AND (policy->>'reviewWindowMs')::BIGINT=604800000
 AND (profile->>'maximumProviderCalls')::BIGINT>=6 AND (profile->>'maximumProviderSpendMicrounits')::NUMERIC>0
 AND policy->>'retentionHash'=disposition->>'hash' AND (disposition->>'accepted')::BOOLEAN
 AND (disposition->'hold'->>'accepted')::BOOLEAN AND length(disposition->'hold'->>'authorityRef')>0
 AND (disposition->'hold'->>'disposeByMs')::NUMERIC>extract(epoch FROM (p_input->>'valid_from')::TIMESTAMPTZ)*1000
 AND least((disposition->>'validUntilMs')::NUMERIC,(disposition->'hold'->>'disposeByMs')::NUMERIC)>=extract(epoch FROM (p_input->>'valid_until')::TIMESTAMPTZ)*1000+(profile->>'sessionTtlMs')::NUMERIC+604800000+greatest((disposition->>'cleanupWithinMs')::NUMERIC,(disposition->>'temporaryCleanupWithinMs')::NUMERIC,(disposition->>'transferWithinMs')::NUMERIC)) IS NOT TRUE THEN
  RAISE EXCEPTION 'policy publication incomplete' USING ERRCODE='DRV06';
 END IF;
 IF (p_input->'producer_registration'->>'status' IN('reserved','active') AND length(p_input->'producer_registration'->>'acceptance_ref')>0
 AND p_input->'producer_registration'->>'acceptance_hash'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'producer registration acceptance required' USING ERRCODE='DRV06'; END IF;
 -- Scope/recipe changes and dropping an old epoch must not partition replay
 -- history. Publication and new capture/reference creation serialize here.
 -- Actual retained claims/current private copies/captured producers constrain
 -- a replacement; public ready-reference history alone is not a key dependency.
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 e WHERE profile->'replayCompatibleEpochs' ? e.key_epoch) THEN RAISE EXCEPTION 'replay epoch retired' USING ERRCODE='DRV07'; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderator_reference_revisions_v1 r
  WHERE r.alignment_evidence->>'normalization_hash' IS DISTINCT FROM policy->>'normalizationHash')
 OR EXISTS(SELECT 1 FROM dance_moderated_public_replay_v1 d WHERE d.scope IS DISTINCT FROM profile->>'replayScope' OR d.normalization_hash IS DISTINCT FROM policy->>'normalizationHash')
 OR EXISTS(SELECT 1 FROM moderated_dance_replay_producer_profiles_v1() prior WHERE prior->>'replayScope' IS DISTINCT FROM profile->>'replayScope'
  OR (prior->>'replayKeyEpoch'<>profile->>'replayKeyEpoch' AND ((profile->'replayCompatibleEpochs') ? (prior->>'replayKeyEpoch')) IS NOT TRUE AND EXISTS(SELECT 1 FROM dance_review_policy_admissions_v1 a JOIN dance_review_policy_versions_v1 other USING(policy_id) WHERE a.community_id<>p_input->>'community_id' AND a.accepted AND a.valid_until>clock_timestamp() AND other.operational_profile=prior)))
 OR EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 c WHERE c.scope IS DISTINCT FROM profile->>'replayScope' OR ((profile->'replayCompatibleEpochs') ? c.key_epoch) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 u JOIN dance_moderated_sessions_v1 session USING(session_id)
  WHERE u.normalized_digest IS NOT NULL AND ((profile->'replayCompatibleEpochs') ? (session.terms->'profile'->>'replayKeyEpoch')) IS NOT TRUE) THEN
  RAISE EXCEPTION 'retained replay family/epochs require compatible normalization' USING ERRCODE='DRV07';
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_sessions_v1 session WHERE session.state IN('created','consented','awaiting_upload') AND session.expires_at>clock_timestamp()
 AND ((profile->'replayCompatibleEpochs') ? (session.terms->'profile'->>'replayKeyEpoch')) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM dance_moderated_reference_commands_v1 c JOIN dance_review_policy_versions_v1 p USING(policy_id) WHERE c.state NOT IN('ready','failed') AND (c.worker_deadline IS NULL OR c.worker_deadline>clock_timestamp())
 AND ((profile->'replayCompatibleEpochs') ? (p.operational_profile->>'replayKeyEpoch')) IS NOT TRUE) THEN RAISE EXCEPTION 'captured replay producer requires its current epoch' USING ERRCODE='DRV07'; END IF;
 SELECT * INTO q FROM qualification_policy_versions WHERE qualification_policy_version_id=policy->>'qualificationVersion' FOR SHARE;
 IF q.qualification_policy_version_id IS NULL THEN
  INSERT INTO qualification_policy_versions(qualification_policy_version_id,activity_key,policy_kind,policy_document)
  VALUES(policy->>'qualificationVersion','dance','dance_owner_verdict_v1',p_input->'qualification_policy_document') RETURNING * INTO q;
 ELSIF q.policy_document IS DISTINCT FROM p_input->'qualification_policy_document' THEN RAISE EXCEPTION 'immutable qualification policy conflict' USING ERRCODE='DRV03'; END IF;
 IF q.activity_key IS DISTINCT FROM 'dance' OR q.policy_kind IS DISTINCT FROM 'dance_owner_verdict_v1'
 OR q.policy_document->>'policy_hash' IS DISTINCT FROM policy->>'qualificationHash'
 OR q.policy_document->>'producer_id' IS DISTINCT FROM policy->>'producerId'
 OR q.policy_document->>'admission' IS DISTINCT FROM policy->>'admission'
 OR q.policy_document->>'admission_version' IS DISTINCT FROM policy->>'admissionVersion'
 OR q.policy_document->>'admission_hash' IS DISTINCT FROM policy->>'admissionHash'
 OR (policy->>'version'='moderator-review-policy-v2' AND q.policy_document->>'opening_pose' IS DISTINCT FROM 'not_required') THEN
  RAISE EXCEPTION 'qualification admission is a separate prerequisite' USING ERRCODE='DRV07';
 END IF;
 SELECT * INTO existing FROM dance_review_policy_versions_v1 WHERE policy_id=p_input->>'policy_id';
 IF existing.policy_id IS NOT NULL THEN
  IF existing.policy_hash IS DISTINCT FROM policy->>'hash' OR existing.review_policy IS DISTINCT FROM policy
  OR existing.operational_profile IS DISTINCT FROM profile OR existing.disposition_profile IS DISTINCT FROM disposition
  OR NOT EXISTS(SELECT 1 FROM dance_moderated_policy_disclosures_v1 d WHERE d.policy_id=existing.policy_id AND d.disclosure=p_input->'disclosure' AND d.safety_policy_snapshot=p_input->'safety_policy'
    AND d.admission_receipt=jsonb_build_object('accepted_by',p_input->>'accepted_by','acceptance_ref',p_input->>'acceptance_ref','acceptance_hash',p_input->>'acceptance_hash','producer_registration',p_input->'producer_registration')) THEN
   RAISE EXCEPTION 'immutable policy publication conflict' USING ERRCODE='DRV03';
  END IF;
 ELSE
  INSERT INTO dance_review_policy_versions_v1(policy_id,policy_hash,review_policy,operational_profile,disposition_profile,qualification_policy_version_id,accepted_by,valid_from,valid_until)
  VALUES(p_input->>'policy_id',policy->>'hash',policy,profile,disposition,q.qualification_policy_version_id,p_input->>'accepted_by',(p_input->>'valid_from')::TIMESTAMPTZ,(p_input->>'valid_until')::TIMESTAMPTZ);
  INSERT INTO dance_moderated_policy_disclosures_v1(policy_id,disclosure,safety_policy_snapshot,admission_receipt)
  VALUES(p_input->>'policy_id',p_input->'disclosure',p_input->'safety_policy',jsonb_build_object('accepted_by',p_input->>'accepted_by','acceptance_ref',p_input->>'acceptance_ref','acceptance_hash',p_input->>'acceptance_hash','producer_registration',p_input->'producer_registration'));
 END IF;
 -- The explicit, separately receipted producer registration is nonfinancial.
 -- This command does not enable Rewards, a custody policy, or a monetary lane.
 UPDATE activity_registry SET status=p_input->'producer_registration'->>'status',
 producer_version=CASE WHEN p_input->'producer_registration'->>'status'='active' THEN policy->>'producerId' ELSE NULL END,
 current_policy_version_id=CASE WHEN p_input->'producer_registration'->>'status'='active' THEN policy->>'qualificationVersion' ELSE NULL END,
 updated_at=clock_timestamp() WHERE activity_key='dance';
 INSERT INTO dance_review_policy_admissions_v1(community_id,policy_id,accepted,accepted_by,effective_at,valid_until)
 VALUES(p_input->>'community_id',p_input->>'policy_id',TRUE,p_input->>'accepted_by',(p_input->>'valid_from')::TIMESTAMPTZ,(p_input->>'valid_until')::TIMESTAMPTZ)
 ON CONFLICT(community_id) DO UPDATE SET policy_id=EXCLUDED.policy_id,accepted=EXCLUDED.accepted,accepted_by=EXCLUDED.accepted_by,effective_at=EXCLUDED.effective_at,valid_until=EXCLUDED.valid_until;
 RETURN policy->>'hash';
END $$;

CREATE OR REPLACE FUNCTION load_moderated_dance_creation_facts_v1(p_actor TEXT,p_command JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE ref dance_moderator_reference_revisions_v1; seg dance_song_segments;
 policy dance_review_policy_versions_v1; admission dance_review_policy_admissions_v1;
 f dance_review_account_fences_v1; zone account_streak_clocks; disclosure dance_moderated_policy_disclosures_v1; now_at TIMESTAMPTZ:=clock_timestamp(); objectives JSONB;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_command->>'community_id',NULL,TRUE);
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO ref FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=p_command->>'choreography_id' AND revision=(p_command->>'choreography_revision')::BIGINT FOR SHARE;
 IF ref.choreography_id IS NULL OR ROW(ref.community_id,ref.song_post_id) IS DISTINCT FROM ROW(p_command->>'community_id',p_command->>'song_post_id')
 OR NOT active_activity_persona(p_actor,p_command->>'persona_id',ref.community_id)
 OR NOT can_account_access_activity_song(p_actor,ref.community_id,ref.song_post_id)
 OR NOT EXISTS(SELECT 1 FROM posts p WHERE p.community_id=ref.reference_community_id AND p.post_id=ref.reference_post_id AND EXISTS(SELECT 1 FROM communities rc WHERE rc.community_id=p.community_id AND rc.status='active') AND p.post_type='video' AND p.status='published' AND p.visibility='public' AND can_account_view_content_rating_v1(p_actor,p.content_rating))
 OR EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=ref.choreography_id AND revision=ref.revision) THEN
  RAISE EXCEPTION 'private Dance reference unavailable' USING ERRCODE='DRV02';
 END IF;
 SELECT * INTO seg FROM dance_song_segments WHERE segment_id=ref.segment_id;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=ref.community_id FOR SHARE;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id FOR SHARE;
 SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=p_actor;
 SELECT * INTO disclosure FROM dance_moderated_policy_disclosures_v1 WHERE policy_id=policy.policy_id;
 SELECT * INTO zone FROM account_streak_clocks WHERE account_id=p_actor FOR SHARE;
 IF admission.accepted IS DISTINCT FROM TRUE OR now_at<admission.effective_at OR now_at>=admission.valid_until
 OR now_at<policy.valid_from OR now_at>=policy.valid_until OR policy.policy_hash IS DISTINCT FROM p_command->>'expected_policy_hash'
 OR zone.account_id IS NULL OR disclosure.policy_id IS NULL OR (policy.disposition_profile->>'accepted')::BOOLEAN IS DISTINCT FROM TRUE
 OR (policy.disposition_profile->>'validUntilMs')::NUMERIC<=extract(epoch FROM now_at)*1000
 OR moderated_dance_policy_profile_matches_v2(policy.review_policy,policy.operational_profile) IS NOT TRUE THEN
  RAISE EXCEPTION 'private Dance policy unavailable' USING ERRCODE='DRV07';
 END IF;
 -- Stabilize the shared offer while capturing objectives BEFORE any bytes.
 PERFORM 1 FROM reward_song_slots_v2 WHERE community_id=ref.community_id AND post_id=ref.song_post_id FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',binding->>'objective_id','version',binding->>'qualification_policy_id',
  'termsHash',leg.shared_song_terms_v2->>'terms_hash','fundingPolicyHash',leg.shared_song_terms_v2->>'funding_policy_hash','gradingMode','moderator_verdict') ORDER BY binding->>'binding_id'),'[]'::JSONB)
 INTO objectives FROM jsonb_array_elements(current_shared_song_objectives_v2(p_actor,ref.community_id,ref.song_post_id,ref.audio_revision,'dance')) binding
 JOIN song_reward_offer_legs leg ON leg.qualification_family_v2='shared_song' AND leg.shared_song_terms_v2->'qualification_bindings' @> jsonb_build_array(binding)
 JOIN song_reward_offers offer ON offer.offer_id=leg.offer_id AND offer.community_id=ref.community_id AND offer.post_id=ref.song_post_id AND offer.audio_revision=ref.audio_revision
 JOIN reward_song_slots_v2 slot ON slot.community_id=offer.community_id AND slot.post_id=offer.post_id AND slot.status='open' AND slot.target->>'offer_id'=offer.offer_id AND slot.target->>'pool_leg_id'=leg.leg_id
 WHERE policy.review_policy->>'admission'='money_admitted' AND binding->>'qualification_policy_id'=policy.qualification_policy_version_id;
 RETURN jsonb_build_object('nowMs',floor(extract(epoch FROM now_at)*1000)::BIGINT,'accountFenceRevision',f.revision,
 'accountId',p_actor,'personaId',p_command->>'persona_id','communityId',ref.community_id,'songPostId',ref.song_post_id,
 'audioRevision',ref.audio_revision,'choreographyId',ref.choreography_id,'choreographyRevision',ref.revision,
 'segmentId',ref.segment_id,'bodyDurationMs',seg.duration_ms,'timezone',zone.timezone,
 'timezoneVersion',to_char(zone.timezone_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'policyId',policy.policy_id,'policy',policy.review_policy,'profile',policy.operational_profile,
 'safetyPolicy',disclosure.safety_policy_snapshot,'disposition',policy.disposition_profile,
 'mediaReady',moderated_dance_public_replay_ready_v1(policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',policy.operational_profile->>'replayKeyEpoch') AND EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 ready WHERE ready.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND ready.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND ready.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND ready.observed_at<=now_at AND ready.valid_until>now_at),
 'objectives',coalesce(objectives,'[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION apply_moderated_dance_intake_v1(p_actor TEXT,p_command JSONB,p_hash TEXT,p_receipt TEXT,p_terms JSONB,p_upload TEXT,p_object TEXT)
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operation TEXT:=p_command->>'operation'; s dance_moderated_sessions_v1; profile JSONB; now_at TIMESTAMPTZ:=clock_timestamp();
 f dance_review_account_fences_v1; consent dance_moderated_consents_v1; u dance_moderated_uploads_v1; result JSONB; deadline TIMESTAMPTZ;
BEGIN
 -- Same-key replay must have been resolved by the retained transaction BEFORE
 -- clock/policy/processing guards. Recheck under the same owned command lock.
 result:=lock_moderated_dance_intake_command_v1(p_actor,p_command);
 IF result IS NOT NULL THEN
  IF result->>'requestHash' IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'command key conflict' USING ERRCODE='DRV03'; END IF;
  RETURN result->'receipt';
 END IF;
 IF operation='create' THEN
  -- Re-read original authority; terms were built from this exact locked snapshot.
  result:=load_moderated_dance_creation_facts_v1(p_actor,p_command);
  profile:=p_terms->'profile';
  IF moderated_dance_capture_mode_valid_v2(p_terms->'capture') IS NOT TRUE
  OR p_terms->>'version' IS DISTINCT FROM (CASE result->'policy'->>'version'
    WHEN 'moderator-review-policy-v1' THEN 'dance-moderated-capture-terms-v1'
    WHEN 'moderator-review-policy-v2' THEN 'dance-moderated-capture-terms-v2' END)
  OR p_terms->'capture'->'bodyStartMs' IS DISTINCT FROM profile->'bodyStartMs'
  OR p_terms->'capture'->'cueStartMs' IS DISTINCT FROM profile->'cueStartMs'
  OR p_terms->'capture'->'cueEndMs' IS DISTINCT FROM profile->'cueEndMs'
  OR p_terms->'capture'->'cueHoldMs' IS DISTINCT FROM profile->'cueHoldMs'
  OR (result->>'mediaReady')::BOOLEAN IS DISTINCT FROM TRUE OR profile IS DISTINCT FROM result->'profile' OR p_terms->'capture'->'policy' IS DISTINCT FROM result->'policy'
  OR p_terms->'capture'->'objectives' IS DISTINCT FROM result->'objectives'
  OR p_terms->'safety_policy' IS DISTINCT FROM result->'safetyPolicy' OR p_terms->'disposition' IS DISTINCT FROM result->'disposition'
  OR p_terms->>'policy_id' IS DISTINCT FROM result->>'policyId'
  OR p_terms->'capture'->>'segmentId' IS DISTINCT FROM result->>'segmentId'
  OR p_terms->'capture'->'audioRevision' IS DISTINCT FROM result->'audioRevision'
  OR p_terms->'capture'->'accountFenceRevision' IS DISTINCT FROM result->'accountFenceRevision'
  OR p_terms->'capture'->>'timezone' IS DISTINCT FROM result->>'timezone' OR p_terms->'capture'->>'timezoneVersion' IS DISTINCT FROM result->>'timezoneVersion'
  OR (p_terms->'capture'->>'bodyEndMs')::NUMERIC-(p_terms->'capture'->>'bodyStartMs')::NUMERIC IS DISTINCT FROM (result->>'bodyDurationMs')::NUMERIC
  OR (p_terms->'capture'->>'captureExpiresAtMs')::NUMERIC IS DISTINCT FROM (p_terms->>'created_at_ms')::NUMERIC+(profile->>'sessionTtlMs')::NUMERIC
  OR least((p_terms->'disposition'->>'validUntilMs')::NUMERIC,(p_terms->'disposition'->'hold'->>'disposeByMs')::NUMERIC)<
    (p_terms->'capture'->>'captureExpiresAtMs')::NUMERIC+604800000+greatest((p_terms->'disposition'->>'cleanupWithinMs')::NUMERIC,(p_terms->'disposition'->>'temporaryCleanupWithinMs')::NUMERIC,(p_terms->'disposition'->>'transferWithinMs')::NUMERIC)
  OR p_terms->'capture'->>'accountId' IS DISTINCT FROM p_actor OR p_terms->'capture'->>'personaId' IS DISTINCT FROM p_command->>'persona_id'
  OR p_terms->'capture'->>'communityId' IS DISTINCT FROM p_command->>'community_id'
  OR p_terms->'capture'->>'songPostId' IS DISTINCT FROM p_command->>'song_post_id'
  OR (p_terms->>'created_at_ms')::NUMERIC>extract(epoch FROM now_at)*1000
  OR p_terms->'capture'->>'choreographyId' IS DISTINCT FROM p_command->>'choreography_id'
  OR (p_terms->'capture'->>'choreographyRevision')::BIGINT IS DISTINCT FROM (p_command->>'choreography_revision')::BIGINT THEN
   RAISE EXCEPTION 'capture authority changed' USING ERRCODE='DRV05';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-global-intake-capacity-v1',0));
  IF (SELECT count(*) FROM dance_moderated_sessions_v1 current_session WHERE current_session.account_id=p_actor AND (current_session.state<>'terminal' OR EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 upload WHERE upload.session_id=current_session.session_id AND (upload.state='unknown' OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 disposition WHERE disposition.upload_id=upload.upload_id AND disposition.state<>'completed') OR EXISTS(SELECT 1 FROM dance_moderated_processing_v1 processing WHERE processing.upload_id=upload.upload_id AND processing.state IN('claimed','unknown') AND processing.completed_at IS NULL))))) >= (profile->>'maximumPendingMediaPerAccount')::BIGINT
  OR (SELECT count(*) FROM dance_moderated_sessions_v1 current_session WHERE current_session.state<>'terminal' OR EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 upload WHERE upload.session_id=current_session.session_id AND (upload.state='unknown' OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 disposition WHERE disposition.upload_id=upload.upload_id AND disposition.state<>'completed') OR EXISTS(SELECT 1 FROM dance_moderated_processing_v1 processing WHERE processing.upload_id=upload.upload_id AND processing.state IN('claimed','unknown') AND processing.completed_at IS NULL)))) >= (profile->>'maximumPendingMediaGlobal')::BIGINT THEN RETURN jsonb_build_object('refusal','capacity_unavailable'); END IF;
  IF NOT charge_moderated_dance_intake_v1(p_actor,profile,FALSE,TRUE) THEN RETURN jsonb_build_object('refusal','rate_limited'); END IF;
  IF (SELECT count(*) FROM dance_moderated_active_slots_v1 WHERE account_id=p_actor)>=(profile->>'maximumActiveSessions')::BIGINT
  OR EXISTS(SELECT 1 FROM dance_moderated_active_slots_v1 WHERE account_id=p_actor AND choreography_id=p_command->>'choreography_id' AND choreography_revision=(p_command->>'choreography_revision')::BIGINT)
  OR (SELECT count(*) FROM dance_moderated_reviews_v1 WHERE community_id=p_command->>'community_id' AND status IN('screening','awaiting_review'))>=(profile->>'maximumOwnerPendingReviews')::BIGINT THEN
   RETURN jsonb_build_object('refusal','capacity_unavailable');
  END IF;
  SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=p_actor;
  INSERT INTO dance_moderated_sessions_v1(session_id,review_id,attempt_id,account_id,persona_id,community_id,song_post_id,choreography_id,choreography_revision,policy_id,capture_account_fence,terms,terms_hash,created_at,expires_at,state)
  VALUES(p_terms->>'session_id',p_terms->'capture'->>'reviewId',p_terms->'capture'->>'attemptId',p_actor,p_command->>'persona_id',p_command->>'community_id',p_command->>'song_post_id',p_command->>'choreography_id',(p_command->>'choreography_revision')::BIGINT,p_terms->>'policy_id',f.revision,p_terms,p_terms->>'terms_hash',to_timestamp((p_terms->>'created_at_ms')::NUMERIC/1000),to_timestamp((p_terms->'capture'->>'captureExpiresAtMs')::NUMERIC/1000),'created') RETURNING * INTO s;
  INSERT INTO dance_moderated_active_slots_v1 VALUES(p_actor,s.choreography_id,s.choreography_revision,s.session_id);
 ELSE
  SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=p_command->>'session_id' FOR UPDATE;
  profile:=s.terms->'profile';
  IF NOT charge_moderated_dance_intake_v1(p_actor,profile,FALSE,FALSE) THEN RETURN jsonb_build_object('refusal','rate_limited'); END IF;
  IF s.terms_hash IS DISTINCT FROM p_command->>'terms_hash' THEN RETURN jsonb_build_object('refusal','terms_changed'); END IF;
  IF now_at>=s.expires_at OR s.state='terminal' OR EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision) THEN RETURN jsonb_build_object('refusal','capture_closed'); END IF;
  SELECT * INTO consent FROM dance_moderated_consents_v1 WHERE session_id=s.session_id;
  IF operation='consent' THEN
   IF ROW(p_command->>'consent_version',p_command->>'consent_hash',p_command->>'retention_hash') IS DISTINCT FROM ROW(s.terms->'capture'->'policy'->>'consentVersion',s.terms->'capture'->'policy'->>'consentHash',s.terms->'capture'->'policy'->>'retentionHash') THEN RETURN jsonb_build_object('refusal','consent_changed'); END IF;
   IF consent.session_id IS NULL THEN
    INSERT INTO dance_moderated_consents_v1 VALUES(s.session_id,p_receipt,p_actor,s.persona_id,s.terms_hash,p_command->>'consent_version',p_command->>'consent_hash',p_command->>'retention_hash',now_at);
    UPDATE dance_moderated_sessions_v1 SET state='consented' WHERE session_id=s.session_id;
   END IF;
  ELSIF operation='reserve' THEN
   IF consent.session_id IS NULL THEN RETURN jsonb_build_object('refusal','consent_required'); END IF;
   SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE session_id=s.session_id FOR UPDATE;
   IF u.upload_id IS NOT NULL THEN
    IF ROW(u.content_type,u.expected_size_bytes,u.expected_duration_ms) IS DISTINCT FROM ROW(p_command->>'content_type',(p_command->>'size_bytes')::BIGINT,(p_command->>'duration_ms')::BIGINT) THEN RETURN jsonb_build_object('refusal','upload_conflict'); END IF;
   ELSE
    IF (p_command->>'size_bytes')::BIGINT NOT BETWEEN 1 AND (profile->>'maximumBytes')::BIGINT
     OR (p_command->>'duration_ms')::BIGINT IS DISTINCT FROM (s.terms->'capture'->>'bodyEndMs')::BIGINT
     OR p_command->>'content_type' NOT IN('video/mp4','video/quicktime')
     OR p_object !~ '^moderated-dance/ingress/[a-f0-9-]{36}/source$' THEN RETURN jsonb_build_object('refusal','invalid_upload'); END IF;
    deadline:=least(s.expires_at,now_at+((profile->>'uploadTtlMs')::BIGINT*interval '1 millisecond'));
    INSERT INTO dance_moderated_uploads_v1(upload_id,session_id,consent_receipt_id,private_object_key,content_type,maximum_bytes,expected_size_bytes,expected_duration_ms,reserved_at,expires_at,state)
    VALUES(p_upload,s.session_id,consent.receipt_id,p_object,p_command->>'content_type',(profile->>'maximumBytes')::BIGINT,(p_command->>'size_bytes')::BIGINT,(p_command->>'duration_ms')::BIGINT,now_at,deadline,'reserved');
    INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state) VALUES
     (p_upload,'ingress',jsonb_build_object('key',p_object,'version',NULL,'etag',NULL,'size',NULL),deadline,'held'),
     (p_upload,'original',jsonb_build_object('key','moderated-dance/originals/'||p_upload||'/source','version',NULL,'etag',NULL,'size',NULL),deadline,'held'),
     (p_upload,'derived',jsonb_build_object('frames',(SELECT jsonb_agg(jsonb_build_object('identity',jsonb_build_object('key','moderated-dance/derived/'||p_upload||'/frame-'||n||'.jpg','version',NULL,'etag',NULL,'size',NULL))) FROM generate_series(0,2) n)),deadline,'held');
    UPDATE dance_moderated_sessions_v1 SET state='awaiting_upload' WHERE session_id=s.session_id;
   END IF;
  ELSIF operation='finalize' THEN
   SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE session_id=s.session_id FOR UPDATE;
   IF u.upload_id IS DISTINCT FROM p_command->>'upload_id' OR consent.session_id IS NULL THEN RETURN jsonb_build_object('refusal','upload_unavailable'); END IF;
   -- This only queues a durable exact-source seal. No browser digest or
   -- duration becomes verified media. The worker owns sealing/analysis.
   IF u.state='reserved' AND now_at<u.expires_at THEN
    UPDATE dance_moderated_uploads_v1 SET state='sealing',seal_token=p_receipt WHERE upload_id=u.upload_id;
   ELSIF u.state NOT IN('sealing','sealed','unknown','held') THEN RETURN jsonb_build_object('refusal','upload_closed'); END IF;
  ELSE RAISE EXCEPTION 'invalid private operation' USING ERRCODE='DRV06';
  END IF;
 END IF;
 result:=jsonb_build_object('version','dance-moderated-intake-receipt-v1','receipt_id',p_receipt,'operation',operation,'session',project_moderated_dance_session_v1(s.session_id));
 INSERT INTO dance_moderated_intake_commands_v1(account_id,operation,idempotency_key,request_hash,community_id,session_id,receipt) VALUES(p_actor,operation,p_command->>'idempotency_key',p_hash,s.community_id,s.session_id,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION commit_moderated_dance_review_v1(p_input JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE a JSONB:=p_input->'action'; transition JSONB:=p_input->'transition'; next JSONB:=transition->'state';
 receipt JSONB:=p_input->'receipt'; r dance_moderated_reviews_v1; f dance_review_account_fences_v1;
 owner community_role_assignments; evidence dance_moderated_review_evidence_v1;
 item JSONB; q JSONB; old_intent JSONB; event_at TIMESTAMPTZ; terminal TIMESTAMPTZ;
 next_status TEXT:=next->>'state'; next_revision BIGINT:=(next->>'revision')::BIGINT;
 qualified TEXT; expected_evidence JSONB; worker BOOLEAN; account_active BOOLEAN;
BEGIN
 -- Re-enter the same locks/authorization, with no provider or external work.
 PERFORM lock_moderated_dance_review_v1(a);
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=a->>'reviewId' FOR UPDATE;
 SELECT * INTO STRICT f FROM dance_review_account_fences_v1 WHERE account_id=r.account_id FOR UPDATE;
 SELECT status='active' AND NOT f.erasing INTO account_active FROM users WHERE user_id=r.account_id;
 worker:=a->'actor'->>'kind'='worker' AND dance_review_worker_authorized_v1();
 IF ((p_input->>'beforeReviewRevision')::BIGINT=r.revision
   AND (p_input->>'beforePublicationRevision')::BIGINT=r.publication_revision
   AND (p_input->>'captureAccountFenceRevision')::BIGINT=(r.state->'capture'->>'accountFenceRevision')::BIGINT
   AND (p_input->>'observedAccountFenceRevision')::BIGINT=f.revision
   AND (p_input->>'observedAccountActive')::BOOLEAN=account_active
   AND next->'capture'=r.state->'capture' AND next->'reviewDeadlineMs'=r.state->'reviewDeadlineMs'
   AND receipt->>'review_id'=r.review_id AND receipt->>'operation'=a->>'operation'
   AND receipt->'result'->>'review_id'=r.review_id AND receipt->>'request_hash' IS NULL
   AND a->>'requestHash' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'review or lifecycle fence changed' USING ERRCODE='DRV05';
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_command_receipts_v1 c WHERE c.actor_kind=a->'actor'->>'kind'
   AND c.actor_id=a->'actor'->>'accountId' AND c.operation=a->>'operation' AND c.idempotency_key=a->>'idempotencyKey') THEN
  RAISE EXCEPTION 'command receipt already exists; reload original' USING ERRCODE='DRV03';
 END IF;
 IF (r.state->'initialSubmit')<>'null'::JSONB AND next->'initialSubmit' IS DISTINCT FROM r.state->'initialSubmit' THEN
  RAISE EXCEPTION 'initial submission is immutable' USING ERRCODE='DRV01';
 END IF;
 IF next IS DISTINCT FROM r.state THEN
  IF next_revision<>r.revision+1 AND NOT(worker AND next_revision=r.revision AND r.status='reviewed'
    AND a->>'operation' IN('erase','publication_failed') AND next_status=r.status
    AND (next->>'publicationRevision')::BIGINT=r.publication_revision+1
    AND (next-'publication'-'publicationRevision')=(r.state-'publication'-'publicationRevision')) THEN
   RAISE EXCEPTION 'invalid review revision' USING ERRCODE='DRV05';
  END IF;
  IF r.status NOT IN('uploaded','screening','awaiting_review') AND
    (next_status IS DISTINCT FROM r.status OR next->'verdict' IS DISTINCT FROM r.state->'verdict'
      OR next->'qualificationRef' IS DISTINCT FROM r.state->'qualificationRef'
      OR next->'attestation' IS DISTINCT FROM r.state->'attestation') THEN
   RAISE EXCEPTION 'terminal result is immutable' USING ERRCODE='DRV01';
  END IF;
 END IF;
 IF NOT account_active OR f.revision<>(r.state->'capture'->>'accountFenceRevision')::BIGINT THEN
  IF NOT worker OR a->>'operation' NOT IN('erase','publication_failed') THEN
   RAISE EXCEPTION 'account lifecycle changed' USING ERRCODE='DRV05';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(transition->'intents') x WHERE x->>'kind' NOT IN('cleanup_review','cleanup_temporary','handoff_cancel')) THEN
   RAISE EXCEPTION 'erasure cannot create review, qualification, notification or publication' USING ERRCODE='DRV05';
  END IF;
 END IF;
 terminal:=CASE WHEN next->>'terminalAtMs' IS NULL THEN NULL ELSE to_timestamp((next->>'terminalAtMs')::NUMERIC/1000) END;
 event_at:=CASE WHEN a->>'operation'='submit' AND r.submitted_at IS NULL
   THEN to_timestamp((next->>'submittedAtMs')::NUMERIC/1000) ELSE terminal END;
 IF next_status='reviewed' AND r.status<>'reviewed' THEN
  SELECT * INTO owner FROM community_role_assignments WHERE community_id=r.community_id AND role='owner' AND status='active' AND (SELECT count(*) FROM community_role_assignments sole WHERE sole.community_id=r.community_id AND sole.role='owner' AND sole.status='active')=1 FOR SHARE;
  SELECT * INTO evidence FROM dance_moderated_review_evidence_v1 WHERE review_id=r.review_id AND analysis_revision=(r.state->'capture'->>'analysisRevision')::BIGINT;
  IF (a->>'operation'='verdict' AND a->'actor'->>'kind'='account'
    AND owner.account_id=a->'actor'->>'accountId' AND owner.account_id<>r.account_id
    AND r.status='awaiting_review' AND terminal<r.review_deadline AND clock_timestamp()<r.review_deadline
    AND terminal>=r.uploaded_at AND terminal<=clock_timestamp()
    AND next->>'verdict' IN('passed','not_passed') AND evidence.safety_status='accepted'
    AND evidence.integrity_status='unique' AND can_account_view_content_rating_v1(owner.account_id,evidence.content_rating)
    AND moderated_dance_capture_mode_valid_v2(r.state->'capture')
    AND next->'attestation'->>'version'=CASE r.state->'capture'->'policy'->>'version'
      WHEN 'moderator-review-policy-v2' THEN 'dance-owner-verdict-attestation-v2'
      ELSE 'dance-owner-verdict-attestation-v1' END
    AND next->'attestation'->>'reviewerAccountId'=owner.account_id
    AND next->'attestation'->>'assignmentId'=owner.role_assignment_id
    AND (next->'attestation'->>'assignmentRevision')::BIGINT=owner.authority_revision
    AND next->'attestation'->>'sourceDigest'=r.state->'capture'->>'sourceDigest'
    AND next->'attestation'->>'rubricVersion'=r.state->'capture'->'policy'->>'rubricVersion'
    AND next->'attestation'->>'rubricHash'=r.state->'capture'->'policy'->>'rubricHash'
    AND next->'attestation'->>'termsHash'=r.state->'capture'->>'termsHash'
    AND next->'attestation'->>'cueId'=r.state->'capture'->>'cueId'
    AND (next->'attestation'->>'bodyStartMs')::BIGINT=(r.state->'capture'->>'bodyStartMs')::BIGINT
    AND (next->'attestation'->>'bodyEndMs')::BIGINT=(r.state->'capture'->>'bodyEndMs')::BIGINT
    AND next->'attestation'->>'cue'=CASE WHEN r.state->'capture'->'policy'->>'version'='moderator-review-policy-v2' THEN 'not_required' WHEN next->>'verdict'='passed' THEN 'affirmed' ELSE 'not_attested' END) IS NOT TRUE THEN
   RAISE EXCEPTION 'current owner, inspection or verdict deadline unavailable' USING ERRCODE='DRV05';
  END IF;
  INSERT INTO dance_moderated_verdict_audits_v1 VALUES(r.review_id,owner.account_id,owner.role_assignment_id,
    owner.authority_revision,next->>'verdict',next->'attestation',r.revision,next_revision,terminal);
 END IF;
 IF next->'initialSubmit'<>'null'::JSONB AND r.state->'initialSubmit'='null'::JSONB THEN
  IF (a->>'operation'='submit' AND a->'actor'->>'accountId'=r.account_id AND r.status='uploaded'
    AND event_at>=r.uploaded_at AND event_at<r.review_deadline AND clock_timestamp()<r.review_deadline
    AND next->'initialSubmit'->>'id'=a->>'receiptId'
    AND jsonb_typeof(next->'initialSubmit'->'showPublicly')='boolean'
    AND next->'initialSubmit'->>'disclosureVersion'=r.state->'capture'->'policy'->>'disclosureVersion') IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid immutable Submit' USING ERRCODE='DRV05';
  END IF;
 END IF;
 IF next_status='review_expired' THEN
  -- A supplied future timestamp cannot manufacture expiry. Account commands
  -- may expire an actually pending submitted review at the real deadline.
  IF terminal IS NULL OR terminal<r.review_deadline OR terminal>clock_timestamp() OR clock_timestamp()<r.review_deadline
   OR (r.status<>'review_expired' AND (r.status NOT IN('screening','awaiting_review') OR r.submitted_at IS NULL OR r.terminal_at IS NOT NULL))
   OR (r.status='review_expired' AND next IS DISTINCT FROM r.state) THEN
   RAISE EXCEPTION 'premature or invalid review expiry' USING ERRCODE='DRV05';
  END IF;
 END IF;
 UPDATE dance_moderated_reviews_v1 SET state=next,revision=next_revision,
  publication_revision=(next->>'publicationRevision')::BIGINT,status=next_status,
  submitted_at=CASE WHEN next->>'submittedAtMs' IS NULL THEN NULL ELSE to_timestamp((next->>'submittedAtMs')::NUMERIC/1000) END,
  terminal_at=terminal WHERE review_id=r.review_id;
 IF next->'showPublicly' IS DISTINCT FROM r.state->'showPublicly' THEN
  INSERT INTO dance_moderated_choice_changes_v1 VALUES(r.review_id,(next->>'choiceRevision')::BIGINT,
   a->'actor'->>'accountId',(r.state->>'showPublicly')::BOOLEAN,(next->>'showPublicly')::BOOLEAN,
   r.state->'capture'->'policy'->>'disclosureVersion',next_revision,coalesce(event_at,clock_timestamp()));
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(transition->'intents') LOOP
  IF (item->>'reviewId'=r.review_id
    AND (item->>'key')::JSONB=jsonb_build_array('dance-review-intent-v1',r.review_id,item->>'kind',(item->>'generation')::BIGINT)
    AND ((item->>'kind' IN('result','cleanup_review','hold_review','qualification') AND (item->>'generation')::BIGINT=0)
      OR (item->>'kind' IN('handoff_prepare','handoff_release') AND (item->>'generation')::BIGINT=(next->>'generation')::BIGINT AND (item->>'generation')::BIGINT>0)
      OR (item->>'kind' IN('handoff_cancel','cleanup_temporary') AND (item->>'generation')::BIGINT=(r.state->>'generation')::BIGINT AND (item->>'generation')::BIGINT>0))) IS NOT TRUE THEN
   RAISE EXCEPTION 'foreign review intent' USING ERRCODE='DRV05'; END IF;
  SELECT intent INTO old_intent FROM dance_moderated_review_intents_v1 WHERE intent_key=item->>'key';
  IF FOUND AND old_intent IS DISTINCT FROM item THEN RAISE EXCEPTION 'intent identity conflict' USING ERRCODE='DRV03'; END IF;
  INSERT INTO dance_moderated_review_intents_v1(intent_key,review_id,kind,generation,deadline_at,intent,status,attempts)
   VALUES(item->>'key',r.review_id,item->>'kind',(item->>'generation')::BIGINT,
    CASE WHEN item->>'deadlineMs' IS NULL THEN NULL ELSE to_timestamp((item->>'deadlineMs')::NUMERIC/1000) END,item,'pending',0)
   ON CONFLICT(intent_key) DO NOTHING;
  IF item->>'kind'='qualification' THEN
   IF qualified IS NOT NULL THEN RAISE EXCEPTION 'multiple qualifications' USING ERRCODE='DRV04'; END IF;
   q:=item->'qualification'; qualified:=q->>'id';
   IF (account_active AND next_status='reviewed' AND next->>'verdict'='passed'
    AND q->>'accountId'=r.account_id AND q->>'communityId'=r.community_id
    AND q->>'grading_mode'='moderator_verdict' AND q->>'verdict'='passed'
    AND jsonb_typeof(q->'score_bps')='null' AND jsonb_typeof(q->'calibration')='null'
    AND jsonb_typeof(q->'floor')='null' AND qualified=next->>'qualificationRef'
    AND q->>'admissionHash'=next->'capture'->'policy'->>'admissionHash'
    AND q->>'policyHash'=next->'capture'->'policy'->>'qualificationHash') IS NOT TRUE THEN
    RAISE EXCEPTION 'unadmitted categorical qualification' USING ERRCODE='DRV04'; END IF;
   expected_evidence:=jsonb_build_object('kind','dance_owner_verdict_v1','review_id',r.review_id,
    'grading_mode','moderator_verdict','verdict','passed','cue_attestation',next->'attestation'->>'cue',
    'policy_hash',next->'capture'->'policy'->>'qualificationHash','admission_hash',next->'capture'->'policy'->>'admissionHash',
    'submission_timezone',next->'capture'->>'timezone','submission_timezone_version',next->'capture'->>'timezoneVersion');
   INSERT INTO activity_qualifications(qualification_id,account_id,persona_id,community_id,post_id,audio_revision,
    activity_key,score_bps,qualification_policy_version_id,qualified_at,streak_day,evidence_summary,
    grading_mode,dance_review_id,categorical_verdict,calibration_id,numeric_floor_bps)
   VALUES(qualified,r.account_id,next->'capture'->>'personaId',r.community_id,next->'capture'->>'songPostId',
    (next->'capture'->>'audioRevision')::BIGINT,'dance',NULL,next->'capture'->'policy'->>'qualificationVersion',
    terminal,(next->'submissionDay'->>'day')::DATE,expected_evidence,'moderator_verdict',r.review_id,'passed',NULL,NULL);
  END IF;
 END LOOP;
 IF (next->>'qualificationRef') IS DISTINCT FROM qualified AND next->'qualificationRef' IS DISTINCT FROM r.state->'qualificationRef' THEN
  RAISE EXCEPTION 'qualification reference has no actual admitted insert' USING ERRCODE='DRV04'; END IF;
 IF r.terminal_at IS NULL AND terminal IS NOT NULL THEN
  UPDATE dance_moderated_sessions_v1 SET state='terminal' WHERE session_id=r.session_id;
  DELETE FROM dance_moderated_active_slots_v1 WHERE session_id=r.session_id;
  IF account_active AND next_status IN('reviewed','review_expired') THEN
   INSERT INTO dance_moderated_result_events_v1(event_id,review_id,recipient_account_id,outcome,review_revision,occurred_at)
   VALUES('dance-result:'||r.review_id,r.review_id,r.account_id,CASE next_status WHEN 'review_expired' THEN 'review_expired' ELSE next->>'verdict' END,next_revision,terminal);
  END IF;
 END IF;
 INSERT INTO dance_moderated_command_receipts_v1 VALUES(a->'actor'->>'kind',a->'actor'->>'accountId',
  a->>'operation',a->>'idempotencyKey',a->>'requestHash',r.review_id,r.community_id,receipt,clock_timestamp());
 RETURN jsonb_build_object('committed',TRUE,'qualificationId',qualified);
END $$;

CREATE OR REPLACE FUNCTION guard_activity_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  study_record study_sessions%ROWTYPE;
  study_v2_record RECORD;
  karaoke_session_record karaoke_sessions%ROWTYPE;
  karaoke_attempt_record karaoke_attempts%ROWTYPE;
  karaoke_policy_document JSONB;
  karaoke_policy_kind TEXT;
  expected_evidence JSONB;
  dance_record dance_moderated_reviews_v1;
  dance_policy qualification_policy_versions;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'activity qualifications are append-only';
  END IF;
  IF NEW.activity_key = 'dance' THEN
    SELECT * INTO dance_record FROM dance_moderated_reviews_v1 WHERE review_id=NEW.dance_review_id FOR SHARE;
    SELECT * INTO dance_policy FROM qualification_policy_versions WHERE qualification_policy_version_id=NEW.qualification_policy_version_id;
    expected_evidence:=jsonb_build_object('kind','dance_owner_verdict_v1','review_id',dance_record.review_id,
      'grading_mode','moderator_verdict','verdict','passed','cue_attestation',dance_record.state->'attestation'->>'cue',
      'policy_hash',dance_record.state->'capture'->'policy'->>'qualificationHash',
      'admission_hash',dance_record.state->'capture'->'policy'->>'admissionHash',
      'submission_timezone',dance_record.state->'capture'->>'timezone',
      'submission_timezone_version',dance_record.state->'capture'->>'timezoneVersion');
    IF (dance_record.status='reviewed' AND dance_record.state->>'verdict'='passed'
      AND moderated_dance_capture_mode_valid_v2(dance_record.state->'capture')
      AND dance_record.state->'attestation'->>'cue'=CASE dance_record.state->'capture'->'policy'->>'version'
        WHEN 'moderator-review-policy-v2' THEN 'not_required' ELSE 'affirmed' END
      AND dance_record.state->'attestation'->>'version'=CASE dance_record.state->'capture'->'policy'->>'version'
        WHEN 'moderator-review-policy-v2' THEN 'dance-owner-verdict-attestation-v2'
        ELSE 'dance-owner-verdict-attestation-v1' END
      AND dance_record.state->'capture'->'policy'->>'admission' IN('streak_admitted','money_admitted')
      AND (dance_record.state->'capture'->'policy'->>'version'<>'moderator-review-policy-v2'
        OR dance_policy.policy_document->>'opening_pose'='not_required')
      AND dance_policy.activity_key='dance' AND dance_policy.policy_kind='dance_owner_verdict_v1'
      AND dance_policy.policy_document->>'policy_hash'=dance_record.state->'capture'->'policy'->>'qualificationHash'
      AND NEW.grading_mode='moderator_verdict' AND NEW.categorical_verdict='passed'
      AND NEW.score_bps IS NULL AND NEW.calibration_id IS NULL AND NEW.numeric_floor_bps IS NULL
      AND NEW.qualification_id=dance_record.state->>'qualificationRef') IS NOT TRUE OR
      ROW(NEW.account_id,NEW.persona_id,NEW.community_id,NEW.post_id,NEW.audio_revision,
        NEW.qualification_policy_version_id,NEW.qualified_at,NEW.streak_day,NEW.evidence_summary)
      IS DISTINCT FROM ROW(dance_record.account_id,dance_record.state->'capture'->>'personaId',dance_record.community_id,
        dance_record.state->'capture'->>'songPostId',(dance_record.state->'capture'->>'audioRevision')::BIGINT,
        dance_record.state->'capture'->'policy'->>'qualificationVersion',dance_record.terminal_at,
        (dance_record.state->'submissionDay'->>'day')::DATE,expected_evidence) THEN
      RAISE EXCEPTION 'Dance qualification is not exact categorical reducer output' USING ERRCODE='DRV04';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.activity_key = 'study' THEN
    SELECT session.account_id, session.persona_id, session.community_id, session.post_id,
           session.audio_revision, session.qualification_policy_revision,
           session.timezone, session.status, session.completed_at,
           count(item.session_item_id)::bigint AS qualifying_exercise_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
           ))::bigint AS presented_count,
           count(item.session_item_id) FILTER (WHERE EXISTS (
             SELECT 1 FROM study_attempts_v2 attempt
              WHERE attempt.session_item_id=item.session_item_id
                AND attempt.attempt_number=1 AND attempt.outcome='correct'
           ))::bigint AS first_pass_correct
      INTO study_v2_record
     FROM study_sessions_v2 session
      JOIN study_session_items_v2 item ON item.session_id=session.session_id
     WHERE session.session_id=NEW.study_session_id
     GROUP BY session.session_id;
    IF study_v2_record.account_id IS NOT NULL THEN
      expected_evidence := jsonb_build_object(
        'kind', 'study_session_first_pass_v2',
        'qualifying_exercise_count', study_v2_record.qualifying_exercise_count,
        'first_pass_correct', study_v2_record.first_pass_correct,
        'required_correct', greatest(
          1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
        )
      );
      IF study_v2_record.status <> 'completed'
         OR study_v2_record.presented_count <> study_v2_record.qualifying_exercise_count
         OR study_v2_record.first_pass_correct < greatest(
           1, ceil((7 * study_v2_record.qualifying_exercise_count)::numeric / 10)::bigint
         )
         OR ROW(
           NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
           NEW.audio_revision, NEW.qualification_policy_version_id,
           NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
         ) IS DISTINCT FROM ROW(
           study_v2_record.account_id, study_v2_record.persona_id,
           study_v2_record.community_id, study_v2_record.post_id,
           study_v2_record.audio_revision, study_v2_record.qualification_policy_revision,
           ((10000 * study_v2_record.first_pass_correct)
             / study_v2_record.qualifying_exercise_count)::integer,
           study_v2_record.completed_at,
           (study_v2_record.completed_at AT TIME ZONE study_v2_record.timezone)::date,
           expected_evidence
         ) THEN
        RAISE EXCEPTION 'Study v2 qualification is not exact reducer output';
      END IF;
      RETURN NEW;
    END IF;

    SELECT * INTO study_record FROM study_sessions
     WHERE session_id = NEW.study_session_id FOR SHARE;
    expected_evidence := jsonb_build_object(
      'kind', 'study_session_first_pass_v2',
      'qualifying_exercise_count', study_record.qualifying_exercise_count,
      'first_pass_correct', study_record.first_pass_correct,
      'required_correct', study_record.required_correct
    );
    IF study_record.session_id IS NULL OR study_record.status <> 'completed'
       OR study_record.first_pass_correct < study_record.required_correct
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         study_record.account_id, study_record.persona_id,
         study_record.community_id, study_record.post_id,
         study_record.audio_revision, study_record.qualification_policy_version_id,
         study_record.score_bps, study_record.completed_at,
         study_record.streak_day, expected_evidence
       ) THEN
      RAISE EXCEPTION 'Study qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.activity_key = 'karaoke' THEN
    SELECT * INTO karaoke_session_record FROM karaoke_sessions
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT * INTO karaoke_attempt_record FROM karaoke_attempts
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT policy_kind, policy_document INTO karaoke_policy_kind, karaoke_policy_document
      FROM qualification_policy_versions
     WHERE qualification_policy_version_id = karaoke_session_record.qualification_policy_version_id
       AND activity_key = 'karaoke';
    IF karaoke_session_record.session_id IS NULL
       OR karaoke_session_record.status <> 'completed'
       OR karaoke_attempt_record.completion_reason <> 'completed'
       OR karaoke_attempt_record.scored_line_count < 5
       OR karaoke_attempt_record.coverage_bps < 8500
       OR karaoke_attempt_record.final_score_bps < 7000
       OR (
         karaoke_policy_kind = 'karaoke_qualification_v2'
         AND NOT (karaoke_policy_document->'eligible_playback_kinds'
           ? karaoke_session_record.playback_kind)
       )
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         karaoke_session_record.account_id, karaoke_session_record.persona_id,
         karaoke_session_record.community_id, karaoke_session_record.post_id,
         karaoke_session_record.audio_revision,
         karaoke_session_record.qualification_policy_version_id,
         karaoke_attempt_record.final_score_bps, karaoke_attempt_record.completed_at,
         (karaoke_attempt_record.completed_at AT TIME ZONE karaoke_session_record.timezone)::date,
         karaoke_attempt_record.evidence_summary
       ) THEN
      RAISE EXCEPTION 'Karaoke qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserved activities cannot produce qualifications';
END
$$;

CREATE OR REPLACE FUNCTION owner_moderated_dance_detail_v1(p_account TEXT,p_community TEXT,p_review TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; reference dance_moderator_reference_revisions_v1; c JSONB;
BEGIN
 IF NOT can_owner_read_moderated_dance_v1(p_account,p_review) THEN RETURN NULL; END IF;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
 IF r.community_id<>p_community THEN RETURN NULL; END IF;
 c:=r.state->'capture';
 SELECT * INTO STRICT reference FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=c->>'choreographyId' AND revision=(c->>'choreographyRevision')::BIGINT;
 RETURN jsonb_build_object('object','dance_owner_review','review',jsonb_build_object(
   'review_id',r.review_id,'review_revision',r.revision,'community_id',p_community,'song_post_id',c->>'songPostId',
   'choreography_id',c->>'choreographyId','choreography_revision',c->'choreographyRevision','segment_id',c->>'segmentId',
   'submitted_at',to_char(r.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'review_deadline',to_char(r.review_deadline AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'state','awaiting_review'),
  'reference_post_id',reference.reference_post_id,'video_render_revision',reference.video_render_revision,
  'cue',jsonb_build_object('id',c->>'cueId','start_ms',c->'cueStartMs','end_ms',c->'cueEndMs','hold_ms',c->'cueHoldMs'),
  'body',jsonb_build_object('start_ms',c->'bodyStartMs','end_ms',c->'bodyEndMs'),
  'rubric_version',c->'policy'->>'rubricVersion','rubric_hash',c->'policy'->>'rubricHash',
  'attestation_version',CASE c->'policy'->>'version' WHEN 'moderator-review-policy-v2' THEN 'dance-owner-verdict-attestation-v2' ELSE 'dance-owner-verdict-attestation-v1' END);
END $$;

CREATE OR REPLACE FUNCTION persist_moderated_dance_normalization_v1(p_upload TEXT,p_token TEXT,p_frames JSONB,p_claims JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE work dance_moderated_processing_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1;
 profile JSONB; claim JSONB; frame JSONB; old dance_moderated_replay_claims_v1; blocked BOOLEAN:=FALSE;
 normalized TEXT; until_at TIMESTAMPTZ; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media worker unavailable' USING ERRCODE='DRV02'; END IF;
 work:=lock_moderated_dance_processing_authority_v1(p_upload);
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 now_at:=clock_timestamp();
 SELECT * INTO STRICT work FROM dance_moderated_processing_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=p_upload FOR UPDATE;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=u.session_id;
 profile:=s.terms->'profile';
 IF NOT moderated_dance_public_replay_ready_v1(profile->>'replayScope',s.terms->'capture'->'policy'->>'normalizationHash',profile->>'replayKeyEpoch') THEN RAISE EXCEPTION 'known public replay index unavailable' USING ERRCODE='DRV07'; END IF;
 IF u.replay_retired_at IS NOT NULL OR EXISTS(SELECT 1 FROM dance_moderated_replay_retirements_v1 WHERE upload_id=p_upload)
 OR work.observation_token IS DISTINCT FROM p_token OR work.state NOT IN('claimed','unknown') OR work.provider_job_id IS NULL
 OR work.provider_deadline<=now_at OR jsonb_array_length(p_frames) IS DISTINCT FROM 3
 OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(profile->'replayCompatibleEpochs')
 OR (SELECT count(DISTINCT sample.value->>'index') FROM jsonb_array_elements(p_frames) AS sample(value))<>3 THEN RAISE EXCEPTION 'normalization authority unavailable' USING ERRCODE='DRV05'; END IF;
 IF (SELECT count(DISTINCT (c->>'epoch',c->>'kind')) FROM jsonb_array_elements(p_claims) c)<>jsonb_array_length(p_claims)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_claims) c WHERE (jsonb_typeof(c->'digest')='string' AND c->>'digest'~'^[a-f0-9]{64}$'
 AND c->>'kind' IN('raw','body') AND profile->'replayCompatibleEpochs' ? (c->>'epoch')) IS NOT TRUE) THEN
  RAISE EXCEPTION 'replay proof incomplete' USING ERRCODE='DRV06'; END IF;
 SELECT c->>'digest' INTO normalized FROM jsonb_array_elements(p_claims) c WHERE c->>'kind'='body' AND c->>'epoch'=profile->>'replayKeyEpoch';
 IF normalized IS NULL THEN RAISE EXCEPTION 'current replay proof missing' USING ERRCODE='DRV06'; END IF;
 until_at:=now_at+((profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond');
 -- Deterministic order and a UNIQUE global scope/epoch/kind/digest fence.
 -- Expiry does not authorize reuse here; only the reviewed retention drain may
 -- dispose a claim. Account/key/persona/policy changes cannot free it.
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO old FROM dance_moderated_replay_claims_v1 WHERE scope=profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF old.source_id IS NOT NULL AND (old.source_kind<>'attempt' OR old.source_id<>p_upload) THEN blocked:=TRUE;
  ELSE INSERT INTO dance_moderated_replay_claims_v1 VALUES(profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','attempt',p_upload,until_at,now_at) ON CONFLICT DO NOTHING; END IF;
 END LOOP;
 IF u.server_sha256=(SELECT reference_digest FROM dance_moderator_reference_revisions_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision) THEN blocked:=TRUE; END IF;
 FOR frame IN SELECT value FROM jsonb_array_elements(p_frames) LOOP
  IF (jsonb_typeof(frame->'index')='number' AND (frame->>'index')::INTEGER BETWEEN 0 AND 2
   AND frame->>'sha256'~'^[a-f0-9]{64}$' AND (frame->>'timestampMs')::BIGINT=CASE (frame->>'index')::INTEGER WHEN 0 THEN 0 WHEN 1 THEN CASE WHEN profile->>'version'='dance-moderated-intake-profile-v2' THEN floor((s.terms->'capture'->>'bodyEndMs')::NUMERIC/4) ELSE floor((s.terms->'capture'->>'bodyStartMs')::NUMERIC/2) END
    WHEN 2 THEN CASE WHEN profile->>'version'='dance-moderated-intake-profile-v2' THEN floor((s.terms->'capture'->>'bodyEndMs')::NUMERIC*3/4) ELSE floor(((s.terms->'capture'->>'bodyStartMs')::NUMERIC+(s.terms->'capture'->>'bodyEndMs')::NUMERIC)/2) END END
   AND frame->'identity'->>'key'='moderated-dance/derived/'||p_upload||'/frame-'||(frame->>'index')||'.jpg'
   AND (frame->'identity'->>'size')::BIGINT BETWEEN 1 AND (profile->>'maximumFrameBytes')::BIGINT
   AND length(frame->'identity'->>'version')>0 AND length(frame->'identity'->>'etag')>0) IS NOT TRUE THEN RAISE EXCEPTION 'private frame proof invalid' USING ERRCODE='DRV06'; END IF;
  IF EXISTS(SELECT 1 FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload AND frame_index=(frame->>'index')::INTEGER AND (object_identity IS DISTINCT FROM frame->'identity' OR sha256 IS DISTINCT FROM frame->>'sha256')) THEN RAISE EXCEPTION 'private frame changed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_frame_artifacts_v1 VALUES(p_upload,(frame->>'index')::INTEGER,frame->'identity',frame->>'sha256',(frame->>'timestampMs')::BIGINT,now_at) ON CONFLICT DO NOTHING;
 END LOOP;
 IF (SELECT count(*) FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=p_upload)<>3 THEN RAISE EXCEPTION 'private frames incomplete' USING ERRCODE='DRV06'; END IF;
 UPDATE dance_moderated_uploads_v1 SET state='sealed',sealed_at=bytes_sealed_at,normalized_digest=normalized,replay_expires_at=coalesce(replay_expires_at,until_at),
 normalization_version=s.terms->'capture'->'policy'->>'normalizationVersion',normalization_hash=s.terms->'capture'->'policy'->>'normalizationHash' WHERE upload_id=p_upload;
 UPDATE dance_moderated_processing_v1 SET result=jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END) WHERE upload_id=p_upload;
 INSERT INTO dance_moderated_media_dispositions_v1(upload_id,kind,identity,dispose_by,state,completed_at) VALUES(p_upload,'derived',jsonb_build_object('frames',p_frames),least(s.expires_at,now_at+((SELECT disposition_profile->>'temporaryCleanupWithinMs' FROM dance_review_policy_versions_v1 WHERE policy_id=s.policy_id)::BIGINT*interval '1 millisecond')),'held',NULL) ON CONFLICT(upload_id,kind) DO UPDATE SET identity=EXCLUDED.identity WHERE dance_moderated_media_dispositions_v1.claim_token IS NULL;
 RETURN jsonb_build_object('integrity',CASE WHEN blocked THEN 'blocked' ELSE 'unique' END);
END $$;

-- Replacements retain their existing ACLs. Only the two new pure helpers
-- need PUBLIC revocation; every function gets the same confined trusted path.
DO $paths$ DECLARE f RECORD; trusted TEXT:=current_schema(); BEGIN
 FOR f IN SELECT oid,proname,oid::regprocedure AS signature FROM pg_proc
 WHERE pronamespace=trusted::regnamespace AND proname IN(
 'moderated_dance_capture_mode_valid_v2','moderated_dance_policy_profile_matches_v2',
 'publish_moderated_dance_policy_v1','load_moderated_dance_creation_facts_v1',
 'apply_moderated_dance_intake_v1','commit_moderated_dance_review_v1',
 'guard_activity_qualification','owner_moderated_dance_detail_v1','persist_moderated_dance_normalization_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  IF f.proname IN('moderated_dance_capture_mode_valid_v2','moderated_dance_policy_profile_matches_v2') THEN
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  END IF;
 END LOOP;
END $paths$;
