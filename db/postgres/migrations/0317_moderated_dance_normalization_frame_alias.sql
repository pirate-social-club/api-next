-- Disambiguate the supplied frame set from the local per-frame variable.
-- Preserve every existing authority, replay, storage and lifecycle check.
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
   AND frame->>'sha256'~'^[a-f0-9]{64}$' AND (frame->>'timestampMs')::BIGINT=CASE (frame->>'index')::INTEGER WHEN 0 THEN 0 WHEN 1 THEN floor((s.terms->'capture'->>'bodyStartMs')::NUMERIC/2) WHEN 2 THEN floor(((s.terms->'capture'->>'bodyStartMs')::NUMERIC+(s.terms->'capture'->>'bodyEndMs')::NUMERIC)/2) END
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

-- CREATE OR REPLACE retains the existing owner and confined execution grants.
-- Restore its trusted path without granting any new runtime/public authority.
DO $path$ DECLARE trusted TEXT:=current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION persist_moderated_dance_normalization_v1(text,text,jsonb,jsonb) SET search_path=%I,pg_catalog,pg_temp',trusted);
END $path$;
