CREATE INDEX media_post_submissions_active_account_recovery
  ON media_post_submissions (community_id, actor_user_id, created_at DESC, submission_id COLLATE "C" DESC)
  WHERE status IN ('processing','action_required','manual_review','processing_failed');
