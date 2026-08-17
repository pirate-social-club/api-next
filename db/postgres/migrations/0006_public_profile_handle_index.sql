-- Public profile lookup is backed by an explicit normalized Pirate-handle
-- index. Historical rows are populated by a separately reviewed operations
-- backfill; this migration does not scan or rewrite existing account JSON.

CREATE TABLE public_handle_index (
  handle_id TEXT PRIMARY KEY,
  label_normalized TEXT NOT NULL,
  label_display TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'redirect', 'retired')),
  owner_user_id TEXT NOT NULL,
  redirect_target_handle_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT public_handle_index_label_not_blank CHECK (btrim(label_normalized) <> ''),
  CONSTRAINT public_handle_index_display_not_blank CHECK (btrim(label_display) <> ''),
  CONSTRAINT public_handle_index_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (user_id),
  CONSTRAINT public_handle_index_redirect_fk
    FOREIGN KEY (redirect_target_handle_id) REFERENCES public_handle_index (handle_id),
  CONSTRAINT public_handle_index_status_target_check CHECK (
    (status = 'active' AND redirect_target_handle_id IS NULL)
    OR (status = 'redirect' AND redirect_target_handle_id IS NOT NULL)
    OR (status = 'retired' AND redirect_target_handle_id IS NULL)
  ),
  CONSTRAINT public_handle_index_not_self_redirect CHECK (
    redirect_target_handle_id IS NULL OR redirect_target_handle_id <> handle_id
  ),
  CONSTRAINT public_handle_index_label_format_check CHECK (
    label_normalized ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND label_display = label_normalized || '.pirate'
  )
);

CREATE UNIQUE INDEX public_handle_index_label_normalized_uidx
  ON public_handle_index (label_normalized);

CREATE INDEX public_handle_index_owner_status_idx
  ON public_handle_index (owner_user_id, status, updated_at DESC);

CREATE INDEX public_handle_index_redirect_target_idx
  ON public_handle_index (redirect_target_handle_id)
  WHERE status = 'redirect';

-- Creator listing is a real query on persisted communities, not an empty
-- placeholder. route_slug remains NULL until it is persisted in this schema.
CREATE INDEX communities_creator_status_created_idx
  ON communities (created_by_user_id, status, created_at DESC, community_id);
