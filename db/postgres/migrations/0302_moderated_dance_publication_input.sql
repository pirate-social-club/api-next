-- The optional Post starts only after a passed/on verdict. No speculative
-- pre-pass copy, invented multipart completion, public finalize or publication
-- bypass. This journal is private; the adopted input belongs to ordinary video.
CREATE TABLE dance_moderated_publication_inputs_v1 (
 review_id TEXT PRIMARY KEY REFERENCES dance_moderated_reviews_v1,
 token TEXT NOT NULL CHECK(btrim(token)<>'' AND length(token)<=192),
 generation BIGINT NOT NULL CHECK(generation>0),
 reservation_id TEXT NOT NULL UNIQUE, submission_id TEXT NOT NULL UNIQUE,
 operation_id TEXT NOT NULL UNIQUE, destination_key TEXT NOT NULL UNIQUE,
 deadline_at TIMESTAMPTZ NOT NULL CHECK(isfinite(deadline_at)),
 source_identity JSONB, body_plan JSONB, body_identity JSONB,
 put_consumed BOOLEAN NOT NULL DEFAULT FALSE,
 state TEXT NOT NULL DEFAULT 'preparing' CHECK(state IN('preparing','stored','adopted','cleanup','cleaned')),
 receipt JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 adopted_at TIMESTAMPTZ, cleaned_at TIMESTAMPTZ,
 CHECK((state='adopted')=(receipt IS NOT NULL AND adopted_at IS NOT NULL)),
 CHECK((state='cleaned')=(cleaned_at IS NOT NULL)),
 CHECK(state NOT IN('stored','adopted') OR put_consumed),
 CHECK(state<>'stored' OR body_identity IS NOT NULL),
 CHECK(state NOT IN('adopted','cleaned') OR (source_identity IS NULL AND body_plan IS NULL AND body_identity IS NULL))
);
CREATE FUNCTION guard_dance_publication_input_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'publication journal retained' USING ERRCODE='DRV01'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','source_identity','body_plan','body_identity','put_consumed','receipt','adopted_at','cleaned_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','source_identity','body_plan','body_identity','put_consumed','receipt','adopted_at','cleaned_at'])
 OR OLD.state IN('adopted','cleaned') OR OLD.state='cleanup' AND NEW.state NOT IN('cleanup','cleaned')
 OR OLD.put_consumed AND NOT NEW.put_consumed
 OR NEW.source_identity IS DISTINCT FROM OLD.source_identity AND NOT(NEW.state IN('adopted','cleaned') AND NEW.source_identity IS NULL)
 OR OLD.body_plan IS NOT NULL AND NEW.body_plan IS DISTINCT FROM OLD.body_plan AND NOT(NEW.state IN('adopted','cleaned') AND NEW.body_plan IS NULL)
 OR OLD.body_identity IS NOT NULL AND NEW.body_identity IS DISTINCT FROM OLD.body_identity AND NOT(NEW.state IN('adopted','cleaned') AND NEW.body_identity IS NULL)
 THEN RAISE EXCEPTION 'publication journal identity changed' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_publication_input_retained BEFORE UPDATE OR DELETE ON dance_moderated_publication_inputs_v1
 FOR EACH ROW EXECUTE FUNCTION guard_dance_publication_input_v1();
CREATE TRIGGER dance_publication_input_no_truncate BEFORE TRUNCATE ON dance_moderated_publication_inputs_v1
 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();

CREATE INDEX dance_publication_input_work_v1 ON dance_moderated_publication_inputs_v1(deadline_at,review_id)
 WHERE state NOT IN('adopted','cleaned');

-- Keep every serving upload row's shape. Internal Dance inputs have an honest
-- source authority and no multipart upload, manifest, URL or completion time.
ALTER TABLE media_upload_reservations ADD COLUMN input_source TEXT NOT NULL DEFAULT 'upload'
 CHECK(input_source IN('upload','dance_handoff'));
ALTER TABLE media_upload_reservations ADD COLUMN input_authority_id TEXT
 REFERENCES dance_moderated_publication_inputs_v1(review_id);
ALTER TABLE media_upload_reservations DROP CONSTRAINT media_upload_reservations_media_shape;
ALTER TABLE media_upload_reservations ADD CONSTRAINT media_upload_reservations_media_shape CHECK (
 (input_source='upload' AND input_authority_id IS NULL AND (
  (media_kind='song' AND video_intent IS NULL AND ingest_policy_revision IS NULL
   AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL AND multipart_part_count IS NULL
   AND multipart_manifest IS NULL AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
   AND upload_url IS NOT NULL AND btrim(upload_url)<>'')
  OR (media_kind='video' AND video_intent IN('original_audio','song_reference') AND ingest_policy_revision>0
   AND multipart_upload_id IS NOT NULL AND btrim(multipart_upload_id)<>'' AND multipart_part_size_bytes>0
   AND multipart_part_count>0 AND (multipart_manifest IS NULL OR jsonb_typeof(multipart_manifest)='array')
   AND NOT(multipart_completed_at IS NOT NULL AND multipart_aborted_at IS NOT NULL)
   AND upload_url IS NULL AND upload_headers='[]'::jsonb)))
 OR (input_source='dance_handoff' AND input_authority_id IS NOT NULL
  AND media_kind='video' AND video_intent='song_reference' AND ingest_policy_revision=1
  AND expected_content_type='video/mp4' AND expected_sha256 IS NOT NULL
  AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL AND multipart_part_count IS NULL
  AND multipart_manifest IS NULL AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
  AND upload_url IS NULL AND upload_headers='[]'::jsonb)
);
CREATE FUNCTION guard_media_input_source_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.input_source,NEW.input_authority_id) IS DISTINCT FROM ROW(OLD.input_source,OLD.input_authority_id)
 THEN RAISE EXCEPTION 'media input authority is immutable' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER media_input_source_immutable BEFORE UPDATE ON media_upload_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_media_input_source_v1();
-- The ordinary multipart guard remains unchanged and still governs uploads.
DROP TRIGGER media_video_reservation_update_guard ON media_upload_reservations;
CREATE TRIGGER media_video_reservation_update_guard BEFORE UPDATE ON media_upload_reservations
 FOR EACH ROW WHEN(OLD.media_kind='video' AND OLD.input_source='upload')
 EXECUTE FUNCTION guard_media_video_reservation_update();
-- The stored generated actor_account_id is recomputed after BEFORE triggers;
-- compare its immutable actor_user_id base, never NEW's temporarily null copy.
CREATE FUNCTION guard_dance_publication_reservation_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state'-'submission_id'-'operation_id'-'claim_fence'-'updated_at'-'actor_account_id')
 IS DISTINCT FROM (to_jsonb(OLD)-'state'-'submission_id'-'operation_id'-'claim_fence'-'updated_at'-'actor_account_id')
 THEN RAISE EXCEPTION 'Dance reservation identity changed' USING ERRCODE='DRV05',DETAIL=(SELECT string_agg(key,',') FROM jsonb_each(to_jsonb(NEW)-ARRAY['state','submission_id','operation_id','claim_fence','updated_at','actor_account_id']) e WHERE e.value IS DISTINCT FROM to_jsonb(OLD)->e.key); END IF;
 IF NEW.updated_at<=OLD.updated_at THEN RAISE EXCEPTION 'Dance reservation clock did not advance' USING ERRCODE='DRV05'; END IF;
 IF NOT(
  OLD.state='issued' AND NEW.state='claimed' AND NEW.claim_fence=1
  AND EXISTS(SELECT 1 FROM dance_moderated_publication_inputs_v1 h WHERE h.review_id=OLD.input_authority_id
   AND h.state='stored' AND h.reservation_id=OLD.reservation_id AND h.submission_id=NEW.submission_id AND h.operation_id=NEW.operation_id)
  OR OLD.state='claimed' AND NEW.state='sealed' AND NEW.claim_fence=OLD.claim_fence
   AND NEW.submission_id=OLD.submission_id AND NEW.operation_id=OLD.operation_id
 ) THEN RAISE EXCEPTION 'Dance input reservation transition changed' USING ERRCODE='DRV05'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_publication_reservation_guard BEFORE UPDATE ON media_upload_reservations
 FOR EACH ROW WHEN(OLD.input_source='dance_handoff') EXECUTE FUNCTION guard_dance_publication_reservation_v1();

-- This existing deferred constraint runs at COMMIT, after the private adoption
-- function returns. Its exact frozen-plan test needs owner execution, not raw
-- table grants to the media role. Trigger arguments cannot be supplied by SQL.
ALTER FUNCTION require_media_video_reservation_song_plan() SECURITY DEFINER;
DO $path$ BEGIN
 EXECUTE format('ALTER FUNCTION require_media_video_reservation_song_plan() SET search_path=%I,pg_catalog,pg_temp',current_schema());
END $path$;
REVOKE ALL ON FUNCTION require_media_video_reservation_song_plan() FROM PUBLIC;

-- Called only with the review lifecycle lock. Resolve the song's own community
-- by post identity: the destination community is not a song ownership shortcut.
CREATE FUNCTION moderated_dance_publication_song_v1(p_state JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE c JSONB:=p_state->'capture'; post_row posts; song media_publication_projections;
 policy song_owner_policy_revisions; timing media_song_canonical_timings; segment dance_song_segments;
BEGIN
 PERFORM 1 FROM personas WHERE persona_id=c->>'personaId' AND account_id=c->>'accountId' FOR SHARE;
 PERFORM 1 FROM persona_community_bindings WHERE persona_id=c->>'personaId' AND community_id=c->>'communityId' FOR SHARE;
 IF NOT active_activity_persona(c->>'accountId',c->>'personaId',c->>'communityId')
 OR NOT EXISTS(SELECT 1 FROM communities WHERE community_id=c->>'communityId' AND status='active' FOR SHARE)
 OR NOT EXISTS(SELECT 1 FROM community_memberships WHERE community_id=c->>'communityId' AND user_id=c->>'accountId' AND status='member' FOR SHARE)
 THEN RAISE EXCEPTION 'Post membership unavailable' USING ERRCODE='DRV05'; END IF;
 PERFORM 1 FROM personas WHERE persona_id=c->>'personaId' AND account_id=c->>'accountId' FOR SHARE;
 PERFORM 1 FROM persona_community_bindings WHERE persona_id=c->>'personaId' AND community_id=c->>'communityId' FOR SHARE;
 SELECT * INTO STRICT post_row FROM posts WHERE post_id=c->>'songPostId' FOR SHARE;
 SELECT * INTO STRICT song FROM media_publication_projections WHERE post_id=post_row.post_id AND media_kind='song' FOR SHARE;
 PERFORM 1 FROM communities WHERE community_id=post_row.community_id AND status='active' FOR SHARE;
 IF NOT FOUND OR post_row.status<>'published' OR post_row.visibility<>'public' OR song.visibility<>'public'
 OR song.audio_revision IS DISTINCT FROM (c->>'audioRevision')::BIGINT
 OR NOT can_account_view_content_rating_v1(c->>'accountId',post_row.content_rating)
 THEN RAISE EXCEPTION 'Post song unavailable' USING ERRCODE='DRV05'; END IF;
 PERFORM lock_song_owner_policy_head_v1(post_row.community_id,post_row.post_id);
 SELECT * INTO STRICT policy FROM song_owner_policy_revisions WHERE community_id=post_row.community_id
  AND post_id=post_row.post_id AND audio_revision=song.audio_revision ORDER BY policy_revision DESC LIMIT 1;
 IF policy.derivative_video='blocked' OR policy.derivative_video='owner_only' AND policy.owner_account_id<>c->>'accountId'
 THEN RAISE EXCEPTION 'Post derivative permission unavailable' USING ERRCODE='DRV05'; END IF;
 SELECT * INTO STRICT timing FROM media_song_canonical_timings WHERE song_post_id=post_row.post_id
  AND audio_revision=song.audio_revision AND canonical_audio_sha256=song.canonical_audio_sha256 AND state='ready';
 SELECT * INTO STRICT segment FROM dance_song_segments WHERE segment_id=c->>'segmentId'
  AND song_post_id=post_row.post_id AND audio_revision=song.audio_revision;
 IF segment.end_ms-segment.start_ms IS DISTINCT FROM (c->>'bodyEndMs')::BIGINT-(c->>'bodyStartMs')::BIGINT
 OR segment.end_ms*48>timing.duration_samples
 OR NOT EXISTS(SELECT 1 FROM media_song_video_pcm_references WHERE song_post_id=post_row.post_id
  AND audio_revision=song.audio_revision AND canonical_audio_sha256=timing.canonical_audio_sha256 AND duration_samples=timing.duration_samples)
 THEN RAISE EXCEPTION 'Post canonical interval unavailable' USING ERRCODE='DRV05'; END IF;
 RETURN jsonb_build_object('postId',post_row.post_id,'audioRevision',song.audio_revision,'assetId',song.audio_asset_ref,
  'sha256',song.canonical_audio_sha256,'durationSamples',timing.duration_samples,'clipStartSamples',segment.start_ms*48,
  'clipDurationSamples',(segment.end_ms-segment.start_ms)*48,'intervalPolicyRevision',1,
  'ownerPolicyRevision',policy.policy_revision,'ownerPolicyHash',policy.policy_hash,'derivativeVideo',policy.derivative_video);
END $$;

CREATE FUNCTION moderated_dance_publication_input_v1(p_review TEXT,p_action TEXT,p_input JSONB) RETURNS JSONB
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

REVOKE ALL ON TABLE dance_moderated_publication_inputs_v1 FROM PUBLIC;
DO $acl$
DECLARE f RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c,
  LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='dance_moderated_publication_inputs_v1'::regclass AND a.grantee NOT IN(0,c.relowner)
 LOOP EXECUTE format('REVOKE ALL ON TABLE dance_moderated_publication_inputs_v1 FROM %I CASCADE',r.name); END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('guard_dance_publication_input_v1','guard_media_input_source_v1','guard_dance_publication_reservation_v1',
  'moderated_dance_publication_song_v1','moderated_dance_publication_input_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;

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
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1','bind_moderated_dance_replay_keys_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1','moderated_dance_publication_input_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

-- Upgrade existing admitted media roles through the same exact owner grant.
DO $bind$ DECLARE role_row RECORD; BEGIN
 FOR role_row IN SELECT DISTINCT pg_get_userbyid(role_oid) name FROM dance_moderated_runtime_roles_v1 WHERE purpose='media' LOOP
  PERFORM grant_moderated_dance_runtime_v1(role_row.name,'media');
 END LOOP;
END $bind$;
