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

-- api-next session-bridge identity slice.
-- This migration creates the identity records read by the HTTP worker. It does
-- not import or rewrite identity data from another control-plane database.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  primary_wallet_attachment_id TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_state IN ('unverified', 'pending', 'verified', 'reverification_required')),
  capability_provider TEXT
    CHECK (capability_provider IS NULL OR capability_provider IN ('self', 'very', 'passport', 'zkpass', 'zkpassport')),
  verification_capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ,
  current_verification_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_verification_state_idx
  ON users (verification_state);

CREATE TABLE IF NOT EXISTS wallet_attachments (
  wallet_attachment_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chain_namespace TEXT NOT NULL,
  wallet_address_normalized TEXT NOT NULL,
  wallet_address_display TEXT NOT NULL,
  source_provider TEXT,
  source_subject TEXT,
  attachment_kind TEXT NOT NULL DEFAULT 'external'
    CHECK (attachment_kind IN ('embedded', 'external', 'delegated')),
  is_primary INTEGER NOT NULL DEFAULT 0
    CHECK (is_primary IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'detached', 'revoked')),
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_attachments_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_attachments_active_unique_idx
  ON wallet_attachments (user_id, chain_namespace, wallet_address_normalized)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS wallet_attachments_active_primary_idx
  ON wallet_attachments (user_id)
  WHERE status = 'active' AND is_primary = 1;

CREATE INDEX IF NOT EXISTS wallet_attachments_user_namespace_idx
  ON wallet_attachments (user_id, chain_namespace);

CREATE TABLE IF NOT EXISTS global_handles (
  global_handle_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label_normalized TEXT NOT NULL,
  label_display TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redirect', 'retired')),
  tier TEXT NOT NULL DEFAULT 'generated'
    CHECK (tier IN ('generated', 'standard', 'premium')),
  issuance_source TEXT NOT NULL DEFAULT 'generated_signup'
    CHECK (issuance_source IN ('generated_signup', 'free_cleanup_rename', 'reddit_verified_claim', 'paid_upgrade', 'admin_grant')),
  redirect_target_global_handle_id TEXT,
  price_paid_usd REAL,
  free_rename_consumed INTEGER NOT NULL DEFAULT 0
    CHECK (free_rename_consumed IN (0, 1)),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT global_handles_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT global_handles_redirect_fk
    FOREIGN KEY (redirect_target_global_handle_id)
    REFERENCES global_handles (global_handle_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS global_handles_active_label_idx
  ON global_handles (label_normalized)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS global_handles_active_user_idx
  ON global_handles (user_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS linked_handles (
  linked_handle_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wallet_attachment_id TEXT,
  kind TEXT NOT NULL
    CHECK (kind IN ('pirate', 'ens')),
  label_normalized TEXT NOT NULL,
  label_display TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_state IN ('verified', 'unverified', 'stale')),
  metadata_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT linked_handles_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT linked_handles_wallet_fk
    FOREIGN KEY (wallet_attachment_id)
    REFERENCES wallet_attachments (wallet_attachment_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS linked_handles_user_kind_label_idx
  ON linked_handles (user_id, kind, label_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS linked_handles_wallet_kind_idx
  ON linked_handles (wallet_attachment_id, kind)
  WHERE wallet_attachment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  bio_source TEXT
    CHECK (bio_source IS NULL OR bio_source IN ('ens', 'manual', 'none')),
  avatar_ref TEXT,
  avatar_source TEXT
    CHECK (avatar_source IS NULL OR avatar_source IN ('ens', 'upload', 'none')),
  cover_ref TEXT,
  cover_source TEXT
    CHECK (cover_source IS NULL OR cover_source IN ('ens', 'upload', 'none')),
  global_handle_id TEXT,
  primary_linked_handle_id TEXT,
  preferred_locale TEXT,
  xmtp_inbox_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profiles_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT profiles_global_handle_fk
    FOREIGN KEY (global_handle_id) REFERENCES global_handles (global_handle_id),
  CONSTRAINT profiles_primary_linked_handle_fk
    FOREIGN KEY (primary_linked_handle_id)
    REFERENCES linked_handles (linked_handle_id)
);

CREATE TABLE IF NOT EXISTS user_account_aliases (
  source_user_id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_account_aliases_source_fk
    FOREIGN KEY (source_user_id) REFERENCES users (user_id),
  CONSTRAINT user_account_aliases_canonical_fk
    FOREIGN KEY (canonical_user_id) REFERENCES users (user_id),
  CONSTRAINT user_account_aliases_distinct_users_check
    CHECK (source_user_id <> canonical_user_id),
  CONSTRAINT user_account_aliases_status_timestamps_check CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS user_account_aliases_canonical_active_idx
  ON user_account_aliases (canonical_user_id)
  WHERE status = 'active';
