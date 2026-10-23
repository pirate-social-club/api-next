-- Publication links are fresh account-private reads, never additions to old
-- immutable command receipts. Public credit contains only public reference IDs.
CREATE FUNCTION read_owned_moderated_dance_publication_v1(p_account TEXT,p_community TEXT,p_review TEXT)
RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT jsonb_build_object('version','dance-moderated-publication-v1','review_id',r.review_id,
  'status',r.state->>'publication','submission',CASE WHEN h.state='adopted' AND r.state->>'publication'='transferred'
   AND s.submission_id=h.submission_id AND s.actor_user_id=p_account AND s.community_id=p_community
   AND s.audio_reservation_id=h.reservation_id AND s.operation_id=h.operation_id AND s.media_kind='video'
   THEN jsonb_build_object('submission_id',h.submission_id,'href',h.receipt->>'href') ELSE NULL END)
 FROM dance_moderated_reviews_v1 r JOIN users u ON u.user_id=r.account_id
 JOIN dance_review_account_fences_v1 f USING(account_id)
 LEFT JOIN dance_moderated_publication_inputs_v1 h USING(review_id)
 LEFT JOIN media_post_submissions s ON s.submission_id=h.submission_id
 WHERE r.review_id=p_review AND r.community_id=p_community AND r.account_id=p_account
  AND u.status='active' AND NOT f.erasing
$$;

-- Bind public reference credit while the actual private adoption transaction
-- owns the review/input. Later public reads need no private-table authority.
CREATE FUNCTION bind_moderated_dance_post_credit_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE h dance_moderated_publication_inputs_v1; r dance_moderated_reviews_v1;
 reference dance_moderator_reference_revisions_v1; credit JSONB;
BEGIN
 IF TG_OP='UPDATE' AND OLD.start_input->>'input_source'='dance_handoff' THEN
  IF NEW.start_input IS DISTINCT FROM OLD.start_input THEN
   RAISE EXCEPTION 'Dance Post reference credit retained' USING ERRCODE='DRV01';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO h FROM dance_moderated_publication_inputs_v1 WHERE reservation_id=NEW.audio_reservation_id;
 IF h.review_id IS NULL THEN
  IF NEW.start_input ? 'dance_credit' OR NEW.start_input->>'input_source'='dance_handoff' THEN
   RAISE EXCEPTION 'Dance Post credit requires owned input' USING ERRCODE='DRV06';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=h.review_id;
 SELECT * INTO STRICT reference FROM dance_moderator_reference_revisions_v1
 WHERE choreography_id=r.state->'capture'->>'choreographyId'
  AND revision=(r.state->'capture'->>'choreographyRevision')::BIGINT;
 IF h.state<>'stored' OR h.submission_id<>NEW.submission_id OR h.operation_id<>NEW.operation_id
  OR r.account_id<>NEW.actor_user_id OR r.community_id<>NEW.community_id
  OR NEW.author_persona_id IS DISTINCT FROM r.state->'capture'->>'personaId'
  OR NEW.media_kind<>'video' OR NEW.video_intent<>'song_reference'
  OR r.state->>'publication'<>'pending' OR r.state->>'verdict'<>'passed'
  OR h.generation<>(r.state->>'generation')::BIGINT OR clock_timestamp()>=h.deadline_at
  OR reference.song_post_id<>r.state->'capture'->>'songPostId'
  OR reference.audio_revision<>(r.state->'capture'->>'audioRevision')::BIGINT
  OR NEW.start_input IS DISTINCT FROM jsonb_build_object('input_source','dance_handoff','authority_id',r.review_id)
 THEN RAISE EXCEPTION 'Dance Post credit identity changed' USING ERRCODE='DRV06'; END IF;
 credit:=jsonb_build_object('choreography_id',reference.choreography_id,'revision',reference.revision,
  'reference_video_post_id',reference.reference_post_id);
 NEW.start_input:=NEW.start_input||jsonb_build_object('dance_credit',credit);
 RETURN NEW;
END $$;
CREATE TRIGGER media_post_dance_credit_v1 BEFORE INSERT OR UPDATE OF start_input ON media_post_submissions
 FOR EACH ROW EXECUTE FUNCTION bind_moderated_dance_post_credit_v1();

CREATE FUNCTION drain_moderated_dance_publication_intents_v1() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE candidate RECORD; r dance_moderated_reviews_v1; h dance_moderated_publication_inputs_v1;
 completed INTEGER:=0; affected INTEGER; cancelled BOOLEAN;
BEGIN
 IF NOT moderated_dance_media_runtime_v1() THEN RAISE EXCEPTION 'publication maintenance unavailable' USING ERRCODE='42501'; END IF;
 FOR candidate IN SELECT DISTINCT i.review_id,review.account_id FROM dance_moderated_review_intents_v1 i
 JOIN dance_moderated_reviews_v1 review USING(review_id)
 WHERE i.status<>'completed' AND (i.kind='handoff_prepare' OR i.kind='handoff_cancel' AND NOT EXISTS(
  SELECT 1 FROM dance_moderated_publication_inputs_v1 retained_input WHERE retained_input.review_id=i.review_id
  AND retained_input.generation=i.generation AND (retained_input.state<>'cleaned' OR EXISTS(
   SELECT 1 FROM dance_moderated_provider_effects_v1 effect JOIN dance_moderated_uploads_v1 upload USING(upload_id)
   WHERE upload.session_id=review.session_id AND effect.purpose='publication' AND effect.state<>'completed'))))
 ORDER BY i.review_id LIMIT 20 LOOP
  -- Same lifecycle order as release/adoption. This prevents an acknowledgement
  -- racing a fresh generation or fresh provider dispatch.
  PERFORM pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||candidate.account_id,0));
  PERFORM 1 FROM users WHERE user_id=candidate.account_id FOR UPDATE;
  PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=candidate.account_id FOR UPDATE;
  SELECT * INTO STRICT r FROM dance_moderated_reviews_v1 WHERE review_id=candidate.review_id FOR UPDATE;
  SELECT * INTO h FROM dance_moderated_publication_inputs_v1 WHERE review_id=candidate.review_id FOR SHARE;
  -- No pre-pass physical work exists. Acknowledging this logical preparation
  -- is not a receipt for a body copy, provider job or released Post.
  UPDATE dance_moderated_review_intents_v1 SET status='completed',lease_token=NULL,lease_until=NULL,
   disposition=jsonb_build_object('status','logical_preparation_recorded','generation',generation)
   WHERE review_id=r.review_id AND kind='handoff_prepare' AND status<>'completed';
  GET DIAGNOSTICS affected=ROW_COUNT; completed:=completed+affected;
  FOR candidate IN SELECT * FROM dance_moderated_review_intents_v1
   WHERE review_id=r.review_id AND kind='handoff_cancel' AND status<>'completed' ORDER BY generation LOOP
   cancelled:=h.review_id IS NULL OR h.generation<>candidate.generation OR
    h.state='cleaned' AND NOT EXISTS(SELECT 1 FROM dance_moderated_provider_effects_v1 effect
     JOIN dance_moderated_uploads_v1 upload USING(upload_id)
     WHERE upload.session_id=r.session_id AND effect.purpose='publication' AND effect.state<>'completed');
   IF cancelled IS TRUE THEN
    UPDATE dance_moderated_review_intents_v1 SET status='completed',lease_token=NULL,lease_until=NULL,
     disposition=jsonb_build_object('status',CASE WHEN h.review_id IS NULL OR h.generation<>candidate.generation
      THEN 'no_physical_input' ELSE 'input_fenced_and_provider_disposed' END,'generation',candidate.generation)
     WHERE intent_key=candidate.intent_key;
    completed:=completed+1;
    -- The release obligation is closed as cancelled, never as transferred.
    UPDATE dance_moderated_review_intents_v1 SET status='completed',lease_token=NULL,lease_until=NULL,
     disposition=jsonb_build_object('status','cancelled','generation',candidate.generation)
     WHERE review_id=r.review_id AND generation=candidate.generation AND kind='handoff_release' AND status<>'completed';
   END IF;
  END LOOP;
 END LOOP;
 RETURN completed;
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
   'lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1','read_owned_moderated_dance_review_v1','read_owned_moderated_dance_publication_v1','latest_owned_moderated_dance_review_v1','owner_moderated_dance_queue_v1','owner_moderated_dance_detail_v1'];
 ELSIF p_purpose='worker' THEN
  names:=ARRAY['next_moderated_dance_review_task_v1','lock_moderated_dance_review_v1','read_moderated_dance_receipt_v1','moderated_dance_review_facts_v1','commit_moderated_dance_review_v1'];
 ELSIF p_purpose='media' THEN
  names:=ARRAY['announce_moderated_dance_processor_v1','claim_moderated_dance_media_v1','persist_moderated_dance_seal_v1','mark_moderated_dance_media_unknown_v1','attach_moderated_dance_provider_v1','issue_moderated_dance_source_v1','claim_moderated_dance_probe_v1','persist_moderated_dance_probe_v1','claim_moderated_dance_normalization_v1','persist_moderated_dance_normalization_v1','moderated_dance_safety_protocol_v1','load_moderated_dance_sealed_capture_v1','initialize_moderated_dance_review_v1','claim_moderated_dance_reference_media_v1','persist_moderated_dance_reference_segment_v1','record_moderated_dance_reference_provider_v1','claim_moderated_dance_reference_normalization_v1','attach_moderated_dance_reference_provider_v1','issue_moderated_dance_reference_source_v1','publish_moderated_dance_reference_v1','claim_moderated_dance_owned_cleanup_v1','finish_moderated_dance_owned_cleanup_v1','record_moderated_dance_maintenance_v1','claim_moderated_dance_provider_cleanup_v1','identify_moderated_dance_provider_cleanup_v1','finish_moderated_dance_provider_cleanup_v1','drain_moderated_dance_replay_v1','bind_moderated_dance_replay_keys_v1','claim_moderated_dance_public_reindex_v1','finish_moderated_dance_public_reindex_v1','drain_moderated_dance_compatible_replay_v1','moderated_dance_publication_input_v1','claim_moderated_dance_publication_cleanup_v1','finish_moderated_dance_publication_cleanup_v1','claim_moderated_dance_publication_v1','drain_moderated_dance_publication_intents_v1','moderated_dance_publication_provider_v1'];
 ELSIF p_purpose='erasure' THEN names:=ARRAY['begin_moderated_dance_account_erasure_v1'];
 ELSIF p_purpose='source_gateway' THEN names:=ARRAY['resolve_moderated_dance_source_v1','resolve_moderated_dance_reference_source_v1','resolve_moderated_dance_publication_source_v1'];
 ELSE RAISE EXCEPTION 'unknown runtime purpose' USING ERRCODE='DRV06'; END IF;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace AND p.proname=ANY(names) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',f.signature,p_role);found_count:=found_count+1;
 END LOOP;
 IF found_count<>cardinality(names) THEN RAISE EXCEPTION 'exact purpose function closure incomplete' USING ERRCODE='DRV06'; END IF;
 IF p_purpose<>'source_gateway' THEN INSERT INTO dance_moderated_runtime_roles_v1 VALUES(target.oid,p_purpose) ON CONFLICT DO NOTHING; END IF;
END $$;

DO $acl$ DECLARE f RECORD; trusted TEXT:=current_schema(); role_row RECORD; acl_role RECORD; BEGIN
 FOR f IN SELECT oid,proowner,oid::regprocedure signature FROM pg_proc WHERE pronamespace=trusted::regnamespace
 AND proname IN('read_owned_moderated_dance_publication_v1','bind_moderated_dance_post_credit_v1',
  'drain_moderated_dance_publication_intents_v1','grant_moderated_dance_runtime_v1') LOOP
  EXECUTE format('ALTER FUNCTION %s SET search_path=%I,pg_catalog,pg_temp',f.signature,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',f.signature);
  FOR acl_role IN SELECT DISTINCT pg_get_userbyid(a.grantee) name
   FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
   WHERE a.grantee NOT IN(0,f.proowner) LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I CASCADE',f.signature,acl_role.name);
  END LOOP;
 END LOOP;
 FOR role_row IN SELECT DISTINCT pg_get_userbyid(role_oid) name,purpose FROM dance_moderated_runtime_roles_v1
 WHERE purpose IN('account','media') LOOP
  PERFORM grant_moderated_dance_runtime_v1(role_row.name,role_row.purpose);
 END LOOP;
END $acl$;
