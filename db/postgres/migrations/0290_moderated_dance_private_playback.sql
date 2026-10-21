-- Audience/account-bound leases. No R2 URL is a browser authorization token.
CREATE FUNCTION issue_moderated_dance_media_lease_v1(p_actor TEXT,p_community TEXT,p_review TEXT,p_revision BIGINT,p_audience TEXT,p_lease TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r dance_moderated_reviews_v1; s dance_moderated_sessions_v1; f dance_review_account_fences_v1; owner community_role_assignments;
 now_at TIMESTAMPTZ:=clock_timestamp(); until_at TIMESTAMPTZ; profile JSONB;
BEGIN
 IF NOT moderated_dance_account_runtime_v1() THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE review_id=p_review AND community_id=p_community;
 IF r.review_id IS NULL THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
 PERFORM 1 FROM users WHERE user_id IN(p_actor,r.account_id) ORDER BY user_id FOR UPDATE;
 SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=r.account_id FOR UPDATE;
 SELECT * INTO s FROM dance_moderated_sessions_v1 WHERE session_id=r.session_id FOR UPDATE;
 SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE review_id=p_review FOR UPDATE;
 profile:=s.terms->'profile';
 IF p_lease !~ '^[A-Za-z0-9_-]{43}$' OR NOT EXISTS(SELECT 1 FROM users WHERE user_id=p_actor AND status='active')
 OR f.erasing OR f.revision<>s.capture_account_fence OR r.revision<>p_revision OR r.status NOT IN('uploaded','screening','awaiting_review')
 OR now_at>=r.review_deadline OR NOT active_activity_persona(r.account_id,s.persona_id,r.community_id)
 OR NOT EXISTS(SELECT 1 FROM dance_moderated_review_evidence_v1 e WHERE e.review_id=r.review_id AND e.safety_status='accepted' AND e.integrity_status='unique' AND can_account_view_content_rating_v1(p_actor,e.content_rating)) THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
 IF p_audience='dancer' THEN
  IF p_actor<>r.account_id THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
 ELSIF p_audience='owner' THEN
  IF NOT can_owner_read_moderated_dance_v1(p_actor,p_review) THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
  SELECT * INTO STRICT owner FROM community_role_assignments WHERE community_id=p_community AND role='owner' AND status='active' AND account_id=p_actor FOR SHARE;
 ELSE RAISE EXCEPTION 'invalid media audience' USING ERRCODE='DRV06'; END IF;
 IF NOT charge_moderated_dance_intake_v1(p_actor,profile,TRUE,FALSE) THEN RAISE EXCEPTION 'private media budget reached' USING ERRCODE='DRV07'; END IF;
 until_at:=least(r.review_deadline,now_at+((profile->>'mediaLeaseMs')::BIGINT*interval '1 millisecond'),CASE WHEN r.submitted_at IS NULL THEN s.expires_at ELSE r.review_deadline END);
 IF until_at IS NULL OR until_at<=now_at THEN RAISE EXCEPTION 'private media unavailable' USING ERRCODE='DRV02'; END IF;
 INSERT INTO dance_moderated_media_leases_v1 VALUES(p_lease,p_review,p_actor,p_audience,owner.role_assignment_id,owner.authority_revision,s.capture_account_fence,now_at,until_at);
 RETURN jsonb_build_object('version','dance-private-media-access-v1','lease_id',p_lease,'expires_at_ms',floor(extract(epoch FROM until_at)*1000)::BIGINT,
 'url','/api/communities/'||p_community||'/dance/reviews/'||p_review||'/media/'||p_lease);
END $$;
CREATE FUNCTION resolve_moderated_dance_media_lease_v1(p_actor TEXT,p_community TEXT,p_review TEXT,p_lease TEXT,p_charge BOOLEAN) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lease dance_moderated_media_leases_v1; r dance_moderated_reviews_v1; s dance_moderated_sessions_v1; u dance_moderated_uploads_v1; f dance_review_account_fences_v1;
BEGIN
 IF NOT moderated_dance_account_runtime_v1() THEN RETURN NULL; END IF;
 SELECT * INTO lease FROM dance_moderated_media_leases_v1 WHERE lease_id=p_lease AND review_id=p_review AND actor_account_id=p_actor;
 SELECT * INTO r FROM dance_moderated_reviews_v1 WHERE review_id=p_review AND community_id=p_community;
 SELECT * INTO s FROM dance_moderated_sessions_v1 WHERE session_id=r.session_id;
 SELECT * INTO u FROM dance_moderated_uploads_v1 WHERE session_id=s.session_id;
 SELECT * INTO f FROM dance_review_account_fences_v1 WHERE account_id=r.account_id;
 IF lease.lease_id IS NULL OR r.review_id IS NULL OR lease.expires_at<=clock_timestamp() OR r.review_deadline<=clock_timestamp()
 OR r.status NOT IN('uploaded','screening','awaiting_review') OR r.submitted_at IS NULL AND s.expires_at<=clock_timestamp()
 OR f.erasing OR f.revision IS DISTINCT FROM lease.capture_account_fence OR f.revision IS DISTINCT FROM s.capture_account_fence
 OR NOT EXISTS(SELECT 1 FROM users WHERE user_id=p_actor AND status='active') OR NOT EXISTS(SELECT 1 FROM users WHERE user_id=r.account_id AND status='active')
 OR EXISTS(SELECT 1 FROM dance_review_account_fences_v1 own_fence WHERE own_fence.account_id=p_actor AND own_fence.erasing)
 OR NOT active_activity_persona(r.account_id,s.persona_id,r.community_id) OR u.state<>'sealed'
 OR NOT EXISTS(SELECT 1 FROM dance_moderated_review_evidence_v1 e WHERE e.review_id=r.review_id AND e.safety_status='accepted' AND e.integrity_status='unique' AND can_account_view_content_rating_v1(p_actor,e.content_rating)) THEN RETURN NULL; END IF;
 IF lease.audience='dancer' AND p_actor<>r.account_id OR lease.audience='owner' AND (NOT can_owner_read_moderated_dance_v1(p_actor,p_review) OR NOT EXISTS(SELECT 1 FROM community_role_assignments owner WHERE owner.role_assignment_id=lease.owner_assignment_id AND owner.authority_revision=lease.owner_assignment_revision AND owner.account_id=p_actor AND owner.community_id=p_community AND owner.role='owner' AND owner.status='active')) THEN RETURN NULL; END IF;
 IF p_charge AND NOT charge_moderated_dance_intake_v1(p_actor,s.terms->'profile',TRUE,FALSE) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('expiresAtMs',floor(extract(epoch FROM lease.expires_at)*1000)::BIGINT,'object',jsonb_build_object('key',u.immutable_object_identity->>'destination_ref','identity','upload_version','version',u.immutable_object_identity->>'version','etag',u.immutable_object_identity->>'etag','size',(u.immutable_object_identity->>'size_bytes')::BIGINT,'contentType',u.content_type,'canonicalSha256',u.server_sha256));
END $$;
DO $acl$
DECLARE f RECORD;r RECORD;trusted TEXT:=current_schema();
BEGIN
 FOR f IN SELECT p.oid,p.proowner,p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=trusted::regnamespace AND p.proname IN('issue_moderated_dance_media_lease_v1','resolve_moderated_dance_media_lease_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR r IN SELECT DISTINCT pg_get_userbyid(a.grantee) name FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a WHERE a.grantee NOT IN(0,f.proowner) LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,r.name); END LOOP;
 END LOOP;
END $acl$;
