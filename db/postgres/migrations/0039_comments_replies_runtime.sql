-- Order 6 comments/replies runtime. Forward-only runtime structures; no
-- reservation, compatibility, or backfill path is permitted.

ALTER TABLE posts
  ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT posts_comment_count_nonnegative CHECK (comment_count >= 0);

ALTER TABLE comments
  ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT comments_reply_count_nonnegative CHECK (reply_count >= 0);

ALTER TABLE text_content_submissions
  ADD COLUMN target_post_id TEXT,
  ADD COLUMN target_parent_comment_id TEXT,
  ADD CONSTRAINT text_content_submissions_target_shape CHECK (
    (surface = 'text_post' AND target_post_id IS NULL AND target_parent_comment_id IS NULL)
    OR (surface = 'comment' AND target_post_id IS NOT NULL AND target_parent_comment_id IS NULL)
    OR (surface = 'reply' AND target_post_id IS NOT NULL AND target_parent_comment_id IS NOT NULL)
  ),
  ADD CONSTRAINT text_content_submissions_target_post_fk
    FOREIGN KEY (community_id, target_post_id)
    REFERENCES posts (community_id, post_id),
  ADD CONSTRAINT text_content_submissions_target_parent_fk
    FOREIGN KEY (community_id, target_parent_comment_id)
    REFERENCES comments (community_id, comment_id);

-- The endpoint template is part of the idempotency identity. A comment and a
-- reply may reuse a key, while reuse across communities remains a conflict.
DROP INDEX IF EXISTS comments_author_idempotency_unique;
CREATE UNIQUE INDEX comments_author_endpoint_idempotency_unique
  ON comments (
    author_user_id,
    (CASE WHEN parent_comment_id IS NULL THEN 'comment' ELSE 'reply' END),
    idempotency_key
  )
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';

CREATE UNIQUE INDEX text_content_submissions_comment_reply_actor_key_unique
  ON text_content_submissions (actor_user_id, surface, idempotency_key)
  WHERE surface IN ('comment', 'reply');

CREATE TABLE comment_publication_projection (
  community_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  parent_comment_id TEXT,
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0 AND depth <= 8),
  status TEXT NOT NULL CHECK (status IN ('published', 'hidden', 'removed')),
  projected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (community_id, comment_id),
  CONSTRAINT comment_publication_projection_comment_fk
    FOREIGN KEY (community_id, comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT comment_publication_projection_post_fk
    FOREIGN KEY (community_id, post_id)
    REFERENCES posts (community_id, post_id),
  CONSTRAINT comment_publication_projection_parent_fk
    FOREIGN KEY (community_id, parent_comment_id)
    REFERENCES comments (community_id, comment_id)
);

CREATE INDEX comment_publication_projection_thread_idx
  ON comment_publication_projection (community_id, post_id, parent_comment_id, projected_at, comment_id);

CREATE TABLE content_publication_outbox (
  outbox_event_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('comment_published', 'comment_notification', 'comment_cache_invalidation')
  ),
  effect_key TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'failed')),
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  CONSTRAINT content_publication_outbox_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT content_publication_outbox_comment_fk
    FOREIGN KEY (community_id, comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT content_publication_outbox_effect_unique
    UNIQUE (submission_id, event_type),
  CONSTRAINT content_publication_outbox_effect_key_unique
    UNIQUE (effect_key),
  CONSTRAINT content_publication_outbox_time_shape CHECK (
    (state = 'published' AND published_at IS NOT NULL)
    OR (state IN ('pending', 'failed') AND published_at IS NULL)
  )
);

CREATE INDEX content_publication_outbox_pending_idx
  ON content_publication_outbox (state, created_at, outbox_event_id)
  WHERE state IN ('pending', 'failed');

CREATE TABLE comment_moderation_cases (
  case_ref TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  comment_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('automated', 'report')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'dismissed', 'blocked')),
  resolved_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT comment_moderation_cases_submission_fk
    FOREIGN KEY (community_id, submission_id)
    REFERENCES text_content_submissions (community_id, submission_id),
  CONSTRAINT comment_moderation_cases_comment_fk
    FOREIGN KEY (community_id, comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT comment_moderation_cases_source_shape CHECK (
    (source = 'automated' AND comment_id IS NULL)
    OR (source = 'report' AND comment_id IS NOT NULL)
  ),
  CONSTRAINT comment_moderation_cases_resolution_shape CHECK (
    (status = 'open' AND resolved_by_user_id IS NULL)
    OR (status <> 'open' AND resolved_by_user_id IS NOT NULL)
  ),
  CONSTRAINT comment_moderation_cases_time_order CHECK (updated_at >= created_at),
  CONSTRAINT comment_moderation_cases_source_submission_unique UNIQUE (source, submission_id)
);

CREATE INDEX comment_moderation_cases_open_target_idx
  ON comment_moderation_cases (community_id, comment_id, created_at, case_ref)
  WHERE status = 'open';

CREATE TABLE comment_reports (
  report_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  case_ref TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('spam', 'harassment', 'hate', 'sexual_content', 'graphic_content', 'misleading', 'other')
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'coalesced')),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT comment_reports_comment_fk
    FOREIGN KEY (community_id, comment_id)
    REFERENCES comments (community_id, comment_id),
  CONSTRAINT comment_reports_case_fk
    FOREIGN KEY (case_ref)
    REFERENCES comment_moderation_cases (case_ref),
  CONSTRAINT comment_reports_reporter_key_unique
    UNIQUE (reporter_user_id, comment_id, idempotency_key)
);

CREATE INDEX comment_reports_open_target_idx
  ON comment_reports (community_id, comment_id, created_at, report_id)
  WHERE status = 'open';

CREATE TABLE comment_moderation_actions (
  action_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  case_ref TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  action TEXT NOT NULL CHECK (action IN ('approve', 'dismiss', 'hide', 'remove', 'restore')),
  target_status TEXT NOT NULL CHECK (target_status IN ('held', 'published', 'hidden', 'removed')),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT comment_moderation_actions_case_fk
    FOREIGN KEY (case_ref)
    REFERENCES comment_moderation_cases (case_ref),
  CONSTRAINT comment_moderation_actions_actor_key_unique
    UNIQUE (case_ref, actor_user_id, idempotency_key)
);
