-- Durable HNS canonical-route revalidation authority.
--
-- Revalidation is scheduler-owned and never reuses community-creation
-- ceremony identifiers. Provider work occurs outside transactions; these
-- rows preserve the reserve -> call -> fenced-finalize authority chain.

CREATE TABLE community_route_revalidation_start_reservations (
  route_revalidation_id TEXT PRIMARY KEY,
  revalidation_session_id TEXT NOT NULL UNIQUE,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'system' CHECK (principal_kind = 'system'),
  principal_id TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  expected_verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT 'hns-txt-v1'
    CHECK (protocol_version = 'hns-txt-v1'),
  environment TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  start_request_hash TEXT NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'acquired'
    CHECK (state IN ('acquired', 'released', 'finalized')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_revalidation_start_binding_fk
    FOREIGN KEY (community_id, route_binding_id)
    REFERENCES community_canonical_route_bindings (community_id, route_binding_id),
  CONSTRAINT community_route_revalidation_start_generation_unique
    UNIQUE (route_binding_id, expected_binding_generation),
  CONSTRAINT community_route_revalidation_start_fence_unique
    UNIQUE (route_revalidation_id, fence_token),
  CONSTRAINT community_route_revalidation_start_identifiers_not_blank CHECK (
    btrim(route_revalidation_id) <> ''
    AND route_revalidation_id = btrim(route_revalidation_id)
    AND octet_length(route_revalidation_id) <= 256
    AND btrim(revalidation_session_id) <> ''
    AND revalidation_session_id = btrim(revalidation_session_id)
    AND octet_length(revalidation_session_id) <= 256
    AND btrim(principal_id) <> ''
    AND principal_id = btrim(principal_id)
    AND octet_length(principal_id) <= 256
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND octet_length(provider_id) <= 256
    AND btrim(provider_configuration_reference) <> ''
    AND provider_configuration_reference = btrim(provider_configuration_reference)
    AND octet_length(provider_configuration_reference) <= 512
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND octet_length(provider_configuration_version) <= 128
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
    AND octet_length(environment) <= 128
  ),
  CONSTRAINT community_route_revalidation_start_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
  ),
  CONSTRAINT community_route_revalidation_start_time_order CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX community_route_revalidation_start_lease_idx
  ON community_route_revalidation_start_reservations (state, lease_expires_at);

CREATE TABLE community_route_revalidation_sessions (
  revalidation_session_id TEXT PRIMARY KEY,
  route_revalidation_id TEXT NOT NULL UNIQUE,
  start_fence_token BIGINT NOT NULL CHECK (start_fence_token > 0),
  community_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'system' CHECK (principal_kind = 'system'),
  principal_id TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  expected_verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  start_request_hash TEXT NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT 'hns-txt-v1'
    CHECK (protocol_version = 'hns-txt-v1'),
  environment TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  upstream_session_ref TEXT NOT NULL,
  start_presentation JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_revalidation_sessions_start_fk
    FOREIGN KEY (route_revalidation_id, start_fence_token)
    REFERENCES community_route_revalidation_start_reservations (
      route_revalidation_id, fence_token
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_revalidation_sessions_binding_fk
    FOREIGN KEY (community_id, route_binding_id)
    REFERENCES community_canonical_route_bindings (community_id, route_binding_id),
  CONSTRAINT community_route_revalidation_sessions_authority_unique
    UNIQUE (
      route_revalidation_id,
      revalidation_session_id,
      route_binding_id,
      expected_binding_generation
    ),
  CONSTRAINT community_route_revalidation_sessions_upstream_unique
    UNIQUE (provider_id, provider_binding_hash, environment, upstream_session_ref),
  CONSTRAINT community_route_revalidation_sessions_identifiers_not_blank CHECK (
    btrim(revalidation_session_id) <> ''
    AND revalidation_session_id = btrim(revalidation_session_id)
    AND octet_length(revalidation_session_id) <= 256
    AND btrim(route_revalidation_id) <> ''
    AND route_revalidation_id = btrim(route_revalidation_id)
    AND octet_length(route_revalidation_id) <= 256
    AND btrim(principal_id) <> ''
    AND principal_id = btrim(principal_id)
    AND octet_length(principal_id) <= 256
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND octet_length(provider_id) <= 256
    AND btrim(provider_configuration_reference) <> ''
    AND provider_configuration_reference = btrim(provider_configuration_reference)
    AND octet_length(provider_configuration_reference) <= 512
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND octet_length(provider_configuration_version) <= 128
    AND btrim(environment) <> ''
    AND environment = btrim(environment)
    AND octet_length(environment) <= 128
  ),
  CONSTRAINT community_route_revalidation_sessions_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
  ),
  CONSTRAINT community_route_revalidation_sessions_upstream_ref_shape CHECK (
    octet_length(upstream_session_ref) BETWEEN 1 AND 16384
    AND btrim(upstream_session_ref) = upstream_session_ref
    AND upstream_session_ref !~ '[[:cntrl:]]'
  ),
  CONSTRAINT community_route_revalidation_sessions_presentation_shape CHECK (
    jsonb_typeof(start_presentation) = 'object'
  ),
  CONSTRAINT community_route_revalidation_sessions_lifecycle_shape CHECK (
    (status = 'pending' AND terminal_at IS NULL)
    OR (status IN ('completed', 'failed', 'expired') AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT community_route_revalidation_sessions_time_order CHECK (
    expires_at > started_at
    AND created_at >= started_at
    AND updated_at >= created_at
    AND (terminal_at IS NULL OR terminal_at >= started_at)
  )
);

CREATE TABLE community_route_revalidation_completion_attempts (
  route_revalidation_attempt_id TEXT PRIMARY KEY,
  route_revalidation_id TEXT NOT NULL,
  revalidation_session_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  expected_verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  idempotency_key TEXT NOT NULL,
  completion_request_hash TEXT NOT NULL CHECK (completion_request_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'leased'
    CHECK (state IN ('leased', 'released', 'consumed')),
  fence_token BIGINT NOT NULL DEFAULT 1 CHECK (fence_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  consumption_kind TEXT CHECK (consumption_kind IN (
    'verified', 'missing_root', 'control_failed', 'challenge_mismatch',
    'insufficient_expiry', 'disputed', 'revoked', 'database_time_expired',
    'session_expired', 'stale_cas'
  )),
  result_hash TEXT CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_revalidation_attempts_session_fk
    FOREIGN KEY (
      route_revalidation_id,
      revalidation_session_id,
      route_binding_id,
      expected_binding_generation
    ) REFERENCES community_route_revalidation_sessions (
      route_revalidation_id,
      revalidation_session_id,
      route_binding_id,
      expected_binding_generation
    ),
  CONSTRAINT community_route_revalidation_attempts_number_unique
    UNIQUE (route_revalidation_id, attempt_number),
  CONSTRAINT community_route_revalidation_attempts_idempotency_unique
    UNIQUE (route_revalidation_id, idempotency_key),
  CONSTRAINT community_route_revalidation_attempts_fence_unique
    UNIQUE (route_revalidation_attempt_id, fence_token),
  CONSTRAINT community_route_revalidation_attempts_identifiers_not_blank CHECK (
    btrim(route_revalidation_attempt_id) <> ''
    AND route_revalidation_attempt_id = btrim(route_revalidation_attempt_id)
    AND octet_length(route_revalidation_attempt_id) <= 256
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 256
    AND btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
  ),
  CONSTRAINT community_route_revalidation_attempts_result_shape CHECK (
    (
      state = 'consumed'
      AND consumption_kind IS NOT NULL
      AND result_hash IS NOT NULL
      AND terminal_at IS NOT NULL
    )
    OR (
      state IN ('leased', 'released')
      AND consumption_kind IS NULL
      AND result_hash IS NULL
      AND terminal_at IS NULL
    )
  ),
  CONSTRAINT community_route_revalidation_attempts_time_order CHECK (
    updated_at >= created_at
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  )
);

CREATE INDEX community_route_revalidation_attempts_lease_idx
  ON community_route_revalidation_completion_attempts (state, lease_expires_at);

CREATE TABLE community_route_revalidation_evidence_snapshots (
  evidence_ref TEXT PRIMARY KEY,
  route_revalidation_attempt_id TEXT NOT NULL UNIQUE,
  route_revalidation_id TEXT NOT NULL,
  revalidation_session_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL DEFAULT 'system' CHECK (principal_kind = 'system'),
  principal_id TEXT NOT NULL,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  expected_binding_generation BIGINT NOT NULL CHECK (expected_binding_generation > 0),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 1),
  expected_verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  start_request_hash TEXT NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_reference TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT 'hns-txt-v1'
    CHECK (protocol_version = 'hns-txt-v1'),
  environment TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  upstream_session_ref TEXT NOT NULL,
  fence_token BIGINT NOT NULL CHECK (fence_token > 0),
  abi_version TEXT NOT NULL DEFAULT 'pirate-hns-route-revalidation-evidence-v1'
    CHECK (abi_version = 'pirate-hns-route-revalidation-evidence-v1'),
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
  observation JSONB NOT NULL CHECK (
    jsonb_typeof(observation) = 'object'
    AND observation ->> 'status' = 'verified'
  ),
  raw_response_bytes BYTEA NOT NULL
    CHECK (octet_length(raw_response_bytes) BETWEEN 1 AND 1048576),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_revalidation_snapshots_attempt_fk
    FOREIGN KEY (route_revalidation_attempt_id, fence_token)
    REFERENCES community_route_revalidation_completion_attempts (
      route_revalidation_attempt_id, fence_token
    ),
  CONSTRAINT community_route_revalidation_snapshots_session_fk
    FOREIGN KEY (
      route_revalidation_id,
      revalidation_session_id,
      route_binding_id,
      expected_binding_generation
    ) REFERENCES community_route_revalidation_sessions (
      route_revalidation_id,
      revalidation_session_id,
      route_binding_id,
      expected_binding_generation
    ),
  CONSTRAINT community_route_revalidation_snapshots_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND octet_length(evidence_ref) <= 512
    AND btrim(principal_id) <> ''
    AND principal_id = btrim(principal_id)
    AND octet_length(principal_id) <= 256
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND octet_length(provider_id) <= 256
    AND btrim(provider_configuration_reference) <> ''
    AND provider_configuration_reference = btrim(provider_configuration_reference)
    AND octet_length(provider_configuration_reference) <= 512
    AND btrim(chain_network) <> ''
    AND chain_network = btrim(chain_network)
    AND btrim(provider_evidence_ref) <> ''
    AND provider_evidence_ref = btrim(provider_evidence_ref)
    AND octet_length(provider_evidence_ref) <= 512
    AND octet_length(provider_configuration_version) <= 128
    AND octet_length(environment) <= 128
  ),
  CONSTRAINT community_route_revalidation_snapshots_generation_shape CHECK (
    binding_generation = expected_binding_generation + 1
  ),
  CONSTRAINT community_route_revalidation_snapshots_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = 'app.' || root_label
  ),
  CONSTRAINT community_route_revalidation_snapshots_challenge_shape CHECK (
    btrim(challenge_name) <> ''
    AND challenge_name = btrim(challenge_name)
    AND octet_length(challenge_name) <= 255
    AND challenge_name !~ '[[:cntrl:]]'
    AND (
      (ownership_source = 'hns_parent_chain_txt' AND challenge_name = root_label)
      OR (
        ownership_source = 'owner_authoritative_dns_txt'
        AND challenge_name = '_pirate.' || root_label
      )
    )
  ),
  CONSTRAINT community_route_revalidation_snapshots_time_order CHECK (
    expires_at > observed_at
    AND created_at >= observed_at
  )
);

ALTER TABLE community_route_ownership_evidence
  ADD COLUMN origin TEXT,
  ADD COLUMN route_revalidation_attempt_id TEXT;

UPDATE community_route_ownership_evidence
   SET origin = 'creation_ceremony';

ALTER TABLE community_route_ownership_evidence
  DROP CONSTRAINT community_route_ownership_evid_creation_ceremony_intent_id_fkey,
  ALTER COLUMN origin SET DEFAULT 'creation_ceremony',
  ALTER COLUMN origin SET NOT NULL,
  ALTER COLUMN creation_ceremony_intent_id DROP NOT NULL,
  ALTER COLUMN verified_by_actor_id DROP NOT NULL,
  ADD CONSTRAINT community_route_ownership_evidence_creation_ceremony_fk
    FOREIGN KEY (creation_ceremony_intent_id)
    REFERENCES community_creation_ceremony_attempts (ceremony_intent_id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT community_route_ownership_evidence_origin_shape CHECK (
    (
      origin = 'creation_ceremony'
      AND creation_ceremony_intent_id IS NOT NULL
      AND route_revalidation_attempt_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'route_revalidation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NOT NULL
      AND verified_by_actor_id IS NULL
    )
  ),
  ADD CONSTRAINT community_route_ownership_evidence_revalidation_attempt_fk
    FOREIGN KEY (route_revalidation_attempt_id)
    REFERENCES community_route_revalidation_completion_attempts (
      route_revalidation_attempt_id
    ) DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX community_route_ownership_evidence_revalidation_attempt_uidx
  ON community_route_ownership_evidence (route_revalidation_attempt_id)
  WHERE origin = 'route_revalidation';

ALTER TABLE community_canonical_route_bindings
  DROP CONSTRAINT community_canonical_route_bindings_verified_evidence_ref_fkey,
  ADD CONSTRAINT community_canonical_route_bindings_verified_evidence_fk
    FOREIGN KEY (verified_evidence_ref)
    REFERENCES community_route_ownership_evidence (evidence_ref)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION guard_community_route_revalidation_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ;
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  creation_session namespace_ownership_sessions%ROWTYPE;
  prior_session community_route_revalidation_sessions%ROWTYPE;
  prior_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
BEGIN
  db_now := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation start reservations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    -- Common route lock order: community -> binding -> evidence/session authority.
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id
     FOR UPDATE;
    SELECT * INTO binding_record
      FROM community_canonical_route_bindings
     WHERE route_binding_id = NEW.route_binding_id
       AND community_id = NEW.community_id
     FOR UPDATE;

    IF community_record.community_id IS NULL
      OR binding_record.route_binding_id IS NULL
      OR community_record.status <> 'active'
      OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
      OR binding_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
      OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
      OR binding_record.family IS DISTINCT FROM NEW.family
      OR binding_record.root_label IS DISTINCT FROM NEW.root_label
      OR binding_record.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR binding_record.path_segment IS DISTINCT FROM NEW.path_segment
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR NEW.lease_expires_at > db_now + INTERVAL '16 seconds'
    THEN
      RAISE EXCEPTION 'route revalidation reservation does not match the canonical binding';
    END IF;

    IF NEW.expected_verified_evidence_ref IS NOT NULL THEN
      SELECT * INTO evidence_record
        FROM community_route_ownership_evidence
       WHERE evidence_ref = NEW.expected_verified_evidence_ref
       FOR SHARE;
      IF evidence_record.evidence_ref IS NULL
        OR evidence_record.family IS DISTINCT FROM NEW.family
        OR evidence_record.root_label IS DISTINCT FROM NEW.root_label
        OR evidence_record.root_label_display IS DISTINCT FROM NEW.root_label_display
        OR evidence_record.path_segment IS DISTINCT FROM NEW.path_segment
        OR evidence_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
        OR evidence_record.provider_id IS DISTINCT FROM NEW.provider_id
        OR evidence_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR evidence_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
      THEN
        RAISE EXCEPTION 'route revalidation reservation does not match current evidence';
      END IF;

      IF evidence_record.origin = 'creation_ceremony' THEN
        SELECT * INTO creation_session
          FROM namespace_ownership_sessions
         WHERE ceremony_intent_id = evidence_record.creation_ceremony_intent_id
         FOR SHARE;
        IF creation_session.namespace_session_id IS NULL
          OR creation_session.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
          OR creation_session.provider_configuration_ref IS DISTINCT FROM NEW.provider_configuration_reference
          OR creation_session.protocol_version IS DISTINCT FROM NEW.protocol_version
          OR creation_session.environment IS DISTINCT FROM NEW.environment
        THEN
          RAISE EXCEPTION 'route revalidation reservation lacks creation provider authority';
        END IF;
      ELSE
        SELECT * INTO prior_snapshot
          FROM community_route_revalidation_evidence_snapshots
         WHERE route_revalidation_attempt_id = evidence_record.route_revalidation_attempt_id
         FOR SHARE;
        IF prior_snapshot.evidence_ref IS NULL
          OR prior_snapshot.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
          OR prior_snapshot.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
          OR prior_snapshot.protocol_version IS DISTINCT FROM NEW.protocol_version
          OR prior_snapshot.environment IS DISTINCT FROM NEW.environment
        THEN
          RAISE EXCEPTION 'route revalidation reservation lacks prior snapshot authority';
        END IF;
      END IF;
    ELSE
      -- Same-root recovery inherits authority from the operation that moved the
      -- binding to this suspended generation; it never guesses from route text.
      SELECT session.* INTO prior_session
        FROM community_route_revalidation_completion_attempts AS attempt
        JOIN community_route_revalidation_sessions AS session
          ON session.route_revalidation_id = attempt.route_revalidation_id
         AND session.revalidation_session_id = attempt.revalidation_session_id
       WHERE attempt.route_binding_id = NEW.route_binding_id
         AND attempt.expected_binding_generation = NEW.expected_binding_generation - 1
         AND attempt.state = 'consumed'
         AND attempt.consumption_kind IN (
           'missing_root', 'control_failed', 'challenge_mismatch',
           'insufficient_expiry', 'disputed', 'revoked', 'database_time_expired'
         )
       ORDER BY attempt.terminal_at DESC
       LIMIT 1
       FOR SHARE OF session;
      IF prior_session.revalidation_session_id IS NULL
        OR binding_record.route_lifecycle_status <> 'suspended'
        OR prior_session.principal_kind IS DISTINCT FROM NEW.principal_kind
        OR prior_session.principal_id IS DISTINCT FROM NEW.principal_id
        OR prior_session.provider_id IS DISTINCT FROM NEW.provider_id
        OR prior_session.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR prior_session.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
        OR prior_session.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
        OR prior_session.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
        OR prior_session.protocol_version IS DISTINCT FROM NEW.protocol_version
        OR prior_session.environment IS DISTINCT FROM NEW.environment
        OR prior_session.family IS DISTINCT FROM NEW.family
        OR prior_session.root_label IS DISTINCT FROM NEW.root_label
        OR prior_session.root_label_display IS DISTINCT FROM NEW.root_label_display
        OR prior_session.path_segment IS DISTINCT FROM NEW.path_segment
      THEN
        RAISE EXCEPTION 'route revalidation recovery lacks prior operation authority';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_id, NEW.revalidation_session_id, NEW.community_id,
    NEW.route_binding_id, NEW.principal_kind, NEW.principal_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.requirement_hash, NEW.provider_id, NEW.provider_binding_hash,
    NEW.provider_configuration_kind, NEW.provider_configuration_reference,
    NEW.provider_configuration_version, NEW.protocol_version, NEW.environment,
    NEW.family, NEW.root_label, NEW.root_label_display, NEW.path_segment,
    NEW.start_request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_id, OLD.revalidation_session_id, OLD.community_id,
    OLD.route_binding_id, OLD.principal_kind, OLD.principal_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.requirement_hash, OLD.provider_id, OLD.provider_binding_hash,
    OLD.provider_configuration_kind, OLD.provider_configuration_reference,
    OLD.provider_configuration_version, OLD.protocol_version, OLD.environment,
    OLD.family, OLD.root_label, OLD.root_label_display, OLD.path_segment,
    OLD.start_request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route revalidation reservation authority is immutable';
  END IF;

  IF OLD.state = 'acquired'
    AND NEW.state IN ('released', 'finalized')
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND OLD.lease_expires_at > db_now
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('released', 'acquired')
    AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND NEW.lease_expires_at <= db_now + INTERVAL '16 seconds'
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'route revalidation reservation transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER community_route_revalidation_start_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_route_revalidation_start_reservations
FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_start();

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ;
  reservation_record community_route_revalidation_start_reservations%ROWTYPE;
  presentation_payload JSONB;
  presentation_member_count INTEGER;
  payload_member_count INTEGER;
BEGIN
  db_now := clock_timestamp();
  NEW.created_at := db_now;
  NEW.updated_at := db_now;
  SELECT * INTO reservation_record
    FROM community_route_revalidation_start_reservations
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND fence_token = NEW.start_fence_token
   FOR UPDATE;
  presentation_payload := NEW.start_presentation -> 'payload';
  SELECT count(*)::integer INTO presentation_member_count
    FROM jsonb_object_keys(NEW.start_presentation);
  SELECT count(*)::integer INTO payload_member_count
    FROM jsonb_object_keys(presentation_payload);
  IF reservation_record.route_revalidation_id IS NULL
    OR reservation_record.revalidation_session_id IS DISTINCT FROM NEW.revalidation_session_id
    OR reservation_record.community_id IS DISTINCT FROM NEW.community_id
    OR reservation_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR reservation_record.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR reservation_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR reservation_record.expected_binding_generation IS DISTINCT FROM NEW.expected_binding_generation
    OR reservation_record.expected_verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
    OR reservation_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR reservation_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR reservation_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR reservation_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR reservation_record.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
    OR reservation_record.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
    OR reservation_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR reservation_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR reservation_record.environment IS DISTINCT FROM NEW.environment
    OR reservation_record.family IS DISTINCT FROM NEW.family
    OR reservation_record.root_label IS DISTINCT FROM NEW.root_label
    OR reservation_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR reservation_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR reservation_record.state NOT IN ('acquired', 'finalized')
    OR reservation_record.lease_expires_at <= db_now
    OR NEW.status <> 'pending'
    OR NEW.started_at > db_now
    OR NEW.expires_at <= db_now
    OR presentation_member_count <> 5
    OR (NEW.start_presentation ->> 'kind') IS DISTINCT FROM 'embedded_sdk'
    OR (NEW.start_presentation ->> 'session_id') IS DISTINCT FROM NEW.upstream_session_ref
    OR (NEW.start_presentation ->> 'protocol') IS DISTINCT FROM 'hns-txt-challenge'
    OR (NEW.start_presentation ->> 'version') IS DISTINCT FROM '1'
    OR jsonb_typeof(presentation_payload) IS DISTINCT FROM 'object'
    OR payload_member_count <> 4
    OR (presentation_payload ->> 'ownership_source') NOT IN (
      'hns_parent_chain_txt', 'owner_authoritative_dns_txt'
    )
    OR (presentation_payload ->> 'challenge_name') IS DISTINCT FROM (CASE
      WHEN (presentation_payload ->> 'ownership_source') = 'hns_parent_chain_txt'
        THEN NEW.root_label
      ELSE '_pirate.' || NEW.root_label
    END)
    OR (presentation_payload ->> 'challenge_value')
      IS DISTINCT FROM 'pirate-verification=' || NEW.upstream_session_ref
    OR (presentation_payload ->> 'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
  THEN
    RAISE EXCEPTION 'route revalidation session does not match its live start reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_revalidation_session_insert_guard
BEFORE INSERT ON community_route_revalidation_sessions
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_session_insert();

CREATE OR REPLACE FUNCTION guard_community_route_revalidation_session_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation sessions cannot be deleted';
  END IF;
  IF ROW(
    NEW.revalidation_session_id, NEW.route_revalidation_id, NEW.start_fence_token,
    NEW.community_id, NEW.route_binding_id, NEW.principal_kind, NEW.principal_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.requirement_hash, NEW.start_request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_reference, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.family, NEW.root_label,
    NEW.root_label_display, NEW.path_segment, NEW.upstream_session_ref,
    NEW.start_presentation,
    NEW.started_at, NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.revalidation_session_id, OLD.route_revalidation_id, OLD.start_fence_token,
    OLD.community_id, OLD.route_binding_id, OLD.principal_kind, OLD.principal_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.requirement_hash, OLD.start_request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_reference, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.family, OLD.root_label,
    OLD.root_label_display, OLD.path_segment, OLD.upstream_session_ref,
    OLD.start_presentation,
    OLD.started_at, OLD.expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route revalidation session authority is immutable';
  END IF;
  IF OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= clock_timestamp()
    AND (NEW.status <> 'expired' OR NEW.terminal_at >= NEW.expires_at)
  THEN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'route revalidation session transition is not allowed: % -> %',
    OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_route_revalidation_session_change_guard
BEFORE UPDATE OR DELETE ON community_route_revalidation_sessions
FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_session_change();

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_start_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_record community_route_revalidation_start_reservations%ROWTYPE;
  session_record community_route_revalidation_sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'community_route_revalidation_start_reservations' THEN
    SELECT * INTO reservation_record FROM community_route_revalidation_start_reservations
     WHERE route_revalidation_id = NEW.route_revalidation_id;
    SELECT * INTO session_record FROM community_route_revalidation_sessions
     WHERE route_revalidation_id = NEW.route_revalidation_id;
  ELSE
    SELECT * INTO session_record FROM community_route_revalidation_sessions
     WHERE revalidation_session_id = NEW.revalidation_session_id;
    SELECT * INTO reservation_record FROM community_route_revalidation_start_reservations
     WHERE route_revalidation_id = session_record.route_revalidation_id;
  END IF;
  IF session_record.revalidation_session_id IS NULL THEN
    IF reservation_record.state IN ('acquired', 'released') THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'finalized route revalidation start requires its session';
  END IF;
  IF reservation_record.state <> 'finalized'
    OR reservation_record.revalidation_session_id IS DISTINCT FROM session_record.revalidation_session_id
    OR reservation_record.fence_token IS DISTINCT FROM session_record.start_fence_token
  THEN
    RAISE EXCEPTION 'route revalidation start/session coherence is incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_route_revalidation_start_coherence
AFTER INSERT OR UPDATE ON community_route_revalidation_start_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_start_coherence();

CREATE CONSTRAINT TRIGGER community_route_revalidation_session_coherence
AFTER INSERT OR UPDATE ON community_route_revalidation_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_start_coherence();

CREATE UNIQUE INDEX community_route_revalidation_one_leased_attempt_uidx
  ON community_route_revalidation_completion_attempts (revalidation_session_id)
  WHERE state = 'leased';

CREATE OR REPLACE FUNCTION guard_community_route_revalidation_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ;
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
BEGIN
  db_now := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation completion attempts cannot be deleted';
  END IF;

  SELECT * INTO session_record
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = COALESCE(NEW.route_revalidation_id, OLD.route_revalidation_id)
     AND revalidation_session_id = COALESCE(NEW.revalidation_session_id, OLD.revalidation_session_id)
   FOR UPDATE;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation completion attempt lacks its session';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT count(*)::integer INTO consumed_count
      FROM community_route_revalidation_completion_attempts
     WHERE route_revalidation_id = NEW.route_revalidation_id
       AND state = 'consumed';
    IF session_record.status <> 'pending'
      OR session_record.expires_at <= db_now
      OR NEW.route_binding_id IS DISTINCT FROM session_record.route_binding_id
      OR NEW.expected_binding_generation IS DISTINCT FROM session_record.expected_binding_generation
      OR NEW.expected_verified_evidence_ref IS DISTINCT FROM session_record.expected_verified_evidence_ref
      OR NEW.attempt_number IS DISTINCT FROM consumed_count + 1
      OR consumed_count >= 3
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR NEW.lease_expires_at > db_now + INTERVAL '16 seconds'
      OR NEW.lease_expires_at > session_record.expires_at
    THEN
      RAISE EXCEPTION 'route revalidation completion attempt is not admissible';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_attempt_id, NEW.route_revalidation_id,
    NEW.revalidation_session_id, NEW.route_binding_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.attempt_number, NEW.idempotency_key, NEW.completion_request_hash,
    NEW.evidence_ref, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_attempt_id, OLD.route_revalidation_id,
    OLD.revalidation_session_id, OLD.route_binding_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.attempt_number, OLD.idempotency_key, OLD.completion_request_hash,
    OLD.evidence_ref, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route revalidation completion attempt authority is immutable';
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL
    AND NEW.result_hash IS NULL
    AND NEW.terminal_at IS NULL
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('released', 'leased')
    AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND NEW.lease_expires_at <= db_now + INTERVAL '16 seconds'
    AND NEW.lease_expires_at <= session_record.expires_at
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.consumption_kind IS NULL
    AND NEW.result_hash IS NULL
    AND NEW.terminal_at IS NULL
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state = 'leased'
    AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NOT NULL
    AND NEW.result_hash IS NOT NULL
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= db_now
    AND (
      (
        NEW.consumption_kind <> 'session_expired'
        AND OLD.lease_expires_at > db_now
        AND session_record.status = 'pending'
        AND session_record.expires_at > db_now
      )
      OR (
        NEW.consumption_kind = 'session_expired'
        AND session_record.expires_at <= db_now
      )
    )
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'route revalidation completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE TRIGGER community_route_revalidation_attempt_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_route_revalidation_completion_attempts
FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_attempt();

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_attempt_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record community_route_revalidation_sessions%ROWTYPE;
  leased_exists BOOLEAN;
  consumed_exists BOOLEAN;
  mismatched_consumption_exists BOOLEAN;
BEGIN
  SELECT * INTO session_record
    FROM community_route_revalidation_sessions
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation attempt has no session';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM community_route_revalidation_completion_attempts
     WHERE revalidation_session_id = NEW.revalidation_session_id
       AND state = 'leased'
  ) INTO leased_exists;
  SELECT EXISTS (
    SELECT 1 FROM community_route_revalidation_completion_attempts
     WHERE revalidation_session_id = NEW.revalidation_session_id
       AND state = 'consumed'
  ) INTO consumed_exists;
  IF session_record.status <> 'pending' AND leased_exists THEN
    RAISE EXCEPTION 'terminal route revalidation session cannot retain a lease';
  END IF;
  IF session_record.status = 'pending' AND consumed_exists THEN
    RAISE EXCEPTION 'consumed route revalidation attempt requires a terminal session';
  END IF;
  IF session_record.status = 'completed' AND NOT consumed_exists THEN
    RAISE EXCEPTION 'completed route revalidation session requires a consumed attempt';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM community_route_revalidation_completion_attempts
     WHERE revalidation_session_id = NEW.revalidation_session_id
       AND state = 'consumed'
       AND (
         (session_record.status = 'completed' AND consumption_kind = 'session_expired')
         OR (session_record.status = 'expired' AND consumption_kind <> 'session_expired')
         OR session_record.status = 'failed'
       )
  ) INTO mismatched_consumption_exists;
  IF mismatched_consumption_exists THEN
    RAISE EXCEPTION 'route revalidation session status contradicts its consumed outcome';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_route_revalidation_attempt_session_guard
AFTER INSERT OR UPDATE ON community_route_revalidation_completion_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();

CREATE CONSTRAINT TRIGGER community_route_revalidation_session_attempt_guard
AFTER UPDATE ON community_route_revalidation_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();

CREATE OR REPLACE FUNCTION validate_community_route_revalidation_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  db_now TIMESTAMPTZ;
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  session_record community_route_revalidation_sessions%ROWTYPE;
  attempt_record community_route_revalidation_completion_attempts%ROWTYPE;
  observation_record JSONB;
  outer_member_count INTEGER;
  observation_member_count INTEGER;
BEGIN
  db_now := clock_timestamp();
  NEW.created_at := db_now;
  -- Preserve the common lock order even when a caller inserts the child first.
  SELECT * INTO community_record FROM communities
   WHERE community_id = NEW.community_id FOR UPDATE;
  SELECT * INTO binding_record FROM community_canonical_route_bindings
   WHERE route_binding_id = NEW.route_binding_id
     AND community_id = NEW.community_id FOR UPDATE;
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND revalidation_session_id = NEW.revalidation_session_id FOR SHARE;
  SELECT * INTO attempt_record FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id FOR UPDATE;

  IF community_record.community_id IS NULL
    OR binding_record.route_binding_id IS NULL
    OR session_record.revalidation_session_id IS NULL
    OR attempt_record.route_revalidation_attempt_id IS NULL
    OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind <> 'verified'
    OR attempt_record.route_revalidation_id IS DISTINCT FROM NEW.route_revalidation_id
    OR attempt_record.revalidation_session_id IS DISTINCT FROM NEW.revalidation_session_id
    OR attempt_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR attempt_record.expected_binding_generation IS DISTINCT FROM NEW.expected_binding_generation
    OR attempt_record.expected_verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
    OR attempt_record.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR attempt_record.fence_token IS DISTINCT FROM NEW.fence_token
    OR session_record.community_id IS DISTINCT FROM NEW.community_id
    OR session_record.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR session_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR session_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR session_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR session_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR session_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR session_record.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
    OR session_record.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
    OR session_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR session_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR session_record.environment IS DISTINCT FROM NEW.environment
    OR session_record.family IS DISTINCT FROM NEW.family
    OR session_record.root_label IS DISTINCT FROM NEW.root_label
    OR session_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR session_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR session_record.upstream_session_ref IS DISTINCT FROM NEW.upstream_session_ref
    OR session_record.status <> 'completed'
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR NEW.observed_at > db_now
    OR NEW.expires_at <= db_now
  THEN
    RAISE EXCEPTION 'route revalidation snapshot does not match its consumed verified authority';
  END IF;

  observation_record := NEW.observation -> 'observation';
  SELECT count(*)::integer INTO outer_member_count
    FROM jsonb_object_keys(NEW.observation);
  SELECT count(*)::integer INTO observation_member_count
    FROM jsonb_object_keys(observation_record);
  IF outer_member_count <> 2
    OR NEW.observation ->> 'status' IS DISTINCT FROM 'verified'
    OR jsonb_typeof(observation_record) IS DISTINCT FROM 'object'
    OR observation_member_count <> 14
    OR observation_record ->> 'ownership_source' IS DISTINCT FROM NEW.ownership_source
    OR observation_record ->> 'challenge_name' IS DISTINCT FROM NEW.challenge_name
    OR (observation_record ->> 'ownership_source')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,ownership_source}')
    OR (observation_record ->> 'challenge_name')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,challenge_name}')
    OR (observation_record ->> 'challenge_value')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,challenge_value}')
    OR (observation_record ->> 'challenge_value')
      IS DISTINCT FROM 'pirate-verification=' || NEW.upstream_session_ref
    OR jsonb_typeof(observation_record -> 'challenge_value') IS DISTINCT FROM 'string'
    OR octet_length(observation_record ->> 'challenge_value') NOT BETWEEN 1 AND 4096
    OR (observation_record ->> 'challenge_value') ~ '[[:cntrl:]]'
    OR encode(
      sha256(convert_to(observation_record ->> 'challenge_value', 'UTF8')),
      'hex'
    ) IS DISTINCT FROM NEW.challenge_value_sha256
    OR jsonb_typeof(observation_record -> 'root_exists') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'root_exists')::boolean IS DISTINCT FROM NEW.root_exists
    OR jsonb_typeof(observation_record -> 'root_control_verified') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'root_control_verified')::boolean
      IS DISTINCT FROM NEW.root_control_verified
    OR jsonb_typeof(observation_record -> 'expiry_horizon_sufficient') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'expiry_horizon_sufficient')::boolean
      IS DISTINCT FROM NEW.expiry_horizon_sufficient
    OR observation_record ->> 'chain_network' IS DISTINCT FROM NEW.chain_network
    OR jsonb_typeof(observation_record -> 'chain_anchor_height') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'chain_anchor_height')::bigint
      IS DISTINCT FROM NEW.chain_anchor_height
    OR observation_record ->> 'chain_anchor_block_hash'
      IS DISTINCT FROM NEW.chain_anchor_block_hash
    OR jsonb_typeof(observation_record -> 'chain_anchor_median_time') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'chain_anchor_median_time')::bigint
      IS DISTINCT FROM NEW.chain_anchor_median_time
    OR jsonb_typeof(observation_record -> 'expiry_height') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'expiry_height')::bigint IS DISTINCT FROM NEW.expiry_height
    OR (observation_record ->> 'observed_at')::timestamptz IS DISTINCT FROM NEW.observed_at
    OR (observation_record ->> 'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
    OR observation_record ->> 'provider_evidence_ref'
      IS DISTINCT FROM NEW.provider_evidence_ref
    OR encode(sha256(NEW.raw_response_bytes), 'hex') IS DISTINCT FROM NEW.observation_sha256
  THEN
    RAISE EXCEPTION 'route revalidation snapshot observation is incomplete or inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_revalidation_snapshot_insert_guard
BEFORE INSERT ON community_route_revalidation_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_snapshot_insert();

CREATE TRIGGER community_route_revalidation_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_route_revalidation_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  creation_attempt community_creation_ceremony_attempts%ROWTYPE;
  creation_result community_creation_ceremony_results%ROWTYPE;
  creation_state community_creation_requirement_states%ROWTYPE;
  creation_completion namespace_ownership_completion_attempts%ROWTYPE;
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  revalidation_attempt community_route_revalidation_completion_attempts%ROWTYPE;
  revalidation_session community_route_revalidation_sessions%ROWTYPE;
  revalidation_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  community_record communities%ROWTYPE;
BEGIN
  IF NEW.origin = 'creation_ceremony' THEN
    SELECT * INTO creation_attempt
      FROM community_creation_ceremony_attempts
     WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
    SELECT * INTO creation_result
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
    SELECT * INTO creation_state
      FROM community_creation_requirement_states
     WHERE intent_id = creation_attempt.intent_id
       AND requirement_kind = creation_attempt.requirement_kind
     FOR SHARE;
    IF creation_result.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO creation_completion
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = creation_result.completion_attempt_id;
    END IF;

    IF creation_attempt.ceremony_intent_id IS NULL
      OR creation_result.ceremony_intent_id IS NULL
      OR creation_state.intent_id IS NULL
      OR creation_attempt.requirement_kind <> 'namespace_ownership'
      OR creation_result.outcome_status <> 'satisfied'
      OR creation_state.status <> 'satisfied'
      OR creation_state.generation IS DISTINCT FROM creation_attempt.generation
      OR creation_state.current_ceremony_intent_id IS DISTINCT FROM NEW.creation_ceremony_intent_id
      OR NEW.verified_by_actor_id IS DISTINCT FROM creation_attempt.actor_id
      OR NEW.family IS DISTINCT FROM creation_attempt.route_family
      OR NEW.root_label IS DISTINCT FROM creation_attempt.route_root_label
      OR NEW.root_label_display IS DISTINCT FROM creation_attempt.route_root_label_display
      OR NEW.path_segment IS DISTINCT FROM creation_attempt.route_path_segment
      OR NEW.requirement_hash IS DISTINCT FROM creation_attempt.requirement_hash
      OR NEW.provider_id IS DISTINCT FROM creation_attempt.provider_id
      OR NEW.provider_binding_hash IS DISTINCT FROM creation_attempt.provider_binding_hash
      OR NEW.provider_configuration_version IS DISTINCT FROM creation_attempt.provider_configuration_version
      OR NEW.provider_identity_digest IS DISTINCT FROM creation_result.provider_identity_digest
      OR NEW.evidence_ref IS DISTINCT FROM creation_result.evidence_ref
      OR NEW.evidence_digest IS DISTINCT FROM creation_result.evidence_digest
      OR NEW.evidence_receipt_id IS DISTINCT FROM creation_result.evidence_receipt_id
      OR NEW.binding_generation IS DISTINCT FROM creation_attempt.generation
      OR NEW.verified_at IS DISTINCT FROM creation_result.satisfied_at
      OR creation_completion.completion_attempt_id IS NULL
      OR creation_completion.namespace_session_id IS DISTINCT FROM creation_result.namespace_session_id
      OR creation_completion.actor_id IS DISTINCT FROM creation_result.actor_id
      OR creation_completion.state IS DISTINCT FROM 'consumed'
      OR creation_completion.consumption_kind IS DISTINCT FROM 'verified'
    THEN
      RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
    END IF;

    SELECT * INTO creation_snapshot
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = NEW.evidence_ref
       AND namespace_session_id = creation_result.namespace_session_id
       AND completion_attempt_id = creation_result.completion_attempt_id;
    IF creation_snapshot.evidence_ref IS NULL
      OR creation_snapshot.evidence_digest IS DISTINCT FROM NEW.evidence_digest
      OR creation_snapshot.provider_identity_digest IS DISTINCT FROM NEW.provider_identity_digest
      OR creation_snapshot.actor_id IS DISTINCT FROM creation_result.actor_id
      OR creation_snapshot.creation_intent_id IS DISTINCT FROM creation_result.intent_id
      OR creation_snapshot.ceremony_intent_id IS DISTINCT FROM creation_result.ceremony_intent_id
      OR creation_snapshot.generation IS DISTINCT FROM NEW.binding_generation
      OR creation_snapshot.requirement_hash IS DISTINCT FROM NEW.requirement_hash
      OR creation_snapshot.provider_id IS DISTINCT FROM NEW.provider_id
      OR creation_snapshot.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
      OR creation_snapshot.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
      OR creation_snapshot.family IS DISTINCT FROM NEW.family
      OR creation_snapshot.root_label IS DISTINCT FROM NEW.root_label
      OR creation_snapshot.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR creation_snapshot.path_segment IS DISTINCT FROM NEW.path_segment
      OR (NEW.expires_at IS NOT NULL AND creation_snapshot.expires_at IS DISTINCT FROM NEW.expires_at)
    THEN
      RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
    END IF;
    RETURN NEW;
  END IF;

  -- Resolve immutable identifiers without row locks, then acquire the common
  -- route lock order: community -> binding -> session -> attempt -> snapshot.
  SELECT * INTO revalidation_attempt
    FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id;
  SELECT * INTO revalidation_session
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = revalidation_attempt.route_revalidation_id
     AND revalidation_session_id = revalidation_attempt.revalidation_session_id;
  SELECT * INTO community_record
    FROM communities
   WHERE community_id = revalidation_session.community_id
   FOR UPDATE;
  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = revalidation_attempt.route_binding_id
     AND community_id = revalidation_session.community_id
   FOR UPDATE;
  SELECT * INTO revalidation_session
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = revalidation_attempt.route_revalidation_id
     AND revalidation_session_id = revalidation_attempt.revalidation_session_id
   FOR SHARE;
  SELECT * INTO revalidation_attempt
    FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id
   FOR SHARE;
  SELECT * INTO revalidation_snapshot
    FROM community_route_revalidation_evidence_snapshots
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id
     AND evidence_ref = NEW.evidence_ref
   FOR SHARE;

  IF revalidation_attempt.route_revalidation_attempt_id IS NULL
    OR revalidation_session.revalidation_session_id IS NULL
    OR revalidation_snapshot.evidence_ref IS NULL
    OR binding_record.route_binding_id IS NULL
    OR community_record.community_id IS NULL
    OR community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR revalidation_attempt.state <> 'consumed'
    OR revalidation_attempt.consumption_kind <> 'verified'
    OR revalidation_session.status <> 'completed'
    OR revalidation_attempt.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR revalidation_snapshot.route_revalidation_id IS DISTINCT FROM revalidation_session.route_revalidation_id
    OR revalidation_snapshot.revalidation_session_id IS DISTINCT FROM revalidation_session.revalidation_session_id
    OR revalidation_snapshot.community_id IS DISTINCT FROM revalidation_session.community_id
    OR revalidation_snapshot.route_binding_id IS DISTINCT FROM revalidation_session.route_binding_id
    OR revalidation_snapshot.principal_kind IS DISTINCT FROM revalidation_session.principal_kind
    OR revalidation_snapshot.principal_id IS DISTINCT FROM revalidation_session.principal_id
    OR revalidation_snapshot.requirement_hash IS DISTINCT FROM revalidation_session.requirement_hash
    OR revalidation_snapshot.expected_binding_generation IS DISTINCT FROM revalidation_session.expected_binding_generation
    OR revalidation_snapshot.expected_verified_evidence_ref IS DISTINCT FROM revalidation_session.expected_verified_evidence_ref
    OR revalidation_snapshot.start_request_hash IS DISTINCT FROM revalidation_session.start_request_hash
    OR revalidation_snapshot.provider_id IS DISTINCT FROM revalidation_session.provider_id
    OR revalidation_snapshot.provider_binding_hash IS DISTINCT FROM revalidation_session.provider_binding_hash
    OR revalidation_snapshot.provider_configuration_kind IS DISTINCT FROM revalidation_session.provider_configuration_kind
    OR revalidation_snapshot.provider_configuration_reference IS DISTINCT FROM revalidation_session.provider_configuration_reference
    OR revalidation_snapshot.provider_configuration_version IS DISTINCT FROM revalidation_session.provider_configuration_version
    OR revalidation_snapshot.protocol_version IS DISTINCT FROM revalidation_session.protocol_version
    OR revalidation_snapshot.environment IS DISTINCT FROM revalidation_session.environment
    OR revalidation_snapshot.family IS DISTINCT FROM revalidation_session.family
    OR revalidation_snapshot.root_label IS DISTINCT FROM revalidation_session.root_label
    OR revalidation_snapshot.root_label_display IS DISTINCT FROM revalidation_session.root_label_display
    OR revalidation_snapshot.path_segment IS DISTINCT FROM revalidation_session.path_segment
    OR revalidation_snapshot.upstream_session_ref IS DISTINCT FROM revalidation_session.upstream_session_ref
    OR revalidation_snapshot.fence_token IS DISTINCT FROM revalidation_attempt.fence_token
    OR revalidation_snapshot.binding_generation IS DISTINCT FROM revalidation_session.expected_binding_generation + 1
    OR NEW.family IS DISTINCT FROM revalidation_snapshot.family
    OR NEW.root_label IS DISTINCT FROM revalidation_snapshot.root_label
    OR NEW.root_label_display IS DISTINCT FROM revalidation_snapshot.root_label_display
    OR NEW.path_segment IS DISTINCT FROM revalidation_snapshot.path_segment
    OR NEW.requirement_hash IS DISTINCT FROM revalidation_snapshot.requirement_hash
    OR NEW.provider_id IS DISTINCT FROM revalidation_snapshot.provider_id
    OR NEW.provider_binding_hash IS DISTINCT FROM revalidation_snapshot.provider_binding_hash
    OR NEW.provider_configuration_version IS DISTINCT FROM revalidation_snapshot.provider_configuration_version
    OR NEW.provider_identity_digest IS DISTINCT FROM revalidation_snapshot.provider_identity_digest
    OR NEW.evidence_digest IS DISTINCT FROM revalidation_snapshot.evidence_digest
    OR NEW.evidence_receipt_id IS NOT NULL
    OR NEW.binding_generation IS DISTINCT FROM revalidation_snapshot.binding_generation
    OR NEW.verified_at IS DISTINCT FROM revalidation_snapshot.observed_at
    OR NEW.expires_at IS DISTINCT FROM revalidation_snapshot.expires_at
    OR binding_record.community_id IS DISTINCT FROM revalidation_snapshot.community_id
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its revalidation authority';
  END IF;
  RETURN NEW;
END;
$$;
