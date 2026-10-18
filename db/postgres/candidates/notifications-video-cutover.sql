-- UNAPPLIED, UNNUMBERED. Execute ONLY inside the admission store's exclusion transaction.
-- Normal Jobs recovery must first drain all outstanding facts under the old guard.
-- No marker/outcome reset, timestamp cohort, alias repair or event fan-out.

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
      AND post.post_type IN('text','song','video')
      AND c.author_user_id=submission.actor_user_id AND c.author_user_id<>NEW.recipient_user_id
      AND NEW.recipient_user_id=CASE WHEN c.parent_comment_id IS NULL THEN post.author_user_id ELSE parent.author_user_id END
      AND EXISTS(SELECT 1 FROM users actor WHERE actor.user_id=c.author_user_id AND actor.status='active')
      AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(NEW.recipient_user_id,c.comment_id) WHERE target_rating_allowed)
  ) THEN RAISE EXCEPTION 'authorized persisted comment notification recipient required'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION eligible_comment_notification_recipient_v1(p_fact TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
 SELECT recipient.user_id FROM content_publication_outbox fact
 JOIN text_content_submissions submission ON submission.community_id=fact.community_id
   AND submission.submission_id=fact.submission_id AND submission.status='published'
 JOIN comments c ON c.community_id=fact.community_id AND c.comment_id=fact.comment_id
   AND c.comment_id=submission.published_comment_id AND c.post_id=submission.target_post_id
   AND c.parent_comment_id IS NOT DISTINCT FROM submission.target_parent_comment_id
   AND c.author_user_id=submission.actor_user_id
 JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id AND post.post_type IN('text','song','video')
 LEFT JOIN comments parent ON parent.community_id=c.community_id AND parent.post_id=c.post_id AND parent.comment_id=c.parent_comment_id
 JOIN users actor ON actor.user_id=c.author_user_id AND actor.status='active'
 JOIN users recipient ON recipient.user_id=CASE WHEN c.parent_comment_id IS NULL THEN post.author_user_id ELSE parent.author_user_id END
   AND recipient.status='active' AND recipient.user_id<>actor.user_id
 WHERE fact.outbox_event_id=p_fact AND fact.event_type='comment_notification' AND submission.surface IN('comment','reply')
   AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(recipient.user_id,c.comment_id) WHERE target_rating_allowed)
$$;

CREATE OR REPLACE FUNCTION readable_notification_source_v1(p_recipient TEXT,p_fact TEXT)
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
 JOIN posts post ON post.community_id=c.community_id AND post.post_id=c.post_id AND post.post_type IN('text','song','video')
 WHERE fact.outbox_event_id=p_fact AND fact.event_type='comment_notification'
   AND EXISTS(SELECT 1 FROM authorized_comment_branch_v1(p_recipient,c.comment_id) WHERE target_rating_allowed)
$$;

