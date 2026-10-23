-- A retained one-shot CAS grant closes every independent input writer before
-- cleanup is acknowledged. No object is deleted to an empty key. Adopted inputs
-- belong to the ordinary Post pipeline and cannot enter this cleanup journal.
CREATE TABLE dance_moderated_publication_cleanup_v1 (
 review_id TEXT PRIMARY KEY REFERENCES dance_moderated_publication_inputs_v1,
 fence_token TEXT NOT NULL UNIQUE CHECK(btrim(fence_token)<>'' AND length(fence_token)<=192),
 granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 observed_at TIMESTAMPTZ, observation JSONB,
 CHECK((observed_at IS NULL)=(observation IS NULL))
);
CREATE FUNCTION guard_dance_publication_cleanup_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR ROW(NEW.review_id,NEW.fence_token,NEW.granted_at)
  IS DISTINCT FROM ROW(OLD.review_id,OLD.fence_token,OLD.granted_at)
  OR OLD.observation->>'outcome'='fenced'
 THEN RAISE EXCEPTION 'publication cleanup identity retained' USING ERRCODE='DRV01'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_publication_cleanup_retained BEFORE UPDATE OR DELETE ON dance_moderated_publication_cleanup_v1
 FOR EACH ROW EXECUTE FUNCTION guard_dance_publication_cleanup_v1();
CREATE TRIGGER dance_publication_cleanup_no_truncate BEFORE TRUNCATE ON dance_moderated_publication_cleanup_v1
 FOR EACH STATEMENT EXECUTE FUNCTION reject_dance_review_history_v1();

CREATE FUNCTION claim_moderated_dance_publication_cleanup_v1(p_token TEXT) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE h dance_moderated_publication_inputs_v1; j dance_moderated_publication_cleanup_v1;
 packet JSONB; fresh BOOLEAN:=FALSE;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'publication cleanup unavailable' USING ERRCODE='42501'; END IF;
 IF coalesce(btrim(p_token),'')='' OR length(p_token)>192 THEN RAISE EXCEPTION 'cleanup token invalid' USING ERRCODE='DRV06'; END IF;
 -- Select only. The protocol below acquires recipient/user/fence/review/input
 -- locks in the same order as adoption, avoiding an input-first deadlock.
 SELECT i.* INTO h FROM dance_moderated_publication_inputs_v1 i
 JOIN dance_moderated_reviews_v1 r USING(review_id)
 JOIN users a ON a.user_id=r.account_id
 JOIN dance_review_account_fences_v1 f ON f.account_id=r.account_id
 LEFT JOIN dance_moderated_publication_cleanup_v1 cleanup_row USING(review_id)
 WHERE i.state IN('preparing','stored','cleanup') AND
  (i.state='cleanup' OR i.deadline_at<=clock_timestamp() OR r.state->>'publication'<>'pending'
   OR r.state->>'showPublicly'<>'true' OR a.status<>'active' OR f.erasing
   OR f.revision<>(r.state->'capture'->>'accountFenceRevision')::BIGINT)
 ORDER BY cleanup_row.observed_at NULLS FIRST,i.deadline_at,i.review_id LIMIT 1;
 IF h.review_id IS NULL THEN RETURN NULL; END IF;
 packet:=moderated_dance_publication_input_v1(h.review_id,'cleanup',jsonb_build_object('token',h.token));
 IF packet IS NULL OR packet->>'status'<>'cleanup' THEN RETURN NULL; END IF;
 INSERT INTO dance_moderated_publication_cleanup_v1(review_id,fence_token)
 VALUES(h.review_id,p_token) ON CONFLICT(review_id) DO NOTHING RETURNING TRUE INTO fresh;
 SELECT * INTO STRICT j FROM dance_moderated_publication_cleanup_v1 WHERE review_id=h.review_id;
 RETURN jsonb_build_object('reviewId',h.review_id,'key',packet->>'key','body',packet->'body','plan',packet->'plan',
  'inputToken',h.token,'fenceToken',j.fence_token,'delivery',CASE WHEN coalesce(fresh,FALSE) THEN 'fresh_grant' ELSE 'recovery_only' END);
END $$;

CREATE FUNCTION finish_moderated_dance_publication_cleanup_v1(p_review TEXT,p_token TEXT,p_result JSONB) RETURNS JSONB
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE h dance_moderated_publication_inputs_v1; j dance_moderated_publication_cleanup_v1; packet JSONB;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'publication cleanup unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT h FROM dance_moderated_publication_inputs_v1 WHERE review_id=p_review;
 -- The same lifecycle locks serialize cleanup against adoption/erasure.
 packet:=moderated_dance_publication_input_v1(p_review,'cleanup',jsonb_build_object('token',h.token));
 SELECT * INTO STRICT j FROM dance_moderated_publication_cleanup_v1 WHERE review_id=p_review FOR UPDATE;
 IF j.fence_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'cleanup identity changed' USING ERRCODE='DRV05'; END IF;
 IF j.observation->>'outcome'='fenced' THEN
  IF j.observation IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'cleanup receipt changed' USING ERRCODE='DRV05'; END IF;
  RETURN jsonb_build_object('status','cleaned');
 END IF;
 IF packet->>'status' IS DISTINCT FROM 'cleanup' THEN RAISE EXCEPTION 'cleanup no longer owns input' USING ERRCODE='DRV05'; END IF;
 IF (p_result=jsonb_build_object('outcome','unknown')) IS NOT TRUE AND
  (p_result->>'outcome'='fenced' AND p_result->>'key'=h.destination_key AND p_result->>'fenceToken'=j.fence_token
   AND coalesce(p_result->>'version','')<>'' AND coalesce(p_result->>'etag','')<>''
   AND p_result->>'size'=octet_length('{"version":"dance-publication-erasure-fence-v1"}')::TEXT
   AND p_result-ARRAY['outcome','key','fenceToken','version','etag','size']='{}'::JSONB) IS NOT TRUE
 THEN RAISE EXCEPTION 'cleanup storage observation invalid' USING ERRCODE='DRV06'; END IF;
 UPDATE dance_moderated_publication_cleanup_v1 SET observation=p_result,observed_at=clock_timestamp() WHERE review_id=p_review;
 IF p_result->>'outcome'='fenced' THEN
  RETURN moderated_dance_publication_input_v1(p_review,'cleaned',jsonb_build_object('token',h.token,'keyFenced',TRUE));
 END IF;
 RETURN jsonb_build_object('status','unknown');
END $$;

CREATE OR REPLACE FUNCTION record_moderated_dance_maintenance_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease_ms BIGINT; now_at TIMESTAMPTZ:=clock_timestamp();
BEGIN
 IF NOT moderated_dance_media_runtime_v1() OR NOT dance_review_worker_authorized_v1() THEN RAISE EXCEPTION 'maintenance purposes unavailable' USING ERRCODE='DRV02'; END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect
  LEFT JOIN dance_moderated_processing_v1 processing ON processing.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_uploads_v1 upload ON upload.upload_id=effect.upload_id
  LEFT JOIN dance_moderated_reviews_v1 review ON review.session_id=upload.session_id
  WHERE effect.state<>'completed' AND CASE WHEN processing.state='held' OR review.status='held' THEN effect.hold_dispose_by ELSE effect.dispose_by END<=now_at) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1;
  DELETE FROM dance_moderated_processor_readiness_v1;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_uploads_v1 WHERE normalized_digest IS NOT NULL AND replay_retired_at IS NULL AND replay_expires_at<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d WHERE d.state IN('pending','running','unknown') AND d.dispose_by<=now_at)
 OR EXISTS(SELECT 1 FROM dance_moderated_media_dispositions_v1 d JOIN dance_moderated_uploads_v1 u USING(upload_id)
 JOIN dance_moderated_reviews_v1 r USING(session_id) JOIN dance_moderated_review_intents_v1 i USING(review_id)
 WHERE d.state='held' AND i.status<>'completed' AND i.deadline_at<=now_at AND
  (i.kind='hold_review' OR i.kind='cleanup_review' AND d.kind IN('ingress','original') OR i.kind='cleanup_temporary' AND d.kind='derived')) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM dance_moderated_publication_inputs_v1 WHERE state='cleanup' OR state IN('preparing','stored') AND deadline_at<=now_at) THEN
  DELETE FROM dance_moderated_maintenance_readiness_v1; DELETE FROM dance_moderated_processor_readiness_v1; RETURN;
 END IF;
 SELECT min((p.operational_profile->>'readinessLeaseMs')::BIGINT) INTO lease_ms FROM dance_review_policy_versions_v1 p
 JOIN dance_review_policy_admissions_v1 a USING(policy_id) WHERE a.accepted AND now_at>=a.effective_at AND now_at<a.valid_until AND now_at>=p.valid_from AND now_at<p.valid_until;
 IF lease_ms IS NULL OR lease_ms<=0 THEN RETURN; END IF;
 INSERT INTO dance_moderated_maintenance_readiness_v1 VALUES(TRUE,now_at,now_at+lease_ms*interval '1 millisecond')
 ON CONFLICT(singleton) DO UPDATE SET observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until;
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
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1','bind_moderated_dance_replay_keys_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1','moderated_dance_publication_input_v1','claim_moderated_dance_publication_cleanup_v1','finish_moderated_dance_publication_cleanup_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

REVOKE ALL ON TABLE dance_moderated_publication_cleanup_v1 FROM PUBLIC;
DO $acl$
DECLARE f RECORD; r RECORD; trusted TEXT:=current_schema();
BEGIN
 FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c,
  LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='dance_moderated_publication_cleanup_v1'::regclass AND a.grantee NOT IN(0,c.relowner)
 LOOP EXECUTE format('REVOKE ALL ON TABLE dance_moderated_publication_cleanup_v1 FROM %I CASCADE',r.name); END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
 AND p.proname IN('guard_dance_publication_cleanup_v1','claim_moderated_dance_publication_cleanup_v1',
 'finish_moderated_dance_publication_cleanup_v1','record_moderated_dance_maintenance_v1','grant_moderated_dance_runtime_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
-- Restore only the same purpose-confined existing roles. No raw table grant.
DO $bind$ DECLARE role_row RECORD; BEGIN
 FOR role_row IN SELECT DISTINCT pg_get_userbyid(role_oid) name FROM dance_moderated_runtime_roles_v1 WHERE purpose='media' LOOP
  PERFORM grant_moderated_dance_runtime_v1(role_row.name,'media');
 END LOOP;
END $bind$;
