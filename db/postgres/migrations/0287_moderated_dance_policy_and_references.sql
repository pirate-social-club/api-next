-- Prospective owner-only publication; never a browser permission toggle.
CREATE FUNCTION publish_moderated_dance_policy_v1(p_input JSONB) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE policy JSONB:=p_input->'policy'; existing dance_review_policy_versions_v1;
 profile JSONB:=p_input->'profile'; disposition JSONB:=p_input->'disposition'; q qualification_policy_versions;
BEGIN
 IF session_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='dance_review_policy_versions_v1'::regclass)) THEN RAISE EXCEPTION 'policy publication requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 IF (p_input->>'version'='dance-moderated-policy-publication-v1' AND length(p_input->>'accepted_by')>0
 AND length(p_input->>'acceptance_ref')>0 AND p_input->>'acceptance_hash'~'^[a-f0-9]{64}$'
 AND policy->>'version'='moderator-review-policy-v1' AND policy->>'hash'~'^[a-f0-9]{64}$'
 AND (policy->>'reviewWindowMs')::BIGINT=604800000 AND profile->>'version'='dance-moderated-intake-profile-v1'
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
 -- A future reviewed retention drain may retire obligations; timestamps alone
 -- do not delete claims or release outstanding references/captures.
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF EXISTS(SELECT 1 FROM dance_review_policy_versions_v1 prior_policy WHERE
  (EXISTS(SELECT 1 FROM dance_moderated_sessions_v1 session WHERE session.policy_id=prior_policy.policy_id AND session.state<>'terminal')
   OR EXISTS(SELECT 1 FROM dance_moderated_reference_commands_v1 command WHERE command.policy_id=prior_policy.policy_id AND command.state<>'failed')
   OR EXISTS(SELECT 1 FROM dance_moderated_replay_claims_v1 claim LEFT JOIN dance_moderated_uploads_v1 upload ON claim.source_kind='attempt' AND upload.upload_id=claim.source_id
     LEFT JOIN dance_moderated_sessions_v1 session ON session.session_id=upload.session_id
     LEFT JOIN dance_moderated_reference_commands_v1 command ON claim.source_kind='reference' AND command.choreography_id=claim.source_id
     WHERE coalesce(session.policy_id,command.policy_id)=prior_policy.policy_id))
  AND (prior_policy.operational_profile->>'replayScope' IS DISTINCT FROM profile->>'replayScope'
   OR prior_policy.review_policy->>'normalizationHash' IS DISTINCT FROM policy->>'normalizationHash'
   OR NOT (prior_policy.operational_profile->'replayCompatibleEpochs'<@profile->'replayCompatibleEpochs'))) THEN
  RAISE EXCEPTION 'retained replay family/epochs require compatible normalization' USING ERRCODE='DRV07';
 END IF;
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
 OR q.policy_document->>'admission_hash' IS DISTINCT FROM policy->>'admissionHash' THEN
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
-- A real reference producer starts from a currently published, verified
-- canonical-replacement master and its accepted PCM reference. No pose/model
-- artifact, browser digest, original-audio video or manually chosen alignment.
CREATE TABLE dance_moderated_reference_commands_v1 (
 account_id TEXT NOT NULL REFERENCES users(user_id), idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 community_id TEXT NOT NULL, song_post_id TEXT NOT NULL, persona_id TEXT NOT NULL,
 reference_post_id TEXT NOT NULL, master_revision_id TEXT NOT NULL REFERENCES media_song_video_masters,
 choreography_id TEXT NOT NULL UNIQUE, segment_id TEXT NOT NULL,
 policy_id TEXT NOT NULL REFERENCES dance_review_policy_versions_v1,
 state TEXT NOT NULL CHECK(state IN('pending','copying','normalizing','ready','unknown','failed')),
 work_token TEXT, observation_token TEXT, observation_until TIMESTAMPTZ, worker_deadline TIMESTAMPTZ,
 provider_tag TEXT UNIQUE, provider_job_id TEXT, normalization_claimed_at TIMESTAMPTZ,
 segment_identity JSONB, reference_terms_hash TEXT, result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,idempotency_key),UNIQUE(community_id,reference_post_id,master_revision_id)
);
CREATE TABLE dance_moderated_reference_receipts_v1 (
 account_id TEXT NOT NULL REFERENCES users(user_id), idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 choreography_id TEXT NOT NULL REFERENCES dance_moderated_reference_commands_v1(choreography_id),
 receipt JSONB NOT NULL, PRIMARY KEY(account_id,idempotency_key)
);
CREATE TRIGGER moderated_reference_receipt_immutable BEFORE UPDATE OR DELETE ON dance_moderated_reference_receipts_v1 FOR EACH ROW EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER moderated_reference_receipt_no_truncate BEFORE TRUNCATE ON dance_moderated_reference_receipts_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE FUNCTION create_moderated_dance_reference_v1(p_actor TEXT,p_command JSONB,p_hash TEXT,p_choreography TEXT,p_segment TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE prior dance_moderated_reference_commands_v1; replay dance_moderated_reference_receipts_v1; receipt JSONB; admission dance_review_policy_admissions_v1;
 policy dance_review_policy_versions_v1; reference RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_command->>'community_id',NULL,TRUE);
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('moderated-dance-reference-command-v1',p_actor,p_command->>'idempotency_key')::TEXT,0));
 SELECT * INTO replay FROM dance_moderated_reference_receipts_v1 WHERE account_id=p_actor AND idempotency_key=p_command->>'idempotency_key';
 IF replay.account_id IS NOT NULL THEN
  IF replay.request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'reference command conflict' USING ERRCODE='DRV03'; END IF;
  RETURN replay.receipt;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 IF NOT active_activity_persona(p_actor,p_command->>'persona_id',p_command->>'community_id') OR NOT can_account_access_activity_song(p_actor,p_command->>'community_id',p_command->>'song_post_id') THEN RAISE EXCEPTION 'reference unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT p.*,r.master_revision_id,plan.clip_start_samples,plan.clip_duration_samples INTO reference FROM posts p
 JOIN media_video_song_references r ON r.post_id=p.post_id AND r.song_community_id=p.community_id AND r.song_post_id=p_command->>'song_post_id'
 JOIN media_song_video_masters master ON master.master_revision_id=r.master_revision_id
 JOIN media_song_video_accepted_masters accepted ON accepted.master_revision_id=master.master_revision_id AND accepted.plan_id=master.plan_id
 JOIN media_song_video_render_plans plan ON plan.plan_id=master.plan_id AND plan.song_post_id=r.song_post_id AND plan.audio_revision=r.audio_revision
 JOIN media_publication_projections video ON video.community_id=p.community_id AND video.post_id=p.post_id AND video.media_kind='video' AND video.song_video_master_revision_id=master.master_revision_id AND video.canonical_video_sha256=master.master_sha256
 JOIN media_publication_projections song ON song.community_id=p.community_id AND song.post_id=r.song_post_id AND song.media_kind='song' AND song.audio_revision=r.audio_revision
 JOIN media_song_video_pcm_references pcm ON pcm.song_post_id=r.song_post_id AND pcm.audio_revision=r.audio_revision AND pcm.canonical_audio_sha256=song.canonical_audio_sha256 AND pcm.duration_samples=plan.song_duration_samples
 WHERE p.community_id=p_command->>'community_id' AND p.post_id=p_command->>'reference_post_id' AND p.post_type='video' AND p.status='published' AND p.visibility='public'
 AND can_account_view_content_rating_v1(p_actor,p.content_rating) AND plan.clip_start_samples%48=0 AND plan.clip_duration_samples%48=0 AND plan.clip_duration_samples BETWEEN 288000 AND 720000;
 IF reference.post_id IS NULL THEN RAISE EXCEPTION 'canonical playable reference unavailable' USING ERRCODE='DRV07'; END IF;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=p_command->>'community_id' FOR SHARE;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id FOR SHARE;
 IF admission.accepted IS DISTINCT FROM TRUE OR now_at<admission.effective_at OR now_at>=admission.valid_until OR now_at<policy.valid_from OR now_at>=policy.valid_until THEN RAISE EXCEPTION 'reference policy unavailable' USING ERRCODE='DRV07'; END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,FALSE,FALSE) THEN RAISE EXCEPTION 'reference work limit reached' USING ERRCODE='DRV07'; END IF;
 INSERT INTO dance_moderated_reference_commands_v1(account_id,idempotency_key,request_hash,community_id,song_post_id,persona_id,reference_post_id,master_revision_id,choreography_id,segment_id,policy_id,state)
 VALUES(p_actor,p_command->>'idempotency_key',p_hash,p_command->>'community_id',p_command->>'song_post_id',p_command->>'persona_id',reference.post_id,reference.master_revision_id,p_choreography,p_segment,policy.policy_id,'pending')
 ON CONFLICT(community_id,reference_post_id,master_revision_id) DO NOTHING;
 SELECT * INTO prior FROM dance_moderated_reference_commands_v1 WHERE community_id=p_command->>'community_id' AND reference_post_id=reference.post_id AND master_revision_id=reference.master_revision_id;
 receipt:=jsonb_build_object('version','dance-moderated-reference-v1','choreography_id',prior.choreography_id,'reference_post_id',prior.reference_post_id,'status',prior.state);
 INSERT INTO dance_moderated_reference_receipts_v1 VALUES(p_actor,p_command->>'idempotency_key',p_hash,prior.choreography_id,receipt);
 RETURN receipt;
END $$;
CREATE FUNCTION read_owned_moderated_dance_reference_v1(p_actor TEXT,p_community TEXT,p_post TEXT,p_choreography TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1; policy dance_review_policy_versions_v1;
BEGIN
 PERFORM authorize_moderated_dance_intake_v1(p_actor,p_community,NULL,FALSE);
 IF NOT can_account_access_activity_song(p_actor,p_community,p_post) THEN RETURN NULL; END IF;
 SELECT c.* INTO command FROM dance_moderated_reference_commands_v1 c
 WHERE c.choreography_id=p_choreography AND c.community_id=p_community AND c.song_post_id=p_post
 AND EXISTS(SELECT 1 FROM dance_moderated_reference_receipts_v1 receipt WHERE receipt.account_id=p_actor AND receipt.choreography_id=c.choreography_id);
 IF command.choreography_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,TRUE,FALSE) THEN RAISE EXCEPTION 'reference read limit reached' USING ERRCODE='DRV07'; END IF;
 RETURN jsonb_build_object('version','dance-moderated-reference-v1','choreography_id',command.choreography_id,'reference_post_id',command.reference_post_id,'status',command.state);
END $$;
CREATE TABLE dance_moderated_reference_sources_v1 (
 capability_sha256 TEXT PRIMARY KEY CHECK(capability_sha256~'^[a-f0-9]{64}$'),
 choreography_id TEXT NOT NULL REFERENCES dance_moderated_reference_commands_v1(choreography_id),
 work_token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE FUNCTION claim_moderated_dance_reference_media_v1(p_token TEXT,p_runtime TEXT,p_epochs JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; command dance_moderated_reference_commands_v1; profile JSONB; now_at TIMESTAMPTZ:=clock_timestamp(); packet JSONB;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference media worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT c.choreography_id,c.account_id INTO candidate FROM dance_moderated_reference_commands_v1 c JOIN dance_review_policy_versions_v1 p USING(policy_id)
 WHERE c.state IN('pending','copying','normalizing','unknown') AND (c.observation_until IS NULL OR c.observation_until<=now_at)
 AND (c.worker_deadline IS NULL OR c.worker_deadline>now_at) AND p.operational_profile->>'mediaRuntimeRevision'=p_runtime AND (p.operational_profile->'replayCompatibleEpochs')<@p_epochs
 ORDER BY c.created_at,c.choreography_id LIMIT 1;
 IF candidate.choreography_id IS NULL THEN RETURN NULL; END IF;
 PERFORM 1 FROM users WHERE user_id=candidate.account_id AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=candidate.choreography_id FOR UPDATE SKIP LOCKED;
 IF command.choreography_id IS NULL OR command.observation_until>now_at THEN RETURN NULL; END IF;
 SELECT operational_profile INTO profile FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 IF NOT active_activity_persona(command.account_id,command.persona_id,command.community_id) OR NOT can_account_access_activity_song(command.account_id,command.community_id,command.song_post_id) THEN RETURN NULL; END IF;
 IF command.state='pending' THEN
  IF NOT reserve_moderated_dance_provider_work_v1(command.account_id,profile) THEN RETURN NULL; END IF;
  UPDATE dance_moderated_reference_commands_v1 SET state='copying',work_token=p_token,provider_tag='dance-reference-'||choreography_id,
   worker_deadline=now_at+((profile->>'providerWaitMs')::BIGINT*interval '1 millisecond') WHERE choreography_id=command.choreography_id RETURNING * INTO command;
 END IF;
 UPDATE dance_moderated_reference_commands_v1 SET observation_token=p_token,observation_until=least(worker_deadline,now_at+((profile->>'workLeaseMs')::BIGINT*interval '1 millisecond')) WHERE choreography_id=command.choreography_id;
 SELECT jsonb_build_object('choreographyId',command.choreography_id,'segmentId',command.segment_id,'token',p_token,'state',command.state,
 'communityId',command.community_id,'songPostId',command.song_post_id,'referencePostId',command.reference_post_id,'masterRevisionId',command.master_revision_id,
 'profile',profile,'normalizationHash',policy.review_policy->>'normalizationHash',
 'source',jsonb_build_object('key',master.verified_object_key,'version',master.verified_object_version,'etag',master.verified_object_etag,'size',master.master_byte_length,'sha256',master.master_sha256),
 'pcm',jsonb_build_object('songPostId',pcm.song_post_id,'audioRevision',pcm.audio_revision,'canonicalAudioSha256',pcm.canonical_audio_sha256,'durationSamples',pcm.duration_samples,'objectKey',pcm.pcm_object_key,'objectVersion',pcm.pcm_object_version,'objectEtag',pcm.pcm_object_etag,'pcmSha256',pcm.pcm_sha256,'byteLength',pcm.pcm_byte_length,'decoderRecipe',pcm.decoder_recipe),
 'songSubmissionId',song.submission_id,'clipStartSamples',plan.clip_start_samples,'clipDurationSamples',plan.clip_duration_samples,
 'segmentIdentity',command.segment_identity,'providerTag',command.provider_tag,'providerJobId',command.provider_job_id,'normalizationClaimed',command.normalization_claimed_at IS NOT NULL,
 'deadlineMs',floor(extract(epoch FROM command.worker_deadline)*1000)::BIGINT)
 INTO packet FROM media_song_video_masters master JOIN media_song_video_render_plans plan USING(plan_id)
 JOIN media_song_video_accepted_masters accepted ON accepted.master_revision_id=master.master_revision_id AND accepted.plan_id=plan.plan_id
 JOIN media_publication_projections song ON song.community_id=command.community_id AND song.post_id=command.song_post_id AND song.media_kind='song' AND song.audio_revision=plan.audio_revision
 JOIN media_song_video_pcm_references pcm ON pcm.song_post_id=song.post_id AND pcm.audio_revision=song.audio_revision AND pcm.canonical_audio_sha256=song.canonical_audio_sha256 AND pcm.duration_samples=plan.song_duration_samples
 JOIN dance_review_policy_versions_v1 policy ON policy.policy_id=command.policy_id
 JOIN posts video ON video.community_id=command.community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 WHERE master.master_revision_id=command.master_revision_id;
 RETURN packet;
END $$;
CREATE FUNCTION record_moderated_dance_reference_provider_v1(p_choreography TEXT,p_token TEXT,p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 IF command.observation_token IS DISTINCT FROM p_token OR command.state NOT IN('copying','normalizing','unknown') OR command.normalization_claimed_at IS NULL THEN RAISE EXCEPTION 'reference purpose changed' USING ERRCODE='DRV05'; END IF;
 IF (jsonb_typeof(p_result)='object' AND p_result->>'status' IN('unknown','error')) IS NOT TRUE THEN RAISE EXCEPTION 'reference observation invalid' USING ERRCODE='DRV06'; END IF;
 IF p_result->>'status'='error' AND (p_result->>'id'=command.provider_job_id AND p_result->>'tag'=command.provider_tag) IS NOT TRUE THEN RAISE EXCEPTION 'reference provider identity changed' USING ERRCODE='DRV05'; END IF;
 UPDATE dance_moderated_reference_commands_v1 SET state=CASE WHEN p_result->>'status'='error' THEN 'failed' ELSE 'unknown' END,result=p_result,observation_until=NULL WHERE choreography_id=p_choreography;
 -- No purpose reset, charge refund, nonce inference, or provider erasure claim.
END $$;
CREATE FUNCTION persist_moderated_dance_reference_segment_v1(p_choreography TEXT,p_token TEXT,p_segment JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 IF command.observation_token IS DISTINCT FROM p_token OR command.worker_deadline<=clock_timestamp()
 OR (p_segment->>'segmentTermsHash'~'^[a-f0-9]{64}$' AND p_segment->>'segmentId'='seg-'||(p_segment->>'segmentTermsHash') AND p_segment->>'key'='moderated-dance/segments/'||(p_segment->>'segmentTermsHash')||'/canonical.wav' AND p_segment->>'sha256'~'^[a-f0-9]{64}$' AND (p_segment->>'size')::BIGINT>44 AND length(p_segment->>'version')>0 AND length(p_segment->>'etag')>0) IS NOT TRUE
 OR command.segment_identity IS NOT NULL AND command.segment_identity IS DISTINCT FROM p_segment THEN RAISE EXCEPTION 'canonical segment identity changed' USING ERRCODE='DRV05'; END IF;
 UPDATE dance_moderated_reference_commands_v1 SET segment_identity=p_segment,segment_id=p_segment->>'segmentId',state='normalizing' WHERE choreography_id=p_choreography;
END $$;
CREATE FUNCTION claim_moderated_dance_reference_normalization_v1(p_choreography TEXT,p_token TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 IF command.observation_token IS DISTINCT FROM p_token OR command.segment_identity IS NULL OR command.worker_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'reference normalization unavailable' USING ERRCODE='DRV05'; END IF;
 IF command.normalization_claimed_at IS NOT NULL THEN RETURN FALSE; END IF;
 UPDATE dance_moderated_reference_commands_v1 SET normalization_claimed_at=clock_timestamp() WHERE choreography_id=p_choreography;
 RETURN TRUE;
END $$;
CREATE FUNCTION attach_moderated_dance_reference_provider_v1(p_choreography TEXT,p_token TEXT,p_job TEXT,p_tag TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 UPDATE dance_moderated_reference_commands_v1 SET provider_job_id=p_job,observation_until=NULL WHERE choreography_id=p_choreography AND observation_token=p_token AND provider_tag=p_tag AND normalization_claimed_at IS NOT NULL AND (provider_job_id IS NULL OR provider_job_id=p_job);
 IF NOT FOUND THEN RAISE EXCEPTION 'reference provider identity changed' USING ERRCODE='DRV05'; END IF;
END $$;
CREATE FUNCTION issue_moderated_dance_reference_source_v1(p_choreography TEXT,p_token TEXT,p_digest TEXT) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 IF command.observation_token IS DISTINCT FROM p_token OR command.worker_deadline<=clock_timestamp() OR command.normalization_claimed_at IS NULL THEN RAISE EXCEPTION 'reference source unavailable' USING ERRCODE='DRV05'; END IF;
 INSERT INTO dance_moderated_reference_sources_v1 VALUES(p_digest,p_choreography,command.work_token,command.worker_deadline,NULL);
 RETURN floor(extract(epoch FROM command.worker_deadline)*1000)::BIGINT;
END $$;
CREATE FUNCTION resolve_moderated_dance_reference_source_v1(p_digest TEXT) RETURNS TABLE(physical_key TEXT,object_version TEXT,etag TEXT,size_bytes BIGINT,content_type TEXT,canonical_sha256 TEXT,expires_at TIMESTAMPTZ,identity_kind TEXT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT master.verified_object_key,master.verified_object_version,master.verified_object_etag,master.master_byte_length,'video/mp4',master.master_sha256,grant_row.expires_at,'content_etag'
 FROM dance_moderated_reference_sources_v1 grant_row JOIN dance_moderated_reference_commands_v1 command USING(choreography_id)
 JOIN media_song_video_masters master ON master.master_revision_id=command.master_revision_id
 JOIN posts video ON video.community_id=command.community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 WHERE grant_row.capability_sha256=p_digest AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp() AND grant_row.work_token=command.work_token AND command.state IN('normalizing','unknown') AND command.worker_deadline>clock_timestamp()
$$;
CREATE FUNCTION publish_moderated_dance_reference_v1(p_choreography TEXT,p_token TEXT,p_document JSONB,p_claims JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1; policy dance_review_policy_versions_v1; plan media_song_video_render_plans; master media_song_video_masters; song media_publication_projections; claim JSONB; prior dance_moderated_replay_claims_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 SELECT * INTO STRICT master FROM media_song_video_masters WHERE master_revision_id=command.master_revision_id;
 SELECT * INTO STRICT plan FROM media_song_video_render_plans WHERE plan_id=master.plan_id;
 SELECT * INTO STRICT song FROM media_publication_projections WHERE community_id=command.community_id AND post_id=command.song_post_id AND media_kind='song' AND audio_revision=plan.audio_revision;
 IF command.observation_token IS DISTINCT FROM p_token OR command.provider_job_id IS NULL OR command.worker_deadline<=clock_timestamp()
 OR command.segment_identity IS NULL OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(policy.operational_profile->'replayCompatibleEpochs')
 OR (p_document->>'referenceTermsHash'~'^[a-f0-9]{64}$' AND p_document->>'segmentTermsHash'~'^[a-f0-9]{64}$') IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM posts WHERE community_id=command.community_id AND post_id=command.reference_post_id AND status='published' AND visibility='public') THEN RAISE EXCEPTION 'reference publication unavailable' USING ERRCODE='DRV05'; END IF;
 IF command.state='ready' THEN IF command.reference_terms_hash IS DISTINCT FROM p_document->>'referenceTermsHash' THEN RAISE EXCEPTION 'reference terms changed' USING ERRCODE='DRV05'; END IF; RETURN; END IF;
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  IF (claim->>'digest'~'^[a-f0-9]{64}$' AND claim->>'kind' IN('raw','body') AND policy.operational_profile->'replayCompatibleEpochs' ? (claim->>'epoch')) IS NOT TRUE THEN RAISE EXCEPTION 'reference replay evidence invalid' USING ERRCODE='DRV06'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO prior FROM dance_moderated_replay_claims_v1 WHERE scope=policy.operational_profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF prior.source_id IS NOT NULL AND prior.source_kind<>'reference' THEN RAISE EXCEPTION 'reference recording already claimed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_replay_claims_v1 VALUES(policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','reference',p_choreography,clock_timestamp()+((policy.operational_profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond'),clock_timestamp()) ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO dance_song_segments(segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash)
 VALUES(command.segment_id,command.community_id,command.song_post_id,song.submission_id,plan.audio_revision,plan.clip_start_samples/48,(plan.clip_start_samples+plan.clip_duration_samples)/48,plan.song_duration_samples/48,command.segment_identity->>'key',command.segment_identity->>'sha256','canonical-pcm-excerpt-v1',song.canonical_audio_sha256,p_document->>'segmentTermsHash') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM dance_song_segments WHERE segment_id=command.segment_id AND community_id=command.community_id AND song_post_id=command.song_post_id AND audio_revision=plan.audio_revision AND start_ms=plan.clip_start_samples/48 AND end_ms=(plan.clip_start_samples+plan.clip_duration_samples)/48 AND canonical_segment_sha256=command.segment_identity->>'sha256' AND source_media_sha256=song.canonical_audio_sha256 AND segment_terms_hash=p_document->>'segmentTermsHash') THEN RAISE EXCEPTION 'canonical segment provenance conflict' USING ERRCODE='DRV05'; END IF;
 INSERT INTO dance_moderator_reference_revisions_v1(choreography_id,revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash)
 VALUES(p_choreography,1,command.community_id,command.song_post_id,plan.audio_revision,command.segment_id,command.reference_post_id,master.master_revision_id,master.master_sha256,
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','master_revision_id',master.master_revision_id,'plan_id',plan.plan_id,'source_sha256',master.master_sha256,'segment',command.segment_identity),
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','clip_start_samples',plan.clip_start_samples,'clip_duration_samples',plan.clip_duration_samples,'reference_body_start_ms',0,'reference_body_end_ms',plan.clip_duration_samples/48,'normalization_hash',policy.review_policy->>'normalizationHash'),p_document->>'referenceTermsHash');
 UPDATE dance_moderated_reference_commands_v1 SET state='ready',reference_terms_hash=p_document->>'referenceTermsHash',result=p_document,observation_until=NULL WHERE choreography_id=p_choreography;
 UPDATE dance_moderated_reference_sources_v1 SET revoked_at=clock_timestamp() WHERE choreography_id=p_choreography AND revoked_at IS NULL;
END $$;
DO $acl$
DECLARE f RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
 REVOKE ALL ON dance_moderated_reference_commands_v1,dance_moderated_reference_receipts_v1,dance_moderated_reference_sources_v1 FROM PUBLIC CASCADE;
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN('dance_moderated_reference_commands_v1'::regclass,'dance_moderated_reference_receipts_v1'::regclass,'dance_moderated_reference_sources_v1'::regclass) AND a.grantee NOT IN(0,c.relowner) LOOP EXECUTE format('REVOKE ALL ON dance_moderated_reference_commands_v1,dance_moderated_reference_receipts_v1,dance_moderated_reference_sources_v1 FROM %I CASCADE',r.name); END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname IN('publish_moderated_dance_policy_v1','create_moderated_dance_reference_v1','read_owned_moderated_dance_reference_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','resolve_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
