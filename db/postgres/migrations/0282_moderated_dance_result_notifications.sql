-- Prospective source only: same recipient-private inbox and delivery job.
-- A Dance result is its own immutable fact, never a fabricated comment event.
ALTER TABLE notification_inbox ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE notification_inbox ADD COLUMN dance_result_event_id TEXT
  REFERENCES dance_moderated_result_events_v1(event_id);
ALTER TABLE notification_inbox ADD CONSTRAINT notification_exact_source_v2
  CHECK ((source_event_id IS NULL) <> (dance_result_event_id IS NULL));
CREATE UNIQUE INDEX notification_dance_result_once_v1
  ON notification_inbox(recipient_user_id,dance_result_event_id) WHERE dance_result_event_id IS NOT NULL;

CREATE FUNCTION eligible_dance_result_notification_recipient_v1(p_event TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
 SELECT event.recipient_account_id FROM dance_moderated_result_events_v1 event
 JOIN dance_moderated_reviews_v1 review ON review.review_id=event.review_id
 JOIN users recipient ON recipient.user_id=event.recipient_account_id AND recipient.status='active'
 WHERE event.event_id=p_event AND review.account_id=event.recipient_account_id
   AND review.terminal_at=event.occurred_at AND review.revision=event.review_revision
   AND ((review.status='reviewed' AND review.state->>'verdict'=event.outcome
         AND event.outcome IN('passed','not_passed'))
        OR (review.status='review_expired' AND event.outcome='review_expired'))
   AND NOT EXISTS(SELECT 1 FROM dance_review_account_fences_v1 fence
                  WHERE fence.account_id=event.recipient_account_id AND fence.erasing)
$$;

CREATE OR REPLACE FUNCTION guard_notification_inbox_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM users WHERE user_id=OLD.recipient_user_id AND status<>'deleted') THEN
      RAISE EXCEPTION 'notification inbox deletion requires account erasure';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at')
      OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
      RAISE EXCEPTION 'notification identity and first read timestamp are immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- Serialize recording with account deletion; never resurrect erased inboxes.
  PERFORM 1 FROM users WHERE user_id=NEW.recipient_user_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active notification recipient required'; END IF;
  IF NEW.dance_result_event_id IS NOT NULL THEN
    PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=NEW.recipient_user_id AND NOT erasing FOR SHARE;
    IF NEW.source_event_id IS NOT NULL OR
      eligible_dance_result_notification_recipient_v1(NEW.dance_result_event_id) IS DISTINCT FROM NEW.recipient_user_id THEN
      RAISE EXCEPTION 'authorized persisted private Dance result recipient required' USING ERRCODE='DRV02';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM content_publication_outbox fact
    JOIN text_content_submissions submission
      ON submission.community_id=fact.community_id AND submission.submission_id=fact.submission_id
    JOIN comments c ON c.community_id=fact.community_id AND c.comment_id=fact.comment_id
    JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id
    LEFT JOIN comments parent ON parent.community_id=c.community_id AND parent.post_id=c.post_id AND parent.comment_id=c.parent_comment_id
    WHERE fact.outbox_event_id=NEW.source_event_id AND fact.event_type='comment_notification'
      AND submission.status='published' AND submission.surface IN('comment','reply')
      AND submission.published_comment_id=c.comment_id
      AND submission.target_post_id=c.post_id
      AND submission.target_parent_comment_id IS NOT DISTINCT FROM c.parent_comment_id
      AND post.post_type IN('text','song')
      AND c.author_user_id=submission.actor_user_id AND c.author_user_id<>NEW.recipient_user_id
      AND NEW.recipient_user_id=CASE WHEN c.parent_comment_id IS NULL THEN post.author_user_id ELSE parent.author_user_id END
      AND EXISTS(SELECT 1 FROM users actor WHERE actor.user_id=c.author_user_id AND actor.status='active')
      AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(NEW.recipient_user_id,c.comment_id) WHERE target_rating_allowed)
  ) THEN RAISE EXCEPTION 'authorized persisted comment notification recipient required'; END IF;
  RETURN NEW;
END $$;

CREATE TABLE dance_review_result_deliveries_v1 (
 event_id TEXT PRIMARY KEY REFERENCES dance_moderated_result_events_v1,
 outcome TEXT NOT NULL CHECK(outcome IN('delivered','suppressed')),
 notification_id TEXT REFERENCES notification_inbox(notification_id) ON DELETE SET NULL,
 processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_dance_result_delivery_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dance delivery history is immutable' USING ERRCODE='DRV01'; END IF;
 IF TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-'notification_id') IS DISTINCT FROM (to_jsonb(OLD)-'notification_id')
      OR OLD.notification_id IS NULL OR NEW.notification_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM notification_inbox WHERE notification_id=OLD.notification_id) THEN
     RAISE EXCEPTION 'Dance delivery history is immutable' USING ERRCODE='DRV01';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.outcome='delivered' THEN
   IF NEW.notification_id IS NULL OR NOT EXISTS(SELECT 1 FROM notification_inbox inbox
      WHERE inbox.notification_id=NEW.notification_id AND inbox.dance_result_event_id=NEW.event_id
        AND inbox.source_event_id IS NULL
        AND inbox.recipient_user_id=eligible_dance_result_notification_recipient_v1(NEW.event_id)) THEN
     RAISE EXCEPTION 'Dance delivery inbox provenance required' USING ERRCODE='DRV01';
   END IF;
 ELSE
   IF NEW.notification_id IS NOT NULL OR eligible_dance_result_notification_recipient_v1(NEW.event_id) IS NOT NULL THEN
     RAISE EXCEPTION 'Dance suppression provenance required' USING ERRCODE='DRV01';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_result_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON dance_review_result_deliveries_v1
 FOR EACH ROW EXECUTE FUNCTION guard_dance_result_delivery_v1();
CREATE FUNCTION guard_dance_result_event_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'delivered_at') IS DISTINCT FROM (to_jsonb(OLD)-'delivered_at')
   OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
   OR (NEW.delivered_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dance_review_result_deliveries_v1 WHERE event_id=NEW.event_id)) THEN
   RAISE EXCEPTION 'Dance result fact is immutable' USING ERRCODE='DRV01';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dance_result_event_guard BEFORE UPDATE OR DELETE ON dance_moderated_result_events_v1
 FOR EACH ROW EXECUTE FUNCTION guard_dance_result_event_v1();

CREATE FUNCTION deliver_recipient_notification_v2(p_event TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE event dance_moderated_result_events_v1%ROWTYPE; prior dance_review_result_deliveries_v1%ROWTYPE;
  recipient TEXT; inbox_id TEXT; did_deliver BOOLEAN:=FALSE;
BEGIN
 -- Prefix is not authority. Resolve exactly one actual persisted fact family.
 IF EXISTS(SELECT 1 FROM content_publication_outbox WHERE outbox_event_id=p_event) THEN
   IF EXISTS(SELECT 1 FROM dance_moderated_result_events_v1 WHERE event_id=p_event) THEN
     RAISE EXCEPTION 'ambiguous notification source' USING ERRCODE='DRV01';
   END IF;
   RETURN deliver_comment_notification_v1(p_event);
 END IF;
 SELECT * INTO event FROM dance_moderated_result_events_v1 WHERE event_id=p_event FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'persisted notification source required' USING ERRCODE='DRV02'; END IF;
 SELECT * INTO prior FROM dance_review_result_deliveries_v1 WHERE event_id=p_event;
 IF FOUND THEN
   IF event.delivered_at IS NULL THEN UPDATE dance_moderated_result_events_v1 SET delivered_at=clock_timestamp() WHERE event_id=p_event; END IF;
   RETURN jsonb_build_object('processed',FALSE,'delivered',prior.outcome='delivered');
 END IF;
 recipient:=event.recipient_account_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||recipient,0));
 PERFORM 1 FROM users WHERE user_id=recipient FOR SHARE;
 PERFORM 1 FROM dance_review_account_fences_v1 WHERE account_id=recipient FOR SHARE;
 IF eligible_dance_result_notification_recipient_v1(p_event)=recipient THEN
   INSERT INTO notification_inbox(recipient_user_id,dance_result_event_id) VALUES(recipient,p_event)
     ON CONFLICT(recipient_user_id,dance_result_event_id) WHERE dance_result_event_id IS NOT NULL
     DO NOTHING RETURNING notification_id INTO inbox_id;
   IF inbox_id IS NULL THEN SELECT notification_id INTO inbox_id FROM notification_inbox
     WHERE recipient_user_id=recipient AND dance_result_event_id=p_event; END IF;
   did_deliver:=TRUE;
 END IF;
 INSERT INTO dance_review_result_deliveries_v1(event_id,outcome,notification_id)
   VALUES(p_event,CASE WHEN did_deliver THEN 'delivered' ELSE 'suppressed' END,inbox_id);
 UPDATE dance_moderated_result_events_v1 SET delivered_at=clock_timestamp() WHERE event_id=p_event;
 RETURN jsonb_build_object('processed',TRUE,'delivered',did_deliver);
END $$;
CREATE FUNCTION publish_dance_result_inbox_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN PERFORM deliver_recipient_notification_v2(NEW.event_id); RETURN NEW; END $$;
CREATE TRIGGER dance_result_inbox_publication AFTER INSERT ON dance_moderated_result_events_v1
 FOR EACH ROW EXECUTE FUNCTION publish_dance_result_inbox_v1();

CREATE FUNCTION readable_recipient_notification_v2(p_recipient TEXT,p_comment TEXT,p_dance TEXT)
RETURNS TABLE(kind TEXT,target JSONB,outcome TEXT,occurred_at TIMESTAMPTZ) LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN comment.parent_comment_id IS NULL THEN 'comment_published' ELSE 'reply_published' END,
   jsonb_build_object('kind','comment_thread','community_id',comment.community_id,'post_id',comment.post_id,'comment_id',comment.comment_id),
   NULL::TEXT,comment.occurred_at
 FROM readable_notification_source_v1(p_recipient,p_comment) comment WHERE p_dance IS NULL
 UNION ALL
 SELECT 'dance_review_result',jsonb_build_object('kind','private_dance_result','community_id',review.community_id,'review_id',review.review_id),
   event.outcome,event.occurred_at
 FROM dance_moderated_result_events_v1 event JOIN dance_moderated_reviews_v1 review USING(review_id)
 WHERE p_comment IS NULL AND event.event_id=p_dance
   AND eligible_dance_result_notification_recipient_v1(p_dance)=p_recipient
$$;

-- The existing job receives only bounded source locators, not raw private
-- review, recipient or recording tables. Both fact families retain recovery.
CREATE FUNCTION pending_recipient_notifications_v2() RETURNS TABLE(outbox_event_id TEXT)
LANGUAGE sql STABLE AS $$
 SELECT pending.event_id FROM (
  SELECT fact.outbox_event_id AS event_id,fact.created_at FROM content_publication_outbox fact
   WHERE fact.event_type='comment_notification' AND NOT fact.inbox_delivery_recorded
  UNION ALL
  SELECT result.event_id,result.occurred_at FROM dance_moderated_result_events_v1 result
   WHERE result.delivered_at IS NULL
 ) pending ORDER BY pending.created_at,pending.event_id LIMIT 50
$$;

-- Use the same trusted-schema convention as the accepted review commands.
DO $harden$
DECLARE fn REGPROCEDURE; grant_row RECORD; owned_table REGCLASS;
BEGIN
 FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY(ARRAY[
   'eligible_dance_result_notification_recipient_v1','guard_notification_inbox_v1','guard_dance_result_delivery_v1',
   'guard_dance_result_event_v1','deliver_recipient_notification_v2','publish_dance_result_inbox_v1','readable_recipient_notification_v2','pending_recipient_notifications_v2']) LOOP
   EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path TO %I, pg_catalog, pg_temp',fn,current_schema());
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
   FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
       WHERE p.oid=fn::oid AND acl.grantee<>p.proowner AND acl.grantee<>0 LOOP
     EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn,pg_get_userbyid(grant_row.grantee));
   END LOOP;
 END LOOP;
 owned_table:='dance_review_result_deliveries_v1'::regclass;
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',owned_table);
 FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl
   WHERE c.oid=owned_table AND acl.grantee<>c.relowner AND acl.grantee<>0 LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',owned_table,pg_get_userbyid(grant_row.grantee));
 END LOOP;
END $harden$;

-- Parent-only binding to exact existing roles, no role/config/credential creation.
CREATE FUNCTION grant_dance_result_notification_runtime_v2(p_role TEXT,p_purpose TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target OID; owner OID; signature TEXT; allowed TEXT[];
BEGIN
 SELECT oid INTO STRICT target FROM pg_roles WHERE rolname=p_role AND NOT rolsuper AND NOT rolcreaterole
   AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls;
 SELECT relowner INTO owner FROM pg_class WHERE oid='dance_moderated_reviews_v1'::REGCLASS;
 IF pg_has_role(target,owner,'MEMBER') THEN RAISE EXCEPTION 'runtime inherits private review owner' USING ERRCODE='42501'; END IF;
 allowed:=CASE p_purpose WHEN 'account' THEN ARRAY['readable_recipient_notification_v2(text,text,text)']
   WHEN 'notification_worker' THEN ARRAY['pending_recipient_notifications_v2()','deliver_recipient_notification_v2(text)'] END;
 IF allowed IS NULL THEN RAISE EXCEPTION 'explicit notification purpose required' USING ERRCODE='42501'; END IF;
 FOREACH signature IN ARRAY allowed LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature::REGPROCEDURE,p_role); END LOOP;
END $$;
REVOKE ALL ON FUNCTION grant_dance_result_notification_runtime_v2(TEXT,TEXT) FROM PUBLIC;
