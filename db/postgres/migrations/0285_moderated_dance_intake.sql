-- Prospective/unapplied. Private consent-gated capture; no provider, profile,
-- financial activation, role or credential is provisioned by this migration.
CREATE TABLE dance_moderated_policy_disclosures_v1 (
 policy_id TEXT PRIMARY KEY REFERENCES dance_review_policy_versions_v1,
 disclosure JSONB NOT NULL CHECK(jsonb_typeof(disclosure)='object'),
 safety_policy_snapshot JSONB NOT NULL CHECK(jsonb_typeof(safety_policy_snapshot)='object'),
 admission_receipt JSONB NOT NULL CHECK(jsonb_typeof(admission_receipt)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE dance_moderated_intake_commands_v1 (
 account_id TEXT NOT NULL REFERENCES users(user_id), operation TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 community_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES dance_moderated_sessions_v1,
 receipt JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,operation,idempotency_key)
);
CREATE TABLE dance_moderated_intake_usage_v1 (
 account_id TEXT NOT NULL REFERENCES users(user_id), window_start_ms BIGINT NOT NULL,
 window_ms BIGINT NOT NULL CHECK(window_ms>0), commands BIGINT NOT NULL CHECK(commands>=0),
 reads BIGINT NOT NULL CHECK(reads>=0), sessions BIGINT NOT NULL CHECK(sessions>=0),
 PRIMARY KEY(account_id,window_start_ms,window_ms)
);
ALTER TABLE dance_moderated_uploads_v1 ADD COLUMN expected_size_bytes BIGINT CHECK(expected_size_bytes>0),
 ADD COLUMN immutable_object_identity JSONB, ADD COLUMN seal_token TEXT,
 ADD COLUMN seal_dispatched_at TIMESTAMPTZ, ADD COLUMN bytes_sealed_at TIMESTAMPTZ;
CREATE TABLE dance_moderated_processor_readiness_v1 (
 runtime_revision TEXT NOT NULL, safety_revision TEXT NOT NULL, replay_epoch TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(runtime_revision,safety_revision,replay_epoch), CHECK(valid_until>observed_at)
);
CREATE TABLE dance_moderated_processing_v1 (
 upload_id TEXT PRIMARY KEY REFERENCES dance_moderated_uploads_v1,
 state TEXT NOT NULL CHECK(state IN('ready','claimed','unknown','screened','failed','held')),
 source_identity JSONB NOT NULL, account_fence BIGINT NOT NULL,
 work_token TEXT, provider_tag TEXT UNIQUE, provider_job_id TEXT,
 dispatched_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 charged_calls BIGINT NOT NULL DEFAULT 0 CHECK(charged_calls>=0),
 charged_spend_microunits NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK(charged_spend_microunits>=0),
 result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='ready')=(work_token IS NULL))
);
CREATE FUNCTION moderated_dance_account_runtime_v1() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT session_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_moderated_sessions_v1'::regclass))
 OR EXISTS(SELECT 1 FROM dance_moderated_runtime_roles_v1 r WHERE r.purpose='account' AND pg_has_role(session_user,r.role_oid,'MEMBER'))
$$;
CREATE FUNCTION authorize_moderated_dance_intake_v1(p_actor TEXT,p_community TEXT,p_session TEXT,p_write BOOLEAN)
 RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s dance_moderated_sessions_v1; f dance_review_account_fences_v1;
BEGIN
 IF NOT moderated_dance_account_runtime_v1() THEN RAISE EXCEPTION 'private Dance unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_write THEN
  PERFORM 1 FROM users WHERE user_id=p_actor AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'private Dance unavailable' USING ERRCODE='DRV02'; END IF;
  INSERT INTO dance_review_account_fences_v1(account_id,revision,erasing) VALUES(p_actor,1,FALSE) ON CONFLICT DO NOTHING;
  SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=p_actor FOR UPDATE;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM users WHERE user_id=p_actor AND status='active') THEN RAISE EXCEPTION 'private Dance unavailable' USING ERRCODE='DRV02'; END IF;
  SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=p_actor;
 END IF;
 IF f.erasing IS TRUE THEN RAISE EXCEPTION 'private Dance unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_session IS NOT NULL THEN
  SELECT * INTO s FROM dance_moderated_sessions_v1 WHERE session_id=p_session;
  IF s.session_id IS NULL OR s.account_id<>p_actor OR s.community_id<>p_community
    OR s.capture_account_fence IS DISTINCT FROM f.revision
    OR NOT active_activity_persona(p_actor,s.persona_id,p_community)
    OR NOT can_account_access_activity_song(p_actor,p_community,s.song_post_id) THEN
   RAISE EXCEPTION 'private Dance unavailable' USING ERRCODE='DRV02';
  END IF;
  IF p_write THEN PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=p_session FOR UPDATE; END IF;
 END IF;
END $$;
CREATE FUNCTION lock_moderated_dance_intake_command_v1(p_actor TEXT,p_command JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE existing dance_moderated_intake_commands_v1;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_command->>'community_id',p_command->>'session_id',TRUE);
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-intake-command-v1',p_actor,p_command->>'operation',p_command->>'idempotency_key')::TEXT,0));
 SELECT * INTO existing FROM dance_moderated_intake_commands_v1 WHERE account_id=p_actor AND operation=p_command->>'operation' AND idempotency_key=p_command->>'idempotency_key';
 IF existing.account_id IS NOT NULL THEN
  -- Authorization for the ORIGINAL resource precedes even immutable replay.
  PERFORM authorize_moderated_dance_intake_v1(p_actor,existing.community_id,existing.session_id,TRUE);
  RETURN jsonb_build_object('requestHash',existing.request_hash,'receipt',existing.receipt);
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION load_moderated_dance_creation_facts_v1(p_actor TEXT,p_command JSONB) RETURNS JSONB
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
 OR NOT EXISTS(SELECT 1 FROM posts p WHERE p.community_id=ref.community_id AND p.post_id=ref.reference_post_id AND p.post_type='video' AND p.status='published' AND p.visibility='public' AND can_account_view_content_rating_v1(p_actor,p.content_rating))
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
 OR policy.operational_profile->>'version' IS DISTINCT FROM 'dance-moderated-intake-profile-v1' THEN
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
 'mediaReady',EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 ready WHERE ready.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND ready.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND ready.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND ready.observed_at<=now_at AND ready.valid_until>now_at),
 'objectives',coalesce(objectives,'[]'::JSONB));
END $$;
CREATE FUNCTION project_moderated_dance_session_v1(p_session TEXT) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object('version','dance-moderated-session-v1','session_id',s.session_id,'review_id',s.review_id,'attempt_id',s.attempt_id,
 'community_id',s.community_id,'song_post_id',s.song_post_id,'choreography_id',s.choreography_id,'choreography_revision',s.choreography_revision,
 'terms_hash',s.terms_hash,'policy_hash',s.terms->'capture'->'policy'->>'hash',
 'consent_version',s.terms->'capture'->'policy'->>'consentVersion','consent_hash',s.terms->'capture'->'policy'->>'consentHash',
 'retention_hash',s.terms->'capture'->'policy'->>'retentionHash','normalization_version',s.terms->'capture'->'policy'->>'normalizationVersion',
 'normalization_hash',s.terms->'capture'->'policy'->>'normalizationHash','safety_hash',s.terms->'capture'->'policy'->>'safetyHash',
 'state',s.state,'created_at_ms',floor(extract(epoch FROM s.created_at)*1000)::BIGINT,'expires_at_ms',floor(extract(epoch FROM s.expires_at)*1000)::BIGINT,
 'body_start_ms',s.terms->'capture'->'bodyStartMs','body_end_ms',s.terms->'capture'->'bodyEndMs',
 'cue',jsonb_build_object('kind',s.terms->'capture'->>'cueId','start_ms',s.terms->'capture'->'cueStartMs','end_ms',s.terms->'capture'->'cueEndMs','hold_ms',s.terms->'capture'->'cueHoldMs'),
 'maximum_bytes',s.terms->'profile'->'maximumBytes','upload_id',u.upload_id,'upload_state',u.state,
 'uploaded_at_ms',CASE WHEN r.review_id IS NULL THEN NULL ELSE floor(extract(epoch FROM r.uploaded_at)*1000)::BIGINT END,
 'review_deadline_ms',CASE WHEN r.review_id IS NULL THEN NULL ELSE floor(extract(epoch FROM r.review_deadline)*1000)::BIGINT END,'score_bps',NULL)
 FROM dance_moderated_sessions_v1 s LEFT JOIN dance_moderated_uploads_v1 u USING(session_id)
 LEFT JOIN dance_moderated_reviews_v1 r USING(session_id) WHERE s.session_id=p_session
$$;
CREATE FUNCTION charge_moderated_dance_intake_v1(p_actor TEXT,p_profile JSONB,p_read BOOLEAN,p_session BOOLEAN) RETURNS BOOLEAN
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE width BIGINT:=(p_profile->>'windowMs')::BIGINT; at_ms BIGINT:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 bucket BIGINT; usage dance_moderated_intake_usage_v1;
BEGIN
 IF width IS NULL OR width<=0 OR (p_profile->>'maximumCommandsPerWindow')::BIGINT IS NULL
 OR (p_profile->>'maximumReadsPerWindow')::BIGINT IS NULL OR (p_profile->>'maximumSessionsPerWindow')::BIGINT IS NULL THEN
  RAISE EXCEPTION 'private Dance bounds unavailable' USING ERRCODE='DRV07';
 END IF;
 bucket:=(at_ms/width)*width;
 INSERT INTO dance_moderated_intake_usage_v1 VALUES(p_actor,bucket,width,0,0,0) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT usage FROM dance_moderated_intake_usage_v1 WHERE account_id=p_actor AND window_start_ms=bucket AND window_ms=width FOR UPDATE;
 IF (p_read AND usage.reads>=(p_profile->>'maximumReadsPerWindow')::BIGINT)
 OR (NOT p_read AND usage.commands>=(p_profile->>'maximumCommandsPerWindow')::BIGINT)
 OR (p_session AND usage.sessions>=(p_profile->>'maximumSessionsPerWindow')::BIGINT) THEN RETURN FALSE; END IF;
 UPDATE dance_moderated_intake_usage_v1 SET reads=reads+CASE WHEN p_read THEN 1 ELSE 0 END,
 commands=commands+CASE WHEN p_read THEN 0 ELSE 1 END,sessions=sessions+CASE WHEN p_session THEN 1 ELSE 0 END
 WHERE account_id=p_actor AND window_start_ms=bucket AND window_ms=width;
 RETURN TRUE;
END $$;
CREATE FUNCTION apply_moderated_dance_intake_v1(p_actor TEXT,p_command JSONB,p_hash TEXT,p_receipt TEXT,p_terms JSONB,p_upload TEXT,p_object TEXT)
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
  IF (result->>'mediaReady')::BOOLEAN IS DISTINCT FROM TRUE OR profile IS DISTINCT FROM result->'profile' OR p_terms->'capture'->'policy' IS DISTINCT FROM result->'policy'
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
CREATE FUNCTION read_owned_moderated_dance_session_v1(p_actor TEXT,p_community TEXT,p_session TEXT,p_upload TEXT,p_terms TEXT)
 RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s dance_moderated_sessions_v1; u dance_moderated_uploads_v1; remaining BIGINT;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_community,p_session,FALSE);
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=p_session;
 IF NOT charge_moderated_dance_intake_v1(p_actor,s.terms->'profile',TRUE,FALSE) THEN RETURN jsonb_build_object('refusal','rate_limited'); END IF;
 IF p_upload IS NULL THEN RETURN project_moderated_dance_session_v1(p_session); END IF;
 SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE session_id=p_session;
 IF u.upload_id IS DISTINCT FROM p_upload OR s.terms_hash IS DISTINCT FROM p_terms OR u.state<>'reserved'
 OR clock_timestamp()>=least(u.expires_at,s.expires_at) OR NOT EXISTS(SELECT 1 FROM dance_moderated_consents_v1 WHERE session_id=p_session)
 OR EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 WHERE choreography_id=s.choreography_id AND revision=s.choreography_revision) THEN
  RAISE EXCEPTION 'upload capability unavailable' USING ERRCODE='DRV02';
 END IF;
 remaining:=floor(extract(epoch FROM least(u.expires_at,s.expires_at)-clock_timestamp()))::BIGINT;
 RETURN jsonb_build_object('key',u.private_object_key,'contentType',u.content_type,'sizeBytes',u.expected_size_bytes,
 'expiresInSeconds',least((s.terms->'profile'->>'presignTtlSeconds')::BIGINT,remaining));
END $$;
CREATE TRIGGER moderated_dance_policy_disclosures_immutable BEFORE UPDATE OR DELETE ON dance_moderated_policy_disclosures_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_dance_policy_disclosures_no_truncate BEFORE TRUNCATE ON dance_moderated_policy_disclosures_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
-- Immutable command histories and non-resettable consumption.
CREATE TRIGGER moderated_dance_intake_receipt_immutable BEFORE UPDATE OR DELETE ON dance_moderated_intake_commands_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_dance_intake_receipt_no_truncate BEFORE TRUNCATE ON dance_moderated_intake_commands_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE FUNCTION guard_moderated_dance_intake_usage_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR ROW(NEW.account_id,NEW.window_start_ms,NEW.window_ms) IS DISTINCT FROM ROW(OLD.account_id,OLD.window_start_ms,OLD.window_ms)
 OR NEW.reads<OLD.reads OR NEW.commands<OLD.commands OR NEW.sessions<OLD.sessions THEN RAISE EXCEPTION 'private work is retained' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_dance_intake_usage_retained BEFORE UPDATE OR DELETE ON dance_moderated_intake_usage_v1 FOR EACH ROW EXECUTE FUNCTION guard_moderated_dance_intake_usage_v1();
CREATE TRIGGER moderated_dance_intake_usage_no_truncate BEFORE TRUNCATE ON dance_moderated_intake_usage_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE FUNCTION read_moderated_dance_capture_options_v1(p_actor TEXT,p_community TEXT,p_post TEXT,p_cursor TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE admission dance_review_policy_admissions_v1; policy dance_review_policy_versions_v1;
 disclosure dance_moderated_policy_disclosures_v1; entries JSONB; available BOOLEAN; code TEXT; now_at TIMESTAMPTZ:=clock_timestamp(); public_policy JSONB; anchor_id TEXT; anchor_revision BIGINT; item RECORD; count_items INTEGER:=0; more BOOLEAN:=FALSE; next_cursor TEXT;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_community,NULL,FALSE);
 IF NOT can_account_access_activity_song(p_actor,p_community,p_post) THEN RAISE EXCEPTION 'song unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=p_community;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id;
 SELECT * INTO disclosure FROM dance_moderated_policy_disclosures_v1 WHERE policy_id=policy.policy_id;
 IF admission.accepted IS DISTINCT FROM TRUE OR admission.effective_at>now_at OR admission.valid_until<=now_at OR policy.valid_from>now_at OR policy.valid_until<=now_at OR disclosure.policy_id IS NULL THEN
  RETURN jsonb_build_object('version','dance-moderated-capture-options-v1','community_id',p_community,'song_post_id',p_post,'ready',FALSE,'unavailable_code','policy_unavailable','policy',NULL,'choreographies','[]'::JSONB,'next_cursor',NULL);
 END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,TRUE,FALSE) THEN RAISE EXCEPTION 'capture read limit reached' USING ERRCODE='DRV07'; END IF;
 public_policy:=jsonb_build_object('policy_hash',policy.policy_hash,'consent_version',policy.review_policy->>'consentVersion','consent_hash',policy.review_policy->>'consentHash','retention_hash',policy.review_policy->>'retentionHash','publication_disclosure_version',policy.review_policy->>'disclosureVersion','disclosure',disclosure.disclosure);
 IF p_cursor IS NOT NULL THEN
  SELECT r.choreography_id,r.revision INTO anchor_id,anchor_revision FROM dance_moderator_reference_revisions_v1 r
   WHERE r.community_id=p_community AND r.song_post_id=p_post
   AND encode(sha256(convert_to(jsonb_build_array(p_actor,p_community,p_post,policy.policy_hash,r.choreography_id,r.revision)::TEXT,'UTF8')),'hex')=p_cursor;
  IF anchor_id IS NULL THEN RAISE EXCEPTION 'invalid capture cursor' USING ERRCODE='DRV06'; END IF;
 END IF;
 entries:='[]';
 FOR item IN SELECT r.*,seg.duration_ms,seg.start_ms,seg.end_ms FROM dance_moderator_reference_revisions_v1 r
 JOIN dance_song_segments seg USING(segment_id) JOIN posts reference ON reference.community_id=r.community_id AND reference.post_id=r.reference_post_id
 WHERE r.community_id=p_community AND r.song_post_id=p_post AND reference.status='published' AND reference.visibility='public'
 AND can_account_view_content_rating_v1(p_actor,reference.content_rating)
 AND (p_cursor IS NULL OR (r.choreography_id,r.revision)>(anchor_id,anchor_revision))
 AND NOT EXISTS(SELECT 1 FROM dance_moderator_reference_cutoffs_v1 c WHERE c.choreography_id=r.choreography_id AND c.revision=r.revision)
 ORDER BY r.choreography_id,r.revision LIMIT 21 LOOP
  count_items:=count_items+1; IF count_items=21 THEN more:=TRUE; EXIT; END IF;
  entries:=entries||jsonb_build_array(jsonb_build_object('choreography_id',item.choreography_id,'revision',item.revision,'reference_post_id',item.reference_post_id,'segment_id',item.segment_id,'audio_revision',item.audio_revision,
   'body_duration_ms',item.duration_ms,'canonical_song_start_ms',item.start_ms,'canonical_song_end_ms',item.end_ms,
   'reference_body_start_ms',0,'reference_body_end_ms',item.duration_ms,'reference_terms_hash',item.terms_hash));
  next_cursor:=encode(sha256(convert_to(jsonb_build_array(p_actor,p_community,p_post,policy.policy_hash,item.choreography_id,item.revision)::TEXT,'UTF8')),'hex');
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 r WHERE r.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND r.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND r.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND r.observed_at<=now_at AND r.valid_until>now_at) INTO available;
 code:=CASE WHEN NOT available THEN 'processor_unavailable' WHEN jsonb_array_length(entries)=0 THEN 'reference_unavailable' ELSE NULL END;
 RETURN jsonb_build_object('version','dance-moderated-capture-options-v1','community_id',p_community,'song_post_id',p_post,'ready',code IS NULL,'unavailable_code',code,'policy',public_policy,'choreographies',entries,'next_cursor',CASE WHEN more THEN next_cursor ELSE NULL END);
END $$;
DO $acl$
DECLARE f RECORD; t TEXT; recipient RECORD; trusted TEXT:=current_schema();
BEGIN
 FOREACH t IN ARRAY ARRAY['dance_moderated_intake_commands_v1','dance_moderated_intake_usage_v1','dance_moderated_processing_v1','dance_moderated_processor_readiness_v1','dance_moderated_policy_disclosures_v1'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC CASCADE',t);
  FOR recipient IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass(t) AND a.grantee NOT IN(0,c.relowner) LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I CASCADE',t,recipient.name);
  END LOOP;
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname IN(
 'moderated_dance_account_runtime_v1','authorize_moderated_dance_intake_v1','lock_moderated_dance_intake_command_v1','load_moderated_dance_creation_facts_v1','project_moderated_dance_session_v1','charge_moderated_dance_intake_v1','apply_moderated_dance_intake_v1','read_owned_moderated_dance_session_v1','guard_moderated_dance_intake_usage_v1','read_moderated_dance_capture_options_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR recipient IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,recipient.name);
  END LOOP;
 END LOOP;
END $acl$;
