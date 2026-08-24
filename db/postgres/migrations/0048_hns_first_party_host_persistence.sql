-- First-party HNS DNS-zone and community-app host activation persistence.
-- External DNS, HSD, gateway, key, and certificate work never occurs inside
-- these transactions. DNS activation finalizers are database-time leased and
-- fenced; all authority documents, revisions, health observations, and
-- operation results are retained for exact replay.

CREATE FUNCTION is_hns_host_persistence_identity(input_value TEXT, maximum_bytes INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT input_value IS NOT NULL
    AND btrim(input_value) <> ''
    AND input_value = btrim(input_value)
    AND octet_length(input_value) <= maximum_bytes
    AND input_value !~ '[[:cntrl:]]'
$$;

CREATE FUNCTION reject_hns_host_persistence_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HNS host persistence evidence is append-only';
END;
$$;

CREATE TABLE hns_dns_zone_activation_revisions (
  dns_zone_activation_id TEXT NOT NULL,
  dns_zone_activation_generation BIGINT NOT NULL,
  activation_document_bytes BYTEA NOT NULL,
  activation_document_digest TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  dns_authority_kind TEXT NOT NULL,
  dns_authority_reference TEXT NOT NULL,
  dns_authority_generation BIGINT NOT NULL,
  pirate_dns_authority_inventory_reference TEXT NOT NULL,
  pirate_dns_authority_inventory_version TEXT NOT NULL,
  pirate_dns_authority_inventory_digest TEXT NOT NULL,
  zone_revision BIGINT NOT NULL,
  zone_bytes BYTEA NOT NULL,
  zone_bytes_digest TEXT NOT NULL,
  dnssec_keyset_reference TEXT NOT NULL,
  dnssec_keyset_version TEXT NOT NULL,
  gateway_deployment_reference TEXT NOT NULL,
  gateway_certificate_spki_sha256 TEXT NOT NULL,
  stable_chain_delegation_snapshot_reference TEXT NOT NULL,
  stable_chain_delegation_snapshot_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  activated_at TIMESTAMPTZ NOT NULL,
  suspended_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_dns_zone_activation_revisions_pk PRIMARY KEY (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_inventory_fk FOREIGN KEY (
    pirate_dns_authority_inventory_reference,
    pirate_dns_authority_inventory_version,
    pirate_dns_authority_inventory_digest
  ) REFERENCES hns_authority_inventories (
    authority_inventory_reference,
    authority_inventory_version,
    authority_inventory_digest
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_identity_check CHECK (
    is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND is_community_route_root_label('hns', canonical_root)
    AND dns_authority_kind = 'pirate_managed_dns_v1'
    AND is_hns_host_persistence_identity(dns_authority_reference, 256)
    AND dns_authority_generation BETWEEN 1 AND 9007199254740991
    AND is_hns_host_persistence_identity(pirate_dns_authority_inventory_reference, 256)
    AND is_hns_host_persistence_identity(pirate_dns_authority_inventory_version, 256)
    AND is_hns_host_persistence_identity(dnssec_keyset_reference, 256)
    AND is_hns_host_persistence_identity(dnssec_keyset_version, 256)
    AND is_hns_host_persistence_identity(gateway_deployment_reference, 256)
    AND is_hns_host_persistence_identity(stable_chain_delegation_snapshot_reference, 424)
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_generation_check CHECK (
    (dns_zone_activation_generation BETWEEN 1 AND 9007199254740991)
    AND (zone_revision BETWEEN 1 AND 9007199254740991)
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_digest_check CHECK (
    activation_document_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(activation_document_bytes), 'hex') = activation_document_digest
    AND pirate_dns_authority_inventory_digest ~ '^[0-9a-f]{64}$'
    AND zone_bytes_digest ~ '^[0-9a-f]{64}$'
    AND encode(sha256(zone_bytes), 'hex') = zone_bytes_digest
    AND gateway_certificate_spki_sha256 ~ '^[0-9a-f]{64}$'
    AND stable_chain_delegation_snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_bytes_check CHECK (
    (octet_length(activation_document_bytes) BETWEEN 1 AND 65536)
    AND (octet_length(zone_bytes) BETWEEN 1 AND 1048576)
  ),
  CONSTRAINT hns_dns_zone_activation_revisions_status_check CHECK (
    status IN ('active', 'suspended', 'revoked')
    AND (
      (status = 'active' AND reason_code IS NULL AND suspended_at IS NULL AND revoked_at IS NULL)
      OR (status = 'suspended' AND is_hns_host_persistence_identity(reason_code, 256)
        AND suspended_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND is_hns_host_persistence_identity(reason_code, 256)
        AND revoked_at IS NOT NULL)
    )
    AND (suspended_at IS NULL OR suspended_at >= activated_at)
    AND (revoked_at IS NULL OR revoked_at >= activated_at)
  )
);

CREATE TABLE hns_dns_zone_activation_current (
  dns_zone_activation_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  current_generation BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_dns_zone_activation_current_revision_fk FOREIGN KEY (
    dns_zone_activation_id,
    current_generation
  ) REFERENCES hns_dns_zone_activation_revisions (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT hns_dns_zone_activation_current_identity_check CHECK (
    is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND is_community_route_root_label('hns', canonical_root)
    AND current_generation BETWEEN 1 AND 9007199254740991
  )
);

CREATE TABLE hns_dns_zone_activation_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  activation_document_digest TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  expected_activation_generation BIGINT NOT NULL,
  state TEXT NOT NULL,
  fence_token BIGINT NOT NULL,
  lease_seconds INTEGER NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  result_activation_generation BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT hns_dns_zone_activation_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(idempotency_key, 512)
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND activation_document_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT hns_dns_zone_activation_operations_fence_check CHECK (
    (expected_activation_generation BETWEEN 0 AND 9007199254740991)
    AND (fence_token BETWEEN 1 AND 9007199254740991)
    AND (lease_seconds BETWEEN 4 AND 60)
    AND lease_expires_at > created_at
    AND updated_at >= created_at
  ),
  CONSTRAINT hns_dns_zone_activation_operations_state_check CHECK (
    (state = 'reserved' AND result_activation_generation IS NULL AND finalized_at IS NULL)
    OR (state = 'finalized' AND result_activation_generation = expected_activation_generation + 1
      AND finalized_at IS NOT NULL AND finalized_at = updated_at)
  )
);

CREATE INDEX hns_dns_zone_activation_operations_live_idx
  ON hns_dns_zone_activation_operations (lease_expires_at, operation_id)
  WHERE state = 'reserved';

CREATE TABLE hns_dns_zone_lifecycle_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  expected_activation_generation BIGINT NOT NULL,
  target_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  result_activation_generation BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_dns_zone_lifecycle_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(idempotency_key, 512)
    AND request_hash ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND expected_activation_generation BETWEEN 1 AND 9007199254740990
    AND target_status IN ('active', 'suspended', 'revoked')
    AND is_hns_host_persistence_identity(reason_code, 256)
    AND result_activation_generation = expected_activation_generation + 1
  )
);

CREATE TABLE hns_dns_zone_health_observations (
  dns_zone_activation_id TEXT NOT NULL,
  activation_generation BIGINT NOT NULL,
  health_generation BIGINT NOT NULL,
  stable_chain_delegation_snapshot_reference TEXT NOT NULL,
  stable_chain_delegation_snapshot_digest TEXT NOT NULL,
  observed_zone_bytes_digest TEXT NOT NULL,
  observed_dnssec_keyset_reference TEXT NOT NULL,
  observed_dnssec_keyset_version TEXT NOT NULL,
  observed_gateway_deployment_reference TEXT NOT NULL,
  observed_gateway_certificate_spki_sha256 TEXT NOT NULL,
  delegation_matches BOOLEAN NOT NULL,
  ds_authenticates_zone BOOLEAN NOT NULL,
  retained_zone_digest_matches BOOLEAN NOT NULL,
  gateway_healthy BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_dns_zone_health_observations_pk PRIMARY KEY (
    dns_zone_activation_id,
    activation_generation,
    health_generation
  ),
  CONSTRAINT hns_dns_zone_health_observations_revision_fk FOREIGN KEY (
    dns_zone_activation_id,
    activation_generation
  ) REFERENCES hns_dns_zone_activation_revisions (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ),
  CONSTRAINT hns_dns_zone_health_observations_identity_check CHECK (
    (health_generation BETWEEN 1 AND 9007199254740991)
    AND is_hns_host_persistence_identity(stable_chain_delegation_snapshot_reference, 424)
    AND stable_chain_delegation_snapshot_digest ~ '^[0-9a-f]{64}$'
    AND observed_zone_bytes_digest ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(observed_dnssec_keyset_reference, 256)
    AND is_hns_host_persistence_identity(observed_dnssec_keyset_version, 256)
    AND is_hns_host_persistence_identity(observed_gateway_deployment_reference, 256)
    AND observed_gateway_certificate_spki_sha256 ~ '^[0-9a-f]{64}$'
    AND valid_until > checked_at
  )
);

CREATE TABLE hns_dns_zone_health_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  activation_generation BIGINT NOT NULL,
  expected_health_generation BIGINT NOT NULL,
  result_health_generation BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_dns_zone_health_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(idempotency_key, 512)
    AND request_hash ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND activation_generation BETWEEN 1 AND 9007199254740991
    AND expected_health_generation BETWEEN 0 AND 9007199254740990
    AND result_health_generation = expected_health_generation + 1
  )
);

CREATE TABLE hns_community_app_host_activation_revisions (
  app_host_activation_id TEXT NOT NULL,
  app_host_activation_generation BIGINT NOT NULL,
  normalized_host TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  route_binding_id TEXT NOT NULL,
  route_authority_kind TEXT NOT NULL,
  route_authority_reference TEXT NOT NULL,
  route_authority_generation BIGINT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  dns_zone_activation_generation BIGINT NOT NULL,
  gateway_deployment_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  activated_at TIMESTAMPTZ NOT NULL,
  suspended_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_community_app_host_activation_revisions_pk PRIMARY KEY (
    app_host_activation_id,
    app_host_activation_generation
  ),
  CONSTRAINT hns_community_app_host_activation_revisions_dns_fk FOREIGN KEY (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ) REFERENCES hns_dns_zone_activation_revisions (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ),
  CONSTRAINT hns_community_app_host_activation_revisions_route_fk FOREIGN KEY (
    community_id,
    route_binding_id
  ) REFERENCES community_canonical_route_bindings (community_id, route_binding_id),
  CONSTRAINT hns_community_app_host_activation_revisions_identity_check CHECK (
    is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND app_host_activation_generation BETWEEN 1 AND 9007199254740991
    AND normalized_host = 'app.' || canonical_root
    AND is_community_route_root_label('hns', canonical_root)
    AND is_hns_host_persistence_identity(route_binding_id, 256)
    AND route_authority_kind IN ('verified_namespace_v1', 'operator_managed_route_v1')
    AND is_hns_host_persistence_identity(route_authority_reference, 512)
    AND route_authority_generation BETWEEN 1 AND 9007199254740991
    AND is_hns_host_persistence_identity(gateway_deployment_reference, 256)
  ),
  CONSTRAINT hns_community_app_host_activation_revisions_status_check CHECK (
    status IN ('active', 'suspended', 'revoked')
    AND (
      (status = 'active' AND reason_code IS NULL AND suspended_at IS NULL AND revoked_at IS NULL)
      OR (status = 'suspended' AND is_hns_host_persistence_identity(reason_code, 256)
        AND suspended_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND is_hns_host_persistence_identity(reason_code, 256)
        AND revoked_at IS NOT NULL)
    )
  )
);

CREATE TABLE hns_community_app_host_activation_current (
  app_host_activation_id TEXT PRIMARY KEY,
  normalized_host TEXT NOT NULL UNIQUE,
  community_id TEXT NOT NULL UNIQUE,
  current_generation BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_community_app_host_activation_current_revision_fk FOREIGN KEY (
    app_host_activation_id,
    current_generation
  ) REFERENCES hns_community_app_host_activation_revisions (
    app_host_activation_id,
    app_host_activation_generation
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT hns_community_app_host_activation_current_identity_check CHECK (
    is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND current_generation BETWEEN 1 AND 9007199254740991
  )
);

CREATE TABLE hns_community_app_host_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  app_host_activation_id TEXT NOT NULL,
  expected_activation_generation BIGINT NOT NULL,
  target_status TEXT NOT NULL,
  result_activation_generation BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_community_app_host_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND operation_kind IN ('activate', 'transition')
    AND is_hns_host_persistence_identity(idempotency_key, 512)
    AND request_hash ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND expected_activation_generation BETWEEN 0 AND 9007199254740990
    AND target_status IN ('active', 'suspended', 'revoked')
    AND result_activation_generation = expected_activation_generation + 1
    AND ((operation_kind = 'activate' AND expected_activation_generation = 0
      AND target_status = 'active') OR operation_kind = 'transition')
  )
);

CREATE TRIGGER hns_dns_zone_activation_revisions_append_only
BEFORE UPDATE OR DELETE ON hns_dns_zone_activation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE TRIGGER hns_dns_zone_lifecycle_operations_append_only
BEFORE UPDATE OR DELETE ON hns_dns_zone_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE TRIGGER hns_dns_zone_health_observations_append_only
BEFORE UPDATE OR DELETE ON hns_dns_zone_health_observations
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE TRIGGER hns_dns_zone_health_operations_append_only
BEFORE UPDATE OR DELETE ON hns_dns_zone_health_operations
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE TRIGGER hns_community_app_host_activation_revisions_append_only
BEFORE UPDATE OR DELETE ON hns_community_app_host_activation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE TRIGGER hns_community_app_host_operations_append_only
BEFORE UPDATE OR DELETE ON hns_community_app_host_operations
FOR EACH ROW EXECUTE FUNCTION reject_hns_host_persistence_append_only_change();

CREATE FUNCTION guard_hns_dns_zone_activation_operation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS DNS activation operations are retained';
  END IF;
  IF ROW(NEW.operation_id, NEW.idempotency_key, NEW.activation_document_digest,
         NEW.dns_zone_activation_id, NEW.expected_activation_generation,
         NEW.lease_seconds, NEW.created_at)
    IS DISTINCT FROM
     ROW(OLD.operation_id, OLD.idempotency_key, OLD.activation_document_digest,
         OLD.dns_zone_activation_id, OLD.expected_activation_generation,
         OLD.lease_seconds, OLD.created_at) THEN
    RAISE EXCEPTION 'HNS DNS activation operation identity is immutable';
  END IF;
  IF OLD.state = 'reserved' AND NEW.state = 'reserved' THEN
    IF OLD.lease_expires_at > clock_timestamp()
      OR NEW.fence_token <> OLD.fence_token + 1
      OR NEW.lease_expires_at <= OLD.lease_expires_at
      OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'HNS DNS activation reacquisition is not fenced';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'reserved' AND NEW.state = 'finalized' THEN
    IF NEW.fence_token <> OLD.fence_token
      OR OLD.lease_expires_at <= clock_timestamp()
      OR NEW.updated_at > clock_timestamp()
      OR NEW.finalized_at <> NEW.updated_at THEN
      RAISE EXCEPTION 'HNS DNS activation finalizer lost its lease or fence';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HNS DNS activation operation transition is not allowed';
END;
$$;

CREATE TRIGGER hns_dns_zone_activation_operations_change_guard
BEFORE UPDATE OR DELETE ON hns_dns_zone_activation_operations
FOR EACH ROW EXECUTE FUNCTION guard_hns_dns_zone_activation_operation_change();

CREATE FUNCTION guard_hns_dns_zone_activation_current_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS DNS activation current authority cannot be deleted';
  END IF;
  IF NEW.dns_zone_activation_id <> OLD.dns_zone_activation_id
    OR NEW.canonical_root <> OLD.canonical_root
    OR NEW.current_generation <> OLD.current_generation + 1
    OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'HNS DNS activation generation change is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_dns_zone_activation_current_change_guard
BEFORE UPDATE OR DELETE ON hns_dns_zone_activation_current
FOR EACH ROW EXECUTE FUNCTION guard_hns_dns_zone_activation_current_change();

CREATE FUNCTION guard_hns_community_app_host_current_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS app-host current authority cannot be deleted';
  END IF;
  IF NEW.app_host_activation_id <> OLD.app_host_activation_id
    OR NEW.normalized_host <> OLD.normalized_host
    OR NEW.community_id <> OLD.community_id
    OR NEW.current_generation <> OLD.current_generation + 1
    OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'HNS app-host generation change is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_community_app_host_current_change_guard
BEFORE UPDATE OR DELETE ON hns_community_app_host_activation_current
FOR EACH ROW EXECUTE FUNCTION guard_hns_community_app_host_current_change();

CREATE FUNCTION reserve_hns_dns_zone_activation_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_activation_document_digest TEXT,
  input_dns_zone_activation_id TEXT,
  input_expected_activation_generation BIGINT,
  input_lease_seconds INTEGER
)
RETURNS TABLE(
  outcome TEXT,
  operation_id TEXT,
  dns_zone_activation_id TEXT,
  fence_token BIGINT,
  lease_expires_at TIMESTAMPTZ,
  activation_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  existing hns_dns_zone_activation_operations%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO existing
    FROM hns_dns_zone_activation_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF existing.operation_id <> input_operation_id
      OR existing.activation_document_digest <> input_activation_document_digest
      OR existing.dns_zone_activation_id <> input_dns_zone_activation_id
      OR existing.expected_activation_generation <> input_expected_activation_generation
      OR existing.lease_seconds <> input_lease_seconds THEN
      RAISE EXCEPTION 'HNS DNS activation idempotency conflict';
    END IF;
    IF existing.state = 'finalized' THEN
      RETURN QUERY SELECT 'replayed'::TEXT, existing.operation_id,
        existing.dns_zone_activation_id, existing.fence_token,
        existing.lease_expires_at, existing.result_activation_generation;
      RETURN;
    END IF;
    IF existing.lease_expires_at <= database_now THEN
      UPDATE hns_dns_zone_activation_operations AS operation
         SET fence_token = operation.fence_token + 1,
             lease_expires_at = database_now + input_lease_seconds * INTERVAL '1 second',
             updated_at = database_now
       WHERE operation.operation_id = existing.operation_id
       RETURNING * INTO existing;
    END IF;
    RETURN QUERY SELECT 'reserved'::TEXT, existing.operation_id,
      existing.dns_zone_activation_id, existing.fence_token,
      existing.lease_expires_at, NULL::BIGINT;
    RETURN;
  END IF;

  INSERT INTO hns_dns_zone_activation_operations (
    operation_id, idempotency_key, activation_document_digest,
    dns_zone_activation_id, expected_activation_generation, state, fence_token,
    lease_seconds, lease_expires_at, created_at, updated_at
  ) VALUES (
    input_operation_id, input_idempotency_key, input_activation_document_digest,
    input_dns_zone_activation_id, input_expected_activation_generation, 'reserved', 1,
    input_lease_seconds, database_now + input_lease_seconds * INTERVAL '1 second',
    database_now, database_now
  ) RETURNING * INTO existing;
  RETURN QUERY SELECT 'reserved'::TEXT, existing.operation_id,
    existing.dns_zone_activation_id, existing.fence_token,
    existing.lease_expires_at, NULL::BIGINT;
END;
$$;

CREATE FUNCTION finalize_hns_dns_zone_activation_v1(
  input_operation_id TEXT,
  input_fence_token BIGINT,
  input_activation_document_bytes BYTEA,
  input_dns_zone_activation_id TEXT,
  input_canonical_root TEXT,
  input_dns_authority_kind TEXT,
  input_dns_authority_reference TEXT,
  input_dns_authority_generation BIGINT,
  input_inventory_reference TEXT,
  input_inventory_version TEXT,
  input_inventory_digest TEXT,
  input_zone_revision BIGINT,
  input_zone_bytes BYTEA,
  input_zone_bytes_digest TEXT,
  input_dnssec_keyset_reference TEXT,
  input_dnssec_keyset_version TEXT,
  input_gateway_deployment_reference TEXT,
  input_gateway_certificate_spki_sha256 TEXT,
  input_delegation_snapshot_reference TEXT,
  input_delegation_snapshot_digest TEXT
)
RETURNS TABLE(outcome TEXT, dns_zone_activation_id TEXT, activation_generation BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  operation hns_dns_zone_activation_operations%ROWTYPE;
  current_record hns_dns_zone_activation_current%ROWTYPE;
  prior_revision hns_dns_zone_activation_revisions%ROWTYPE;
  result_revision hns_dns_zone_activation_revisions%ROWTYPE;
  inventory hns_authority_inventories%ROWTYPE;
  activation_document JSONB;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT;
BEGIN
  activation_document := convert_from(input_activation_document_bytes, 'UTF8')::JSONB;
  IF activation_document IS DISTINCT FROM jsonb_build_object(
    'version', 'pirate-hns-dns-zone-activation-document-v1',
    'dns_zone_activation_id', input_dns_zone_activation_id,
    'canonical_root', input_canonical_root,
    'dns_authority', jsonb_build_array(
      input_dns_authority_kind,
      input_dns_authority_reference,
      input_dns_authority_generation
    ),
    'pirate_dns_authority_inventory', jsonb_build_array(
      input_inventory_reference,
      input_inventory_version,
      input_inventory_digest
    ),
    'zone', jsonb_build_array(input_zone_revision, input_zone_bytes_digest),
    'dnssec_keyset', jsonb_build_array(
      input_dnssec_keyset_reference,
      input_dnssec_keyset_version
    ),
    'gateway', jsonb_build_array(
      input_gateway_deployment_reference,
      input_gateway_certificate_spki_sha256
    ),
    'stable_chain_delegation_snapshot', jsonb_build_array(
      input_delegation_snapshot_reference,
      input_delegation_snapshot_digest
    )
  ) THEN
    RAISE EXCEPTION 'HNS DNS activation document does not match its authority fields';
  END IF;

  SELECT * INTO operation
    FROM hns_dns_zone_activation_operations AS stored_operation
   WHERE stored_operation.operation_id = input_operation_id
   FOR UPDATE;
  IF NOT FOUND OR operation.dns_zone_activation_id <> input_dns_zone_activation_id
    OR operation.activation_document_digest <> encode(sha256(input_activation_document_bytes), 'hex') THEN
    RAISE EXCEPTION 'HNS DNS activation finalizer authority mismatch';
  END IF;

  IF operation.state = 'finalized' THEN
    SELECT * INTO result_revision
      FROM hns_dns_zone_activation_revisions AS revision
     WHERE revision.dns_zone_activation_id = operation.dns_zone_activation_id
       AND revision.dns_zone_activation_generation = operation.result_activation_generation;
    IF NOT FOUND
      OR result_revision.activation_document_bytes IS DISTINCT FROM input_activation_document_bytes
      OR result_revision.canonical_root <> input_canonical_root
      OR result_revision.dns_authority_reference <> input_dns_authority_reference
      OR result_revision.zone_bytes IS DISTINCT FROM input_zone_bytes
      OR result_revision.gateway_deployment_reference <> input_gateway_deployment_reference
      OR result_revision.stable_chain_delegation_snapshot_digest <> input_delegation_snapshot_digest THEN
      RAISE EXCEPTION 'HNS DNS activation replay does not match retained authority';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, operation.dns_zone_activation_id,
      operation.result_activation_generation;
    RETURN;
  END IF;

  IF operation.state <> 'reserved'
    OR operation.fence_token <> input_fence_token
    OR operation.lease_expires_at <= database_now THEN
    RAISE EXCEPTION 'HNS DNS activation finalizer lost its lease or fence';
  END IF;

  SELECT * INTO inventory
    FROM hns_authority_inventories AS retained_inventory
   WHERE retained_inventory.authority_inventory_reference = input_inventory_reference
     AND retained_inventory.authority_inventory_version = input_inventory_version
     AND retained_inventory.authority_inventory_digest = input_inventory_digest
   FOR SHARE;
  IF NOT FOUND OR inventory.published_at > database_now OR inventory.expires_at <= database_now THEN
    RAISE EXCEPTION 'HNS DNS activation inventory is unavailable';
  END IF;

  SELECT * INTO current_record
    FROM hns_dns_zone_activation_current AS current_authority
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id
      OR current_authority.canonical_root = input_canonical_root
   FOR UPDATE;
  IF operation.expected_activation_generation = 0 THEN
    IF FOUND THEN
      RAISE EXCEPTION 'HNS DNS activation root already has authority';
    END IF;
  ELSE
    IF NOT FOUND
      OR current_record.dns_zone_activation_id <> input_dns_zone_activation_id
      OR current_record.canonical_root <> input_canonical_root
      OR current_record.current_generation <> operation.expected_activation_generation THEN
      RAISE EXCEPTION 'HNS DNS activation generation fence does not match';
    END IF;
    SELECT * INTO prior_revision
      FROM hns_dns_zone_activation_revisions AS revision
     WHERE revision.dns_zone_activation_id = current_record.dns_zone_activation_id
       AND revision.dns_zone_activation_generation = current_record.current_generation;
    IF prior_revision.status = 'revoked' OR input_zone_revision <= prior_revision.zone_revision THEN
      RAISE EXCEPTION 'HNS DNS activation rotation is not monotonic';
    END IF;
  END IF;

  new_generation := operation.expected_activation_generation + 1;
  INSERT INTO hns_dns_zone_activation_revisions (
    dns_zone_activation_id, dns_zone_activation_generation,
    activation_document_bytes, activation_document_digest, canonical_root,
    dns_authority_kind, dns_authority_reference, dns_authority_generation,
    pirate_dns_authority_inventory_reference, pirate_dns_authority_inventory_version,
    pirate_dns_authority_inventory_digest, zone_revision, zone_bytes, zone_bytes_digest,
    dnssec_keyset_reference, dnssec_keyset_version, gateway_deployment_reference,
    gateway_certificate_spki_sha256, stable_chain_delegation_snapshot_reference,
    stable_chain_delegation_snapshot_digest, status, activated_at
  ) VALUES (
    input_dns_zone_activation_id, new_generation,
    input_activation_document_bytes, operation.activation_document_digest, input_canonical_root,
    input_dns_authority_kind, input_dns_authority_reference, input_dns_authority_generation,
    input_inventory_reference, input_inventory_version, input_inventory_digest,
    input_zone_revision, input_zone_bytes, input_zone_bytes_digest,
    input_dnssec_keyset_reference, input_dnssec_keyset_version,
    input_gateway_deployment_reference, input_gateway_certificate_spki_sha256,
    input_delegation_snapshot_reference, input_delegation_snapshot_digest,
    'active', database_now
  );

  IF operation.expected_activation_generation = 0 THEN
    INSERT INTO hns_dns_zone_activation_current (
      dns_zone_activation_id, canonical_root, current_generation, updated_at
    ) VALUES (input_dns_zone_activation_id, input_canonical_root, new_generation, database_now);
  ELSE
    UPDATE hns_dns_zone_activation_current AS current_authority
       SET current_generation = new_generation, updated_at = database_now
     WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id;
  END IF;

  UPDATE hns_dns_zone_activation_operations AS stored_operation
     SET state = 'finalized', result_activation_generation = new_generation,
         finalized_at = database_now, updated_at = database_now
   WHERE stored_operation.operation_id = input_operation_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'activated'::TEXT, input_dns_zone_activation_id, new_generation;
END;
$$;

CREATE FUNCTION change_hns_dns_zone_activation_status_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_dns_zone_activation_id TEXT,
  input_expected_activation_generation BIGINT,
  input_target_status TEXT,
  input_reason_code TEXT
)
RETURNS TABLE(outcome TEXT, activation_id TEXT, activation_generation BIGINT, status TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_dns_zone_lifecycle_operations%ROWTYPE;
  current_record hns_dns_zone_activation_current%ROWTYPE;
  prior hns_dns_zone_activation_revisions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT := input_expected_activation_generation + 1;
BEGIN
  SELECT * INTO replay FROM hns_dns_zone_lifecycle_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_id <> input_operation_id OR replay.request_hash <> input_request_hash
      OR replay.dns_zone_activation_id <> input_dns_zone_activation_id
      OR replay.expected_activation_generation <> input_expected_activation_generation
      OR replay.target_status <> input_target_status OR replay.reason_code <> input_reason_code THEN
      RAISE EXCEPTION 'HNS DNS lifecycle idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.dns_zone_activation_id,
      replay.result_activation_generation, replay.target_status;
    RETURN;
  END IF;

  SELECT * INTO current_record FROM hns_dns_zone_activation_current AS current_authority
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id FOR UPDATE;
  IF NOT FOUND OR current_record.current_generation <> input_expected_activation_generation THEN
    RAISE EXCEPTION 'HNS DNS lifecycle generation fence does not match';
  END IF;
  SELECT * INTO prior FROM hns_dns_zone_activation_revisions AS revision
   WHERE revision.dns_zone_activation_id = input_dns_zone_activation_id
     AND revision.dns_zone_activation_generation = input_expected_activation_generation;
  IF prior.status = 'revoked'
    OR NOT ((prior.status = 'active' AND input_target_status IN ('suspended', 'revoked'))
      OR (prior.status = 'suspended' AND input_target_status IN ('active', 'revoked'))) THEN
    RAISE EXCEPTION 'HNS DNS lifecycle transition is not allowed';
  END IF;

  INSERT INTO hns_dns_zone_activation_revisions (
    dns_zone_activation_id, dns_zone_activation_generation,
    activation_document_bytes, activation_document_digest, canonical_root,
    dns_authority_kind, dns_authority_reference, dns_authority_generation,
    pirate_dns_authority_inventory_reference, pirate_dns_authority_inventory_version,
    pirate_dns_authority_inventory_digest, zone_revision, zone_bytes, zone_bytes_digest,
    dnssec_keyset_reference, dnssec_keyset_version, gateway_deployment_reference,
    gateway_certificate_spki_sha256, stable_chain_delegation_snapshot_reference,
    stable_chain_delegation_snapshot_digest, status, reason_code, activated_at,
    suspended_at, revoked_at
  ) SELECT
    prior.dns_zone_activation_id, new_generation,
    prior.activation_document_bytes, prior.activation_document_digest, prior.canonical_root,
    prior.dns_authority_kind, prior.dns_authority_reference, prior.dns_authority_generation,
    prior.pirate_dns_authority_inventory_reference,
    prior.pirate_dns_authority_inventory_version,
    prior.pirate_dns_authority_inventory_digest, prior.zone_revision, prior.zone_bytes,
    prior.zone_bytes_digest, prior.dnssec_keyset_reference, prior.dnssec_keyset_version,
    prior.gateway_deployment_reference, prior.gateway_certificate_spki_sha256,
    prior.stable_chain_delegation_snapshot_reference,
    prior.stable_chain_delegation_snapshot_digest, input_target_status,
    CASE WHEN input_target_status = 'active' THEN NULL ELSE input_reason_code END,
    prior.activated_at,
    CASE WHEN input_target_status = 'suspended' THEN database_now ELSE NULL END,
    CASE WHEN input_target_status = 'revoked' THEN database_now ELSE NULL END;

  UPDATE hns_dns_zone_activation_current AS current_authority
     SET current_generation = new_generation, updated_at = database_now
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id;
  INSERT INTO hns_dns_zone_lifecycle_operations VALUES (
    input_operation_id, input_idempotency_key, input_request_hash,
    input_dns_zone_activation_id, input_expected_activation_generation,
    input_target_status, input_reason_code, new_generation, database_now
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'changed'::TEXT, input_dns_zone_activation_id,
    new_generation, input_target_status;
END;
$$;

CREATE FUNCTION record_hns_dns_zone_health_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_dns_zone_activation_id TEXT,
  input_activation_generation BIGINT,
  input_expected_health_generation BIGINT,
  input_delegation_snapshot_reference TEXT,
  input_delegation_snapshot_digest TEXT,
  input_observed_zone_bytes_digest TEXT,
  input_observed_dnssec_keyset_reference TEXT,
  input_observed_dnssec_keyset_version TEXT,
  input_observed_gateway_deployment_reference TEXT,
  input_observed_gateway_certificate_spki_sha256 TEXT,
  input_delegation_matches BOOLEAN,
  input_ds_authenticates_zone BOOLEAN,
  input_retained_zone_digest_matches BOOLEAN,
  input_gateway_healthy BOOLEAN,
  input_valid_for_seconds INTEGER
)
RETURNS TABLE(
  outcome TEXT,
  dns_zone_activation_id TEXT,
  activation_generation BIGINT,
  health_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_dns_zone_health_operations%ROWTYPE;
  current_record hns_dns_zone_activation_current%ROWTYPE;
  latest_generation BIGINT;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT := input_expected_health_generation + 1;
BEGIN
  SELECT * INTO replay FROM hns_dns_zone_health_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_id <> input_operation_id OR replay.request_hash <> input_request_hash
      OR replay.dns_zone_activation_id <> input_dns_zone_activation_id
      OR replay.activation_generation <> input_activation_generation
      OR replay.expected_health_generation <> input_expected_health_generation THEN
      RAISE EXCEPTION 'HNS DNS health idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.dns_zone_activation_id,
      replay.activation_generation, replay.result_health_generation;
    RETURN;
  END IF;
  IF input_valid_for_seconds < 1 OR input_valid_for_seconds > 86400 THEN
    RAISE EXCEPTION 'HNS DNS health lifetime is invalid';
  END IF;
  SELECT * INTO current_record FROM hns_dns_zone_activation_current AS current_authority
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id FOR SHARE;
  IF NOT FOUND OR current_record.current_generation <> input_activation_generation THEN
    RAISE EXCEPTION 'HNS DNS health activation generation is stale';
  END IF;
  SELECT COALESCE(max(observation.health_generation), 0) INTO latest_generation
    FROM hns_dns_zone_health_observations AS observation
   WHERE observation.dns_zone_activation_id = input_dns_zone_activation_id
     AND observation.activation_generation = input_activation_generation;
  IF latest_generation <> input_expected_health_generation THEN
    RAISE EXCEPTION 'HNS DNS health generation fence does not match';
  END IF;
  INSERT INTO hns_dns_zone_health_observations VALUES (
    input_dns_zone_activation_id, input_activation_generation, new_generation,
    input_delegation_snapshot_reference, input_delegation_snapshot_digest,
    input_observed_zone_bytes_digest, input_observed_dnssec_keyset_reference,
    input_observed_dnssec_keyset_version, input_observed_gateway_deployment_reference,
    input_observed_gateway_certificate_spki_sha256, input_delegation_matches,
    input_ds_authenticates_zone, input_retained_zone_digest_matches,
    input_gateway_healthy, database_now,
    database_now + input_valid_for_seconds * INTERVAL '1 second'
  );
  INSERT INTO hns_dns_zone_health_operations VALUES (
    input_operation_id, input_idempotency_key, input_request_hash,
    input_dns_zone_activation_id, input_activation_generation,
    input_expected_health_generation, new_generation, database_now
  );
  RETURN QUERY SELECT 'recorded'::TEXT, input_dns_zone_activation_id,
    input_activation_generation, new_generation;
END;
$$;

CREATE FUNCTION activate_hns_community_app_host_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_app_host_activation_id TEXT,
  input_community_id TEXT,
  input_canonical_root TEXT,
  input_route_binding_id TEXT,
  input_route_authority_kind TEXT,
  input_route_authority_reference TEXT,
  input_route_authority_generation BIGINT,
  input_dns_zone_activation_id TEXT,
  input_dns_zone_activation_generation BIGINT,
  input_gateway_deployment_reference TEXT
)
RETURNS TABLE(
  outcome TEXT,
  app_host_activation_id TEXT,
  app_host_activation_generation BIGINT,
  status TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_community_app_host_operations%ROWTYPE;
  route RECORD;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  dns_current hns_dns_zone_activation_current%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  resolved_reference TEXT;
  resolved_generation BIGINT;
BEGIN
  SELECT * INTO replay FROM hns_community_app_host_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_kind <> 'activate' OR replay.operation_id <> input_operation_id
      OR replay.request_hash <> input_request_hash
      OR replay.app_host_activation_id <> input_app_host_activation_id THEN
      RAISE EXCEPTION 'HNS app-host activation idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.app_host_activation_id,
      replay.result_activation_generation, replay.target_status;
    RETURN;
  END IF;
  SELECT * INTO route FROM effective_route_authority_v2(input_community_id, database_now)
   WHERE route_binding_id = input_route_binding_id;
  resolved_reference := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
    THEN route.verified_evidence_ref ELSE route.authority_reference END;
  resolved_generation := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
    THEN route.binding_generation ELSE route.authority_generation END;
  IF route.community_id IS NULL OR route.family <> 'hns' OR route.root_label <> input_canonical_root
    OR route.route_authority_kind <> input_route_authority_kind
    OR resolved_reference <> input_route_authority_reference
    OR resolved_generation <> input_route_authority_generation THEN
    RAISE EXCEPTION 'HNS app-host route authority does not match';
  END IF;
  SELECT * INTO dns_current FROM hns_dns_zone_activation_current AS current_authority
   WHERE current_authority.dns_zone_activation_id = input_dns_zone_activation_id
     AND current_authority.canonical_root = input_canonical_root FOR SHARE;
  SELECT * INTO dns_revision FROM hns_dns_zone_activation_revisions AS revision
   WHERE revision.dns_zone_activation_id = input_dns_zone_activation_id
     AND revision.dns_zone_activation_generation = input_dns_zone_activation_generation;
  IF dns_current.dns_zone_activation_id IS NULL
    OR dns_current.current_generation <> input_dns_zone_activation_generation
    OR dns_revision.status <> 'active'
    OR dns_revision.gateway_deployment_reference <> input_gateway_deployment_reference THEN
    RAISE EXCEPTION 'HNS app-host DNS authority does not match';
  END IF;
  INSERT INTO hns_community_app_host_activation_revisions (
    app_host_activation_id, app_host_activation_generation, normalized_host,
    canonical_root, community_id, route_binding_id, route_authority_kind,
    route_authority_reference, route_authority_generation, dns_zone_activation_id,
    dns_zone_activation_generation, gateway_deployment_reference, status, activated_at
  ) VALUES (
    input_app_host_activation_id, 1, 'app.' || input_canonical_root,
    input_canonical_root, input_community_id, input_route_binding_id,
    input_route_authority_kind, input_route_authority_reference,
    input_route_authority_generation, input_dns_zone_activation_id,
    input_dns_zone_activation_generation, input_gateway_deployment_reference,
    'active', database_now
  );
  INSERT INTO hns_community_app_host_activation_current VALUES (
    input_app_host_activation_id, 'app.' || input_canonical_root,
    input_community_id, 1, database_now
  );
  INSERT INTO hns_community_app_host_operations VALUES (
    input_operation_id, 'activate', input_idempotency_key, input_request_hash,
    input_app_host_activation_id, 0, 'active', 1, database_now
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'activated'::TEXT, input_app_host_activation_id, 1::BIGINT, 'active'::TEXT;
END;
$$;

CREATE FUNCTION change_hns_community_app_host_status_v1(
  input_operation_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_app_host_activation_id TEXT,
  input_expected_activation_generation BIGINT,
  input_target_status TEXT,
  input_reason_code TEXT
)
RETURNS TABLE(
  outcome TEXT,
  app_host_activation_id TEXT,
  app_host_activation_generation BIGINT,
  status TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay hns_community_app_host_operations%ROWTYPE;
  current_record hns_community_app_host_activation_current%ROWTYPE;
  prior hns_community_app_host_activation_revisions%ROWTYPE;
  route RECORD;
  dns_current hns_dns_zone_activation_current%ROWTYPE;
  dns_revision hns_dns_zone_activation_revisions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  new_generation BIGINT := input_expected_activation_generation + 1;
  next_route_kind TEXT;
  next_route_reference TEXT;
  next_route_generation BIGINT;
BEGIN
  SELECT * INTO replay FROM hns_community_app_host_operations AS operation
   WHERE operation.idempotency_key = input_idempotency_key;
  IF FOUND THEN
    IF replay.operation_kind <> 'transition' OR replay.operation_id <> input_operation_id
      OR replay.request_hash <> input_request_hash
      OR replay.app_host_activation_id <> input_app_host_activation_id
      OR replay.expected_activation_generation <> input_expected_activation_generation
      OR replay.target_status <> input_target_status THEN
      RAISE EXCEPTION 'HNS app-host transition idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.app_host_activation_id,
      replay.result_activation_generation, replay.target_status;
    RETURN;
  END IF;
  SELECT * INTO current_record FROM hns_community_app_host_activation_current AS current_authority
   WHERE current_authority.app_host_activation_id = input_app_host_activation_id FOR UPDATE;
  IF NOT FOUND OR current_record.current_generation <> input_expected_activation_generation THEN
    RAISE EXCEPTION 'HNS app-host generation fence does not match';
  END IF;
  SELECT * INTO prior FROM hns_community_app_host_activation_revisions AS revision
   WHERE revision.app_host_activation_id = input_app_host_activation_id
     AND revision.app_host_activation_generation = input_expected_activation_generation;
  IF prior.status = 'revoked'
    OR NOT ((prior.status = 'active' AND input_target_status IN ('suspended', 'revoked'))
      OR (prior.status = 'suspended' AND input_target_status IN ('active', 'revoked'))) THEN
    RAISE EXCEPTION 'HNS app-host transition is not allowed';
  END IF;
  next_route_kind := prior.route_authority_kind;
  next_route_reference := prior.route_authority_reference;
  next_route_generation := prior.route_authority_generation;
  IF input_target_status = 'active' THEN
    SELECT * INTO route FROM effective_route_authority_v2(prior.community_id, database_now)
     WHERE route_binding_id = prior.route_binding_id;
    next_route_kind := route.route_authority_kind;
    next_route_reference := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
      THEN route.verified_evidence_ref ELSE route.authority_reference END;
    next_route_generation := CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
      THEN route.binding_generation ELSE route.authority_generation END;
    SELECT * INTO dns_current FROM hns_dns_zone_activation_current AS current_authority
     WHERE current_authority.canonical_root = prior.canonical_root FOR SHARE;
    SELECT * INTO dns_revision FROM hns_dns_zone_activation_revisions AS revision
     WHERE revision.dns_zone_activation_id = dns_current.dns_zone_activation_id
       AND revision.dns_zone_activation_generation = dns_current.current_generation;
    IF route.community_id IS NULL OR dns_current.dns_zone_activation_id IS NULL
      OR dns_revision.status <> 'active' THEN
      RAISE EXCEPTION 'HNS app-host restoration authority is unavailable';
    END IF;
  ELSE
    dns_current.dns_zone_activation_id := prior.dns_zone_activation_id;
    dns_current.current_generation := prior.dns_zone_activation_generation;
    dns_revision.gateway_deployment_reference := prior.gateway_deployment_reference;
  END IF;
  INSERT INTO hns_community_app_host_activation_revisions (
    app_host_activation_id, app_host_activation_generation, normalized_host,
    canonical_root, community_id, route_binding_id, route_authority_kind,
    route_authority_reference, route_authority_generation, dns_zone_activation_id,
    dns_zone_activation_generation, gateway_deployment_reference, status,
    reason_code, activated_at, suspended_at, revoked_at
  ) VALUES (
    prior.app_host_activation_id, new_generation, prior.normalized_host,
    prior.canonical_root, prior.community_id, prior.route_binding_id,
    next_route_kind, next_route_reference, next_route_generation,
    dns_current.dns_zone_activation_id, dns_current.current_generation,
    dns_revision.gateway_deployment_reference, input_target_status,
    CASE WHEN input_target_status = 'active' THEN NULL ELSE input_reason_code END,
    prior.activated_at,
    CASE WHEN input_target_status = 'suspended' THEN database_now ELSE NULL END,
    CASE WHEN input_target_status = 'revoked' THEN database_now ELSE NULL END
  );
  UPDATE hns_community_app_host_activation_current AS current_authority
     SET current_generation = new_generation, updated_at = database_now
   WHERE current_authority.app_host_activation_id = input_app_host_activation_id;
  INSERT INTO hns_community_app_host_operations VALUES (
    input_operation_id, 'transition', input_idempotency_key, input_request_hash,
    input_app_host_activation_id, input_expected_activation_generation,
    input_target_status, new_generation, database_now
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'changed'::TEXT, input_app_host_activation_id,
    new_generation, input_target_status;
END;
$$;

CREATE FUNCTION resolve_hns_community_app_host_authority_v1(
  input_normalized_host TEXT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE(
  normalized_host TEXT,
  canonical_root TEXT,
  community_id TEXT,
  app_host_activation_id TEXT,
  app_host_activation_generation BIGINT,
  app_host_activation_status TEXT,
  activation_dns_zone_id TEXT,
  activation_dns_zone_generation BIGINT,
  activation_gateway_deployment_reference TEXT,
  route_binding_id TEXT,
  route_binding_current BOOLEAN,
  route_authority_kind TEXT,
  route_authority_reference TEXT,
  route_authority_generation BIGINT,
  route_authority_effective BOOLEAN,
  dns_zone_activation_id TEXT,
  dns_zone_activation_generation BIGINT,
  dns_zone_status TEXT,
  stable_chain_delegation_matches BOOLEAN,
  dnssec_ds_authenticates_zone BOOLEAN,
  retained_zone_digest_matches BOOLEAN,
  gateway_deployment_reference TEXT,
  gateway_certificate_spki_sha256 TEXT,
  gateway_health TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT app.normalized_host,
         app.canonical_root,
         app.community_id,
         app.app_host_activation_id,
         app.app_host_activation_generation,
         app.status,
         app.dns_zone_activation_id,
         app.dns_zone_activation_generation,
         app.gateway_deployment_reference,
         app.route_binding_id,
         COALESCE(route.route_binding_id = app.route_binding_id
           AND route.route_authority_kind = app.route_authority_kind
           AND (CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
             THEN route.verified_evidence_ref ELSE route.authority_reference END)
               = app.route_authority_reference
           AND (CASE WHEN route.route_authority_kind = 'verified_namespace_v1'
             THEN route.binding_generation ELSE route.authority_generation END)
               = app.route_authority_generation, FALSE),
         app.route_authority_kind,
         app.route_authority_reference,
         app.route_authority_generation,
         route.route_binding_id IS NOT NULL,
         dns.dns_zone_activation_id,
         dns.dns_zone_activation_generation,
         dns.status,
         COALESCE(health.valid_until > database_now
           AND inventory.published_at <= database_now
           AND inventory.expires_at > database_now
           AND health.delegation_matches
           AND health.stable_chain_delegation_snapshot_reference
               = dns.stable_chain_delegation_snapshot_reference
           AND health.stable_chain_delegation_snapshot_digest
               = dns.stable_chain_delegation_snapshot_digest, FALSE),
         COALESCE(health.valid_until > database_now
           AND health.ds_authenticates_zone
           AND health.observed_dnssec_keyset_reference = dns.dnssec_keyset_reference
           AND health.observed_dnssec_keyset_version = dns.dnssec_keyset_version, FALSE),
         COALESCE(health.valid_until > database_now
           AND health.retained_zone_digest_matches
           AND health.observed_zone_bytes_digest = dns.zone_bytes_digest, FALSE),
         dns.gateway_deployment_reference,
         dns.gateway_certificate_spki_sha256,
         CASE WHEN health.valid_until > database_now
           AND health.gateway_healthy
           AND health.observed_gateway_deployment_reference = dns.gateway_deployment_reference
           AND health.observed_gateway_certificate_spki_sha256
               = dns.gateway_certificate_spki_sha256
           THEN 'healthy'::TEXT ELSE 'unavailable'::TEXT END
    FROM hns_community_app_host_activation_current AS current_app
    JOIN hns_community_app_host_activation_revisions AS app
      ON app.app_host_activation_id = current_app.app_host_activation_id
     AND app.app_host_activation_generation = current_app.current_generation
    JOIN hns_dns_zone_activation_current AS current_dns
      ON current_dns.dns_zone_activation_id = app.dns_zone_activation_id
    JOIN hns_dns_zone_activation_revisions AS dns
      ON dns.dns_zone_activation_id = current_dns.dns_zone_activation_id
     AND dns.dns_zone_activation_generation = current_dns.current_generation
    JOIN hns_authority_inventories AS inventory
      ON inventory.authority_inventory_reference
          = dns.pirate_dns_authority_inventory_reference
     AND inventory.authority_inventory_version
          = dns.pirate_dns_authority_inventory_version
     AND inventory.authority_inventory_digest
          = dns.pirate_dns_authority_inventory_digest
    LEFT JOIN LATERAL effective_route_authority_v2(app.community_id, database_now) AS route
      ON route.route_binding_id = app.route_binding_id
    LEFT JOIN LATERAL (
      SELECT observation.*
        FROM hns_dns_zone_health_observations AS observation
       WHERE observation.dns_zone_activation_id = dns.dns_zone_activation_id
         AND observation.activation_generation = dns.dns_zone_activation_generation
       ORDER BY observation.health_generation DESC
       LIMIT 1
    ) AS health ON TRUE
   WHERE database_now IS NOT NULL
     AND input_normalized_host = current_app.normalized_host
$$;

COMMENT ON FUNCTION resolve_hns_community_app_host_authority_v1(TEXT, TIMESTAMPTZ) IS
  'Source-closed current app-host authority. Database-time expiry and every route, DNS, delegation, DS, zone, gateway, and generation mismatch fail closed.';
