-- api-next v1 product slice.
-- PlanetScale Postgres is the only runtime relational store. All identifiers
-- API identifiers remain TEXT so the current string-ID contracts need no
-- remapping.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communities (
  community_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'hidden', 'archived')),
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT communities_id_not_blank CHECK (btrim(community_id) <> '')
);

CREATE TABLE IF NOT EXISTS community_memberships (
  community_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'member'
    CHECK (status IN ('pending', 'member', 'left', 'banned')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, membership_id),
  CONSTRAINT community_memberships_user_unique
    UNIQUE (community_id, user_id),
  CONSTRAINT community_memberships_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS community_memberships_status_idx
  ON community_memberships (community_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author_user_id TEXT,
  post_type TEXT NOT NULL DEFAULT 'text'
    CHECK (post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost', 'file')),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'processing', 'published', 'failed', 'hidden', 'removed', 'deleted')),
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'members_only')),
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_id),
  CONSTRAINT posts_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS posts_status_created_idx
  ON posts (community_id, status, created_at DESC, post_id);

CREATE INDEX IF NOT EXISTS posts_author_created_idx
  ON posts (community_id, author_user_id, created_at DESC, post_id);

CREATE TABLE IF NOT EXISTS comments (
  community_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  parent_comment_id TEXT,
  author_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'hidden', 'removed', 'deleted')),
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, comment_id),
  CONSTRAINT comments_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT comments_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id),
  CONSTRAINT comments_parent_fk
    FOREIGN KEY (community_id, parent_comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT comments_not_self_parent
    CHECK (parent_comment_id IS NULL OR parent_comment_id <> comment_id)
);

CREATE INDEX IF NOT EXISTS comments_post_created_idx
  ON comments (community_id, post_id, created_at, comment_id);

CREATE INDEX IF NOT EXISTS comments_parent_created_idx
  ON comments (community_id, parent_comment_id, created_at, comment_id);

CREATE TABLE IF NOT EXISTS post_votes (
  community_id TEXT NOT NULL,
  post_vote_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vote_value SMALLINT NOT NULL CHECK (vote_value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_vote_id),
  CONSTRAINT post_votes_user_post_unique UNIQUE (community_id, post_id, user_id),
  CONSTRAINT post_votes_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id),
  CONSTRAINT post_votes_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS post_votes_post_idx
  ON post_votes (community_id, post_id, updated_at DESC, post_vote_id);

CREATE TABLE IF NOT EXISTS moderation_reports (
  community_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'triaged', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, report_id),
  CONSTRAINT moderation_reports_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS moderation_reports_status_idx
  ON moderation_reports (community_id, status, created_at, report_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  community_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'comment', 'member')),
  target_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('hide', 'restore', 'ban', 'unban')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, action_id),
  CONSTRAINT moderation_actions_community_fk
    FOREIGN KEY (community_id) REFERENCES communities (community_id)
);

CREATE INDEX IF NOT EXISTS moderation_actions_target_idx
  ON moderation_actions (community_id, target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_feed_projection (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  rank_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  projected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, post_id),
  CONSTRAINT community_feed_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS community_feed_rank_idx
  ON community_feed_projection (community_id, rank_score DESC, post_id);

CREATE TABLE IF NOT EXISTS home_feed_projection (
  community_id TEXT NOT NULL,
  feed_item_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  rank_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  projected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, feed_item_id),
  CONSTRAINT home_feed_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id)
);

CREATE INDEX IF NOT EXISTS home_feed_rank_idx
  ON home_feed_projection (community_id, rank_score DESC, feed_item_id);
