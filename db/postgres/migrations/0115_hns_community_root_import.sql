-- Join the ratified community route-attachment aggregate to the existing HNS
-- root-import machine without manufacturing community-creation authority.

CREATE TABLE community_route_attachment_start_reservations (
  reservation_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  attachment_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  client_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  route_root_label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('acquired', 'released', 'finalized')),
  fence_token BIGINT NOT NULL CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_start_reservations_intent_fk
    FOREIGN KEY (actor_id, attachment_intent_id)
    REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id),
  CONSTRAINT community_route_attachment_start_reservations_ceremony_fk
    FOREIGN KEY (ceremony_intent_id)
    REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  CONSTRAINT community_route_attachment_start_reservations_identity_check CHECK (
    is_hns_host_persistence_identity(reservation_id, 256)
    AND is_hns_host_persistence_identity(namespace_session_id, 256)
    AND is_hns_host_persistence_identity(community_id, 256)
    AND is_hns_host_persistence_identity(client_idempotency_key, 256)
    AND is_hns_host_persistence_identity(provider_id, 256)
    AND is_hns_host_persistence_identity(provider_configuration_ref, 256)
    AND is_hns_host_persistence_identity(provider_configuration_version, 256)
    AND is_hns_host_persistence_identity(protocol_version, 256)
    AND is_hns_host_persistence_identity(environment, 256)
    AND is_community_route_root_label('hns', route_root_label) IS TRUE
    AND updated_at >= created_at
  ),
  UNIQUE (actor_id, attachment_intent_id, client_idempotency_key),
  UNIQUE (namespace_session_id, actor_id),
  UNIQUE (reservation_id, fence_token)
);

CREATE INDEX community_route_attachment_start_reservations_lease_idx
  ON community_route_attachment_start_reservations(state, lease_expires_at);

CREATE TABLE hns_community_root_import_preparations (
  attachment_intent_id TEXT PRIMARY KEY
    REFERENCES community_route_attachment_intents(attachment_intent_id),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  ceremony_intent_id TEXT NOT NULL UNIQUE
    REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  root_label TEXT NOT NULL,
  root_import_session_id TEXT NOT NULL UNIQUE,
  provision_job_id TEXT NOT NULL UNIQUE,
  start_idempotency_key TEXT NOT NULL,
  start_request_sha256 TEXT NOT NULL CHECK (start_request_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_community_root_import_preparations_intent_actor_fk
    FOREIGN KEY (actor_id, attachment_intent_id)
    REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id),
  CONSTRAINT hns_community_root_import_preparations_identity_check CHECK (
    is_hns_host_persistence_identity(root_import_session_id, 256)
    AND is_hns_host_persistence_identity(provision_job_id, 256)
    AND is_hns_host_persistence_identity(start_idempotency_key, 256)
    AND is_community_route_root_label('hns', root_label) IS TRUE
    AND expires_at > created_at
  ),
  UNIQUE (actor_id, community_id, start_idempotency_key)
);

CREATE FUNCTION reject_hns_community_root_import_preparation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HNS community root-import preparations are append-only';
END;
$$;

CREATE TRIGGER hns_community_root_import_preparations_change_guard
BEFORE UPDATE OR DELETE ON hns_community_root_import_preparations
FOR EACH ROW EXECUTE FUNCTION reject_hns_community_root_import_preparation_change();

CREATE TABLE community_route_attachment_namespace_sessions (
  namespace_session_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  attachment_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  start_reservation_id TEXT NOT NULL,
  start_fence_token BIGINT NOT NULL CHECK (start_fence_token > 0),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  route_root_label TEXT NOT NULL,
  upstream_session_ref TEXT NOT NULL,
  presentation_kind TEXT NOT NULL CHECK (presentation_kind = 'embedded_sdk'),
  presentation_payload JSONB NOT NULL CHECK (jsonb_typeof(presentation_payload) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_namespace_sessions_intent_fk
    FOREIGN KEY (actor_id, attachment_intent_id)
    REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id),
  CONSTRAINT community_route_attachment_namespace_sessions_ceremony_fk
    FOREIGN KEY (ceremony_intent_id)
    REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id),
  CONSTRAINT community_route_attachment_namespace_sessions_reservation_fk
    FOREIGN KEY (start_reservation_id, start_fence_token)
    REFERENCES community_route_attachment_start_reservations(reservation_id, fence_token),
  CONSTRAINT community_route_attachment_namespace_sessions_identity_check CHECK (
    is_hns_host_persistence_identity(namespace_session_id, 256)
    AND is_hns_host_persistence_identity(community_id, 256)
    AND is_hns_host_persistence_identity(provider_id, 256)
    AND is_hns_host_persistence_identity(provider_configuration_ref, 256)
    AND is_hns_host_persistence_identity(provider_configuration_version, 256)
    AND is_hns_host_persistence_identity(protocol_version, 256)
    AND is_hns_host_persistence_identity(environment, 256)
    AND is_community_route_root_label('hns', route_root_label) IS TRUE
    AND octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
    AND expires_at > started_at
    AND updated_at >= created_at
  ),
  CONSTRAINT community_route_attachment_namespace_sessions_state_shape CHECK (
    (status = 'pending' AND completed_at IS NULL AND terminal_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND terminal_at = completed_at)
    OR (status IN ('failed', 'expired') AND completed_at IS NULL AND terminal_at IS NOT NULL)
  ),
  UNIQUE (namespace_session_id, actor_id),
  UNIQUE (actor_id, attachment_intent_id, generation),
  UNIQUE (actor_id, ceremony_intent_id)
);

ALTER TABLE hns_root_import_sessions
  ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'creation_intent',
  ADD COLUMN community_id TEXT REFERENCES communities(community_id),
  ADD COLUMN attachment_intent_id TEXT REFERENCES community_route_attachment_intents(attachment_intent_id),
  DROP CONSTRAINT hns_root_import_sessions_identity_check,
  DROP CONSTRAINT hns_root_import_sessions_generation_check,
  DROP CONSTRAINT hns_root_import_sessions_namespace_actor_fk,
  ALTER COLUMN creation_intent_id DROP NOT NULL,
  ALTER COLUMN ceremony_intent_id DROP NOT NULL,
  ALTER COLUMN namespace_session_id DROP NOT NULL,
  ALTER COLUMN ownership_generation DROP NOT NULL,
  ALTER COLUMN ownership_expected_revision DROP NOT NULL;

ALTER TABLE hns_root_import_sessions
  ADD CONSTRAINT hns_root_import_sessions_origin_check CHECK (
    (
      origin_kind = 'creation_intent'
      AND creation_intent_id IS NOT NULL
      AND ceremony_intent_id IS NOT NULL
      AND namespace_session_id IS NOT NULL
      AND ownership_generation IS NOT NULL
      AND ownership_expected_revision IS NOT NULL
      AND community_id IS NULL
      AND attachment_intent_id IS NULL
    )
    OR (
      origin_kind = 'community_attachment'
      AND creation_intent_id IS NULL
      AND ceremony_intent_id IS NULL
      AND namespace_session_id IS NOT NULL
      AND ownership_generation IS NOT NULL
      AND ownership_expected_revision IS NOT NULL
      AND community_id IS NOT NULL
      AND attachment_intent_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT hns_root_import_sessions_identity_check CHECK (
    is_hns_host_persistence_identity(root_import_session_id, 256)
    AND is_hns_host_persistence_identity(actor_id, 256)
    AND (creation_intent_id IS NULL OR is_hns_host_persistence_identity(creation_intent_id, 256))
    AND (ceremony_intent_id IS NULL OR is_hns_host_persistence_identity(ceremony_intent_id, 256))
    AND is_hns_host_persistence_identity(namespace_session_id, 256)
    AND is_community_route_root_label('hns', root_label) IS TRUE
    AND challenge_txt_value LIKE 'pirate-verification=%'
    AND octet_length(challenge_txt_value) BETWEEN 21 AND 16448
    AND challenge_txt_value !~ '[[:cntrl:]]'
    AND is_hns_host_persistence_identity(start_idempotency_key, 256)
    AND is_hns_host_persistence_identity(provision_job_id, 256)
    AND (provision_idempotency_key IS NULL OR is_hns_host_persistence_identity(provision_idempotency_key, 256))
    AND (observation_job_id IS NULL OR is_hns_host_persistence_identity(observation_job_id, 256))
    AND (observation_idempotency_key IS NULL OR is_hns_host_persistence_identity(observation_idempotency_key, 256))
  ),
  ADD CONSTRAINT hns_root_import_sessions_generation_check CHECK (
    ownership_generation BETWEEN 1 AND 9007199254740991
    AND ownership_expected_revision BETWEEN 1 AND 9007199254740991
    AND revision BETWEEN 1 AND 9007199254740991
  ),
  ADD CONSTRAINT hns_root_import_sessions_community_actor_fk
    FOREIGN KEY (actor_id, attachment_intent_id)
    REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id),
  ADD CONSTRAINT hns_root_import_sessions_community_idempotency_unique
    UNIQUE (actor_id, community_id, start_idempotency_key),
  ADD CONSTRAINT hns_root_import_sessions_community_session_unique
    UNIQUE (actor_id, community_id, root_import_session_id);

CREATE OR REPLACE FUNCTION guard_hns_root_import_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  creation_ownership namespace_ownership_sessions%ROWTYPE;
  attachment_ownership community_route_attachment_namespace_sessions%ROWTYPE;
BEGIN
  IF NEW.origin_kind = 'creation_intent' THEN
    SELECT * INTO creation_ownership
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR creation_ownership.actor_id <> NEW.actor_id
      OR creation_ownership.creation_intent_id <> NEW.creation_intent_id
      OR creation_ownership.ceremony_intent_id <> NEW.ceremony_intent_id
      OR creation_ownership.requirement_kind <> 'namespace_ownership'
      OR creation_ownership.generation <> NEW.ownership_generation
      OR creation_ownership.expected_revision <> NEW.ownership_expected_revision
      OR creation_ownership.route_family <> 'hns'
      OR creation_ownership.route_root_label <> NEW.root_label
      OR creation_ownership.status <> 'pending'
      OR creation_ownership.expires_at <> NEW.expires_at THEN
      RAISE EXCEPTION 'HNS root-import session does not match creation ownership authority';
    END IF;
  ELSIF NEW.origin_kind = 'community_attachment' THEN
    SELECT * INTO attachment_ownership
      FROM community_route_attachment_namespace_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NOT FOUND
      OR attachment_ownership.actor_id <> NEW.actor_id
      OR attachment_ownership.community_id <> NEW.community_id
      OR attachment_ownership.attachment_intent_id <> NEW.attachment_intent_id
      OR attachment_ownership.generation <> NEW.ownership_generation
      OR attachment_ownership.expected_revision <> NEW.ownership_expected_revision
      OR attachment_ownership.route_root_label <> NEW.root_label
      OR attachment_ownership.status <> 'pending'
      OR attachment_ownership.expires_at <> NEW.expires_at THEN
      RAISE EXCEPTION 'HNS root-import session does not match attachment ownership authority';
    END IF;
  ELSE
    RAISE EXCEPTION 'HNS root-import session origin is invalid';
  END IF;
  IF NEW.status <> 'awaiting_ownership' OR NEW.revision <> 1 THEN
    RAISE EXCEPTION 'HNS root-import session must start awaiting ownership';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_hns_root_import_session_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS root-import sessions are retained';
  END IF;
  IF ROW(
    NEW.root_import_session_id, NEW.actor_id, NEW.origin_kind,
    NEW.creation_intent_id, NEW.ceremony_intent_id, NEW.namespace_session_id,
    NEW.community_id, NEW.attachment_intent_id, NEW.ownership_generation,
    NEW.ownership_expected_revision, NEW.root_label, NEW.challenge_txt_value,
    NEW.start_idempotency_key, NEW.start_request_sha256, NEW.provision_job_id,
    NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.root_import_session_id, OLD.actor_id, OLD.origin_kind,
    OLD.creation_intent_id, OLD.ceremony_intent_id, OLD.namespace_session_id,
    OLD.community_id, OLD.attachment_intent_id, OLD.ownership_generation,
    OLD.ownership_expected_revision, OLD.root_label, OLD.challenge_txt_value,
    OLD.start_idempotency_key, OLD.start_request_sha256, OLD.provision_job_id,
    OLD.expires_at, OLD.created_at
  ) OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'HNS root-import session identity or revision changed';
  END IF;
  IF (OLD.ownership_result_sha256 IS NOT NULL AND NEW.ownership_result_sha256 IS DISTINCT FROM OLD.ownership_result_sha256)
    OR (OLD.provision_idempotency_key IS NOT NULL AND NEW.provision_idempotency_key IS DISTINCT FROM OLD.provision_idempotency_key)
    OR (OLD.provision_poll_request_sha256 IS NOT NULL AND NEW.provision_poll_request_sha256 IS DISTINCT FROM OLD.provision_poll_request_sha256)
    OR (OLD.observation_job_id IS NOT NULL AND NEW.observation_job_id IS DISTINCT FROM OLD.observation_job_id)
    OR (OLD.observation_idempotency_key IS NOT NULL AND NEW.observation_idempotency_key IS DISTINCT FROM OLD.observation_idempotency_key)
    OR (OLD.observation_request_sha256 IS NOT NULL AND NEW.observation_request_sha256 IS DISTINCT FROM OLD.observation_request_sha256)
    OR (OLD.readiness_result_bytes IS NOT NULL AND NEW.readiness_result_bytes IS DISTINCT FROM OLD.readiness_result_bytes)
    OR (OLD.readiness_result_sha256 IS NOT NULL AND NEW.readiness_result_sha256 IS DISTINCT FROM OLD.readiness_result_sha256) THEN
    RAISE EXCEPTION 'HNS root-import retained evidence changed';
  END IF;
  IF NOT (
    (OLD.status = 'awaiting_ownership' AND NEW.status IN ('provisioning', 'failed', 'expired'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('awaiting_owner_update', 'failed', 'expired'))
    OR (OLD.status IN ('awaiting_owner_update', 'observing') AND NEW.status IN ('observing', 'ready', 'failed', 'expired'))
    OR (OLD.status = 'ready' AND NEW.status IN ('activated', 'expired'))
  ) THEN
    RAISE EXCEPTION 'HNS root-import session transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE hns_root_import_activation_operations
  ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'creation_intent',
  ADD COLUMN attachment_intent_id TEXT REFERENCES community_route_attachment_intents(attachment_intent_id),
  ALTER COLUMN creation_intent_id DROP NOT NULL,
  DROP CONSTRAINT hns_root_import_activation_operations_identity_check;

ALTER TABLE hns_root_import_activation_operations
  ADD CONSTRAINT hns_root_import_activation_operations_origin_check CHECK (
    (origin_kind = 'creation_intent' AND creation_intent_id IS NOT NULL AND attachment_intent_id IS NULL)
    OR (origin_kind = 'community_attachment' AND creation_intent_id IS NULL AND attachment_intent_id IS NOT NULL)
  ),
  ADD CONSTRAINT hns_root_import_activation_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(root_import_session_id, 256)
    AND is_hns_host_persistence_identity(actor_id, 256)
    AND (creation_intent_id IS NULL OR is_hns_host_persistence_identity(creation_intent_id, 256))
    AND (attachment_intent_id IS NULL OR is_hns_host_persistence_identity(attachment_intent_id, 256))
    AND is_hns_host_persistence_identity(idempotency_key, 256)
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
    AND sale_namespace_activation_sha256 ~ '^[0-9a-f]{64}$'
  );
