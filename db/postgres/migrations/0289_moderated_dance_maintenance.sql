-- Prospective nonfinancial maintenance. Runs independently of Rewards flags.
CREATE TABLE dance_moderated_maintenance_readiness_v1 (
 singleton BOOLEAN PRIMARY KEY CHECK(singleton), observed_at TIMESTAMPTZ NOT NULL,
 valid_until TIMESTAMPTZ NOT NULL CHECK(valid_until>observed_at)
);
ALTER TABLE dance_moderated_media_dispositions_v1 ADD COLUMN claim_token TEXT, ADD COLUMN observed_result JSONB, ADD COLUMN last_observed_at TIMESTAMPTZ;
CREATE FUNCTION next_moderated_dance_review_task_v1() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; operation TEXT;
BEGIN
 IF NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'review worker unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE
 (status IN('uploaded','screening','awaiting_review') AND EXISTS(SELECT 1 FROM dance_review_account_fences_v1 fence WHERE fence.account_id=dance_moderated_reviews_v1.account_id AND fence.erasing)) OR status='screening' OR
 (status IN('uploaded','awaiting_review') AND (review_deadline<=clock_timestamp() OR
  status='uploaded' AND (state->'capture'->>'captureExpiresAtMs')::NUMERIC<=extract(epoch FROM clock_timestamp())*1000)) OR
 (state->>'publication'='pending' AND (state->>'transferDeadlineMs')::NUMERIC<=extract(epoch FROM clock_timestamp())*1000)
 ORDER BY review_deadline,review_id LIMIT 1;
 IF r.review_id IS NULL THEN RETURN NULL; END IF;
 operation:=CASE WHEN EXISTS(SELECT 1 FROM dance_review_account_fences_v1 fence WHERE fence.account_id=r.account_id AND fence.erasing) THEN 'erase' WHEN r.state->>'publication'='pending' AND (r.state->>'transferDeadlineMs')::NUMERIC<=extract(epoch FROM clock_timestamp())*1000 THEN 'publication_failed' WHEN r.status='screening' AND clock_timestamp()<r.review_deadline THEN 'screen' ELSE 'expire' END;
 RETURN jsonb_build_object('communityId',r.community_id,'reviewId',r.review_id,'revision',r.revision,'operation',operation,'generation',(r.state->>'generation')::BIGINT);
END $$;
CREATE FUNCTION claim_moderated_dance_owned_cleanup_v1(p_token TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE disposition dance_moderated_media_dispositions_v1; u dance_moderated_uploads_v1; work dance_moderated_processing_v1;
 s dance_moderated_sessions_v1; intent RECORD; selected RECORD; abandoned RECORD; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media cleanup unavailable' USING ERRCODE='DRV02'; END IF;
 -- Close abandoned pre-review captures using the same account/fence/session
 -- lock order as intake and sealing. Expiry closes eligibility, never proves a
 -- writer did not submit. Predictable private keys were registered pre-bytes;
 -- their conditional fences must still complete, and provider liabilities stay.
 FOR abandoned IN SELECT session.session_id,session.account_id FROM dance_moderated_sessions_v1 session
 JOIN users account ON account.user_id=session.account_id
 JOIN dance_review_account_fences_v1 fence ON fence.account_id=session.account_id
 WHERE session.state IN('created','consented','awaiting_upload')
 AND (session.expires_at<=now_at OR fence.erasing OR fence.revision<>session.capture_account_fence OR account.status<>'active')
 AND NOT EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 review WHERE review.session_id=session.session_id)
 ORDER BY session.expires_at,session.session_id LIMIT 20 LOOP
  PERFORM 1 FROM users WHERE user_id=abandoned.account_id FOR UPDATE;
  PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=abandoned.account_id FOR UPDATE;
  SELECT * INTO s FROM dance_moderated_sessions_v1 WHERE session_id=abandoned.session_id FOR UPDATE SKIP LOCKED;
  IF s.session_id IS NULL OR s.state NOT IN('created','consented','awaiting_upload')
  OR EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 review WHERE review.session_id=s.session_id)
  OR NOT (s.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM users account JOIN dance_review_account_fences_v1 fence ON fence.account_id=account.user_id
   WHERE account.user_id=s.account_id AND (account.status<>'active' OR fence.erasing OR fence.revision<>s.capture_account_fence))) THEN CONTINUE; END IF;
  UPDATE dance_moderated_sessions_v1 SET state='terminal' WHERE session_id=s.session_id;
  DELETE FROM dance_moderated_active_slots_v1 WHERE session_id=s.session_id;
 END LOOP;
 -- A consumed cleanup claim never regains a fresh PUT grant, even when its
 -- acknowledgement or storage outcome is unknown. Recovery observes its fence.
 FOR intent IN SELECT i.*,r.session_id FROM dance_moderated_review_intents_v1 i JOIN dance_moderated_reviews_v1 r USING(review_id)
 WHERE i.kind IN('cleanup_review','cleanup_temporary','hold_review') AND i.status='pending' AND (i.kind<>'hold_review' OR i.deadline_at<=clock_timestamp()) ORDER BY i.created_at,i.intent_key LIMIT 20 LOOP
  UPDATE dance_moderated_media_dispositions_v1 d SET state='pending',dispose_by=coalesce(intent.deadline_at,clock_timestamp())
  FROM dance_moderated_uploads_v1 upload WHERE upload.session_id=intent.session_id AND d.upload_id=upload.upload_id
  AND d.state='held' AND (intent.kind IN('cleanup_review','hold_review') AND d.kind IN('ingress','original') OR intent.kind IN('cleanup_temporary','hold_review') AND d.kind='derived');
 END LOOP;
 UPDATE dance_moderated_media_dispositions_v1 d SET state='pending' FROM dance_moderated_uploads_v1 upload JOIN dance_moderated_sessions_v1 session USING(session_id)
 LEFT JOIN dance_moderated_reviews_v1 review USING(session_id) WHERE d.upload_id=upload.upload_id AND d.state='held' AND session.state='terminal'
 AND (d.kind<>'original' OR review.review_id IS NULL OR review.state->>'publication'<>'pending' OR (review.state->>'transferDeadlineMs')::NUMERIC<=extract(epoch FROM clock_timestamp())*1000)
 AND (review.status IS DISTINCT FROM 'held' OR EXISTS(SELECT 1 FROM dance_moderated_review_intents_v1 hold_intent WHERE hold_intent.review_id=review.review_id AND hold_intent.kind='hold_review' AND hold_intent.deadline_at<=clock_timestamp()));
 SELECT d.upload_id,d.kind INTO selected FROM dance_moderated_media_dispositions_v1 d
 JOIN dance_moderated_uploads_v1 upload USING(upload_id) JOIN dance_moderated_sessions_v1 session USING(session_id)
 LEFT JOIN dance_moderated_processing_v1 processing USING(upload_id)
 WHERE d.state IN('pending','running','unknown') AND d.kind IN('ingress','original','derived')
 AND (session.state='terminal' OR d.kind='ingress' AND upload.immutable_object_identity IS NOT NULL)
 AND (d.kind<>'original' OR NOT EXISTS(SELECT 1 FROM dance_moderated_reviews_v1 r WHERE r.session_id=session.session_id AND r.state->>'publication'='pending' AND (r.state->>'transferDeadlineMs')::NUMERIC>extract(epoch FROM clock_timestamp())*1000)) ORDER BY d.last_observed_at NULLS FIRST,d.dispose_by,d.upload_id,d.kind LIMIT 1;
 IF selected.upload_id IS NULL THEN RETURN NULL; END IF;
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=selected.upload_id;
 PERFORM 1 FROM users WHERE user_id=s.account_id FOR UPDATE;
 PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=s.account_id FOR UPDATE;
 PERFORM 1 FROM dance_moderated_sessions_v1 WHERE session_id=s.session_id FOR UPDATE;
 SELECT * INTO STRICT u FROM dance_moderated_uploads_v1 WHERE upload_id=selected.upload_id FOR UPDATE;
 SELECT * INTO work FROM dance_moderated_processing_v1 WHERE upload_id=u.upload_id FOR UPDATE;
 SELECT * INTO disposition FROM dance_moderated_media_dispositions_v1 WHERE upload_id=selected.upload_id AND kind=selected.kind FOR UPDATE SKIP LOCKED;
 IF disposition.upload_id IS NULL OR disposition.state NOT IN('pending','running','unknown') THEN RETURN NULL; END IF;
 UPDATE dance_moderated_source_grants_v1 SET revoked_at=clock_timestamp() WHERE upload_id=u.upload_id AND revoked_at IS NULL;
 DELETE FROM dance_moderated_media_leases_v1 WHERE review_id=s.review_id;
 IF disposition.state='pending' THEN UPDATE dance_moderated_media_dispositions_v1 SET state='running',claim_token=p_token WHERE upload_id=u.upload_id AND kind=disposition.kind; END IF;
 -- An unresolved oldest object cannot starve the other cleanup targets. This
 -- rotates bounded observations, never restores the consumed write grant.
 UPDATE dance_moderated_media_dispositions_v1 SET last_observed_at=clock_timestamp() WHERE upload_id=u.upload_id AND kind=disposition.kind;
 RETURN jsonb_build_object('uploadId',u.upload_id,'kind',disposition.kind,'identity',disposition.identity,'token',coalesce(disposition.claim_token,p_token),'delivery',CASE WHEN disposition.state='pending' THEN 'fresh_grant' ELSE 'recovery_only' END);
END $$;
CREATE FUNCTION finish_moderated_dance_owned_cleanup_v1(p_upload TEXT,p_kind TEXT,p_token TEXT,p_result JSONB) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE d dance_moderated_media_dispositions_v1; expected_keys TEXT[]; observed_keys TEXT[]; complete BOOLEAN;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'media cleanup unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO d FROM dance_moderated_media_dispositions_v1 WHERE upload_id=p_upload AND kind=p_kind AND claim_token=p_token FOR UPDATE;
 IF d.upload_id IS NULL OR d.state NOT IN('running','unknown','completed') THEN RAISE EXCEPTION 'cleanup claim changed' USING ERRCODE='DRV05'; END IF;
 IF (jsonb_typeof(p_result)='object' AND p_result->>'outcome' IN('owned_payload_fenced','unknown') AND jsonb_typeof(p_result->'observations')='array') IS NOT TRUE THEN RAISE EXCEPTION 'cleanup evidence unavailable' USING ERRCODE='DRV06'; END IF;
 complete:=p_result->>'outcome'='owned_payload_fenced';
 IF complete THEN
  IF p_kind='derived' THEN SELECT array_agg(f->'identity'->>'key' ORDER BY f->'identity'->>'key') INTO expected_keys FROM jsonb_array_elements(d.identity->'frames') f;
  ELSE expected_keys:=ARRAY[coalesce(d.identity->>'destination_ref',d.identity->>'key')]; END IF;
  SELECT array_agg(o->>'key' ORDER BY o->>'key') INTO observed_keys FROM jsonb_array_elements(p_result->'observations') o;
  IF expected_keys IS NULL OR array_position(expected_keys,NULL) IS NOT NULL OR observed_keys IS DISTINCT FROM expected_keys
   OR cardinality(expected_keys)<>(CASE WHEN p_kind='derived' THEN 3 ELSE 1 END)
   OR (SELECT count(DISTINCT key) FROM unnest(expected_keys) key)<>cardinality(expected_keys)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'observations') o WHERE (o->>'outcome'='payload_fenced'
    AND jsonb_typeof(o->'version')='string' AND length(o->>'version')>0 AND jsonb_typeof(o->'etag')='string' AND length(o->>'etag')>0) IS NOT TRUE) THEN
   RAISE EXCEPTION 'cleanup evidence unavailable' USING ERRCODE='DRV06';
  END IF;
 END IF;
 IF d.state='completed' THEN
  IF NOT complete OR d.observed_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'immutable cleanup evidence changed' USING ERRCODE='DRV05'; END IF;
  RETURN;
 END IF;
 UPDATE dance_moderated_media_dispositions_v1 SET state=CASE WHEN complete THEN 'completed' ELSE 'unknown' END,
 observed_result=p_result,completed_at=CASE WHEN complete THEN clock_timestamp() ELSE NULL END WHERE upload_id=p_upload AND kind=p_kind;
 -- This only attests owned payload fencing. External processor copies, unknown
 -- requests, and the permanent minimal fence are independent retained custody.
END $$;
CREATE FUNCTION record_moderated_dance_maintenance_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease_ms BIGINT;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'maintenance purposes unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT min((p.operational_profile->>'readinessLeaseMs')::BIGINT) INTO lease_ms FROM dance_review_policy_versions_v1 p
 JOIN dance_review_policy_admissions_v1 a USING(policy_id) WHERE a.accepted AND clock_timestamp()>=a.effective_at AND clock_timestamp()<a.valid_until AND clock_timestamp()>=p.valid_from AND clock_timestamp()<p.valid_until;
 IF lease_ms IS NULL OR lease_ms<=0 THEN RETURN; END IF;
 INSERT INTO dance_moderated_maintenance_readiness_v1 VALUES(TRUE,clock_timestamp(),clock_timestamp()+lease_ms*interval '1 millisecond')
 ON CONFLICT(singleton) DO UPDATE SET observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until;
END $$;
DO $acl$
DECLARE f RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
 REVOKE ALL ON dance_moderated_maintenance_readiness_v1 FROM PUBLIC CASCADE;
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='dance_moderated_maintenance_readiness_v1'::regclass AND a.grantee NOT IN(0,c.relowner) LOOP EXECUTE format('REVOKE ALL ON dance_moderated_maintenance_readiness_v1 FROM %I CASCADE',r.name); END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname IN('next_moderated_dance_review_task_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
