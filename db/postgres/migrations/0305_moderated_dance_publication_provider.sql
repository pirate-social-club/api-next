-- Private original Post handoff effects. No speculative pre-pass provider job,
-- repeated create, copied URL, role/credential creation or financial effect.
CREATE TABLE dance_moderated_publication_jobs_v1 (
 review_id TEXT PRIMARY KEY REFERENCES dance_moderated_publication_inputs_v1,
 provider_tag TEXT NOT NULL UNIQUE CHECK(provider_tag~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
 create_consumed BOOLEAN NOT NULL DEFAULT FALSE,
 request_hash TEXT CHECK(request_hash~'^[a-f0-9]{64}$'),
 provider_job_id TEXT UNIQUE CHECK(provider_job_id~'^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$'),
 lease_token TEXT,lease_until TIMESTAMPTZ,last_observed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(create_consumed=(request_hash IS NOT NULL)),
 CHECK(provider_job_id IS NULL OR create_consumed),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE dance_moderated_publication_sources_v1 (
 capability_sha256 TEXT PRIMARY KEY CHECK(capability_sha256~'^[a-f0-9]{64}$'),
 review_id TEXT NOT NULL REFERENCES dance_moderated_publication_inputs_v1,
 expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX dance_publication_one_source_v1 ON dance_moderated_publication_sources_v1(review_id) WHERE revoked_at IS NULL;
CREATE FUNCTION guard_dance_publication_job_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR ROW(NEW.review_id,NEW.provider_tag,NEW.created_at) IS DISTINCT FROM ROW(OLD.review_id,OLD.provider_tag,OLD.created_at)
 OR OLD.create_consumed AND (NOT NEW.create_consumed OR NEW.request_hash IS DISTINCT FROM OLD.request_hash)
 OR OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id
 THEN RAISE EXCEPTION 'publication provider identity retained' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_dance_publication_source_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
 OR OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'publication source retained' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_publication_job_retained BEFORE UPDATE OR DELETE ON dance_moderated_publication_jobs_v1 FOR EACH ROW EXECUTE FUNCTION guard_dance_publication_job_v1();
CREATE TRIGGER dance_publication_job_no_truncate BEFORE TRUNCATE ON dance_moderated_publication_jobs_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
CREATE TRIGGER dance_publication_source_retained BEFORE UPDATE OR DELETE ON dance_moderated_publication_sources_v1 FOR EACH ROW EXECUTE FUNCTION guard_dance_publication_source_v1();
CREATE TRIGGER dance_publication_source_no_truncate BEFORE TRUNCATE ON dance_moderated_publication_sources_v1 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();
ALTER TABLE dance_moderated_provider_effects_v1 DROP CONSTRAINT dance_moderated_provider_effects_v1_purpose_check;
ALTER TABLE dance_moderated_provider_effects_v1 ADD CONSTRAINT dance_moderated_provider_effects_v1_purpose_check CHECK(purpose IN('probe','normalization','publication'));

CREATE OR REPLACE FUNCTION moderated_dance_publication_input_v1(p_review TEXT,p_action TEXT,p_input JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; h dance_moderated_publication_inputs_v1; u dance_moderated_uploads_v1;
 c JSONB; facts JSONB; song JSONB; packet JSONB; body JSONB; actor JSONB:='{"kind":"worker","accountId":"dance-publication"}';
 now_ms BIGINT; initial JSONB; sealed JSONB; next JSONB; initial_bytes BYTEA; sealed_bytes BYTEA;
 reservation_bytes BYTEA; immutable TEXT; v JSONB; expected_next JSONB;
BEGIN
 IF NOT moderated_dance_media_runtime_v1()
 THEN RAISE EXCEPTION 'publication worker unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
 PERFORM pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||r.account_id,0));
 PERFORM 1 FROM users WHERE user_id=r.account_id FOR UPDATE;
 PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=r.account_id FOR UPDATE;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review FOR UPDATE;
 PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=r.session_id FOR SHARE;
 PERFORM 1 FROM dance_review_policy_versions_v1 p JOIN dance_moderated_sessions_v1 x USING(policy_id) WHERE x.session_id=r.session_id FOR SHARE OF p;
 PERFORM 1 FROM dance_moderated_uploads_v1 WHERE session_id=r.session_id FOR SHARE;
 SELECT * INTO h FROM dance_moderated_publication_inputs_v1 WHERE review_id=p_review FOR UPDATE;
 c:=r.state->'capture';
 IF p_action='inspect' THEN RETURN CASE WHEN h.review_id IS NULL THEN NULL ELSE to_jsonb(h) END; END IF;
 IF h.review_id IS NOT NULL AND h.token IS DISTINCT FROM p_input->>'token'
 THEN RAISE EXCEPTION 'publication input token changed' USING ERRCODE='DRV05'; END IF;
 -- Replaying committed adoption is historical knowledge, never new authority.
 IF h.state='adopted' AND p_action='adopt' THEN RETURN h.receipt; END IF;
 -- Cleanup permanently wins over a late put/adoption. Its consumer must fence
 -- the key against an in-flight conditional put before reporting completion.
 IF p_action IN('cleanup','cleaned','abandon') THEN
  IF h.review_id IS NULL OR h.state='adopted' THEN RETURN NULL; END IF;
  IF h.state='cleaned' THEN RETURN jsonb_build_object('status','cleaned'); END IF;
  IF p_action='abandon' OR h.deadline_at<=clock_timestamp()
   OR r.state->>'publication'<>'pending' OR r.state->>'showPublicly'<>'true'
   OR NOT EXISTS(SELECT 1 FROM users a JOIN dance_review_account_fences_v1 f ON f.account_id=a.user_id
    WHERE a.user_id=r.account_id AND a.status='active' AND NOT f.erasing AND f.revision=(c->>'accountFenceRevision')::BIGINT)
   OR h.state='cleanup' THEN
   IF p_action='cleaned' THEN
    IF h.state<>'cleanup' OR p_input->>'keyFenced' IS DISTINCT FROM 'true'
    THEN RAISE EXCEPTION 'publication cleanup not fenced' USING ERRCODE='DRV05'; END IF;
    UPDATE dance_moderated_publication_inputs_v1 SET state='cleaned',source_identity=NULL,body_plan=NULL,body_identity=NULL,
     cleaned_at=clock_timestamp() WHERE review_id=p_review;
    RETURN jsonb_build_object('status','cleaned');
   END IF;
   UPDATE dance_moderated_publication_inputs_v1 SET state='cleanup' WHERE review_id=p_review;
   RETURN jsonb_build_object('status','cleanup','key',h.destination_key,'body',h.body_identity,'plan',h.body_plan);
  END IF;
  RETURN NULL;
 END IF;
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 facts:=moderated_dance_review_facts_v1(p_review,actor,'publication_input',now_ms);
 IF (r.status='reviewed' AND r.state->>'verdict'='passed' AND r.state->>'showPublicly'='true'
  AND r.state->>'publication'='pending' AND now_ms<(r.state->>'transferDeadlineMs')::BIGINT
  AND facts->>'accountActive'='true' AND facts->>'accountFenceRevision'=c->>'accountFenceRevision'
  AND facts->'media'->>'accepted'='true' AND facts->'media'->>'sourceDigest'=c->>'sourceDigest'
  AND facts->'media'->>'normalizedDigest'=c->>'normalizedDigest'
  AND facts->'safety'->>'status'='accepted' AND facts->'safety'->>'sourceDigest'=c->>'sourceDigest'
  AND facts->'safety'->>'policyHash'=c->'policy'->>'safetyHash'
  AND facts->'disposition'->>'accepted'='true' AND now_ms<(facts->'disposition'->>'validUntilMs')::BIGINT
  AND facts->'disposition'->>'hash'=c->'policy'->>'retentionHash'
  AND p_input->>'videoTrackEnabled'='true') IS NOT TRUE
 THEN RAISE EXCEPTION 'publication release unavailable' USING ERRCODE='DRV05'; END IF;
 song:=moderated_dance_publication_song_v1(r.state);
 -- Current policy/persona locks may wait beyond the snapshot taken above.
 -- Recheck before EVERY fresh input action, including body-plan/PUT grants.
 now_ms:=floor(extract(epoch FROM clock_timestamp())*1000)::BIGINT;
 IF now_ms>=(r.state->>'transferDeadlineMs')::BIGINT OR now_ms>=(facts->'disposition'->>'validUntilMs')::BIGINT OR h.review_id IS NOT NULL AND h.deadline_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'publication transfer expired after rights wait' USING ERRCODE='DRV05'; END IF;
 IF p_action='begin' THEN
  IF h.review_id IS NULL THEN
   SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=c->>'uploadId' AND state='sealed' FOR SHARE;
   INSERT INTO dance_moderated_publication_inputs_v1(review_id,token,generation,reservation_id,submission_id,operation_id,
    destination_key,deadline_at,source_identity)
   VALUES(p_review,p_input->>'token',(r.state->>'generation')::BIGINT,'dance-post-reservation:'||p_review,
    'dance-post-submission:'||p_review,'dance-post-operation:'||p_review,'immutable/dance-post-operation:'||p_review||'/video/1',
    to_timestamp((r.state->>'transferDeadlineMs')::NUMERIC/1000),u.immutable_object_identity)
   RETURNING * INTO h;
  END IF;
  IF h.state NOT IN('preparing','stored') THEN RAISE EXCEPTION 'publication input closed' USING ERRCODE='DRV05'; END IF;
  RETURN to_jsonb(h);
 END IF;
 IF h.review_id IS NULL OR h.generation<>(r.state->>'generation')::BIGINT OR h.state NOT IN('preparing','stored')
 THEN RAISE EXCEPTION 'publication input unavailable' USING ERRCODE='DRV05'; END IF;
 IF p_action='plan' THEN
  body:=p_input->'body';
  IF (body->>'key'=h.destination_key AND body->>'sha256' ~ '^[a-f0-9]{64}$'
   AND (body->>'size')::BIGINT BETWEEN 1 AND 16777216
   AND body->>'sourceSha256'=c->>'sourceDigest' AND body->>'bodyStartMs'=c->>'bodyStartMs'
   AND body->>'bodyEndMs'=c->>'bodyEndMs' AND (body->>'durationMs')::BIGINT=(c->>'bodyEndMs')::BIGINT-(c->>'bodyStartMs')::BIGINT
   AND body->>'transformRevision'='dance-publication-body-v1'
   AND body - ARRAY['key','sha256','size','sourceSha256','bodyStartMs','bodyEndMs','durationMs','transformRevision']='{}'::JSONB) IS NOT TRUE
  THEN RAISE EXCEPTION 'publication body plan changed' USING ERRCODE='DRV06'; END IF;
  IF h.body_plan IS NOT NULL AND h.body_plan IS DISTINCT FROM body THEN RAISE EXCEPTION 'publication body plan immutable' USING ERRCODE='DRV05'; END IF;
  UPDATE dance_moderated_publication_inputs_v1 SET body_plan=body WHERE review_id=p_review;
  RETURN body;
 END IF;
 IF p_action='put' THEN
  IF h.body_plan IS NULL THEN RAISE EXCEPTION 'publication body plan missing' USING ERRCODE='DRV05'; END IF;
  IF h.put_consumed THEN RETURN jsonb_build_object('status','unknown'); END IF;
  UPDATE dance_moderated_publication_inputs_v1 SET put_consumed=TRUE WHERE review_id=p_review;
  RETURN jsonb_build_object('status','put','body',h.body_plan);
 END IF;
 IF p_action='observe' THEN
  body:=p_input->'body';
  IF NOT h.put_consumed OR h.body_plan IS NULL OR body-ARRAY['version','etag'] IS DISTINCT FROM h.body_plan
   OR coalesce(body->>'version','')='' OR coalesce(body->>'etag','')=''
  THEN RAISE EXCEPTION 'publication body observation changed' USING ERRCODE='DRV06'; END IF;
  IF h.body_identity IS NOT NULL AND h.body_identity IS DISTINCT FROM body
  THEN RAISE EXCEPTION 'publication body observation immutable' USING ERRCODE='DRV05'; END IF;
  UPDATE dance_moderated_publication_inputs_v1 SET body_identity=body,state='stored' WHERE review_id=p_review;
  RETURN body;
 END IF;
 IF h.state<>'stored' THEN RAISE EXCEPTION 'publication body not secured' USING ERRCODE='DRV05'; END IF;
 packet:=jsonb_build_object('handoffId',p_review,'token',h.token,'generation',h.generation,'nowMs',now_ms,
  'review',r.state,'facts',facts,'reservationId',h.reservation_id,'submissionId',h.submission_id,'operationId',h.operation_id,
  'authorPersona',public_persona_projection(c->>'personaId'),'song',song-ARRAY['ownerPolicyRevision','ownerPolicyHash','derivativeVideo'],
  'body',h.body_identity,'postGatesAccepted',TRUE);
 IF p_action='packet' THEN RETURN packet; END IF;
 IF p_action<>'adopt' THEN RAISE EXCEPTION 'publication operation unavailable' USING ERRCODE='DRV06'; END IF;
 initial:=p_input->'prepared'->'initial'; sealed:=p_input->'prepared'->'sealed'; next:=p_input->'prepared'->'review';
 expected_next:=jsonb_set(jsonb_set(r.state,'{publication}','"transferred"'),'{publicationRevision}',to_jsonb(r.publication_revision+1));
 immutable:='media://immutable/'||h.operation_id||'/video/1'; body:=h.body_identity;
 v:=jsonb_build_object('videoRevision',1,'immutableRef',immutable,'canonicalSha256',body->>'sha256','contentType','video/mp4','sizeBytes',(body->>'size')::BIGINT);
 IF p_input->'prepared'->'before' IS DISTINCT FROM r.state OR next IS DISTINCT FROM expected_next
 OR (initial->>'submissionId'=h.submission_id AND initial->>'operationId'=h.operation_id
  AND initial->>'communityId'=r.community_id AND initial->>'actorAccountId'=r.account_id
  AND initial->>'authorPersonaId'=c->>'personaId' AND initial->>'reservationId'=h.reservation_id
  AND initial->>'intent'='song_reference' AND initial->>'phase'='awaiting_upload' AND initial->>'status'='processing'
  AND initial->>'creationRevision'='1' AND initial->>'videoRevision'='0' AND initial->>'analysisRevision'='0'
  AND initial->'video'='null'::JSONB AND initial->'caption'='null'::JSONB AND initial->>'authorDeclaredRating'='general'
  AND initial->'songPlan'=jsonb_build_object('planId','song-video-plan:'||h.submission_id,'songPostId',song->>'postId',
   'songAssetId',song->>'assetId','audioRevision',(song->>'audioRevision')::BIGINT,'canonicalAudioSha256',song->>'sha256',
   'songDurationSamples',(song->>'durationSamples')::BIGINT,'clipStartSamples',(song->>'clipStartSamples')::BIGINT,
   'clipDurationSamples',(song->>'clipDurationSamples')::BIGINT,'intervalPolicyRevision',1)) IS NOT TRUE
 OR initial-ARRAY['submissionId','operationId','communityId','actorAccountId','authorPersonaId','reservationId','songPlan']
 IS DISTINCT FROM '{"intent":"song_reference","master":null,"caption":null,"posterTimestampMs":null,"authorDeclaredRating":"general","creationRevision":1,"videoRevision":0,"analysisRevision":0,"retryCount":0,"reconciliationRequired":false,"status":"processing","phase":"awaiting_upload","video":null,"analysis":null,"decision":null,"reviewReasons":[],"approvedHolds":[],"failureCode":null,"postId":null}'::JSONB
 OR sealed IS DISTINCT FROM initial||jsonb_build_object('videoRevision',1,'video',v,'phase','analysis')
 THEN RAISE EXCEPTION 'publication adoption binding changed' USING ERRCODE='DRV06'; END IF;
 IF (p_input->'prepared'->'initialResponse')-ARRAY['updated_at','video_revision','phase'] IS DISTINCT FROM
  jsonb_build_object('submission_id',h.submission_id,'author_persona',packet->'authorPersona','href','/media-post-submissions/'||replace(h.submission_id,':','%3A'),
   'track','video','intent','song_reference','creation_revision',1,'caption',NULL,'status','processing')
 OR p_input->'prepared'->'initialResponse'->>'phase' IS DISTINCT FROM 'awaiting_upload'
 OR p_input->'prepared'->'initialResponse'->>'video_revision' IS DISTINCT FROM '0'
 OR p_input->'prepared'->'sealedResponse' IS DISTINCT FROM (p_input->'prepared'->'initialResponse')||jsonb_build_object('video_revision',1,'phase','analysis')
 THEN RAISE EXCEPTION 'publication response changed' USING ERRCODE='DRV06'; END IF;
 -- The song/policy/persona locks above may have waited. Check the absolute
 -- transfer deadline again after all waits, before creating ordinary authority.
 IF clock_timestamp()>=h.deadline_at THEN RAISE EXCEPTION 'publication transfer expired' USING ERRCODE='DRV05'; END IF;
 initial_bytes:=convert_to((p_input->'prepared'->'initialResponse')::TEXT,'UTF8');
 sealed_bytes:=convert_to((p_input->'prepared'->'sealedResponse')::TEXT,'UTF8');
 reservation_bytes:=convert_to(jsonb_build_object('input_source','dance_handoff','authority_id',p_review)::TEXT,'UTF8');
 INSERT INTO media_upload_reservations(reservation_id,community_id,actor_user_id,actor_persona_id,idempotency_key,request_hash,
  expected_content_type,expected_size_bytes,expected_sha256,upload_url,expires_at,response_snapshot_bytes,response_snapshot_sha256,
  media_kind,video_intent,ingest_policy_revision,input_source,input_authority_id)
 VALUES(h.reservation_id,r.community_id,r.account_id,c->>'personaId',h.reservation_id,encode(sha256(reservation_bytes),'hex'),
  'video/mp4',(body->>'size')::BIGINT,body->>'sha256',NULL,h.deadline_at,reservation_bytes,encode(sha256(reservation_bytes),'hex'),
  'video','song_reference',1,'dance_handoff',p_review);
 INSERT INTO media_video_reservation_song_plans(reservation_id,reservation_community_id,song_post_id,audio_revision,
  canonical_audio_sha256,song_duration_samples,song_asset_id,clip_start_samples,clip_duration_samples,interval_policy_revision,
  owner_policy_revision,owner_policy_hash,derivative_video,selected_from_kind,origin_verified)
 VALUES(h.reservation_id,r.community_id,song->>'postId',(song->>'audioRevision')::BIGINT,song->>'sha256',
  (song->>'durationSamples')::BIGINT,song->>'assetId',(song->>'clipStartSamples')::BIGINT,(song->>'clipDurationSamples')::BIGINT,
  1,(song->>'ownerPolicyRevision')::BIGINT,song->>'ownerPolicyHash',song->>'derivativeVideo','library',FALSE);
 INSERT INTO media_post_submissions(submission_id,community_id,actor_user_id,author_persona_id,operation_id,idempotency_key,
  request_hash,title,song_type,start_input,audio_reservation_id,creation_revision,audio_revision,analysis_revision,event_sequence,
  status,phase,response_snapshot_bytes,response_snapshot_sha256,media_kind,video_intent,caption,video_revision,video_state_snapshot,author_declared_rating)
 VALUES(h.submission_id,r.community_id,r.account_id,c->>'personaId',h.operation_id,h.submission_id,encode(sha256(initial_bytes),'hex'),
  NULL,NULL,jsonb_build_object('input_source','dance_handoff','authority_id',p_review),h.reservation_id,1,0,0,1,'processing',
  'awaiting_upload',initial_bytes,encode(sha256(initial_bytes),'hex'),'video','song_reference',NULL,0,initial,'general');
 INSERT INTO media_song_video_render_plans(plan_id,submission_id,song_post_id,song_asset_id,audio_revision,song_duration_samples,clip_start_samples,clip_duration_samples)
 VALUES('song-video-plan:'||h.submission_id,h.submission_id,song->>'postId',song->>'assetId',(song->>'audioRevision')::BIGINT,
  (song->>'durationSamples')::BIGINT,(song->>'clipStartSamples')::BIGINT,(song->>'clipDurationSamples')::BIGINT);
 UPDATE media_upload_reservations SET state='claimed',submission_id=h.submission_id,operation_id=h.operation_id,
  claim_fence=1,updated_at=clock_timestamp() WHERE reservation_id=h.reservation_id;
 INSERT INTO media_immutable_objects(immutable_ref,community_id,actor_user_id,reservation_id,submission_id,operation_id,
  destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256)
 VALUES(immutable,r.community_id,r.account_id,h.reservation_id,h.submission_id,h.operation_id,h.destination_key,
  body->>'etag',body->>'version',(body->>'size')::BIGINT,'video/mp4',body->>'sha256');
 INSERT INTO media_video_revisions(submission_id,community_id,actor_user_id,operation_id,video_revision,immutable_ref,canonical_sha256,content_type,size_bytes)
 VALUES(h.submission_id,r.community_id,r.account_id,h.operation_id,1,immutable,body->>'sha256','video/mp4',(body->>'size')::BIGINT);
 INSERT INTO media_video_analysis_outbox(effect_identity,submission_id,operation_id,video_revision,creation_revision,canonical_video_sha256)
 VALUES('video-analysis:'||h.operation_id||':v1:c1',h.submission_id,h.operation_id,1,1,body->>'sha256');
 UPDATE media_post_submissions SET video_state_snapshot=sealed,phase='analysis',video_revision=1,event_sequence=2,
  current_immutable_ref=immutable,response_snapshot_bytes=sealed_bytes,response_snapshot_sha256=encode(sha256(sealed_bytes),'hex'),updated_at=clock_timestamp()
 WHERE submission_id=h.submission_id;
 UPDATE media_upload_reservations SET state='sealed',updated_at=clock_timestamp() WHERE reservation_id=h.reservation_id;
 UPDATE dance_moderated_reviews_v1 SET state=next,publication_revision=publication_revision+1 WHERE review_id=p_review;
 UPDATE dance_moderated_publication_inputs_v1 SET state='adopted',receipt=p_input->'prepared'->'sealedResponse',
  adopted_at=clock_timestamp(),source_identity=NULL,body_plan=NULL,body_identity=NULL WHERE review_id=p_review;
 UPDATE dance_moderated_review_intents_v1 SET status='completed',lease_token=NULL,lease_until=NULL,
  disposition=jsonb_build_object('status','transferred','submission_id',h.submission_id)
 WHERE review_id=p_review AND kind IN('handoff_prepare','handoff_release') AND generation=h.generation;
 RETURN p_input->'prepared'->'sealedResponse';
END $$;

CREATE FUNCTION claim_moderated_dance_publication_v1(p_token TEXT,p_runtime TEXT,p_video BOOLEAN) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; h dance_moderated_publication_inputs_v1;j dance_moderated_publication_jobs_v1;
 s dance_moderated_sessions_v1;packet JSONB;input_token TEXT;now_at TIMESTAMPTZ;action TEXT;timeout_s BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'publication media role unavailable' USING ERRCODE='42501'; END IF;
 IF NOT p_video OR p_video IS NULL THEN RETURN NULL; END IF;
 IF coalesce(btrim(p_token),'')='' OR length(p_token)>192 THEN RAISE EXCEPTION 'publication lease invalid' USING ERRCODE='DRV06'; END IF;
 FOR candidate IN SELECT r.review_id,r.session_id,r.state FROM dance_moderated_reviews_v1 r
 JOIN dance_moderated_sessions_v1 session USING(session_id)
 LEFT JOIN dance_moderated_publication_inputs_v1 input ON input.review_id=r.review_id
 LEFT JOIN dance_moderated_publication_jobs_v1 job ON job.review_id=r.review_id
 WHERE r.status='reviewed' AND r.state->>'verdict'='passed' AND r.state->>'showPublicly'='true' AND r.state->>'publication'='pending'
 AND (r.state->>'transferDeadlineMs')::NUMERIC>extract(epoch FROM clock_timestamp())*1000
 AND session.terms->'profile'->>'mediaRuntimeRevision'=p_runtime
 AND (input.review_id IS NULL OR input.state IN('preparing','stored'))
 AND (job.lease_until IS NULL OR job.lease_until<=clock_timestamp())
 ORDER BY job.last_observed_at NULLS FIRST,r.submitted_at,r.review_id LIMIT 20 LOOP
  SELECT token INTO input_token FROM dance_moderated_publication_inputs_v1 WHERE review_id=candidate.review_id;
  input_token:=coalesce(input_token,p_token);
  BEGIN
   packet:=moderated_dance_publication_input_v1(candidate.review_id,'begin',jsonb_build_object('token',input_token,'videoTrackEnabled',TRUE));
  EXCEPTION WHEN SQLSTATE 'DRV05' THEN CONTINUE; END;
  SELECT * INTO STRICT h FROM dance_moderated_publication_inputs_v1 WHERE review_id=candidate.review_id;
  SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=candidate.session_id;
  INSERT INTO dance_moderated_publication_jobs_v1(review_id,provider_tag) VALUES(h.review_id,'dance-publication:'||h.review_id||':'||h.generation) ON CONFLICT(review_id) DO NOTHING;
  SELECT * INTO STRICT j FROM dance_moderated_publication_jobs_v1 WHERE review_id=h.review_id FOR UPDATE;
  now_at:=clock_timestamp();
  IF h.deadline_at<=now_at OR j.lease_until>now_at THEN CONTINUE; END IF;
  action:=CASE WHEN h.state='stored' THEN 'adopt' WHEN h.put_consumed THEN 'recover' WHEN j.create_consumed THEN 'observe' ELSE 'create' END;
  -- The seventh effect is optional Post work, not part of the six-purpose
  -- capture reservation. No captured admission is enlarged retrospectively.
  IF action='create' AND (s.terms->'profile'->>'maximumProviderCalls')::BIGINT<7 THEN
   UPDATE dance_moderated_publication_jobs_v1 SET last_observed_at=now_at WHERE review_id=h.review_id;
   CONTINUE;
  END IF;
  timeout_s:=least(300,(s.terms->'profile'->>'normalizationTimeoutSeconds')::BIGINT,floor(extract(epoch FROM h.deadline_at-now_at))::BIGINT);
  IF timeout_s<1 THEN CONTINUE; END IF;
  UPDATE dance_moderated_publication_jobs_v1 SET lease_token=p_token,lease_until=least(h.deadline_at,now_at+(s.terms->'profile'->>'workLeaseMs')::BIGINT*interval '1 millisecond'),last_observed_at=now_at WHERE review_id=h.review_id;
  RETURN jsonb_build_object('reviewId',h.review_id,'inputToken',h.token,'leaseToken',p_token,'action',action,
   'tag',j.provider_tag,'jobId',j.provider_job_id,'timeoutSeconds',timeout_s,'deadlineMs',floor(extract(epoch FROM h.deadline_at)*1000)::BIGINT,
   'bodyStartMs',candidate.state->'capture'->'bodyStartMs','bodyEndMs',candidate.state->'capture'->'bodyEndMs','sourceSha256',candidate.state->'capture'->'sourceDigest');
 END LOOP;
 RETURN NULL;
END $$;

CREATE FUNCTION moderated_dance_publication_provider_v1(p_review TEXT,p_action TEXT,p_input JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE h dance_moderated_publication_inputs_v1;j dance_moderated_publication_jobs_v1;s dance_moderated_sessions_v1;
 r dance_moderated_reviews_v1;grant_row dance_moderated_publication_sources_v1;until_at TIMESTAMPTZ;timeout_s BIGINT;request TEXT;effect TEXT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'publication media role unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT h FROM dance_moderated_publication_inputs_v1 WHERE review_id=p_review;
 IF h.token IS DISTINCT FROM p_input->>'inputToken' THEN RAISE EXCEPTION 'publication input identity changed' USING ERRCODE='DRV05'; END IF;
 IF p_action IN('identify','release') THEN
  -- Historical identity/lease receipts grant no new source read or processing.
  SELECT * INTO STRICT j FROM dance_moderated_publication_jobs_v1 WHERE review_id=p_review FOR UPDATE;
  IF p_action='release' THEN
   IF j.lease_token IS DISTINCT FROM p_input->>'leaseToken' THEN RAISE EXCEPTION 'publication observer changed' USING ERRCODE='DRV05'; END IF;
   UPDATE dance_moderated_publication_jobs_v1 SET lease_token=NULL,lease_until=NULL,last_observed_at=clock_timestamp() WHERE review_id=p_review;
   RETURN NULL;
  END IF;
  IF NOT j.create_consumed OR j.provider_tag IS DISTINCT FROM p_input->>'tag' OR (p_input->>'jobId'~'^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$') IS NOT TRUE
   OR j.provider_job_id IS NOT NULL AND j.provider_job_id IS DISTINCT FROM p_input->>'jobId'
  THEN RAISE EXCEPTION 'publication provider identity changed' USING ERRCODE='DRV05'; END IF;
  SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
  effect:='attempt:'||(r.state->'capture'->>'uploadId')||':publication';
  UPDATE dance_moderated_provider_effects_v1 SET provider_job_id=p_input->>'jobId' WHERE effect_id=effect AND provider_tag=j.provider_tag AND (provider_job_id IS NULL OR provider_job_id=p_input->>'jobId');
  IF NOT FOUND THEN RAISE EXCEPTION 'publication liability missing' USING ERRCODE='DRV05'; END IF;
  UPDATE dance_moderated_publication_jobs_v1 SET provider_job_id=p_input->>'jobId' WHERE review_id=p_review;
  RETURN jsonb_build_object('jobId',p_input->>'jobId','tag',j.provider_tag);
 END IF;
 -- All fresh grants use the actual existing account/review/source/rights locks.
 PERFORM moderated_dance_publication_input_v1(p_review,'begin',jsonb_build_object('token',h.token,'videoTrackEnabled',p_input->'videoTrackEnabled'));
 SELECT * INTO STRICT h FROM dance_moderated_publication_inputs_v1 WHERE review_id=p_review;
 SELECT * INTO STRICT j FROM dance_moderated_publication_jobs_v1 WHERE review_id=p_review FOR UPDATE;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=p_review;
 SELECT * INTO STRICT s FROM dance_moderated_sessions_v1 WHERE session_id=r.session_id;
 IF j.lease_token IS NULL OR j.lease_until IS NULL OR j.lease_token IS DISTINCT FROM p_input->>'leaseToken' OR j.lease_until<=clock_timestamp() OR h.state<>'preparing'
 OR h.generation IS DISTINCT FROM (r.state->>'generation')::BIGINT
 OR h.deadline_at IS DISTINCT FROM to_timestamp((r.state->>'transferDeadlineMs')::NUMERIC/1000)
 THEN RAISE EXCEPTION 'publication observer expired' USING ERRCODE='DRV05'; END IF;
 IF p_action='observe' THEN
  IF NOT j.create_consumed THEN RAISE EXCEPTION 'publication provider not dispatched' USING ERRCODE='DRV05'; END IF;
  RETURN jsonb_build_object('status','observe','jobId',j.provider_job_id,'tag',j.provider_tag);
 ELSIF p_action='source' THEN
  IF j.create_consumed THEN RETURN NULL; END IF;
  IF (p_input->>'capabilitySha256'~'^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'publication capability invalid' USING ERRCODE='DRV06'; END IF;
  until_at:=least(h.deadline_at,clock_timestamp()+(s.terms->'profile'->>'mediaLeaseMs')::BIGINT*interval '1 millisecond');
  UPDATE dance_moderated_publication_sources_v1 SET revoked_at=clock_timestamp() WHERE review_id=p_review AND revoked_at IS NULL;
  INSERT INTO dance_moderated_publication_sources_v1(capability_sha256,review_id,expires_at) VALUES(p_input->>'capabilitySha256',p_review,until_at);
  RETURN jsonb_build_object('expiresAtMs',floor(extract(epoch FROM until_at)*1000)::BIGINT);
 ELSIF p_action='create' THEN
  IF j.create_consumed THEN RETURN jsonb_build_object('status','unknown'); END IF;
  IF (s.terms->'profile'->>'maximumProviderCalls')::BIGINT<7 THEN RAISE EXCEPTION 'publication purpose not admitted' USING ERRCODE='DRV07'; END IF;
  SELECT * INTO STRICT grant_row FROM dance_moderated_publication_sources_v1 WHERE review_id=p_review AND capability_sha256=p_input->>'capabilitySha256' AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF NOT reserve_moderated_dance_provider_work_v1(r.account_id,s.terms->'profile') THEN RETURN jsonb_build_object('status','budget_refused'); END IF;
  -- Usage-row waits may cross either original authority bound.
  IF h.deadline_at<=clock_timestamp() OR j.lease_until<=clock_timestamp() OR grant_row.expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'publication grant expired during budget wait' USING ERRCODE='DRV05'; END IF;
  timeout_s:=least(300,(s.terms->'profile'->>'normalizationTimeoutSeconds')::BIGINT,floor(extract(epoch FROM h.deadline_at-clock_timestamp()))::BIGINT);
  IF timeout_s<1 THEN RAISE EXCEPTION 'publication deadline expired' USING ERRCODE='DRV05'; END IF;
  request:=encode(sha256(convert_to(jsonb_build_object('recipe','dance-publication-body-v1','reviewId',p_review,'generation',h.generation,'source',h.source_identity,
   'bodyStartMs',r.state->'capture'->'bodyStartMs','bodyEndMs',r.state->'capture'->'bodyEndMs','capabilitySha256',grant_row.capability_sha256,'timeoutSeconds',timeout_s)::TEXT,'UTF8')),'hex');
  PERFORM register_moderated_dance_provider_effect_v1(r.state->'capture'->>'uploadId',NULL,'publication','cloudconvert',j.provider_tag,NULL,s.terms_hash,h.deadline_at,s.terms->'disposition',s.terms->'profile');
  UPDATE dance_moderated_publication_jobs_v1 SET create_consumed=TRUE,request_hash=request WHERE review_id=p_review;
  RETURN jsonb_build_object('status','create','tag',j.provider_tag,'timeoutSeconds',timeout_s);
 END IF;
 RAISE EXCEPTION 'publication provider action unavailable' USING ERRCODE='DRV06';
END $$;

CREATE FUNCTION resolve_moderated_dance_publication_source_v1(p_digest TEXT)
 RETURNS TABLE(physical_key TEXT,object_version TEXT,etag TEXT,size_bytes BIGINT,content_type TEXT,canonical_sha256 TEXT,expires_at TIMESTAMPTZ,identity_kind TEXT)
 LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT h.source_identity->>'destination_ref',h.source_identity->>'version',h.source_identity->>'etag',
 (h.source_identity->>'size_bytes')::BIGINT,u.content_type,h.source_identity->>'canonical_sha256',g.expires_at,'upload_version'
 FROM dance_moderated_publication_sources_v1 g JOIN dance_moderated_publication_inputs_v1 h USING(review_id)
 JOIN dance_moderated_publication_jobs_v1 job USING(review_id) JOIN dance_moderated_reviews_v1 r USING(review_id)
 JOIN dance_moderated_sessions_v1 s USING(session_id) JOIN dance_moderated_uploads_v1 u USING(session_id)
 JOIN users a ON a.user_id=r.account_id JOIN dance_review_account_fences_v1 f ON f.account_id=r.account_id
 WHERE g.capability_sha256=p_digest AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND h.deadline_at>clock_timestamp()
 AND h.state='preparing' AND job.create_consumed AND h.generation=(r.state->>'generation')::BIGINT
 AND r.status='reviewed' AND r.state->>'verdict'='passed' AND r.state->>'publication'='pending' AND r.state->>'showPublicly'='true'
 AND a.status='active' AND NOT f.erasing AND f.revision=(r.state->'capture'->>'accountFenceRevision')::BIGINT
 AND active_activity_persona(r.account_id,s.persona_id,r.community_id) AND u.state='sealed'
 AND h.source_identity=u.immutable_object_identity AND h.source_identity->>'canonical_sha256'=r.state->'capture'->>'sourceDigest'
$$;

CREATE OR REPLACE FUNCTION claim_moderated_dance_provider_cleanup_v1(p_token TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item dance_moderated_provider_effects_v1; candidate TEXT; owner RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'provider cleanup unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT effect.effect_id INTO candidate FROM dance_moderated_provider_effects_v1 effect
 LEFT JOIN dance_moderated_processing_v1 processing ON processing.upload_id=effect.upload_id
 LEFT JOIN dance_moderated_uploads_v1 upload ON upload.upload_id=effect.upload_id
 LEFT JOIN dance_moderated_sessions_v1 session ON session.session_id=upload.session_id
 LEFT JOIN dance_moderated_reviews_v1 review ON review.session_id=session.session_id
 LEFT JOIN dance_moderated_reference_commands_v1 reference ON reference.choreography_id=effect.choreography_id
 WHERE effect.state<>'completed' AND (effect.lease_until IS NULL OR effect.lease_until<=now_at)
 AND (effect.work_deadline<=now_at OR effect.purpose='publication' AND EXISTS(SELECT 1 FROM dance_moderated_publication_inputs_v1 handoff WHERE handoff.review_id=review.review_id AND handoff.state IN('stored','adopted','cleanup','cleaned')) OR effect.purpose<>'publication' AND (processing.state IN('screened','failed','held') OR session.state='terminal' OR reference.state IN('ready','failed')))
 AND ((processing.state IS DISTINCT FROM 'held' AND review.status IS DISTINCT FROM 'held') OR effect.hold_dispose_by<=now_at)
 ORDER BY effect.last_observed_at NULLS FIRST,effect.dispose_by,effect.effect_id LIMIT 1;
 IF candidate IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT item FROM dance_moderated_provider_effects_v1 WHERE effect_id=candidate;
 IF item.upload_id IS NOT NULL THEN
  SELECT session.account_id,session.session_id INTO STRICT owner FROM dance_moderated_sessions_v1 session
   JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=item.upload_id;
  -- Match intake/review/erasure lock order, then recheck eligibility after any
  -- wait. A safety hold committed during that wait must prevent deletion.
  PERFORM 1 FROM users WHERE user_id=owner.account_id FOR UPDATE;
  PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=owner.account_id FOR UPDATE;
  PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=owner.session_id FOR UPDATE;
  PERFORM 1 FROM dance_moderated_uploads_v1 WHERE upload_id=item.upload_id FOR UPDATE;
  PERFORM 1 FROM dance_moderated_processing_v1 WHERE upload_id=item.upload_id FOR UPDATE;
 ELSE
  PERFORM 1 FROM dance_moderated_reference_commands_v1 WHERE choreography_id=item.choreography_id FOR UPDATE;
 END IF;
 SELECT * INTO item FROM dance_moderated_provider_effects_v1 WHERE effect_id=candidate AND state<>'completed'
  AND (lease_until IS NULL OR lease_until<=clock_timestamp()) FOR UPDATE SKIP LOCKED;
 IF item.effect_id IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect
  LEFT JOIN dance_moderated_processing_v1 processing ON processing.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_uploads_v1 upload ON upload.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_sessions_v1 session ON session.session_id=upload.session_id
  LEFT JOIN dance_moderated_reviews_v1 review ON review.session_id=session.session_id
  LEFT JOIN dance_moderated_reference_commands_v1 reference ON reference.choreography_id=effect.choreography_id
  WHERE effect.effect_id=item.effect_id
  AND (effect.work_deadline<=clock_timestamp() OR effect.purpose='publication' AND EXISTS(SELECT 1 FROM dance_moderated_publication_inputs_v1 handoff WHERE handoff.review_id=review.review_id AND handoff.state IN('stored','adopted','cleanup','cleaned')) OR effect.purpose<>'publication' AND (processing.state IN('screened','failed','held') OR session.state='terminal' OR reference.state IN('ready','failed')))
  AND ((processing.state IS DISTINCT FROM 'held' AND review.status IS DISTINCT FROM 'held') OR effect.hold_dispose_by<=clock_timestamp())) THEN RETURN NULL; END IF;
 UPDATE dance_moderated_provider_effects_v1 SET state='leased',claim_token=p_token,
  lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',last_observed_at=clock_timestamp() WHERE effect_id=item.effect_id;
 RETURN jsonb_build_object('effectId',item.effect_id,'provider',item.provider,'tag',item.provider_tag,'jobId',item.provider_job_id,'token',p_token);
END $$;


CREATE OR REPLACE FUNCTION grant_moderated_dance_runtime_v1(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target RECORD; owner_oid OID; names TEXT[]; f RECORD; t RECORD; found_count INTEGER:=0;
BEGIN
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='dance_moderated_sessions_v1'::regclass;
 IF session_user<>pg_get_userbyid(owner_oid) THEN RAISE EXCEPTION 'runtime binding requires admitted owner custody' USING ERRCODE='DRV02'; END IF;
 SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication INTO target FROM pg_roles WHERE rolname=p_role;
 IF target.oid IS NULL OR target.oid=owner_oid OR target.rolsuper OR target.rolbypassrls OR target.rolcreaterole OR target.rolcreatedb OR target.rolreplication THEN RAISE EXCEPTION 'runtime role is not confined' USING ERRCODE='DRV06'; END IF;
 FOR t IN SELECT c.oid FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN('r','p') AND
 (c.relname LIKE 'dance_moderated_%_v1' OR c.relname IN('dance_review_account_fences_v1','dance_review_policy_versions_v1','dance_review_policy_admissions_v1','dance_moderator_reference_revisions_v1','dance_moderator_reference_cutoffs_v1')) LOOP
  IF has_table_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(target.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'inherited/raw private table privilege must be reconciled first' USING ERRCODE='DRV06'; END IF;
 END LOOP;
 IF p_purpose='account' THEN
  names:=ARRAY['lock_moderated_dance_intake_command_v1','load_moderated_dance_creation_facts_v1','apply_moderated_dance_intake_v1','read_owned_moderated_dance_session_v1','read_moderated_dance_capture_options_v1','create_moderated_dance_reference_v1','read_owned_moderated_dance_reference_v1','issue_moderated_dance_media_lease_v1','resolve_moderated_dance_media_lease_v1',
   'lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1','read_owned_moderated_dance_review_v1','latest_owned_moderated_dance_review_v1','owner_moderated_dance_queue_v1','owner_moderated_dance_detail_v1'];
 ELSIF p_purpose='worker' THEN
  names:=ARRAY['next_moderated_dance_review_task_v1','lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1'];
 ELSIF p_purpose='media' THEN
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1','bind_moderated_dance_replay_keys_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1','moderated_dance_publication_input_v1','claim_moderated_dance_publication_cleanup_v1','finish_moderated_dance_publication_cleanup_v1','claim_moderated_dance_publication_v1','moderated_dance_publication_provider_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1','resolve_moderated_dance_publication_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

REVOKE ALL ON TABLE dance_moderated_publication_jobs_v1,dance_moderated_publication_sources_v1 FROM PUBLIC;
DO $acl$
DECLARE f RECORD;r RECORD;t TEXT;trusted TEXT:=current_schema();
BEGIN
 FOREACH t IN ARRAY ARRAY['dance_moderated_publication_jobs_v1','dance_moderated_publication_sources_v1'] LOOP
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=t::regclass AND a.grantee NOT IN(0,c.relowner) LOOP EXECUTE format('REVOKE ALL ON TABLE %I FROM %I CASCADE',t,r.name); END LOOP;
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('guard_dance_publication_job_v1','guard_dance_publication_source_v1','claim_moderated_dance_publication_v1','moderated_dance_publication_provider_v1',
 'resolve_moderated_dance_publication_source_v1','moderated_dance_publication_input_v1','claim_moderated_dance_provider_cleanup_v1','grant_moderated_dance_runtime_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
DO $bind$ DECLARE r RECORD; BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(role_oid) name FROM dance_moderated_runtime_roles_v1 WHERE purpose='media' LOOP PERFORM grant_moderated_dance_runtime_v1(r.name,'media'); END LOOP;
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid='resolve_moderated_dance_source_v1(text)'::regprocedure AND a.grantee NOT IN(0,p.proowner) AND a.privilege_type='EXECUTE' LOOP
  PERFORM grant_moderated_dance_runtime_v1(r.name,'source_gateway');
 END LOOP;
END $bind$;
