-- Persist the existing v1 post comment-lock policy before comment replies are
-- wired. Existing rows remain replyable; future moderation can lock them.

ALTER TABLE posts
  ADD COLUMN comments_locked BOOLEAN NOT NULL DEFAULT FALSE;
