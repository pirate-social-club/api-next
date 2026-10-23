-- Keep activity, review and qualification ownership on the canonical song.
-- The ordinary reference video has its own separately bound community.
ALTER TABLE dance_moderated_reference_commands_v1 ADD COLUMN reference_community_id TEXT;
ALTER TABLE dance_moderator_reference_revisions_v1 ADD COLUMN reference_community_id TEXT;
-- The old producer admitted only same-community references. Only the new
-- locator is populated; no captured document, digest or historical term changes.
UPDATE dance_moderated_reference_commands_v1 SET reference_community_id=community_id;
ALTER TABLE dance_moderator_reference_revisions_v1 DISABLE TRIGGER dance_moderator_reference_revisions_v1_immutable;
UPDATE dance_moderator_reference_revisions_v1 SET reference_community_id=community_id;
ALTER TABLE dance_moderator_reference_revisions_v1 ENABLE TRIGGER dance_moderator_reference_revisions_v1_immutable;
ALTER TABLE dance_moderated_reference_commands_v1 ALTER COLUMN reference_community_id SET NOT NULL;
ALTER TABLE dance_moderator_reference_revisions_v1 ALTER COLUMN reference_community_id SET NOT NULL;
DO $reference_fk$
DECLARE existing RECORD; matches INTEGER:=0;
BEGIN
 FOR existing IN SELECT c.conname FROM pg_constraint c
 WHERE c.conrelid='dance_moderator_reference_revisions_v1'::regclass AND c.contype='f'
 AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='community_id'),
  (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='reference_post_id')]::SMALLINT[] LOOP
  EXECUTE format('ALTER TABLE dance_moderator_reference_revisions_v1 DROP CONSTRAINT %I',existing.conname);
  matches:=matches+1;
 END LOOP;
 IF matches<>1 THEN RAISE EXCEPTION 'exact prior Dance reference foreign key required'; END IF;
END $reference_fk$;
ALTER TABLE dance_moderator_reference_revisions_v1 ADD CONSTRAINT moderated_reference_post_community_v1
 FOREIGN KEY(reference_community_id,reference_post_id) REFERENCES posts(community_id,post_id);
ALTER TABLE dance_moderated_reference_commands_v1 ADD CONSTRAINT moderated_reference_command_post_v1
 FOREIGN KEY(reference_community_id,reference_post_id) REFERENCES posts(community_id,post_id);
CREATE INDEX moderated_reference_post_community_v1 ON dance_moderator_reference_revisions_v1(reference_community_id,reference_post_id);
CREATE INDEX moderated_reference_command_post_v1 ON dance_moderated_reference_commands_v1(reference_community_id,reference_post_id);
CREATE FUNCTION guard_moderated_reference_community_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reference_community_id IS DISTINCT FROM OLD.reference_community_id THEN
  RAISE EXCEPTION 'Dance reference community is immutable' USING ERRCODE='DRV01';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER moderated_reference_community_immutable_v1 BEFORE UPDATE ON dance_moderated_reference_commands_v1
 FOR EACH ROW EXECUTE FUNCTION guard_moderated_reference_community_v1();

CREATE OR REPLACE FUNCTION create_moderated_dance_reference_v1(p_actor TEXT,p_command JSONB,p_hash TEXT,p_choreography TEXT,p_segment TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
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
 JOIN communities reference_community ON reference_community.community_id=p.community_id AND reference_community.status='active'
 JOIN media_video_song_references r ON r.post_id=p.post_id AND r.song_community_id=p_command->>'community_id' AND r.song_post_id=p_command->>'song_post_id'
 JOIN media_song_video_masters master ON master.master_revision_id=r.master_revision_id
 JOIN media_song_video_accepted_masters accepted ON accepted.master_revision_id=master.master_revision_id AND accepted.plan_id=master.plan_id
 JOIN media_song_video_render_plans plan ON plan.plan_id=master.plan_id AND plan.plan_id=r.plan_id AND plan.submission_id=r.submission_id AND plan.song_post_id=r.song_post_id AND plan.audio_revision=r.audio_revision
 JOIN media_publication_projections video ON video.community_id=p.community_id AND video.post_id=p.post_id AND video.media_kind='video' AND video.song_video_master_revision_id=master.master_revision_id AND video.canonical_video_sha256=master.master_sha256
 JOIN media_publication_projections song ON song.community_id=r.song_community_id AND song.post_id=r.song_post_id AND song.media_kind='song' AND song.audio_revision=r.audio_revision
 JOIN media_song_video_pcm_references pcm ON pcm.song_post_id=r.song_post_id AND pcm.audio_revision=r.audio_revision AND pcm.canonical_audio_sha256=song.canonical_audio_sha256 AND pcm.duration_samples=plan.song_duration_samples
 WHERE p.post_id=p_command->>'reference_post_id' AND p.author_user_id=p_actor
 AND plan.submission_id=video.submission_id AND r.submission_id=video.submission_id AND r.operation_id=video.operation_id
 AND EXISTS(SELECT 1 FROM video_detail_access_v1(p_actor,p.post_id) access WHERE access.non_age_allowed AND access.age_allowed) AND p.post_type='video' AND p.status='published' AND p.visibility='public'
 AND can_account_view_content_rating_v1(p_actor,p.content_rating) AND plan.clip_start_samples%48=0 AND plan.clip_duration_samples%48=0 AND plan.clip_duration_samples BETWEEN 288000 AND 1440000 FOR SHARE OF p,reference_community;
 IF reference.post_id IS NULL THEN RAISE EXCEPTION 'canonical playable reference unavailable' USING ERRCODE='DRV07'; END IF;
 SELECT * INTO admission FROM dance_review_policy_admissions_v1 WHERE community_id=p_command->>'community_id' FOR SHARE;
 SELECT * INTO policy FROM dance_review_policy_versions_v1 WHERE policy_id=admission.policy_id FOR SHARE;
 now_at:=clock_timestamp();
 IF admission.accepted IS DISTINCT FROM TRUE OR now_at<admission.effective_at OR now_at>=admission.valid_until OR now_at<policy.valid_from OR now_at>=policy.valid_until THEN RAISE EXCEPTION 'reference policy unavailable' USING ERRCODE='DRV07'; END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,policy.operational_profile,FALSE,FALSE) THEN RAISE EXCEPTION 'reference work limit reached' USING ERRCODE='DRV07'; END IF;
 INSERT INTO dance_moderated_reference_commands_v1(account_id,idempotency_key,request_hash,community_id,song_post_id,persona_id,reference_community_id,reference_post_id,master_revision_id,choreography_id,segment_id,policy_id,state)
 VALUES(p_actor,p_command->>'idempotency_key',p_hash,p_command->>'community_id',p_command->>'song_post_id',p_command->>'persona_id',reference.community_id,reference.post_id,reference.master_revision_id,p_choreography,p_segment,policy.policy_id,'pending')
 ON CONFLICT(community_id,reference_post_id,master_revision_id) DO NOTHING;
 SELECT * INTO prior FROM dance_moderated_reference_commands_v1 WHERE community_id=p_command->>'community_id' AND reference_post_id=reference.post_id AND master_revision_id=reference.master_revision_id;
 receipt:=jsonb_build_object('version','dance-moderated-reference-v1','choreography_id',prior.choreography_id,'reference_post_id',prior.reference_post_id,'status',prior.state);
 INSERT INTO dance_moderated_reference_receipts_v1 VALUES(p_actor,p_command->>'idempotency_key',p_hash,prior.choreography_id,receipt);
 RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION claim_moderated_dance_reference_media_v1(p_token TEXT,p_runtime TEXT,p_epochs JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
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
 now_at:=clock_timestamp();
 IF command.choreography_id IS NULL OR command.observation_until>now_at OR command.worker_deadline<=now_at THEN RETURN NULL; END IF;
 SELECT operational_profile INTO profile FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 IF NOT active_activity_persona(command.account_id,command.persona_id,command.community_id) OR NOT can_account_access_activity_song(command.account_id,command.community_id,command.song_post_id) THEN RETURN NULL; END IF;
 PERFORM 1 FROM posts video JOIN communities vc ON vc.community_id=video.community_id AND vc.status='active'
 WHERE video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 AND EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,video.post_id) access WHERE access.non_age_allowed AND access.age_allowed) FOR SHARE OF video,vc;
 IF NOT FOUND THEN RETURN NULL; END IF;
 now_at:=clock_timestamp();
 IF command.worker_deadline<=now_at THEN RETURN NULL; END IF;
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
 JOIN posts video ON video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 WHERE master.master_revision_id=command.master_revision_id;
 RETURN packet;
END $$;

CREATE OR REPLACE FUNCTION resolve_moderated_dance_reference_source_v1(p_digest TEXT) RETURNS TABLE(physical_key TEXT,object_version TEXT,etag TEXT,size_bytes BIGINT,content_type TEXT,canonical_sha256 TEXT,expires_at TIMESTAMPTZ,identity_kind TEXT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT master.verified_object_key,master.verified_object_version,master.verified_object_etag,master.master_byte_length,'video/mp4',master.master_sha256,grant_row.expires_at,'content_etag'
 FROM dance_moderated_reference_sources_v1 grant_row JOIN dance_moderated_reference_commands_v1 command USING(choreography_id)
 JOIN media_song_video_masters master ON master.master_revision_id=command.master_revision_id
 JOIN posts video ON video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 WHERE EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,video.post_id) access WHERE access.non_age_allowed AND access.age_allowed)
 AND grant_row.capability_sha256=p_digest AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp() AND grant_row.work_token=command.work_token AND command.state IN('normalizing','unknown') AND command.worker_deadline>clock_timestamp()
$$;

CREATE OR REPLACE FUNCTION publish_moderated_dance_reference_v1(p_choreography TEXT,p_token TEXT,p_document JSONB,p_claims JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE command dance_moderated_reference_commands_v1; policy dance_review_policy_versions_v1; plan media_song_video_render_plans; master media_song_video_masters; song media_publication_projections; claim JSONB; prior dance_moderated_replay_claims_v1;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'reference worker unavailable' USING ERRCODE='DRV02'; END IF;
 -- Intake locks the actor before the replay family. Match that order; a
 -- reference publication may not hold the global lock while awaiting its author.
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography;
 IF NOT active_activity_persona(command.account_id,command.persona_id,command.community_id)
 OR NOT can_account_access_activity_song(command.account_id,command.community_id,command.song_post_id) THEN RAISE EXCEPTION 'reference author unavailable' USING ERRCODE='DRV05'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT * INTO STRICT command FROM dance_moderated_reference_commands_v1 WHERE choreography_id=p_choreography FOR UPDATE;
 SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=command.policy_id;
 SELECT * INTO STRICT master FROM media_song_video_masters WHERE master_revision_id=command.master_revision_id;
 SELECT * INTO STRICT plan FROM media_song_video_render_plans WHERE plan_id=master.plan_id;
 PERFORM 1 FROM posts video JOIN communities vc ON vc.community_id=video.community_id AND vc.status='active'
 WHERE video.community_id=command.reference_community_id AND video.post_id=command.reference_post_id AND video.status='published' AND video.visibility='public'
 AND EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,video.post_id) access WHERE access.non_age_allowed AND access.age_allowed) FOR SHARE OF video,vc;
 IF NOT FOUND THEN RAISE EXCEPTION 'reference publication unavailable' USING ERRCODE='DRV05'; END IF;
 SELECT * INTO STRICT song FROM media_publication_projections WHERE community_id=command.community_id AND post_id=command.song_post_id AND media_kind='song' AND audio_revision=plan.audio_revision;
 IF command.observation_token IS DISTINCT FROM p_token OR command.provider_job_id IS NULL OR command.worker_deadline<=clock_timestamp()
 OR command.segment_identity IS NULL OR jsonb_array_length(p_claims) IS DISTINCT FROM 2*jsonb_array_length(policy.operational_profile->'replayCompatibleEpochs')
 OR (p_document->>'referenceTermsHash'~'^[a-f0-9]{64}$' AND p_document->>'segmentTermsHash'~'^[a-f0-9]{64}$') IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM posts WHERE community_id=command.reference_community_id AND post_id=command.reference_post_id AND status='published' AND visibility='public'
  AND EXISTS(SELECT 1 FROM video_detail_access_v1(command.account_id,command.reference_post_id) access WHERE access.non_age_allowed AND access.age_allowed)) THEN RAISE EXCEPTION 'reference publication unavailable' USING ERRCODE='DRV05'; END IF;
 IF jsonb_typeof(p_document->'publicFrames') IS DISTINCT FROM 'array' OR jsonb_array_length(p_document->'publicFrames') IS DISTINCT FROM ceil(plan.clip_duration_samples::NUMERIC/48000*(policy.operational_profile->>'normalizationFps')::NUMERIC)::INTEGER
 OR jsonb_array_length(p_document->'publicFrames') NOT BETWEEN 1 AND 3600
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_document->'publicFrames') frame WHERE jsonb_typeof(frame) IS DISTINCT FROM 'string' OR (frame#>>'{}')!~'^[a-f0-9]{64}$')
 OR (SELECT count(DISTINCT (c->>'epoch',c->>'kind')) FROM jsonb_array_elements(p_claims) c)<>jsonb_array_length(p_claims) THEN RAISE EXCEPTION 'public reference replay descriptor incomplete' USING ERRCODE='DRV06'; END IF;
 IF command.state='ready'  THEN IF command.reference_terms_hash IS DISTINCT FROM p_document->>'referenceTermsHash' THEN RAISE EXCEPTION 'reference terms changed' USING ERRCODE='DRV05'; END IF; RETURN; END IF;
 FOR claim IN SELECT c FROM jsonb_array_elements(p_claims) c ORDER BY c->>'epoch',c->>'kind',c->>'digest' LOOP
  IF (claim->>'digest'~'^[a-f0-9]{64}$' AND claim->>'kind' IN('raw','body') AND policy.operational_profile->'replayCompatibleEpochs' ? (claim->>'epoch')) IS NOT TRUE THEN RAISE EXCEPTION 'reference replay evidence invalid' USING ERRCODE='DRV06'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('dance-recording-replay-v1',policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest')::TEXT,0));
  SELECT * INTO prior FROM dance_moderated_replay_claims_v1 WHERE scope=policy.operational_profile->>'replayScope' AND key_epoch=claim->>'epoch' AND kind=claim->>'kind' AND digest=claim->>'digest';
  IF prior.source_id IS NOT NULL AND prior.source_kind<>'reference' THEN RAISE EXCEPTION 'reference recording already claimed' USING ERRCODE='DRV05'; END IF;
  INSERT INTO dance_moderated_replay_claims_v1 VALUES(policy.operational_profile->>'replayScope',claim->>'epoch',claim->>'kind',claim->>'digest','reference',p_choreography,clock_timestamp()+((policy.operational_profile->>'replayRetentionMs')::BIGINT*interval '1 millisecond'),clock_timestamp()) ON CONFLICT(scope,key_epoch,kind,digest) DO UPDATE SET expires_at=greatest(dance_moderated_replay_claims_v1.expires_at,EXCLUDED.expires_at);
 END LOOP;
 INSERT INTO dance_song_segments(segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash)
 VALUES(command.segment_id,command.community_id,command.song_post_id,song.submission_id,plan.audio_revision,plan.clip_start_samples/48,(plan.clip_start_samples+plan.clip_duration_samples)/48,plan.song_duration_samples/48,command.segment_identity->>'key',command.segment_identity->>'sha256','canonical-pcm-excerpt-v1',song.canonical_audio_sha256,p_document->>'segmentTermsHash') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM dance_song_segments WHERE segment_id=command.segment_id AND community_id=command.community_id AND song_post_id=command.song_post_id AND audio_revision=plan.audio_revision AND start_ms=plan.clip_start_samples/48 AND end_ms=(plan.clip_start_samples+plan.clip_duration_samples)/48 AND canonical_segment_sha256=command.segment_identity->>'sha256' AND source_media_sha256=song.canonical_audio_sha256 AND segment_terms_hash=p_document->>'segmentTermsHash') THEN RAISE EXCEPTION 'canonical segment provenance conflict' USING ERRCODE='DRV05'; END IF;
 INSERT INTO dance_moderator_reference_revisions_v1(choreography_id,revision,community_id,song_post_id,audio_revision,segment_id,reference_community_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash)
 VALUES(p_choreography,1,command.community_id,command.song_post_id,plan.audio_revision,command.segment_id,command.reference_community_id,command.reference_post_id,master.master_revision_id,master.master_sha256,
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','master_revision_id',master.master_revision_id,'plan_id',plan.plan_id,'source_sha256',master.master_sha256,'segment',command.segment_identity),
 jsonb_build_object('kind','verified_canonical_replacement_master_v1','clip_start_samples',plan.clip_start_samples,'clip_duration_samples',plan.clip_duration_samples,'reference_body_start_ms',0,'reference_body_end_ms',plan.clip_duration_samples/48,'normalization_hash',policy.review_policy->>'normalizationHash'),p_document->>'referenceTermsHash');
 INSERT INTO dance_moderated_public_replay_v1(choreography_id,revision,scope,normalization_hash,source_sha256,frames)
 VALUES(p_choreography,1,policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',master.master_sha256,p_document->'publicFrames');
 INSERT INTO dance_moderated_public_replay_indexes_v1(choreography_id,revision,key_epoch,claims,valid_until)
 SELECT p_choreography,1,e.value,jsonb_agg(proof.value),min(c.expires_at)
 FROM jsonb_array_elements_text(policy.operational_profile->'replayCompatibleEpochs') e(value)
 CROSS JOIN LATERAL jsonb_array_elements(p_claims) proof(value) JOIN dance_moderated_replay_claims_v1 c
 ON c.scope=policy.operational_profile->>'replayScope' AND c.key_epoch=e.value AND c.kind=proof.value->>'kind' AND c.digest=proof.value->>'digest'
 WHERE proof.value->>'epoch'=e.value GROUP BY e.value;
 UPDATE dance_moderated_reference_commands_v1 SET state='ready' ,reference_terms_hash=p_document->>'referenceTermsHash',result=p_document-'publicFrames',observation_until=NULL WHERE choreography_id=p_choreography;
 UPDATE dance_moderated_reference_sources_v1 SET revoked_at=clock_timestamp() WHERE choreography_id=p_choreography AND revoked_at IS NULL;
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
 'mediaReady',moderated_dance_public_replay_ready_v1(policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',policy.operational_profile->>'replayKeyEpoch') AND EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 ready WHERE ready.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND ready.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND ready.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND ready.observed_at<=now_at AND ready.valid_until>now_at),
 'objectives',coalesce(objectives,'[]'::JSONB));
END $$;

CREATE OR REPLACE FUNCTION read_moderated_dance_capture_options_v1(p_actor TEXT,p_community TEXT,p_post TEXT,p_cursor TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
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
 JOIN dance_song_segments seg USING(segment_id) JOIN posts reference ON reference.community_id=r.reference_community_id AND reference.post_id=r.reference_post_id
 JOIN communities reference_community ON reference_community.community_id=reference.community_id AND reference_community.status='active'
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
 SELECT moderated_dance_public_replay_ready_v1(policy.operational_profile->>'replayScope',policy.review_policy->>'normalizationHash',policy.operational_profile->>'replayKeyEpoch') AND EXISTS(SELECT 1 FROM dance_moderated_processor_readiness_v1 r WHERE r.runtime_revision=policy.operational_profile->>'mediaRuntimeRevision' AND r.safety_revision=policy.operational_profile->>'safetyProviderRevision' AND r.replay_epoch=policy.operational_profile->>'replayKeyEpoch' AND r.observed_at<=now_at AND r.valid_until>now_at) INTO available;
 code:=CASE WHEN NOT available THEN 'processor_unavailable' WHEN jsonb_array_length(entries)=0 THEN 'reference_unavailable' ELSE NULL END;
 RETURN jsonb_build_object('version','dance-moderated-capture-options-v1','community_id',p_community,'song_post_id',p_post,'ready',code IS NULL,'unavailable_code',code,'policy',public_policy,'choreographies',entries,'next_cursor',CASE WHEN more THEN next_cursor ELSE NULL END);
END $$;

CREATE OR REPLACE FUNCTION moderated_dance_public_replay_ready_v1(p_scope TEXT,p_normalization TEXT,p_epoch TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
 SELECT NOT EXISTS(SELECT 1 FROM dance_moderator_reference_revisions_v1 r JOIN posts p ON p.community_id=r.reference_community_id AND p.post_id=r.reference_post_id
 JOIN communities reference_community ON reference_community.community_id=p.community_id AND reference_community.status='active'
 WHERE p.status='published' AND p.visibility='public' AND r.alignment_evidence->>'normalization_hash'=p_normalization
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_public_replay_v1 d JOIN dance_moderated_public_replay_indexes_v1 i USING(choreography_id,revision)
 WHERE d.choreography_id=r.choreography_id AND d.revision=r.revision AND d.scope=p_scope AND d.normalization_hash=p_normalization
 AND i.key_epoch=p_epoch AND i.valid_until>clock_timestamp() AND jsonb_array_length(i.claims)=2
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.claims) c WHERE NOT EXISTS(
  SELECT 1 FROM dance_moderated_replay_claims_v1 claim WHERE claim.scope=d.scope AND claim.key_epoch=i.key_epoch
  AND claim.kind=c->>'kind' AND claim.digest=c->>'digest' AND claim.source_kind='reference' AND claim.expires_at>=i.valid_until))))
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 WHERE key_epoch=p_epoch)
$$;

CREATE OR REPLACE FUNCTION claim_moderated_dance_public_reindex_v1(p_token TEXT,p_epochs JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'public reindex unavailable' USING ERRCODE='DRV02'; END IF;
 IF (length(p_token) BETWEEN 1 AND 192) IS NOT TRUE OR jsonb_typeof(p_epochs) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'public reindex identity invalid' USING ERRCODE='DRV06'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('moderated-dance-replay-family-v1',0));
 SELECT d.*,q.key_epoch,q.retention_ms,q.lease_ms INTO candidate FROM dance_moderated_public_replay_v1 d
 JOIN moderated_dance_public_replay_requirements_v1() q ON q.scope=d.scope AND q.normalization_hash=d.normalization_hash
 JOIN dance_moderator_reference_revisions_v1 r USING(choreography_id,revision)
 JOIN posts p ON p.community_id=r.reference_community_id AND p.post_id=r.reference_post_id
 JOIN communities reference_community ON reference_community.community_id=p.community_id AND reference_community.status='active' AND p.status='published' AND p.visibility='public'
 LEFT JOIN dance_moderated_public_replay_indexes_v1 i ON i.choreography_id=d.choreography_id AND i.revision=d.revision AND i.key_epoch=q.key_epoch
 WHERE p_epochs ? q.key_epoch AND EXISTS(SELECT 1 FROM dance_moderated_replay_epochs_v1 e WHERE e.key_epoch=q.key_epoch)
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_replay_epoch_retirements_v1 e WHERE e.key_epoch=q.key_epoch)
 AND (i.work_until IS NULL OR i.work_until<=now_at) AND (i.valid_until IS NULL OR i.valid_until<=now_at+(q.lease_ms*interval '1 millisecond'))
 ORDER BY i.last_checked_at NULLS FIRST,d.created_at,d.choreography_id,d.revision,q.key_epoch LIMIT 1;
 IF candidate.choreography_id IS NULL THEN RETURN NULL; END IF;
 INSERT INTO dance_moderated_public_replay_indexes_v1(choreography_id,revision,key_epoch,work_token,work_until)
 VALUES(candidate.choreography_id,candidate.revision,candidate.key_epoch,p_token,now_at+(candidate.lease_ms*interval '1 millisecond'))
 ON CONFLICT(choreography_id,revision,key_epoch) DO UPDATE SET work_token=EXCLUDED.work_token,work_until=EXCLUDED.work_until,last_checked_at=now_at;
 RETURN jsonb_build_object('choreographyId',candidate.choreography_id,'revision',candidate.revision,'scope',candidate.scope,
 'normalizationHash',candidate.normalization_hash,'sourceSha256',candidate.source_sha256,'frames',candidate.frames,'epoch',candidate.key_epoch,'token',p_token);
END $$;

DO $acl$ DECLARE f RECORD; trusted TEXT:=current_schema(); BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=trusted::regnamespace
 AND proname=ANY(ARRAY['guard_moderated_reference_community_v1','create_moderated_dance_reference_v1','claim_moderated_dance_reference_media_v1','resolve_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','load_moderated_dance_creation_facts_v1','read_moderated_dance_capture_options_v1','moderated_dance_public_replay_ready_v1','claim_moderated_dance_public_reindex_v1']) LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
 END LOOP;
 REVOKE ALL ON FUNCTION guard_moderated_reference_community_v1() FROM PUBLIC;
END $acl$;
