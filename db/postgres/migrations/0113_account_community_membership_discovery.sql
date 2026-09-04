-- Account-scoped posting-target discovery reads only active memberships and
-- advances in immutable creation order. The partial index keeps that lookup
-- bounded without indexing non-member lifecycle rows.
CREATE INDEX community_memberships_account_active_created_idx
  ON community_memberships (user_id, created_at, community_id COLLATE "C")
  WHERE status = 'member';
