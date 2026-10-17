-- UNAPPLIED, UNNUMBERED candidate. Parent-operated control plane only.
-- Actual duplicate persisted video bindings must be preflighted before this unique index.
CREATE UNIQUE INDEX media_video_owned_post_v1_uidx ON media_post_submissions(post_id)
 WHERE media_kind='video' AND post_id IS NOT NULL;

-- Apply only after fixed producer/terminal fences, with independently reviewed ACLs.
-- No Worker/Jobs role may write these audit tables or invoke the materializer.
CREATE INDEX media_video_alias_inventory_order_v1_idx
 ON media_post_submissions(created_at,post_id) WHERE media_kind='video' AND status='published';

CREATE TABLE video_alias_audit_runs_v1 (
 run_id UUID PRIMARY KEY,
 plan_sha256 TEXT NOT NULL CHECK(plan_sha256~'^[0-9a-f]{64}$'),
 mode TEXT NOT NULL CHECK(mode IN('inventory','materialize')),
 upper_created_at TIMESTAMPTZ, upper_post_id TEXT,
 cursor_created_at TIMESTAMPTZ, cursor_post_id TEXT,
 complete BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((upper_created_at IS NULL)=(upper_post_id IS NULL)),
 CHECK((cursor_created_at IS NULL)=(cursor_post_id IS NULL))
);
CREATE TABLE video_alias_audit_items_v1 (
 run_id UUID NOT NULL REFERENCES video_alias_audit_runs_v1,
 submission_id TEXT NOT NULL, operation_id TEXT NOT NULL, post_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN('inserted','already-exact','missing','invalid-key','slug-collision','different-existing-alias','invalid-provenance','unknown')),
 before_binding JSONB NOT NULL, after_binding JSONB NOT NULL,
 receipt_digests JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,submission_id)
);
CREATE INDEX video_alias_audit_unresolved_v1_idx ON video_alias_audit_items_v1(run_id)
 WHERE outcome NOT IN('inserted','already-exact');
CREATE TRIGGER video_alias_audit_items_immutable BEFORE UPDATE OR DELETE ON video_alias_audit_items_v1
 FOR EACH ROW EXECUTE FUNCTION reject_post_slug_alias_mutation();

CREATE FUNCTION guard_video_alias_audit_run_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'video alias audit runs are retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['cursor_created_at','cursor_post_id','complete']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['cursor_created_at','cursor_post_id','complete'])
    OR (OLD.complete AND NEW IS DISTINCT FROM OLD)
    OR (OLD.cursor_created_at IS NOT NULL AND (NEW.cursor_created_at IS NULL OR
       (NEW.cursor_created_at,NEW.cursor_post_id)<(OLD.cursor_created_at,OLD.cursor_post_id)))
    OR (NEW.cursor_created_at,NEW.cursor_post_id)>(NEW.upper_created_at,NEW.upper_post_id) THEN
   RAISE EXCEPTION 'video alias audit assignment and checkpoint are immutable/monotonic';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_alias_audit_runs_guard BEFORE UPDATE OR DELETE ON video_alias_audit_runs_v1
 FOR EACH ROW EXECUTE FUNCTION guard_video_alias_audit_run_v1();

CREATE FUNCTION start_video_alias_audit_v1(p_run UUID,p_plan TEXT,p_mode TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE upper_row media_post_submissions%ROWTYPE;
BEGIN
 IF p_mode NOT IN('inventory','materialize') THEN RAISE EXCEPTION 'invalid video alias audit mode'; END IF;
 IF EXISTS(SELECT 1 FROM media_post_submissions WHERE media_kind='video' AND status='published' AND post_id IS NULL) THEN
   RAISE EXCEPTION 'invalid published video identity blocks alias inventory';
 END IF;
 -- Replayed start is an exact immutable assignment, never a new boundary.
 IF EXISTS(SELECT 1 FROM video_alias_audit_runs_v1 WHERE run_id=p_run) THEN
   IF NOT EXISTS(SELECT 1 FROM video_alias_audit_runs_v1 WHERE run_id=p_run AND plan_sha256=p_plan AND mode=p_mode) THEN
     RAISE EXCEPTION 'video alias audit identity mismatch';
   END IF;
   RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='media_post_submissions'::regclass
   AND tgname='media_video_terminal_exact_alias' AND tgenabled='O') THEN
   RAISE EXCEPTION 'fixed publication fence required before alias inventory';
 END IF;
 SELECT * INTO upper_row FROM media_post_submissions WHERE media_kind='video' AND status='published'
 ORDER BY created_at DESC,post_id DESC LIMIT 1;
 INSERT INTO video_alias_audit_runs_v1(run_id,plan_sha256,mode,upper_created_at,upper_post_id,complete)
 VALUES(p_run,p_plan,p_mode,upper_row.created_at,upper_row.post_id,upper_row.post_id IS NULL);
END $$;

CREATE FUNCTION process_video_alias_audit_batch_v1(p_run UUID,p_plan TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE run video_alias_audit_runs_v1%ROWTYPE; s media_post_submissions%ROWTYPE;
 before_row JSONB; after_row JSONB; receipts JSONB; disposition TEXT; n INTEGER:=0;
BEGIN
 SELECT * INTO STRICT run FROM video_alias_audit_runs_v1 WHERE run_id=p_run FOR UPDATE;
 IF run.plan_sha256<>p_plan THEN RAISE EXCEPTION 'video alias audit plan mismatch'; END IF;
 IF run.complete THEN RETURN 0; END IF;
 FOR s IN SELECT * FROM media_post_submissions WHERE media_kind='video' AND status='published'
   AND (run.cursor_created_at IS NULL OR (created_at,post_id)>(run.cursor_created_at,run.cursor_post_id))
   AND (created_at,post_id)<=(run.upper_created_at,run.upper_post_id)
   ORDER BY created_at,post_id LIMIT 50 FOR UPDATE
 LOOP
   SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.slug),'[]') INTO before_row FROM post_slug_aliases a WHERE a.post_id=s.post_id OR a.slug=s.post_id;
   SELECT jsonb_build_object('submission',s.response_snapshot_sha256,'commands',COALESCE(
     (SELECT jsonb_agg(response_snapshot_sha256 ORDER BY endpoint_template,idempotency_key)
       FROM media_submission_command_replays WHERE submission_id=s.submission_id),'[]')) INTO receipts;
   IF s.post_id IS NULL THEN disposition:='invalid-key';
   ELSIF run.mode='materialize' THEN
     BEGIN
       disposition:=ensure_exact_video_receipt_alias_v1(s.submission_id,s.operation_id,s.post_id);
     EXCEPTION WHEN raise_exception THEN disposition:='invalid-provenance'; END;
   ELSE
     disposition:=CASE
       WHEN EXISTS(SELECT 1 FROM post_slug_aliases WHERE slug=s.post_id AND post_id=s.post_id) THEN 'already-exact'
       WHEN EXISTS(SELECT 1 FROM post_slug_aliases WHERE slug=s.post_id AND post_id<>s.post_id) THEN 'slug-collision'
       WHEN EXISTS(SELECT 1 FROM post_slug_aliases WHERE post_id=s.post_id AND slug<>s.post_id) THEN 'different-existing-alias'
       WHEN NOT video_detail_id_safe_v1(s.post_id) OR s.post_id<>normalize(s.post_id,NFKC) OR post_slug_utf16_code_units(s.post_id) NOT BETWEEN 1 AND 80
         OR s.post_id~'[[:space:][:cntrl:]%/\\]' OR s.post_id IN('.','..') THEN 'invalid-key'
       ELSE 'missing' END;
   END IF;
   SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.slug),'[]') INTO after_row FROM post_slug_aliases a WHERE a.post_id=s.post_id OR a.slug=s.post_id;
   INSERT INTO video_alias_audit_items_v1(run_id,submission_id,operation_id,post_id,outcome,before_binding,after_binding,receipt_digests)
   VALUES(p_run,s.submission_id,s.operation_id,s.post_id,disposition,before_row,after_row,receipts);
   UPDATE video_alias_audit_runs_v1 SET cursor_created_at=s.created_at,cursor_post_id=s.post_id WHERE run_id=p_run;
   n:=n+1;
 END LOOP;
 IF n<50 OR EXISTS(SELECT 1 FROM video_alias_audit_runs_v1 WHERE run_id=p_run
   AND (cursor_created_at,cursor_post_id)=(upper_created_at,upper_post_id)) THEN
   UPDATE video_alias_audit_runs_v1 SET complete=TRUE WHERE run_id=p_run;
 END IF;
 RETURN n;
END $$;

-- Private immutable cutover receipt; never a mutable runtime feature flag.
CREATE TABLE video_notification_cutovers_v1 (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 plan_sha256 TEXT NOT NULL CHECK(plan_sha256~'^[0-9a-f]{64}$'),
 alias_run_id UUID NOT NULL REFERENCES video_alias_audit_runs_v1,
 paired_solid_sha256 TEXT NOT NULL CHECK(paired_solid_sha256~'^[0-9a-f]{64}$'),
 cutover_source_sha256 TEXT NOT NULL CHECK(cutover_source_sha256~'^[0-9a-f]{64}$'),
 committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER video_notification_cutovers_immutable BEFORE UPDATE OR DELETE ON video_notification_cutovers_v1
 FOR EACH ROW EXECUTE FUNCTION reject_post_slug_alias_mutation();

-- No SECURITY DEFINER, role creation, owner-membership grants or global default
-- privilege edits. Like the accepted Activity ACL inspection, remove actual
-- named/default grants as well as PUBLIC. Private evidence has NO runtime reader
-- exception. Operator grants are a separate reviewed parent-held step, AFTER
-- this candidate. The owner remains trusted; runtime must not own these objects,
-- be superuser or inherit their owner (an explicit final-role-review condition).
DO $$
DECLARE object_row RECORD; grant_row RECORD; column_row RECORD; grantee_sql TEXT;
BEGIN
 FOR object_row IN SELECT c.oid,c.relowner,n.nspname,c.relname FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.oid IN('video_alias_audit_runs_v1'::regclass,'video_alias_audit_items_v1'::regclass,
     'video_notification_cutovers_v1'::regclass)
 LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC CASCADE',object_row.nspname,object_row.relname);
   FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c,
     LATERAL aclexplode(c.relacl) acl WHERE c.oid=object_row.oid AND acl.grantee<>0 AND acl.grantee<>c.relowner
   LOOP
     EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I CASCADE',object_row.nspname,object_row.relname,pg_get_userbyid(grant_row.grantee));
   END LOOP;
   -- Table-level REVOKE does not remove independently granted column ACLs.
   FOR column_row IN SELECT a.attname,acl.grantee FROM pg_attribute a,
     LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=object_row.oid AND NOT a.attisdropped
       AND acl.grantee<>object_row.relowner
   LOOP
     grantee_sql:=CASE WHEN column_row.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(column_row.grantee)) END;
     EXECUTE format('REVOKE ALL (%I) ON TABLE %I.%I FROM %s CASCADE',column_row.attname,object_row.nspname,object_row.relname,grantee_sql);
   END LOOP;
 END LOOP;
 FOR object_row IN SELECT p.oid,p.proowner,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.oid IN('start_video_alias_audit_v1(uuid,text,text)'::regprocedure,
     'process_video_alias_audit_batch_v1(uuid,text)'::regprocedure,'guard_video_alias_audit_run_v1()'::regprocedure)
 LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC CASCADE',object_row.nspname,object_row.proname,object_row.args);
   FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_proc p,
     LATERAL aclexplode(p.proacl) acl WHERE p.oid=object_row.oid AND acl.grantee<>0 AND acl.grantee<>p.proowner
   LOOP
     EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I CASCADE',object_row.nspname,object_row.proname,object_row.args,pg_get_userbyid(grant_row.grantee));
   END LOOP;
 END LOOP;
END $$;
