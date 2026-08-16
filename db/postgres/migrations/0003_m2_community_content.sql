-- M2 community/content runtime invariants. The D1 migration fixtures are not
-- runtime schema and are deliberately not imported into Postgres.

ALTER TABLE communities
  ADD COLUMN membership_mode TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN human_verification_lane TEXT,
  ADD CONSTRAINT communities_membership_mode_check
    CHECK (membership_mode IN ('open', 'request', 'gated')),
  ADD CONSTRAINT communities_human_verification_lane_check
    CHECK (
      human_verification_lane IS NULL
      OR human_verification_lane IN ('very', 'self')
    );

CREATE TABLE community_follows (
  community_follow_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  unfollowed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_follows_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT community_follows_user_unique
    UNIQUE (community_id, user_id)
);

CREATE INDEX community_follows_user_status_idx
  ON community_follows (user_id, status);

ALTER TABLE posts
  ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN idempotency_body_hash TEXT;

CREATE UNIQUE INDEX posts_author_idempotency_unique
  ON posts (community_id, author_user_id, idempotency_key)
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

ALTER TABLE comments
  ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN idempotency_body_hash TEXT;

CREATE UNIQUE INDEX comments_author_idempotency_unique
  ON comments (community_id, author_user_id, idempotency_key)
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

-- Public v1 paths locate posts and comments without a community ID. These
-- indexes make that lookup unambiguous before every scoped operation.
CREATE UNIQUE INDEX posts_post_id_global_unique
  ON posts (post_id);

CREATE UNIQUE INDEX comments_comment_id_global_unique
  ON comments (comment_id);
