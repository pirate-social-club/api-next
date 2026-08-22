-- Post-vote runtime ledger and stored aggregate repair. This is a forward-only
-- tranche: existing vote rows require an explicit reviewed migration plan.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM post_votes) THEN
    RAISE EXCEPTION '0040 requires post_votes to be empty';
  END IF;
END
$$;

ALTER TABLE posts
  ADD COLUMN upvote_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN downvote_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT posts_upvote_count_nonnegative CHECK (upvote_count >= 0),
  ADD CONSTRAINT posts_downvote_count_nonnegative CHECK (downvote_count >= 0);

CREATE TABLE post_vote_actions (
  action_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template IN ('/posts/:postId/vote', '/posts/:postId/clear_vote')
  ),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key <> ''),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_value INTEGER NOT NULL CHECK (result_value IN (-1, 0, 1)),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT post_vote_actions_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id),
  CONSTRAINT post_vote_actions_endpoint_result_shape CHECK (
    (endpoint_template = '/posts/:postId/vote' AND result_value IN (-1, 1))
    OR (endpoint_template = '/posts/:postId/clear_vote' AND result_value = 0)
  ),
  CONSTRAINT post_vote_actions_actor_post_endpoint_key_unique
    UNIQUE (actor_user_id, post_id, endpoint_template, idempotency_key)
);

CREATE INDEX post_vote_actions_target_time_idx
  ON post_vote_actions (community_id, post_id, created_at, action_id);
