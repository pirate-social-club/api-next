-- Durable target-owned namespace-ownership sessions, completion leases, and
-- immutable HNS evidence snapshots.
--
-- Lock order for trigger paths that touch more than one row is fixed as:
-- users(actor) -> creation intent -> requirement state -> namespace session ->
-- completion attempt -> evidence snapshot/result. Provider calls are always
-- outside SQL, after the reservation transaction has committed.

ALTER TABLE community_creation_requirement_states
  ADD CONSTRAINT community_creation_requirement_states_actor_generation_unique
  UNIQUE (actor_id, intent_id, requirement_kind, generation);

CREATE TABLE namespace_ownership_start_reservations (
  reservation_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
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
  route_family TEXT NOT NULL CHECK (route_family = 'hns'),
  route_root_label TEXT NOT NULL,
  route_root_label_display TEXT NOT NULL,
  route_path_segment TEXT NOT NULL,
  route_href TEXT NOT NULL,
  route_app_host TEXT,
  state TEXT NOT NULL DEFAULT 'acquired'
    CHECK (state IN ('acquired', 'released', 'finalized')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_start_reservations_actor_intent_fk
    FOREIGN KEY (actor_id, creation_intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT namespace_ownership_start_reservations_requirement_fk
    FOREIGN KEY (creation_intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT namespace_ownership_start_reservations_ceremony_fk
    FOREIGN KEY (
      actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id
    )
    REFERENCES community_creation_ceremony_attempts (
      actor_id, intent_id, requirement_kind, generation, ceremony_intent_id
    ),
  CONSTRAINT namespace_ownership_start_reservations_generation_unique
    UNIQUE (creation_intent_id, requirement_kind, generation),
  CONSTRAINT namespace_ownership_start_reservations_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT namespace_ownership_start_reservations_client_key_unique
    UNIQUE (actor_id, creation_intent_id, client_idempotency_key),
  CONSTRAINT namespace_ownership_start_reservations_session_unique
    UNIQUE (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_start_reservations_fence_unique
    UNIQUE (reservation_id, fence_token),
  CONSTRAINT namespace_ownership_start_reservations_identifiers_not_blank CHECK (
    btrim(reservation_id) <> ''
    AND reservation_id = btrim(reservation_id)
    AND btrim(namespace_session_id) <> ''
    AND namespace_session_id = btrim(namespace_session_id)
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(client_idempotency_key) <> ''
    AND client_idempotency_key = btrim(client_idempotency_key)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
  ),
  CONSTRAINT namespace_ownership_start_reservations_route_shape CHECK (
    is_community_route_root_label(route_family, route_root_label) IS TRUE
    AND is_community_route_root_label_display(route_root_label_display) IS TRUE
    AND route_path_segment = 'app.' || route_root_label
    AND route_href = '/c/' || route_path_segment
    AND route_app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_start_reservations_time_order CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX namespace_ownership_start_reservations_lease_idx
  ON namespace_ownership_start_reservations (state, lease_expires_at);

CREATE TABLE namespace_ownership_sessions (
  namespace_session_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  start_reservation_id TEXT NOT NULL,
  start_fence_token BIGINT NOT NULL CHECK (start_fence_token > 0),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
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
  route_family TEXT NOT NULL CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT NOT NULL,
  route_root_label_display TEXT NOT NULL,
  route_path_segment TEXT NOT NULL,
  route_href TEXT NOT NULL,
  route_app_host TEXT,
  upstream_session_ref TEXT NOT NULL,
  presentation_kind TEXT NOT NULL
    CHECK (presentation_kind IN ('redirect', 'deeplink', 'embedded_sdk', 'poll', 'none')),
  presentation_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(presentation_payload) = 'object'),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_sessions_actor_intent_fk
    FOREIGN KEY (actor_id, creation_intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT namespace_ownership_sessions_requirement_fk
    FOREIGN KEY (creation_intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT namespace_ownership_sessions_ceremony_fk
    FOREIGN KEY (
      actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id
    )
    REFERENCES community_creation_ceremony_attempts (
      actor_id, intent_id, requirement_kind, generation, ceremony_intent_id
    ),
  CONSTRAINT namespace_ownership_sessions_start_reservation_fk
    FOREIGN KEY (start_reservation_id, start_fence_token)
    REFERENCES namespace_ownership_start_reservations (reservation_id, fence_token)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT namespace_ownership_sessions_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT namespace_ownership_sessions_generation_unique
    UNIQUE (creation_intent_id, requirement_kind, generation),
  CONSTRAINT namespace_ownership_sessions_identifiers_not_blank CHECK (
    btrim(namespace_session_id) <> ''
    AND namespace_session_id = btrim(namespace_session_id)
    AND btrim(start_reservation_id) <> ''
    AND start_reservation_id = btrim(start_reservation_id)
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
  ),
  CONSTRAINT namespace_ownership_sessions_route_shape CHECK (
    is_community_route_root_label(route_family, route_root_label) IS TRUE
    AND is_community_route_root_label_display(route_root_label_display) IS TRUE
    AND route_path_segment = CASE route_family
      WHEN 'hns' THEN 'app.' || route_root_label
      WHEN 'spaces' THEN '@' || route_root_label
    END
    AND route_href = '/c/' || route_path_segment
    AND route_app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_sessions_upstream_ref_shape CHECK (
    octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_sessions_request_lifecycle_shape CHECK (
    (
      status = 'pending'
      AND completed_at IS NULL
      AND terminal_at IS NULL
    )
    OR (
      status = 'completed'
      AND completed_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND completed_at = terminal_at
    )
    OR (
      status IN ('failed', 'expired')
      AND completed_at IS NULL
      AND terminal_at IS NOT NULL
      AND (status <> 'expired' OR terminal_at >= expires_at)
    )
  ),
  CONSTRAINT namespace_ownership_sessions_time_order CHECK (
    expires_at > started_at
    AND created_at >= started_at
    AND updated_at >= created_at
    AND (terminal_at IS NULL OR terminal_at >= started_at)
  )
);

ALTER TABLE namespace_ownership_sessions
  ADD CONSTRAINT namespace_ownership_sessions_id_actor_unique
  UNIQUE (namespace_session_id, actor_id);

CREATE OR REPLACE FUNCTION guard_namespace_ownership_start_reservation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership start reservations are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Lock order: actor -> intent -> requirement state -> start reservation.
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT * INTO intent_record
      FROM community_creation_intents
     WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
     FOR SHARE;
    SELECT * INTO state_record
      FROM community_creation_requirement_states
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
     FOR UPDATE;
    SELECT * INTO ceremony_record
      FROM community_creation_ceremony_attempts
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
       AND generation = NEW.generation
       AND ceremony_intent_id = NEW.ceremony_intent_id
     FOR SHARE;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
     FOR SHARE;

    IF intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR ceremony_record.ceremony_intent_id IS NULL
      OR state_record.status <> 'pending'
      OR intent_record.revision <> NEW.expected_revision
      OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
      OR state_record.generation <> NEW.generation
      OR state_record.requirement_hash <> NEW.requirement_hash
      OR state_record.provider_id <> NEW.provider_id
      OR state_record.provider_binding_hash <> NEW.provider_binding_hash
      OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR state_record.provider_configuration_version <> NEW.provider_configuration_version
      OR state_record.route_family <> NEW.route_family
      OR state_record.route_root_label <> NEW.route_root_label
      OR state_record.route_root_label_display <> NEW.route_root_label_display
      OR state_record.route_path_segment <> NEW.route_path_segment
      OR ceremony_record.requirement_hash <> NEW.requirement_hash
      OR ceremony_record.provider_id <> NEW.provider_id
      OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
      OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
      OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
      OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
      OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
      OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= clock_timestamp()
      OR (
        session_record.namespace_session_id IS NOT NULL
        AND NEW.lease_expires_at > session_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its ceremony';
    END IF;

    IF session_record.namespace_session_id IS NOT NULL
      AND (
        session_record.start_reservation_id <> NEW.reservation_id
        OR session_record.start_fence_token <> NEW.fence_token
        OR session_record.expected_revision <> NEW.expected_revision
        OR session_record.requirement_hash <> NEW.requirement_hash
        OR session_record.request_hash <> NEW.request_hash
        OR session_record.provider_id <> NEW.provider_id
        OR session_record.provider_binding_hash <> NEW.provider_binding_hash
        OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR session_record.provider_configuration_version <> NEW.provider_configuration_version
        OR session_record.protocol_version <> NEW.protocol_version
        OR session_record.environment <> NEW.environment
        OR session_record.route_family <> NEW.route_family
        OR session_record.route_root_label <> NEW.route_root_label
        OR session_record.route_root_label_display <> NEW.route_root_label_display
        OR session_record.route_path_segment <> NEW.route_path_segment
        OR session_record.route_href <> NEW.route_href
        OR session_record.route_app_host IS DISTINCT FROM NEW.route_app_host
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its session';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.reservation_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.creation_intent_id, NEW.ceremony_intent_id, NEW.requirement_kind,
    NEW.generation, NEW.requirement_hash, NEW.expected_revision,
    NEW.client_idempotency_key, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.reservation_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.creation_intent_id, OLD.ceremony_intent_id, OLD.requirement_kind,
    OLD.generation, OLD.requirement_hash, OLD.expected_revision,
    OLD.client_idempotency_key, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership start reservation authority is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  IF session_record.namespace_session_id IS NOT NULL
    AND NEW.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start lease exceeds its session expiry';
  END IF;

  IF OLD.state = 'acquired'
    AND NEW.state IN ('released', 'finalized')
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'released'
    AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'namespace ownership start reservation transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER namespace_ownership_start_reservation_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON namespace_ownership_start_reservations
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_start_reservation_change();

CREATE TABLE namespace_ownership_completion_attempts (
  -- The number of attempts is intentionally application-owned; no SQL budget
  -- is frozen until the namespace ceremony contract ratifies one.
  completion_attempt_id TEXT PRIMARY KEY,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  idempotency_key TEXT NOT NULL,
  completion_request_hash TEXT NOT NULL CHECK (completion_request_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL,
  submission_channel TEXT NOT NULL DEFAULT 'poll_result'
    CHECK (submission_channel = 'poll_result'),
  state TEXT NOT NULL CHECK (state IN ('leased', 'released', 'consumed')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_completion_attempts_session_actor_fk
    FOREIGN KEY (namespace_session_id, actor_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_completion_attempts_idempotency_unique
    UNIQUE (namespace_session_id, idempotency_key),
  CONSTRAINT namespace_ownership_completion_attempts_evidence_ref_unique
    UNIQUE (evidence_ref),
  CONSTRAINT namespace_ownership_completion_attempts_identifiers_not_blank CHECK (
    btrim(completion_attempt_id) <> ''
    AND completion_attempt_id = btrim(completion_attempt_id)
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
  ),
  CONSTRAINT namespace_ownership_completion_attempts_time_order CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX namespace_ownership_completion_attempts_lease_idx
  ON namespace_ownership_completion_attempts (state, lease_expires_at);

CREATE TABLE namespace_ownership_evidence_snapshots (
  evidence_ref TEXT PRIMARY KEY,
  completion_attempt_id TEXT NOT NULL UNIQUE,
  namespace_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL DEFAULT 'namespace_ownership'
    CHECK (requirement_kind = 'namespace_ownership'),
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
  family TEXT NOT NULL CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  href TEXT NOT NULL,
  app_host TEXT,
  upstream_session_ref TEXT NOT NULL,
  fence_token BIGINT NOT NULL CHECK (fence_token > 0),
  abi_version TEXT NOT NULL DEFAULT 'pirate-hns-ownership-evidence-v1'
    CHECK (abi_version = 'pirate-hns-ownership-evidence-v1'),
  ownership_source TEXT NOT NULL
    CHECK (ownership_source IN ('hns_parent_chain_txt', 'owner_authoritative_dns_txt')),
  challenge_name TEXT NOT NULL,
  challenge_value_sha256 TEXT NOT NULL CHECK (challenge_value_sha256 ~ '^[0-9a-f]{64}$'),
  root_exists BOOLEAN NOT NULL CHECK (root_exists IS TRUE),
  root_control_verified BOOLEAN NOT NULL CHECK (root_control_verified IS TRUE),
  expiry_horizon_sufficient BOOLEAN NOT NULL CHECK (expiry_horizon_sufficient IS TRUE),
  chain_network TEXT NOT NULL,
  chain_anchor_height BIGINT NOT NULL CHECK (chain_anchor_height > 0),
  chain_anchor_block_hash TEXT NOT NULL CHECK (chain_anchor_block_hash ~ '^[0-9a-f]{64}$'),
  chain_anchor_median_time BIGINT NOT NULL CHECK (chain_anchor_median_time > 0),
  expiry_height BIGINT NOT NULL CHECK (expiry_height > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  provider_evidence_ref TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL CHECK (observation_sha256 ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT NOT NULL CHECK (provider_identity_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  observation JSONB NOT NULL,
  raw_response_bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_ownership_evidence_snapshots_attempt_fk
    FOREIGN KEY (completion_attempt_id)
    REFERENCES namespace_ownership_completion_attempts (completion_attempt_id),
  CONSTRAINT namespace_ownership_evidence_snapshots_session_actor_fk
    FOREIGN KEY (namespace_session_id, actor_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id, actor_id),
  CONSTRAINT namespace_ownership_evidence_snapshots_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
    AND btrim(creation_intent_id) <> ''
    AND creation_intent_id = btrim(creation_intent_id)
    AND btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND octet_length(provider_configuration_ref) <= 512
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
    AND btrim(chain_network) <> ''
    AND chain_network = btrim(chain_network)
    AND btrim(provider_evidence_ref) <> ''
    AND provider_evidence_ref = btrim(provider_evidence_ref)
    AND octet_length(provider_evidence_ref) <= 512
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
    AND href = '/c/' || path_segment
    AND app_host IS NULL
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_upstream_ref_shape CHECK (
    octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_challenge_shape CHECK (
    btrim(challenge_name) <> ''
    AND challenge_name = btrim(challenge_name)
    AND octet_length(challenge_name) <= 255
    AND challenge_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_observation_shape CHECK (
    jsonb_typeof(observation) = 'object'
    AND observation ->> 'status' = 'verified'
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_raw_bytes_shape CHECK (
    octet_length(raw_response_bytes) BETWEEN 1 AND 1048576
  ),
  CONSTRAINT namespace_ownership_evidence_snapshots_time_order CHECK (
    expires_at > observed_at
    AND created_at >= observed_at
  )
);

CREATE OR REPLACE FUNCTION validate_namespace_ownership_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
BEGIN
  -- Lock order: actor -> intent -> requirement state -> start reservation -> session.
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR UPDATE;
  SELECT * INTO ceremony_record
    FROM community_creation_ceremony_attempts
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = NEW.requirement_kind
     AND generation = NEW.generation
     AND ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;
  SELECT * INTO reservation_record
    FROM namespace_ownership_start_reservations
   WHERE reservation_id = NEW.start_reservation_id
     AND fence_token = NEW.start_fence_token
   FOR SHARE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR ceremony_record.ceremony_intent_id IS NULL
    OR state_record.status <> 'pending'
    OR intent_record.revision <> NEW.expected_revision
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
    OR state_record.provider_id <> NEW.provider_id
    OR state_record.provider_binding_hash <> NEW.provider_binding_hash
    OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR state_record.provider_configuration_version <> NEW.provider_configuration_version
    OR NEW.status <> 'pending'
    OR NEW.expires_at <= clock_timestamp()
    OR ceremony_record.provider_id <> NEW.provider_id
    OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
    OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
    OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
    OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
    OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
    OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
    OR (
      reservation_record.reservation_id IS NOT NULL
      AND (
        reservation_record.namespace_session_id <> NEW.namespace_session_id
        OR reservation_record.actor_id <> NEW.actor_id
        OR reservation_record.creation_intent_id <> NEW.creation_intent_id
        OR reservation_record.ceremony_intent_id <> NEW.ceremony_intent_id
        OR reservation_record.requirement_kind <> NEW.requirement_kind
        OR reservation_record.generation <> NEW.generation
        OR reservation_record.expected_revision <> NEW.expected_revision
        OR reservation_record.requirement_hash <> NEW.requirement_hash
        OR reservation_record.request_hash <> NEW.request_hash
        OR reservation_record.provider_id <> NEW.provider_id
        OR reservation_record.provider_binding_hash <> NEW.provider_binding_hash
        OR reservation_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR reservation_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR reservation_record.provider_configuration_version <> NEW.provider_configuration_version
        OR reservation_record.protocol_version <> NEW.protocol_version
        OR reservation_record.environment <> NEW.environment
        OR reservation_record.route_family <> NEW.route_family
        OR reservation_record.route_root_label <> NEW.route_root_label
        OR reservation_record.route_root_label_display <> NEW.route_root_label_display
        OR reservation_record.route_path_segment <> NEW.route_path_segment
        OR reservation_record.route_href <> NEW.route_href
        OR reservation_record.route_app_host IS DISTINCT FROM NEW.route_app_host
        OR reservation_record.state NOT IN ('acquired', 'finalized')
        OR reservation_record.lease_expires_at > NEW.expires_at
      )
    ) THEN
    RAISE EXCEPTION 'namespace ownership session does not match its creation ceremony';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_session_insert_guard
BEFORE INSERT ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_session_insert();

CREATE OR REPLACE FUNCTION guard_namespace_ownership_session_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership sessions are append-only';
  END IF;

  IF ROW(
    NEW.namespace_session_id, NEW.actor_id, NEW.creation_intent_id,
    NEW.ceremony_intent_id, NEW.start_reservation_id, NEW.start_fence_token,
    NEW.expected_revision, NEW.requirement_kind, NEW.generation,
    NEW.requirement_hash, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.upstream_session_ref,
    NEW.presentation_kind, NEW.presentation_payload, NEW.started_at, NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.namespace_session_id, OLD.actor_id, OLD.creation_intent_id,
    OLD.ceremony_intent_id, OLD.start_reservation_id, OLD.start_fence_token,
    OLD.expected_revision, OLD.requirement_kind, OLD.generation,
    OLD.requirement_hash, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.upstream_session_ref,
    OLD.presentation_kind, OLD.presentation_payload, OLD.started_at, OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership session identity and launch fields are immutable';
  END IF;

  IF NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.generation = OLD.generation
  ) THEN
    RAISE EXCEPTION 'namespace ownership session transition is not allowed: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_session_update_guard
BEFORE UPDATE ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE TRIGGER namespace_ownership_session_delete_guard
BEFORE DELETE ON namespace_ownership_sessions
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_start_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_start_reservations' THEN
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = NEW.reservation_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = reservation_record.namespace_session_id
       AND actor_id = reservation_record.actor_id;
    IF session_record.namespace_session_id IS NULL THEN
      IF reservation_record.state IN ('acquired', 'released') THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'finalized namespace ownership start requires its session';
    END IF;
  ELSE
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = session_record.start_reservation_id
       AND fence_token = session_record.start_fence_token;
  END IF;

  IF reservation_record.reservation_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR reservation_record.state <> 'finalized'
    OR reservation_record.namespace_session_id <> session_record.namespace_session_id
    OR reservation_record.actor_id <> session_record.actor_id
    OR reservation_record.creation_intent_id <> session_record.creation_intent_id
    OR reservation_record.ceremony_intent_id <> session_record.ceremony_intent_id
    OR reservation_record.requirement_kind <> session_record.requirement_kind
    OR reservation_record.generation <> session_record.generation
    OR reservation_record.expected_revision <> session_record.expected_revision
    OR reservation_record.requirement_hash <> session_record.requirement_hash
    OR reservation_record.request_hash <> session_record.request_hash
    OR reservation_record.provider_id <> session_record.provider_id
    OR reservation_record.provider_binding_hash <> session_record.provider_binding_hash
    OR reservation_record.provider_configuration_kind <> session_record.provider_configuration_kind
    OR reservation_record.provider_configuration_ref <> session_record.provider_configuration_ref
    OR reservation_record.provider_configuration_version <> session_record.provider_configuration_version
    OR reservation_record.protocol_version <> session_record.protocol_version
    OR reservation_record.environment <> session_record.environment
    OR reservation_record.route_family <> session_record.route_family
    OR reservation_record.route_root_label <> session_record.route_root_label
    OR reservation_record.route_root_label_display <> session_record.route_root_label_display
    OR reservation_record.route_path_segment <> session_record.route_path_segment
    OR reservation_record.route_href <> session_record.route_href
    OR reservation_record.route_app_host IS DISTINCT FROM session_record.route_app_host
    OR reservation_record.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start reservation/session coherence is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_start_reservation_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_start_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_start_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE OR REPLACE FUNCTION guard_namespace_ownership_completion_attempt_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership completion attempts are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Lock order: actor -> intent -> requirement state -> session -> attempt.
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT ci.* INTO intent_record
      FROM community_creation_intents AS ci
     WHERE ci.actor_id = NEW.actor_id
       AND ci.intent_id = (
         SELECT ns0.creation_intent_id
           FROM namespace_ownership_sessions AS ns0
          WHERE ns0.namespace_session_id = NEW.namespace_session_id
            AND ns0.actor_id = NEW.actor_id
       )
     FOR SHARE;
    SELECT crs.* INTO state_record
      FROM community_creation_requirement_states AS crs
     WHERE crs.actor_id = NEW.actor_id
       AND crs.intent_id = intent_record.intent_id
       AND crs.requirement_kind = 'namespace_ownership'
     FOR SHARE;
    SELECT ns.* INTO session_record
      FROM namespace_ownership_sessions AS ns
     WHERE ns.namespace_session_id = NEW.namespace_session_id
       AND ns.actor_id = NEW.actor_id
     FOR UPDATE;
    IF session_record.namespace_session_id IS NULL
      OR intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR session_record.status <> 'pending'
      OR session_record.expires_at <= clock_timestamp()
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'namespace ownership completion attempt requires a live pending session';
    END IF;
    IF NEW.lease_expires_at > session_record.expires_at THEN
      RAISE EXCEPTION 'completion lease exceeds its namespace session expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.completion_attempt_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.idempotency_key, NEW.completion_request_hash, NEW.evidence_ref,
    NEW.submission_channel,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.completion_attempt_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.idempotency_key, OLD.completion_request_hash, OLD.evidence_ref,
    OLD.submission_channel,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership completion attempt identity is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  -- The UPDATE statement already holds the attempt row lock. Read the parent
  -- without taking a second lock; repositories pre-lock the session before
  -- updating an attempt, and the deferred coherence trigger below validates
  -- the pair at commit.
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  IF session_record.namespace_session_id IS NULL
    OR session_record.status <> 'pending'
    OR session_record.expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'completion attempt requires a live pending session';
  END IF;

  IF OLD.state = 'leased' AND NEW.state IN ('released', 'consumed')
    AND NEW.fence_token = OLD.fence_token
    AND OLD.lease_expires_at > clock_timestamp()
    AND NEW.lease_expires_at = OLD.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'released' AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > clock_timestamp()
    AND NEW.lease_expires_at <= session_record.expires_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'namespace ownership completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER namespace_ownership_completion_attempt_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON namespace_ownership_completion_attempts
FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_completion_attempt_change();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_attempt_session_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  leased_attempt_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_completion_attempts' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id;

    IF session_record.namespace_session_id IS NULL THEN
      RAISE EXCEPTION 'namespace ownership completion attempt has no session';
    END IF;

    IF NEW.state = 'leased'
      AND (
        session_record.status <> 'pending'
        OR session_record.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'leased namespace ownership attempt requires a live pending session';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  SELECT EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
       AND state = 'leased'
  ) INTO leased_attempt_exists;

  IF session_record.namespace_session_id IS NULL THEN
    RAISE EXCEPTION 'namespace ownership session has no completion attempt parent';
  END IF;

  IF session_record.status <> 'pending' AND leased_attempt_exists THEN
    RAISE EXCEPTION 'terminal namespace ownership session cannot retain a leased attempt';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_attempt_session_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_attempt_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  -- Lock order: actor -> intent -> requirement state -> session -> attempt.
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR session_record.expires_at <= clock_timestamp()
    OR attempt_record.state NOT IN ('leased', 'consumed')
    OR attempt_record.lease_expires_at <= clock_timestamp()
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its live session fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NEW.challenge_name <> '_pirate.' || NEW.root_label THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER namespace_ownership_evidence_snapshot_insert_guard
BEFORE INSERT ON namespace_ownership_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_evidence_snapshot_insert();

CREATE OR REPLACE FUNCTION reject_namespace_ownership_evidence_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'namespace ownership evidence snapshots are append-only';
END;
$$;

CREATE TRIGGER namespace_ownership_evidence_snapshot_append_only
BEFORE UPDATE OR DELETE ON namespace_ownership_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_namespace_ownership_evidence_snapshot_change();

ALTER TABLE community_creation_ceremony_results
  ADD COLUMN namespace_session_id TEXT,
  ADD COLUMN completion_attempt_id TEXT,
  ADD COLUMN submission_channel TEXT,
  ADD CONSTRAINT community_creation_ceremony_results_namespace_session_fk
    FOREIGN KEY (namespace_session_id)
    REFERENCES namespace_ownership_sessions (namespace_session_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_fk
    FOREIGN KEY (completion_attempt_id)
    REFERENCES namespace_ownership_completion_attempts (completion_attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_unique
    UNIQUE (completion_attempt_id),
  ADD CONSTRAINT community_creation_ceremony_results_submission_channel_check
    CHECK (submission_channel IS NULL OR submission_channel = 'poll_result');

ALTER TABLE community_creation_ceremony_results
  DROP CONSTRAINT community_creation_ceremony_results_outcome_shape;

ALTER TABLE community_creation_ceremony_results
  ADD CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND proof_session_id IS NOT NULL
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND proof_session_id IS NULL
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
          AND evidence_receipt_id IS NULL
        )
      )
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
      AND (
        (
          requirement_kind = 'human_identity'
          AND namespace_session_id IS NULL
          AND completion_attempt_id IS NULL
          AND submission_channel IS NULL
        )
        OR (
          requirement_kind = 'namespace_ownership'
          AND namespace_session_id IS NOT NULL
          AND completion_attempt_id IS NOT NULL
          AND submission_channel = 'poll_result'
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
  receipt_record evidence_receipts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;

  IF NOT FOUND
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.intent_id <> attempt_record.intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.completion_attempt_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion attempt';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = NEW.completion_attempt_id
     FOR SHARE;
    IF session_record.namespace_session_id IS NULL
      OR completion_record.completion_attempt_id IS NULL
      OR completion_record.namespace_session_id <> session_record.namespace_session_id
      OR completion_record.actor_id <> NEW.actor_id
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR completion_record.submission_channel <> 'poll_result'
      OR NEW.callback_idempotency_key <> completion_record.idempotency_key
      OR NEW.callback_request_hash <> completion_record.completion_request_hash
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version THEN
      RAISE EXCEPTION 'ceremony result proof session does not match its attempt';
    END IF;
  END IF;

  IF NEW.evidence_receipt_id IS NOT NULL THEN
    SELECT * INTO receipt_record
      FROM evidence_receipts
     WHERE evidence_receipt_id = NEW.evidence_receipt_id;
    IF NOT FOUND
      OR NEW.proof_session_id IS NULL
      OR receipt_record.proof_session_id <> NEW.proof_session_id
      OR receipt_record.user_id <> NEW.actor_id
      OR receipt_record.provider_id <> NEW.provider_id
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_namespace_ownership_terminal_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_sessions' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO result_record
     FROM community_creation_ceremony_results
     WHERE namespace_session_id = session_record.namespace_session_id;
  ELSE
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.ceremony_intent_id;
    IF result_record.namespace_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = result_record.namespace_session_id;
  END IF;

  IF session_record.status = 'pending' THEN
    IF result_record.ceremony_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'pending namespace ownership session cannot have a ceremony result';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.namespace_session_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id <> session_record.namespace_session_id
    OR (
      session_record.status = 'completed'
      AND result_record.outcome_status <> 'satisfied'
    )
    OR (
      session_record.status IN ('failed', 'expired')
      AND result_record.outcome_status <> session_record.status
    )
  THEN
    RAISE EXCEPTION 'terminal namespace ownership session/result correlation is incomplete';
  END IF;

  IF session_record.status = 'completed' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM community_creation_ceremony_results AS result
        JOIN namespace_ownership_evidence_snapshots AS snapshot
          ON snapshot.evidence_ref = result.evidence_ref
         AND snapshot.namespace_session_id = result.namespace_session_id
         AND snapshot.completion_attempt_id = result.completion_attempt_id
         AND snapshot.evidence_digest = result.evidence_digest
         AND snapshot.provider_identity_digest = result.provider_identity_digest
         AND snapshot.observed_at <= clock_timestamp()
         AND snapshot.expires_at > clock_timestamp()
       WHERE result.namespace_session_id = session_record.namespace_session_id
         AND result.outcome_status = 'satisfied'
    ) THEN
      RAISE EXCEPTION 'completed namespace ownership session requires its evidence snapshot';
    END IF;
  ELSE
    IF result_record.evidence_ref IS NOT NULL
      OR result_record.evidence_digest IS NOT NULL
      OR result_record.provider_identity_digest IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM namespace_ownership_evidence_snapshots
         WHERE namespace_session_id = session_record.namespace_session_id
      )
    THEN
      RAISE EXCEPTION 'failed or expired namespace ownership has no evidence snapshot';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER namespace_ownership_session_terminal_coherence
AFTER INSERT OR UPDATE ON namespace_ownership_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_result_terminal_coherence
AFTER INSERT ON community_creation_ceremony_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
  state_found BOOLEAN;
  result_found BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN RETURN NULL; END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;
  state_found := FOUND;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;
  result_found := FOUND;

  IF NOT result_found THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
    END IF;

    IF state_found
      AND state_record.status IN ('satisfied', 'failed', 'expired') THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;

    RETURN NULL;
  END IF;

  IF state_record.status IN ('satisfied', 'failed', 'expired') THEN
    IF result_record.ceremony_intent_id IS NULL
      OR result_record.outcome_status <> state_record.status
      OR result_record.actor_id <> state_record.actor_id
      OR result_record.intent_id <> state_record.intent_id
      OR result_record.requirement_kind <> state_record.requirement_kind
      OR result_record.generation <> state_record.generation
      OR result_record.requirement_hash <> state_record.requirement_hash
      OR result_record.provider_id <> state_record.provider_id
      OR result_record.provider_binding_hash <> state_record.provider_binding_hash
      OR result_record.provider_configuration_version <> state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at
    THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_creation_ceremony_attempts
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = attempt_record.intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;

  IF attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR attempt_record.requirement_kind <> 'namespace_ownership'
    OR result_record.outcome_status <> 'satisfied'
    OR state_record.status <> 'satisfied'
    OR state_record.generation <> attempt_record.generation
    OR state_record.current_ceremony_intent_id <> NEW.creation_ceremony_intent_id
    OR NEW.verified_by_actor_id <> attempt_record.actor_id
    OR NEW.family <> attempt_record.route_family
    OR NEW.root_label <> attempt_record.route_root_label
    OR NEW.root_label_display <> attempt_record.route_root_label_display
    OR NEW.path_segment <> attempt_record.route_path_segment
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
    OR NEW.provider_identity_digest <> result_record.provider_identity_digest
    OR NEW.evidence_ref <> result_record.evidence_ref
    OR NEW.evidence_digest <> result_record.evidence_digest
    OR NEW.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
    OR NEW.verified_at <> result_record.satisfied_at
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  IF result_record.namespace_session_id IS NOT NULL THEN
    SELECT * INTO snapshot_record
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = NEW.evidence_ref
       AND namespace_session_id = result_record.namespace_session_id
       AND completion_attempt_id = result_record.completion_attempt_id;
    IF snapshot_record.evidence_ref IS NULL
      OR snapshot_record.evidence_digest <> NEW.evidence_digest
      OR snapshot_record.provider_identity_digest <> NEW.provider_identity_digest
    THEN
      RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
