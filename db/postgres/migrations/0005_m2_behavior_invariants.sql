-- Persistence required by the reviewed M2 community/content behavior.

ALTER TABLE community_memberships
  ADD COLUMN request_note TEXT;

ALTER TABLE community_follows
  ADD CONSTRAINT community_follows_status_timestamp_check
    CHECK (
      (status = 'active' AND unfollowed_at IS NULL)
      OR (status = 'inactive' AND unfollowed_at IS NOT NULL)
    );

ALTER TABLE comments
  ADD COLUMN depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0);
