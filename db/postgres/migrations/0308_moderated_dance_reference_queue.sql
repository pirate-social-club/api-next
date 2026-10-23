-- Bound reference work from its original enqueue time, including time waiting
-- for access or account budget. Do not renew a provider/capture deadline on retry.
CREATE FUNCTION bound_moderated_dance_reference_queue_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE width BIGINT;
BEGIN
 IF NEW.state='pending' AND NEW.worker_deadline IS NULL THEN
  SELECT (operational_profile->>'providerWaitMs')::BIGINT INTO STRICT width
  FROM dance_review_policy_versions_v1 WHERE policy_id=NEW.policy_id;
  IF width IS NULL OR width<=0 THEN RAISE EXCEPTION 'reference work bound unavailable' USING ERRCODE='DRV07'; END IF;
  NEW.worker_deadline:=NEW.created_at+(width*interval '1 millisecond');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_reference_queue_bound_v1 BEFORE INSERT ON dance_moderated_reference_commands_v1
 FOR EACH ROW EXECUTE FUNCTION bound_moderated_dance_reference_queue_v1();

-- Older pending commands have no external grant yet. Bound them by their actual
-- creation time and original profile, retaining every historical receipt byte.
UPDATE dance_moderated_reference_commands_v1 c
 SET worker_deadline=c.created_at+((p.operational_profile->>'providerWaitMs')::BIGINT*interval '1 millisecond')
 FROM dance_review_policy_versions_v1 p WHERE p.policy_id=c.policy_id AND c.state='pending' AND c.worker_deadline IS NULL;

CREATE OR REPLACE FUNCTION claim_moderated_dance_reference_media_v1(p_token TEXT,p_runtime TEXT,p_epochs JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; command dance_moderated_reference_commands_v1; profile JSONB; now_at TIMESTAMPTZ:=clock_timestamp(); packet JSONB; actor_status TEXT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference media worker unavailable' USING ERRCODE='DRV02'; END IF;
 FOR candidate IN SELECT c.choreography_id,c.account_id FROM dance_moderated_reference_commands_v1 c JOIN dance_review_policy_versions_v1 p USING(policy_id)
 WHERE c.state IN('pending','copying','normalizing','unknown') AND (c.observation_until IS NULL OR c.observation_until<=now_at)
 AND p.operational_profile->>'mediaRuntimeRevision'=p_runtime AND (p.operational_profile->'replayCompatibleEpochs')<@p_epochs
 ORDER BY coalesce(c.observation_until,c.created_at),c.created_at,c.choreography_id LIMIT 20 LOOP
 -- Preserve actor-before-command lock ordering; a busy actor/command does not
 -- prevent this bounded pass from inspecting another due reference.
 SELECT status INTO actor_status FROM users WHERE user_id=candidate.account_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN CONTINUE; END IF;
 SELECT * INTO command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=candidate.choreography_id AND state IN('pending','copying','normalizing','unknown') FOR UPDATE SKIP LOCKED;
 now_at:=clock_timestamp();
 IF command.choreography_id IS NULL THEN CONTINUE; END IF;
 IF command.worker_deadline<=now_at THEN
  UPDATE dance_moderated_reference_commands_v1 SET state='failed',observation_token=NULL,observation_until=NULL,
   result=jsonb_build_object('reason','reference_work_expired') WHERE choreography_id=command.choreography_id;
  -- Original command receipts, provider identity and cleanup liabilities remain.
  CONTINUE;
 END IF;
 IF command.observation_until>now_at THEN CONTINUE; END IF;
 SELECT operational_profile INTO profile FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 -- A temporary gate or exhausted account budget cannot hold the queue head.
 -- Use the captured lease for retry, capped by the original absolute deadline.
 UPDATE dance_moderated_reference_commands_v1 SET observation_token=NULL,
  observation_until=least(worker_deadline,now_at+((profile->>'workLeaseMs')::BIGINT*interval '1 millisecond'))
 WHERE choreography_id=command.choreography_id;
 IF actor_status<>'active' THEN CONTINUE; END IF;
 IF NOT active_activity_persona(command.account_id,command.persona_id,command.community_id) OR NOT can_account_access_activity_song(command.account_id,command.community_id,command.song_post_id) THEN CONTINUE; END IF;
 PERFORM 1 FROM posts video JOIN communities vc ON vc.community_id=video.community_id AND vc.status='active'
 WHERE video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 AND EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,video.post_id) access WHERE access.non_age_allowed AND access.age_allowed) FOR SHARE OF video,vc;
 IF NOT FOUND THEN CONTINUE; END IF;
 now_at:=clock_timestamp();
 IF command.worker_deadline<=now_at THEN CONTINUE; END IF;
 IF command.state='pending' THEN
  IF NOT reserve_moderated_dance_provider_work_v1(command.account_id,profile) THEN CONTINUE; END IF;
  UPDATE dance_moderated_reference_commands_v1 SET state='copying',work_token=p_token,provider_tag='dance-reference-'||choreography_id WHERE choreography_id=command.choreography_id RETURNING * INTO command;
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
 JOIN posts video ON video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 WHERE master.master_revision_id=command.master_revision_id;
 IF packet IS NOT NULL THEN RETURN packet; END IF;
 END LOOP;
 RETURN NULL;
END $$;

DO $acl$ DECLARE f RECORD; trusted TEXT:=current_schema(); BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=trusted::regnamespace
 AND proname=ANY(ARRAY['bound_moderated_dance_reference_queue_v1','claim_moderated_dance_reference_media_v1']) LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
 END LOOP;
 REVOKE ALL ON FUNCTION bound_moderated_dance_reference_queue_v1() FROM PUBLIC;
END $acl$;
