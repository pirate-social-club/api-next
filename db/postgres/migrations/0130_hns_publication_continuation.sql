-- Explicit publication acknowledgements survive browser disconnects.
CREATE TABLE hns_community_publication_jobs (
  root_import_session_id TEXT PRIMARY KEY REFERENCES hns_root_import_sessions(root_import_session_id),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  idempotency_key TEXT NOT NULL CHECK (is_hns_host_persistence_identity(idempotency_key,256)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','completed','failed')),
  fence_token BIGINT NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id,idempotency_key)
);
CREATE INDEX hns_community_publication_due_idx
  ON hns_community_publication_jobs (next_attempt_at) WHERE state IN ('pending','leased');

-- A pending observation is not a failed proof. Renew it with a fresh fence
-- and observation identity; the existing three-failure budget stays bounded.
ALTER TABLE community_route_attachment_completion_attempts
  ADD COLUMN retryable_observation BOOLEAN NOT NULL DEFAULT FALSE;
