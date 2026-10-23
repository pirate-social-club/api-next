-- Private Dance only. Register each provider liability in the transaction that
-- consumes its original processing grant. No provider or credential is invoked.
CREATE TABLE dance_moderated_provider_effects_v1 (
 effect_id TEXT PRIMARY KEY,
 upload_id TEXT REFERENCES dance_moderated_uploads_v1,
 choreography_id TEXT REFERENCES dance_moderated_reference_commands_v1(choreography_id),
 purpose TEXT NOT NULL CHECK(purpose IN('probe','normalization')),
 provider TEXT NOT NULL CHECK(provider IN('cloudconvert','qencode')),
 provider_tag TEXT, provider_job_id TEXT,
 terms_hash TEXT NOT NULL CHECK(terms_hash~'^[a-f0-9]{64}$'),
 work_deadline TIMESTAMPTZ NOT NULL, dispose_by TIMESTAMPTZ NOT NULL,
 hold_dispose_by TIMESTAMPTZ NOT NULL, lease_ms BIGINT NOT NULL CHECK(lease_ms>0),
 state TEXT NOT NULL DEFAULT 'registered' CHECK(state IN('registered','leased','unknown','completed')),
 claim_token TEXT, lease_until TIMESTAMPTZ, last_observed_at TIMESTAMPTZ,
 observed_result JSONB, completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((upload_id IS NULL)<>(choreography_id IS NULL)),
 CHECK(provider<>'cloudconvert' OR provider_tag IS NOT NULL),
 CHECK(dispose_by>=work_deadline AND hold_dispose_by>=dispose_by),
 CHECK((state='completed')=(completed_at IS NOT NULL)),
 UNIQUE(upload_id,purpose), UNIQUE(choreography_id,purpose)
);
CREATE INDEX dance_moderated_provider_effects_cleanup_v1
 ON dance_moderated_provider_effects_v1(last_observed_at,dispose_by,effect_id) WHERE state<>'completed';

CREATE FUNCTION register_moderated_dance_provider_effect_v1(
 p_upload TEXT,p_choreography TEXT,p_purpose TEXT,p_provider TEXT,p_tag TEXT,p_job TEXT,
 p_terms TEXT,p_deadline TIMESTAMPTZ,p_disposition JSONB,p_profile JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE identity TEXT:=CASE WHEN p_upload IS NULL THEN 'reference:'||p_choreography ELSE 'attempt:'||p_upload END||':'||p_purpose;
 old dance_moderated_provider_effects_v1; dispose_at TIMESTAMPTZ;
BEGIN
 dispose_at:=p_deadline+(p_disposition->>'temporaryCleanupWithinMs')::BIGINT*interval '1 millisecond';
 SELECT * INTO old FROM dance_moderated_provider_effects_v1 WHERE effect_id=identity FOR UPDATE;
 IF old.effect_id IS NOT NULL THEN
  IF ROW(old.upload_id,old.choreography_id,old.purpose,old.provider,old.provider_tag,old.terms_hash,old.work_deadline)
    IS DISTINCT FROM ROW(p_upload,p_choreography,p_purpose,p_provider,p_tag,p_terms,p_deadline)
   OR old.provider_job_id IS NOT NULL AND p_job IS NOT NULL AND old.provider_job_id<>p_job THEN
   RAISE EXCEPTION 'provider effect identity changed' USING ERRCODE='DRV05';
  END IF;
  IF old.provider_job_id IS NULL AND p_job IS NOT NULL THEN
   UPDATE dance_moderated_provider_effects_v1 SET provider_job_id=p_job WHERE effect_id=identity;
  END IF;
  RETURN;
 END IF;
 INSERT INTO dance_moderated_provider_effects_v1(effect_id,upload_id,choreography_id,purpose,provider,provider_tag,provider_job_id,terms_hash,work_deadline,dispose_by,hold_dispose_by,lease_ms)
 VALUES(identity,p_upload,p_choreography,p_purpose,p_provider,p_tag,p_job,p_terms,p_deadline,dispose_at,
  to_timestamp((p_disposition->'hold'->>'disposeByMs')::NUMERIC/1000),(p_profile->>'workLeaseMs')::BIGINT);
END $$;

CREATE FUNCTION capture_moderated_dance_attempt_provider_effects_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE s dance_moderated_sessions_v1;
BEGIN
 SELECT session.* INTO STRICT s FROM dance_moderated_sessions_v1 session JOIN dance_moderated_uploads_v1 upload USING(session_id) WHERE upload.upload_id=NEW.upload_id;
 IF NEW.probe_phase<>'unclaimed' THEN
  PERFORM register_moderated_dance_provider_effect_v1(NEW.upload_id,NULL,'probe','qencode',NULL,NEW.probe_attempt->>'providerJobId',
   s.terms_hash,NEW.provider_deadline,s.terms->'disposition',s.terms->'profile');
 END IF;
 IF NEW.normalization_claimed_at IS NOT NULL THEN
  PERFORM register_moderated_dance_provider_effect_v1(NEW.upload_id,NULL,'normalization','cloudconvert',NEW.provider_tag,NEW.provider_job_id,
   s.terms_hash,NEW.provider_deadline,s.terms->'disposition',s.terms->'profile');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_moderated_dance_attempt_provider_effects_v1
 AFTER INSERT OR UPDATE ON dance_moderated_processing_v1 FOR EACH ROW
 EXECUTE FUNCTION capture_moderated_dance_attempt_provider_effects_v1();

CREATE FUNCTION capture_moderated_dance_reference_provider_effect_v1() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE policy dance_review_policy_versions_v1;
BEGIN
 IF NEW.normalization_claimed_at IS NOT NULL THEN
  SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=NEW.policy_id;
  PERFORM register_moderated_dance_provider_effect_v1(NULL,NEW.choreography_id,'normalization','cloudconvert',NEW.provider_tag,NEW.provider_job_id,
   policy.policy_hash,NEW.worker_deadline,policy.disposition_profile,policy.operational_profile);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_moderated_dance_reference_provider_effect_v1
 AFTER INSERT OR UPDATE ON dance_moderated_reference_commands_v1 FOR EACH ROW
 EXECUTE FUNCTION capture_moderated_dance_reference_provider_effect_v1();

-- An upgrade retains every already consumed purpose, including unknown Qencode
-- allocation/START and unknown CloudConvert creation. No empty lookup can close it.
DO $backfill$
DECLARE work RECORD; policy RECORD;
BEGIN
 FOR work IN SELECT processing.*,session.terms,session.terms_hash FROM dance_moderated_processing_v1 processing
  JOIN dance_moderated_uploads_v1 upload USING(upload_id) JOIN dance_moderated_sessions_v1 session USING(session_id) LOOP
  IF work.probe_phase<>'unclaimed' THEN
   PERFORM register_moderated_dance_provider_effect_v1(work.upload_id,NULL,'probe','qencode',NULL,work.probe_attempt->>'providerJobId',work.terms_hash,work.provider_deadline,work.terms->'disposition',work.terms->'profile');
  END IF;
  IF work.normalization_claimed_at IS NOT NULL THEN
   PERFORM register_moderated_dance_provider_effect_v1(work.upload_id,NULL,'normalization','cloudconvert',work.provider_tag,work.provider_job_id,work.terms_hash,work.provider_deadline,work.terms->'disposition',work.terms->'profile');
  END IF;
 END LOOP;
 FOR work IN SELECT * FROM dance_moderated_reference_commands_v1 WHERE normalization_claimed_at IS NOT NULL LOOP
  SELECT * INTO STRICT policy FROM dance_review_policy_versions_v1 WHERE policy_id=work.policy_id;
  PERFORM register_moderated_dance_provider_effect_v1(NULL,work.choreography_id,'normalization','cloudconvert',work.provider_tag,work.provider_job_id,policy.policy_hash,work.worker_deadline,policy.disposition_profile,policy.operational_profile);
 END LOOP;
END $backfill$;

CREATE FUNCTION claim_moderated_dance_provider_cleanup_v1(p_token TEXT) RETURNS JSONB
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
 AND (effect.work_deadline<=now_at OR processing.state IN('screened','failed','held') OR session.state='terminal' OR reference.state IN('ready','failed'))
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
  AND (effect.work_deadline<=clock_timestamp() OR processing.state IN('screened','failed','held') OR session.state='terminal' OR reference.state IN('ready','failed'))
  AND ((processing.state IS DISTINCT FROM 'held' AND review.status IS DISTINCT FROM 'held') OR effect.hold_dispose_by<=clock_timestamp())) THEN RETURN NULL; END IF;
 UPDATE dance_moderated_provider_effects_v1 SET state='leased',claim_token=p_token,
  lease_until=clock_timestamp()+lease_ms*interval '1 millisecond',last_observed_at=clock_timestamp() WHERE effect_id=item.effect_id;
 RETURN jsonb_build_object('effectId',item.effect_id,'provider',item.provider,'tag',item.provider_tag,'jobId',item.provider_job_id,'token',p_token);
END $$;

CREATE FUNCTION identify_moderated_dance_provider_cleanup_v1(p_effect TEXT,p_token TEXT,p_job TEXT,p_tag TEXT) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'provider cleanup unavailable' USING ERRCODE='DRV02'; END IF;
 UPDATE dance_moderated_provider_effects_v1 SET provider_job_id=p_job
 WHERE effect_id=p_effect AND claim_token=p_token AND state='leased' AND lease_until>clock_timestamp()
 AND provider='cloudconvert' AND provider_tag=p_tag AND p_job~'^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$'
 AND (provider_job_id IS NULL OR provider_job_id=p_job);
 IF NOT FOUND THEN RAISE EXCEPTION 'provider cleanup identity changed' USING ERRCODE='DRV05'; END IF;
END $$;

CREATE FUNCTION finish_moderated_dance_provider_cleanup_v1(p_effect TEXT,p_token TEXT,p_result JSONB) RETURNS VOID
 LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE item dance_moderated_provider_effects_v1; complete BOOLEAN;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'provider cleanup unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO item FROM dance_moderated_provider_effects_v1 WHERE effect_id=p_effect AND claim_token=p_token AND state='leased' FOR UPDATE;
 IF item.effect_id IS NULL THEN RAISE EXCEPTION 'provider cleanup observation changed' USING ERRCODE='DRV05'; END IF;
 IF (jsonb_typeof(p_result)='object' AND p_result->>'outcome' IN('deleted','observed_absent','unknown')
  AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) key WHERE key NOT IN('outcome','jobId','tag','reason'))
  AND (p_result->>'reason' IS NULL OR p_result->>'reason' IN('route_unavailable','identity_unresolved','identity_mismatch','provider_unknown'))) IS NOT TRUE THEN
  RAISE EXCEPTION 'provider cleanup proof invalid' USING ERRCODE='DRV06';
 END IF;
 complete:=p_result->>'outcome' IN('deleted','observed_absent');
 IF complete AND (item.provider='cloudconvert' AND item.provider_job_id IS NOT NULL AND p_result->>'jobId'=item.provider_job_id AND p_result->>'tag'=item.provider_tag) IS NOT TRUE THEN
  RAISE EXCEPTION 'provider cleanup proof unbound' USING ERRCODE='DRV06';
 END IF;
 UPDATE dance_moderated_provider_effects_v1 SET state=CASE WHEN complete THEN 'completed' ELSE 'unknown' END,
  observed_result=p_result,completed_at=CASE WHEN complete THEN clock_timestamp() ELSE NULL END,last_observed_at=clock_timestamp()
 WHERE effect_id=item.effect_id;
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
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

DO $acl$
DECLARE f RECORD; grantee RECORD; trusted TEXT:=current_schema();
BEGIN
 REVOKE ALL ON dance_moderated_provider_effects_v1 FROM PUBLIC CASCADE;
 FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM pg_class c
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid='dance_moderated_provider_effects_v1'::regclass AND a.grantee NOT IN(0,c.relowner) LOOP
  EXECUTE format('REVOKE ALL ON dance_moderated_provider_effects_v1 FROM %I CASCADE',grantee.name);
 END LOOP;
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace
  AND p.proname IN('register_moderated_dance_provider_effect_v1','capture_moderated_dance_attempt_provider_effects_v1','capture_moderated_dance_reference_provider_effect_v1',
   'claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR grantee IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,grantee.name);
  END LOOP;
 END LOOP;
END $acl$;
