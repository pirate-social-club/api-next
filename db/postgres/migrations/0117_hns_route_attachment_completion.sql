CREATE TABLE community_route_attachment_completion_attempts (
  completion_attempt_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  attachment_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  idempotency_key TEXT NOT NULL,
  completion_request_sha256 TEXT NOT NULL CHECK (completion_request_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('leased','released','consumed')),
  fence_token BIGINT NOT NULL CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  terminal_status TEXT CHECK (terminal_status IN ('verified','rejected','expired')),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_completion_session_fk FOREIGN KEY (
    namespace_session_id,actor_id
  ) REFERENCES community_route_attachment_namespace_sessions(namespace_session_id,actor_id),
  CONSTRAINT community_route_attachment_completion_intent_fk FOREIGN KEY (
    actor_id,attachment_intent_id
  ) REFERENCES community_route_attachment_intents(actor_id,attachment_intent_id),
  CONSTRAINT community_route_attachment_completion_ceremony_fk FOREIGN KEY (
    ceremony_intent_id
  ) REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  CONSTRAINT community_route_attachment_completion_shape CHECK (
    is_hns_host_persistence_identity(completion_attempt_id,256)
    AND is_hns_host_persistence_identity(idempotency_key,256)
    AND is_hns_host_persistence_identity(evidence_ref,256)
    AND updated_at >= created_at
    AND (
      (state IN ('leased','released') AND terminal_status IS NULL
        AND result_hash IS NULL AND terminal_at IS NULL)
      OR (state='consumed' AND terminal_status IS NOT NULL
        AND result_hash IS NOT NULL AND terminal_at IS NOT NULL)
    )
  ),
  UNIQUE(actor_id,namespace_session_id,idempotency_key,attempt_number),
  UNIQUE(completion_attempt_id,fence_token),
  UNIQUE(completion_attempt_id,namespace_session_id,actor_id,community_id,
    attachment_intent_id,ceremony_intent_id)
);

CREATE INDEX community_route_attachment_completion_lease_idx
  ON community_route_attachment_completion_attempts(state,lease_expires_at);

CREATE TABLE community_route_attachment_completion_observations (
  result_hash TEXT PRIMARY KEY CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  completion_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES community_route_attachment_completion_attempts(completion_attempt_id),
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  attachment_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','rejected','expired')),
  provider_response_sha256 TEXT
    CHECK (provider_response_sha256 IS NULL OR provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT
    CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT
    CHECK (provider_identity_digest IS NULL OR provider_identity_digest ~ '^[0-9a-f]{64}$'),
  raw_response_bytes BYTEA,
  observed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_completion_observation_session_fk FOREIGN KEY (
    namespace_session_id,actor_id
  ) REFERENCES community_route_attachment_namespace_sessions(namespace_session_id,actor_id),
  CONSTRAINT community_route_attachment_completion_observation_attempt_fk FOREIGN KEY (
    completion_attempt_id,namespace_session_id,actor_id,community_id,
    attachment_intent_id,ceremony_intent_id
  ) REFERENCES community_route_attachment_completion_attempts(
    completion_attempt_id,namespace_session_id,actor_id,community_id,
    attachment_intent_id,ceremony_intent_id
  ),
  CONSTRAINT community_route_attachment_completion_observation_shape CHECK (
    (status='verified' AND provider_response_sha256 IS NOT NULL
      AND evidence_digest IS NOT NULL AND provider_identity_digest IS NOT NULL
      AND raw_response_bytes IS NOT NULL AND observed_at IS NOT NULL
      AND (expires_at IS NULL OR expires_at > observed_at))
    OR (status IN ('rejected','expired') AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL)
  )
);

CREATE TRIGGER community_route_attachment_completion_observation_append_only
BEFORE UPDATE OR DELETE ON community_route_attachment_completion_observations
FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();
