CREATE UNIQUE INDEX idx_community_roles_active_owner_unique
    ON community_roles(community_id)
    WHERE status = 'active' AND role = 'owner';
