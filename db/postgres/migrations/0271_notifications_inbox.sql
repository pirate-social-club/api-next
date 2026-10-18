-- Branch-local next free ordinal. Renumber in actual merge order, without gaps.
-- Existing comment_notification is the sole fact; no new channel or wire receipt.
ALTER TABLE content_publication_outbox ADD COLUMN inbox_delivery_recorded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE notification_inbox (
  notification_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text
    CHECK (notification_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  delivery_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL REFERENCES content_publication_outbox(outbox_event_id),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ,
  UNIQUE (recipient_user_id, source_event_id),
  CHECK (read_at IS NULL OR read_at >= delivered_at)
);
CREATE INDEX notification_inbox_recipient_order_idx
  ON notification_inbox(recipient_user_id, delivery_order DESC);

CREATE INDEX notification_inbox_unread_recipient_idx ON notification_inbox(recipient_user_id,source_event_id) WHERE read_at IS NULL;

CREATE FUNCTION guard_notification_inbox_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
CREATE TRIGGER notification_inbox_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_inbox
  FOR EACH ROW EXECUTE FUNCTION guard_notification_inbox_v1();

CREATE FUNCTION delete_recipient_notification_inbox_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM notification_inbox WHERE recipient_user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_delete_notification_inbox AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION delete_recipient_notification_inbox_v1();

CREATE INDEX comments_navigation_window_v1_idx ON comments
  (community_id,post_id,parent_comment_id,created_at,comment_id) WHERE status='published';

-- Shared complete current branch authorization. A target-only age denial is
-- represented separately so the resolver can return the existing placeholder.
CREATE FUNCTION authorized_comment_branch_v1(p_viewer TEXT,p_comment TEXT)
RETURNS TABLE(community_id TEXT,post_id TEXT,comment_id TEXT,path_ids TEXT[],
  ancestor_ids TEXT[],target_rating_allowed BOOLEAN)
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE ancestry AS (
   SELECT c.community_id,c.post_id,c.comment_id,c.parent_comment_id,c.depth,c.depth AS target_depth,
     c.status,c.content_rating,0 AS hops,ARRAY[c.comment_id] AS seen,FALSE AS cycle
     FROM comments c WHERE c.comment_id=p_comment
   UNION ALL
   SELECT c.community_id,c.post_id,c.comment_id,c.parent_comment_id,c.depth,a.target_depth,
     c.status,c.content_rating,a.hops+1,a.seen||c.comment_id,c.comment_id=ANY(a.seen)
     FROM comments c JOIN ancestry a ON c.comment_id=a.parent_comment_id
     WHERE c.community_id=a.community_id AND c.post_id=a.post_id AND a.hops<8 AND NOT a.cycle
 ), valid AS (
   SELECT COUNT(*)=MAX(target_depth)+1 AND COUNT(DISTINCT comment_id)=COUNT(*)
     AND bool_and(target_depth BETWEEN 0 AND 8 AND depth=target_depth-hops AND NOT cycle AND status='published')
     AND bool_or(depth=0 AND parent_comment_id IS NULL AND hops=target_depth)
     AND bool_and(hops=0 OR can_account_view_content_rating_v1(p_viewer,content_rating)) AS allowed
   FROM ancestry
 ) SELECT target.community_id,target.post_id,target.comment_id,
   ARRAY(SELECT a.comment_id FROM ancestry a ORDER BY a.hops DESC),
   ARRAY(SELECT a.comment_id FROM ancestry a WHERE a.hops>0 ORDER BY a.hops DESC),
   can_account_view_content_rating_v1(p_viewer,target.content_rating)
 FROM ancestry target JOIN posts p ON p.community_id=target.community_id AND p.post_id=target.post_id
 JOIN communities community ON community.community_id=p.community_id
 JOIN users viewer ON viewer.user_id=p_viewer AND viewer.status='active'
 WHERE target.hops=0 AND (SELECT allowed FROM valid)
   AND p.status='published' AND community.status='active'
   AND can_account_view_content_rating_v1(p_viewer,p.content_rating)
   AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS (
     SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id
       AND m.user_id=p_viewer AND m.status='member')))
$$;

-- Current Notifications destinations require an owned text/song reader. This
-- does not alter ordinary comments, persisted facts or terminal delivery history.
-- Shared source ownership/authorization, without presentation JSON.
CREATE FUNCTION eligible_comment_notification_recipient_v1(p_fact TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
 SELECT recipient.user_id FROM content_publication_outbox fact
 JOIN text_content_submissions submission ON submission.community_id=fact.community_id
   AND submission.submission_id=fact.submission_id AND submission.status='published'
 JOIN comments c ON c.community_id=fact.community_id AND c.comment_id=fact.comment_id
   AND c.comment_id=submission.published_comment_id AND c.post_id=submission.target_post_id
   AND c.parent_comment_id IS NOT DISTINCT FROM submission.target_parent_comment_id
   AND c.author_user_id=submission.actor_user_id
 JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id AND post.post_type IN('text','song')
 LEFT JOIN comments parent ON parent.community_id=c.community_id AND parent.post_id=c.post_id AND parent.comment_id=c.parent_comment_id
 JOIN users actor ON actor.user_id=c.author_user_id AND actor.status='active'
 JOIN users recipient ON recipient.user_id=CASE WHEN c.parent_comment_id IS NULL THEN post.author_user_id ELSE parent.author_user_id END
   AND recipient.status='active' AND recipient.user_id<>actor.user_id
 WHERE fact.outbox_event_id=p_fact AND fact.event_type='comment_notification' AND submission.surface IN('comment','reply')
   AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(recipient.user_id,c.comment_id) WHERE target_rating_allowed)
$$;

CREATE FUNCTION readable_notification_source_v1(p_recipient TEXT,p_fact TEXT)
RETURNS TABLE(community_id TEXT,post_id TEXT,comment_id TEXT,parent_comment_id TEXT,occurred_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
 SELECT c.community_id,c.post_id,c.comment_id,c.parent_comment_id,fact.created_at
 FROM content_publication_outbox fact
 JOIN text_content_submissions submission ON submission.community_id=fact.community_id
   AND submission.submission_id=fact.submission_id AND submission.status='published'
   AND submission.published_comment_id=fact.comment_id AND submission.surface IN('comment','reply')
 JOIN comments c ON c.community_id=fact.community_id AND c.comment_id=fact.comment_id
   AND c.post_id=submission.target_post_id
   AND c.parent_comment_id IS NOT DISTINCT FROM submission.target_parent_comment_id
 JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id AND post.post_type IN('text','song')
 WHERE fact.outbox_event_id=p_fact AND fact.event_type='comment_notification'
   AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(p_recipient,c.comment_id) WHERE target_rating_allowed)
$$;

CREATE FUNCTION resolve_comment_navigation_v1(p_viewer TEXT,p_comment TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('post_slug',alias.slug,'document',CASE WHEN NOT branch.target_rating_allowed THEN
   jsonb_build_object('kind','age_locked','content_rating','adult_18',
     'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
 ELSE jsonb_build_object('kind','available','post_id',branch.post_id,'community_id',branch.community_id,
   'target_comment_id',branch.comment_id,'ancestor_comment_ids',to_jsonb(branch.ancestor_ids),
   'windows',(SELECT jsonb_agg(w.document ORDER BY path.ordinal)
     FROM unnest(branch.path_ids) WITH ORDINALITY AS path(id,ordinal)
     JOIN comments node ON node.comment_id=path.id AND node.community_id=branch.community_id AND node.post_id=branch.post_id
     CROSS JOIN LATERAL (
       WITH page AS MATERIALIZED (
         SELECT c.comment_id,c.created_at,CASE WHEN NOT can_account_view_content_rating_v1(p_viewer,c.content_rating) THEN
           jsonb_build_object('kind','age_locked','content_rating','adult_18',
             'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
         ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
           'body',c.body,'author_persona',CASE WHEN EXISTS(SELECT 1 FROM users author WHERE author.user_id=c.author_user_id AND author.status='active') THEN public_persona_projection(c.author_persona_id) ELSE NULL END,'depth',c.depth,
           'reply_count',(SELECT count(*) FROM comments reply WHERE reply.community_id=c.community_id
             AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'),
           'status','published','content_rating',c.content_rating,'created_at',c.created_at) END AS item
         FROM comments c WHERE c.community_id=branch.community_id AND c.post_id=branch.post_id
           AND c.parent_comment_id IS NOT DISTINCT FROM node.parent_comment_id AND c.status='published'
           AND (c.created_at,c.comment_id)>=(node.created_at,node.comment_id)
         ORDER BY c.created_at,c.comment_id LIMIT 21
       ), shown AS (SELECT * FROM page ORDER BY created_at,comment_id LIMIT 20)
       SELECT jsonb_build_object('parent_comment_id',node.parent_comment_id,'branch_comment_id',node.comment_id,
         'items',(SELECT jsonb_agg(item ORDER BY created_at,comment_id) FROM shown),
         'earlier_items_omitted',EXISTS(SELECT 1 FROM comments earlier WHERE earlier.community_id=branch.community_id
           AND earlier.post_id=branch.post_id AND earlier.parent_comment_id IS NOT DISTINCT FROM node.parent_comment_id
           AND earlier.status='published' AND (earlier.created_at,earlier.comment_id)<(node.created_at,node.comment_id)),
         'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
           (SELECT comment_id FROM shown ORDER BY created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END) AS document
     ) w)) END)
 FROM authorized_comment_branch_v1(p_viewer,p_comment) branch
 JOIN posts p ON p.community_id=branch.community_id AND p.post_id=branch.post_id AND p.post_type IN('text','song')
 JOIN post_slug_aliases alias ON alias.post_id=p.post_id
$$;


-- Ordinary continuations use the same current branch guard and one snapshot.
-- Cursor anchors deliberately do not require published status or actor binding.
CREATE FUNCTION list_post_comment_children_v1(p_viewer TEXT,p_post TEXT,p_parent TEXT,p_cursor TEXT)
RETURNS JSONB LANGUAGE sql STABLE AS $$
 WITH access AS MATERIALIZED (
   SELECT p.community_id FROM posts p JOIN communities community USING(community_id)
   JOIN users viewer ON viewer.user_id=p_viewer AND viewer.status='active'
   WHERE p.post_id=p_post AND p.status='published' AND community.status='active'
     AND can_account_view_content_rating_v1(p_viewer,p.content_rating)
     AND (p.visibility='public' OR (p.visibility='members_only' AND EXISTS(
       SELECT 1 FROM community_memberships m WHERE m.community_id=p.community_id
         AND m.user_id=p_viewer AND m.status='member')))
 ), authorized AS MATERIALIZED (
   SELECT access.community_id,p_parent IS NULL OR EXISTS(
     SELECT 1 FROM authorized_comment_branch_v1(p_viewer,p_parent) branch
       WHERE branch.community_id=access.community_id AND branch.post_id=p_post
         AND branch.target_rating_allowed) AS parent_allowed FROM access
 ), anchor AS MATERIALIZED (
   SELECT c.comment_id,c.created_at FROM comments c JOIN access USING(community_id)
   WHERE c.post_id=p_post AND c.parent_comment_id IS NOT DISTINCT FROM p_parent AND c.comment_id=p_cursor
 ), page AS MATERIALIZED (
   SELECT c.comment_id,c.created_at,
     CASE WHEN NOT can_account_view_content_rating_v1(p_viewer,c.content_rating) THEN
       jsonb_build_object('kind','age_locked','content_rating','adult_18',
         'next_action',jsonb_build_object('kind','verify_minimum_age','minimum_age',18))
     ELSE jsonb_build_object('comment_id',c.comment_id,'parent_comment_id',c.parent_comment_id,
       'body',c.body,'author_persona',CASE WHEN EXISTS(SELECT 1 FROM users author
         WHERE author.user_id=c.author_user_id AND author.status='active')
         THEN public_persona_projection(c.author_persona_id) ELSE NULL END,
       'depth',c.depth,'reply_count',(SELECT count(*) FROM comments reply WHERE reply.community_id=c.community_id
         AND reply.post_id=c.post_id AND reply.parent_comment_id=c.comment_id AND reply.status='published'),
       'status','published','content_rating',c.content_rating,'created_at',c.created_at) END AS item
   FROM comments c JOIN authorized a USING(community_id)
   WHERE a.parent_allowed AND c.post_id=p_post AND c.parent_comment_id IS NOT DISTINCT FROM p_parent
     AND c.status='published' AND (p_cursor IS NULL OR
       (c.created_at,c.comment_id)>(SELECT created_at,comment_id FROM anchor))
   ORDER BY c.created_at,c.comment_id LIMIT 21
 ), shown AS (SELECT * FROM page ORDER BY created_at,comment_id LIMIT 20)
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM access) THEN jsonb_build_object('kind','post_not_found')
   WHEN NOT EXISTS(SELECT 1 FROM authorized WHERE parent_allowed) THEN jsonb_build_object('kind','comment_not_found')
   WHEN p_cursor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM anchor) THEN jsonb_build_object('kind','invalid_cursor')
   ELSE jsonb_build_object('kind','available','document',jsonb_build_object(
     'items',COALESCE((SELECT jsonb_agg(item ORDER BY created_at,comment_id) FROM shown),'[]'::jsonb),
     'next_cursor',CASE WHEN (SELECT count(*) FROM page)>20 THEN
       (SELECT comment_id FROM shown ORDER BY created_at DESC,comment_id DESC LIMIT 1) ELSE NULL END)) END
$$;

-- Private processing ledger, not a command response, subscription or new queue.
-- It retains no recipient/account identity after inbox erasure. Recovery covers
-- old pending facts AND facts previously acknowledged without an inbox effect.
CREATE TABLE notification_publication_deliveries (
  source_event_id TEXT PRIMARY KEY REFERENCES content_publication_outbox(outbox_event_id),
  outcome TEXT NOT NULL CHECK(outcome IN('delivered','suppressed')),
  notification_id TEXT REFERENCES notification_inbox(notification_id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notification_publication_source_idx ON content_publication_outbox(created_at,outbox_event_id)
  WHERE event_type='comment_notification' AND NOT inbox_delivery_recorded;


-- Terminal processing history survives account erasure and cannot be revised.
CREATE FUNCTION guard_notification_delivery_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'notification delivery history is immutable'; END IF;
 IF TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-'notification_id') IS DISTINCT FROM (to_jsonb(OLD)-'notification_id')
     OR OLD.notification_id IS NULL OR NEW.notification_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM notification_inbox WHERE notification_id=OLD.notification_id) THEN
     RAISE EXCEPTION 'notification delivery history is immutable';
   END IF;
   RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM content_publication_outbox WHERE outbox_event_id=NEW.source_event_id AND event_type='comment_notification') THEN
   RAISE EXCEPTION 'notification delivery source provenance required';
 END IF;
 IF NEW.outcome='delivered' THEN
   IF NEW.notification_id IS NULL OR NOT EXISTS(
     SELECT 1 FROM notification_inbox inbox WHERE inbox.notification_id=NEW.notification_id
       AND inbox.source_event_id=NEW.source_event_id
       AND inbox.recipient_user_id=eligible_comment_notification_recipient_v1(NEW.source_event_id)
   ) THEN RAISE EXCEPTION 'notification delivery inbox provenance required'; END IF;
 ELSE
   IF NEW.notification_id IS NOT NULL OR eligible_comment_notification_recipient_v1(NEW.source_event_id) IS NOT NULL THEN
     RAISE EXCEPTION 'notification suppression provenance required';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON notification_publication_deliveries
 FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery_v1();

CREATE FUNCTION guard_comment_notification_fact_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.event_type='comment_notification' THEN RAISE EXCEPTION 'notification fact provenance is immutable'; END IF;
   RETURN OLD;
 END IF;
 IF OLD.event_type='comment_notification' OR NEW.event_type='comment_notification' THEN
   IF (to_jsonb(NEW)-ARRAY['state','published_at','inbox_delivery_recorded']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','published_at','inbox_delivery_recorded'])
     OR (OLD.state='published' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.published_at IS DISTINCT FROM OLD.published_at))
     OR (OLD.inbox_delivery_recorded AND NOT NEW.inbox_delivery_recorded)
     OR (NEW.inbox_delivery_recorded AND NOT EXISTS(SELECT 1 FROM notification_publication_deliveries WHERE source_event_id=NEW.outbox_event_id)) THEN
     RAISE EXCEPTION 'notification fact provenance is immutable';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER comment_notification_fact_guard BEFORE UPDATE OR DELETE ON content_publication_outbox
 FOR EACH ROW EXECUTE FUNCTION guard_comment_notification_fact_v1();

CREATE FUNCTION deliver_comment_notification_v1(p_fact TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE fact content_publication_outbox%ROWTYPE; prior notification_publication_deliveries%ROWTYPE;
  actor_id TEXT; recipient_id TEXT; target_id TEXT; inbox_id TEXT; delivered BOOLEAN:=FALSE;
BEGIN
 SELECT * INTO fact FROM content_publication_outbox WHERE outbox_event_id=p_fact FOR UPDATE;
 IF NOT FOUND OR fact.event_type<>'comment_notification' THEN RAISE EXCEPTION 'comment notification fact required'; END IF;
 SELECT * INTO prior FROM notification_publication_deliveries WHERE source_event_id=p_fact;
 IF FOUND THEN
   -- Reconcile a valid receipt written by an earlier producer without its
   -- private acknowledgement; do not leave it at the head of recovery forever.
   IF NOT fact.inbox_delivery_recorded THEN
     UPDATE content_publication_outbox SET state='published',
       published_at=COALESCE(published_at,clock_timestamp()),inbox_delivery_recorded=TRUE WHERE outbox_event_id=p_fact;
   END IF;
   RETURN jsonb_build_object('processed',FALSE,'delivered',prior.outcome='delivered');
 END IF;
 SELECT c.author_user_id,
   CASE WHEN c.parent_comment_id IS NULL THEN post.author_user_id ELSE parent.author_user_id END,c.comment_id
 INTO actor_id,recipient_id,target_id
 FROM text_content_submissions submission
 JOIN comments c ON c.community_id=submission.community_id AND c.comment_id=submission.published_comment_id
 JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id
 LEFT JOIN comments parent ON parent.community_id=c.community_id AND parent.post_id=c.post_id AND parent.comment_id=c.parent_comment_id
 WHERE submission.community_id=fact.community_id AND submission.submission_id=fact.submission_id
   AND submission.status='published' AND submission.surface IN('comment','reply')
   AND c.author_user_id=submission.actor_user_id
   AND c.comment_id=fact.comment_id AND c.post_id=submission.target_post_id
   AND c.parent_comment_id IS NOT DISTINCT FROM submission.target_parent_comment_id;
 IF actor_id IS NOT NULL AND recipient_id IS NOT NULL AND actor_id<>recipient_id
   AND EXISTS(SELECT 1 FROM users WHERE user_id=actor_id AND status='active') THEN
   -- Lock before allocating delivery_order. Serializes concurrent recipient
   -- deliveries and account erasure without relying on a timestamp checkpoint.
   -- SHARE is compatible with actor FK locks: opposite-recipient publications
   -- must not upgrade each other's account key-share locks into a deadlock.
   PERFORM pg_advisory_xact_lock(hashtextextended('notifications-recipient-v1:'||recipient_id,0));
   PERFORM 1 FROM users WHERE user_id IN(actor_id,recipient_id) ORDER BY user_id FOR SHARE;
   IF FOUND AND eligible_comment_notification_recipient_v1(p_fact)=recipient_id THEN
     INSERT INTO notification_inbox(recipient_user_id,source_event_id) VALUES(recipient_id,p_fact)
       ON CONFLICT(recipient_user_id,source_event_id) DO NOTHING RETURNING notification_id INTO inbox_id;
     IF inbox_id IS NULL THEN SELECT notification_id INTO inbox_id FROM notification_inbox
       WHERE recipient_user_id=recipient_id AND source_event_id=p_fact; END IF;
     delivered:=TRUE;
   END IF;
 END IF;
 INSERT INTO notification_publication_deliveries(source_event_id,outcome,notification_id)
   VALUES(p_fact,CASE WHEN delivered THEN 'delivered' ELSE 'suppressed' END,inbox_id);
 UPDATE content_publication_outbox SET state='published',published_at=COALESCE(published_at,clock_timestamp()),inbox_delivery_recorded=TRUE
   WHERE outbox_event_id=p_fact;
 RETURN jsonb_build_object('processed',TRUE,'delivered',delivered);
END $$;

CREATE FUNCTION publish_comment_notification_inbox_v1() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM deliver_comment_notification_v1(NEW.outbox_event_id);
 RETURN NEW;
END $$;
CREATE TRIGGER comment_notification_inbox_publication AFTER INSERT ON content_publication_outbox
  FOR EACH ROW WHEN (NEW.event_type='comment_notification') EXECUTE FUNCTION publish_comment_notification_inbox_v1();
