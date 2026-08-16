-- Preserve the existing binding as the primary, then remove the scalar
-- community uniqueness constraint so independently verified mirrors can be
-- represented in the same shard.
ALTER TABLE namespace_bindings
  ADD COLUMN namespace_role TEXT NOT NULL DEFAULT 'primary'
    CHECK (namespace_role IN ('primary', 'mirror'));

DROP INDEX idx_namespace_bindings_active_community;

CREATE UNIQUE INDEX idx_namespace_bindings_active_primary_community
  ON namespace_bindings(community_id)
  WHERE status = 'active' AND namespace_role = 'primary';

CREATE UNIQUE INDEX idx_namespace_bindings_active_verification
  ON namespace_bindings(namespace_verification_id)
  WHERE status = 'active';
