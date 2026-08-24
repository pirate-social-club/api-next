-- Operator-managed first-party HNS route authority.
--
-- This authority is an audited platform operation, never namespace evidence.
-- It extends optional-route-v2 with one exactly-discriminated authority branch
-- while keeping verified ownership as the only sale-authority predicate.

CREATE TABLE platform_operator_route_authority_grants (
  grant_id TEXT PRIMARY KEY,
  operator_principal_id TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority = 'manage_operator_routes'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by_operator_principal_id TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_operator_principal_id TEXT,
  CONSTRAINT platform_operator_route_authority_grants_identity_shape CHECK (
    btrim(grant_id) <> ''
    AND grant_id = btrim(grant_id)
    AND octet_length(grant_id) <= 512
    AND btrim(operator_principal_id) <> ''
    AND operator_principal_id = btrim(operator_principal_id)
    AND octet_length(operator_principal_id) <= 512
    AND btrim(granted_by_operator_principal_id) <> ''
    AND granted_by_operator_principal_id = btrim(granted_by_operator_principal_id)
  ),
  CONSTRAINT platform_operator_route_authority_grants_status_shape CHECK (
    (status = 'active'
      AND revoked_at IS NULL
      AND revoked_by_operator_principal_id IS NULL)
    OR
    (status = 'revoked'
      AND revoked_at IS NOT NULL
      AND btrim(revoked_by_operator_principal_id) <> '')
  )
);

CREATE UNIQUE INDEX platform_operator_route_authority_grants_active_uidx
  ON platform_operator_route_authority_grants (operator_principal_id, authority)
  WHERE status = 'active';

CREATE FUNCTION guard_platform_operator_route_authority_grant_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.grant_id,
    NEW.operator_principal_id,
    NEW.authority,
    NEW.granted_at,
    NEW.granted_by_operator_principal_id
  ) IS DISTINCT FROM ROW(
    OLD.grant_id,
    OLD.operator_principal_id,
    OLD.authority,
    OLD.granted_at,
    OLD.granted_by_operator_principal_id
  ) THEN
    RAISE EXCEPTION 'platform operator route authority identity is immutable';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'revoked platform operator route authority is terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_operator_route_authority_grants_change_guard
BEFORE UPDATE ON platform_operator_route_authority_grants
FOR EACH ROW EXECUTE FUNCTION guard_platform_operator_route_authority_grant_change();

CREATE FUNCTION is_operator_managed_root_registry_document(
  exact_bytes BYTEA,
  expected_reference TEXT,
  expected_version BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  document JSONB;
  entries JSONB;
  canonical_entries TEXT;
  canonical_document TEXT;
  invalid_entries BIGINT;
  reordered_entries BIGINT;
BEGIN
  IF exact_bytes IS NULL
    OR octet_length(exact_bytes) = 0
    OR octet_length(exact_bytes) > 65536
    OR btrim(expected_reference) = ''
    OR expected_reference <> btrim(expected_reference)
    OR expected_version <= 0 THEN
    RETURN FALSE;
  END IF;

  document := convert_from(exact_bytes, 'UTF8')::jsonb;
  IF jsonb_typeof(document) <> 'array'
    OR jsonb_array_length(document) <> 4
    OR document ->> 0 <> 'pirate-operator-managed-root-registry-v1'
    OR document ->> 1 <> expected_reference
    OR jsonb_typeof(document -> 2) <> 'number'
    OR document ->> 2 !~ '^[1-9][0-9]*$'
    OR (document ->> 2)::numeric <> expected_version
    OR jsonb_typeof(document -> 3) <> 'array'
    OR jsonb_array_length(document -> 3) > 256 THEN
    RETURN FALSE;
  END IF;

  entries := document -> 3;
  SELECT COUNT(*) INTO invalid_entries
    FROM jsonb_array_elements(entries) AS item(entry)
   WHERE jsonb_typeof(entry) <> 'array'
      OR jsonb_array_length(entry) <> 3
      OR entry ->> 0 <> 'hns'
      OR is_community_route_root_label('hns', entry ->> 1) IS NOT TRUE
      OR entry ->> 2 <> 'active';
  IF invalid_entries <> 0 THEN
    RETURN FALSE;
  END IF;

  SELECT COALESCE(
           '[' || string_agg(
             format(
               '[%s,%s,%s]',
               to_jsonb(entry ->> 0)::TEXT,
               to_jsonb(entry ->> 1)::TEXT,
               to_jsonb(entry ->> 2)::TEXT
             ),
             ',' ORDER BY ordinal
           ) || ']',
           '[]'
         )
    INTO canonical_entries
    FROM jsonb_array_elements(entries) WITH ORDINALITY AS item(entry, ordinal);
  canonical_document := format(
    '[%s,%s,%s,%s]',
    to_jsonb(document ->> 0)::TEXT,
    to_jsonb(document ->> 1)::TEXT,
    expected_version::TEXT,
    canonical_entries
  );
  IF convert_from(exact_bytes, 'UTF8') <> canonical_document THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO reordered_entries
    FROM (
      SELECT entry ->> 1 AS root_label,
             lag(entry ->> 1) OVER (ORDER BY ordinal) AS previous_root
        FROM jsonb_array_elements(entries) WITH ORDINALITY AS item(entry, ordinal)
    ) AS ordered
   WHERE previous_root IS NOT NULL
     AND convert_to(previous_root, 'UTF8') >= convert_to(root_label, 'UTF8');
  RETURN reordered_entries = 0;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE TABLE operator_managed_root_registry_versions (
  registry_reference TEXT NOT NULL,
  registry_version BIGINT NOT NULL CHECK (registry_version > 0),
  registry_digest TEXT NOT NULL CHECK (registry_digest ~ '^[0-9a-f]{64}$'),
  registry_bytes BYTEA NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  published_by_operator_principal_id TEXT NOT NULL,
  PRIMARY KEY (registry_reference, registry_version),
  UNIQUE (registry_reference, registry_version, registry_digest),
  CONSTRAINT operator_managed_root_registry_versions_identity_shape CHECK (
    btrim(registry_reference) <> ''
    AND registry_reference = btrim(registry_reference)
    AND octet_length(registry_reference) <= 256
    AND btrim(published_by_operator_principal_id) <> ''
    AND published_by_operator_principal_id = btrim(published_by_operator_principal_id)
  ),
  CONSTRAINT operator_managed_root_registry_versions_exact_bytes CHECK (
    encode(sha256(registry_bytes), 'hex') = registry_digest
    AND is_operator_managed_root_registry_document(
      registry_bytes,
      registry_reference,
      registry_version
    )
  )
);

CREATE FUNCTION reject_operator_managed_root_registry_version_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator-managed root registry versions are append-only';
END;
$$;

CREATE TRIGGER operator_managed_root_registry_versions_change_guard
BEFORE UPDATE OR DELETE ON operator_managed_root_registry_versions
FOR EACH ROW EXECUTE FUNCTION reject_operator_managed_root_registry_version_change();

CREATE TABLE operator_managed_root_registry_current (
  registry_kind TEXT PRIMARY KEY
    CHECK (registry_kind = 'pirate-operator-managed-root-registry-v1'),
  registry_reference TEXT NOT NULL,
  registry_version BIGINT NOT NULL,
  registry_digest TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  activated_by_operator_principal_id TEXT NOT NULL,
  FOREIGN KEY (registry_reference, registry_version, registry_digest)
    REFERENCES operator_managed_root_registry_versions (
      registry_reference, registry_version, registry_digest
    )
);

CREATE FUNCTION operator_managed_registry_has_active_root(
  expected_reference TEXT,
  expected_version BIGINT,
  expected_digest TEXT,
  expected_root TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM operator_managed_root_registry_versions AS registry
      CROSS JOIN LATERAL jsonb_array_elements(
        convert_from(registry.registry_bytes, 'UTF8')::jsonb -> 3
      ) AS item(entry)
     WHERE registry.registry_reference = expected_reference
       AND registry.registry_version = expected_version
       AND registry.registry_digest = expected_digest
       AND item.entry = jsonb_build_array('hns', expected_root, 'active')
  )
$$;

ALTER TABLE community_canonical_route_bindings
  ADD COLUMN route_authority_kind TEXT NOT NULL DEFAULT 'verified_namespace_v1',
  ADD COLUMN authority_reference TEXT,
  ADD COLUMN authority_generation BIGINT,
  DROP CONSTRAINT community_canonical_route_bindings_active_shape,
  ADD CONSTRAINT community_canonical_route_bindings_authority_kind_check CHECK (
    route_authority_kind IN ('verified_namespace_v1', 'operator_managed_route_v1')
  ),
  ADD CONSTRAINT community_canonical_route_bindings_authority_shape CHECK (
    (
      route_authority_kind = 'verified_namespace_v1'
      AND authority_reference IS NULL
      AND authority_generation IS NULL
    )
    OR
    (
      route_authority_kind = 'operator_managed_route_v1'
      AND family = 'hns'
      AND ownership_status <> 'verified'
      AND verified_evidence_ref IS NULL
      AND btrim(authority_reference) <> ''
      AND authority_reference = btrim(authority_reference)
      AND authority_generation = binding_generation
      AND authority_generation > 0
    )
  ),
  ADD CONSTRAINT community_canonical_route_bindings_active_shape CHECK (
    route_lifecycle_status <> 'active'
    OR (
      route_authority_kind = 'verified_namespace_v1'
      AND ownership_status = 'verified'
      AND verified_evidence_ref IS NOT NULL
    )
    OR (
      route_authority_kind = 'operator_managed_route_v1'
      AND ownership_status = 'pending'
      AND verified_evidence_ref IS NULL
    )
  );

CREATE TABLE operator_managed_route_activations (
  operator_route_activation_id TEXT PRIMARY KEY,
  operator_route_activation_generation BIGINT NOT NULL DEFAULT 1
    CHECK (operator_route_activation_generation > 0),
  community_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family = 'hns'),
  canonical_root TEXT NOT NULL,
  canonical_path_segment TEXT GENERATED ALWAYS AS ('app.' || canonical_root) STORED,
  operator_principal_id TEXT NOT NULL,
  operator_authority_grant_id TEXT NOT NULL
    REFERENCES platform_operator_route_authority_grants (grant_id),
  operator_managed_root_registry_reference TEXT NOT NULL,
  operator_managed_root_registry_version BIGINT NOT NULL,
  operator_managed_root_registry_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  reason_code TEXT,
  activated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (community_id),
  UNIQUE (route_binding_id),
  UNIQUE (family, canonical_root),
  CONSTRAINT operator_managed_route_activations_identity_shape CHECK (
    btrim(operator_route_activation_id) <> ''
    AND operator_route_activation_id = btrim(operator_route_activation_id)
    AND octet_length(operator_route_activation_id) <= 512
    AND btrim(operator_principal_id) <> ''
    AND operator_principal_id = btrim(operator_principal_id)
    AND is_community_route_root_label(family, canonical_root)
  ),
  CONSTRAINT operator_managed_route_activations_status_shape CHECK (
    (status = 'active' AND reason_code IS NULL AND revoked_at IS NULL)
    OR
    (status = 'revoked'
      AND btrim(reason_code) <> ''
      AND reason_code = btrim(reason_code)
      AND revoked_at IS NOT NULL
      AND revoked_at >= activated_at)
  ),
  FOREIGN KEY (
    operator_managed_root_registry_reference,
    operator_managed_root_registry_version,
    operator_managed_root_registry_digest
  ) REFERENCES operator_managed_root_registry_versions (
    registry_reference, registry_version, registry_digest
  ),
  FOREIGN KEY (community_id, route_binding_id)
    REFERENCES community_canonical_route_bindings (community_id, route_binding_id)
    DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE community_canonical_route_bindings
  ADD CONSTRAINT community_canonical_route_bindings_operator_activation_fk
  FOREIGN KEY (authority_reference)
  REFERENCES operator_managed_route_activations (operator_route_activation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE operator_managed_route_operations (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('activate', 'revoke')),
  operator_principal_id TEXT NOT NULL,
  operator_authority_grant_id TEXT NOT NULL
    REFERENCES platform_operator_route_authority_grants (grant_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  community_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family = 'hns'),
  canonical_root TEXT NOT NULL,
  canonical_path_segment TEXT GENERATED ALWAYS AS ('app.' || canonical_root) STORED,
  operator_route_activation_id TEXT NOT NULL
    REFERENCES operator_managed_route_activations (operator_route_activation_id),
  route_binding_id TEXT NOT NULL,
  registry_reference TEXT,
  registry_version BIGINT,
  registry_digest TEXT,
  expected_activation_generation BIGINT,
  reason_code TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (operator_principal_id, operation_kind, idempotency_key),
  CONSTRAINT operator_managed_route_operations_identity_shape CHECK (
    btrim(operation_id) <> ''
    AND operation_id = btrim(operation_id)
    AND btrim(operator_principal_id) <> ''
    AND operator_principal_id = btrim(operator_principal_id)
    AND btrim(idempotency_key) <> ''
    AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 512
    AND is_community_route_root_label(family, canonical_root)
    AND btrim(reason_code) <> ''
    AND reason_code = btrim(reason_code)
  ),
  CONSTRAINT operator_managed_route_operations_kind_shape CHECK (
    (
      operation_kind = 'activate'
      AND registry_reference IS NOT NULL
      AND registry_version > 0
      AND registry_digest ~ '^[0-9a-f]{64}$'
      AND expected_activation_generation IS NULL
    )
    OR
    (
      operation_kind = 'revoke'
      AND registry_reference IS NULL
      AND registry_version IS NULL
      AND registry_digest IS NULL
      AND expected_activation_generation > 0
    )
  )
);

CREATE FUNCTION reject_operator_managed_route_operation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator-managed route operations are append-only';
END;
$$;

CREATE TRIGGER operator_managed_route_operations_change_guard
BEFORE UPDATE OR DELETE ON operator_managed_route_operations
FOR EACH ROW EXECUTE FUNCTION reject_operator_managed_route_operation_change();

ALTER TABLE community_route_operator_override_audit
  DROP CONSTRAINT community_route_operator_override_audit_action_kind_check,
  ADD CONSTRAINT community_route_operator_override_audit_action_kind_check CHECK (
    action_kind IN (
      'attachment_intent_created',
      'attachment_committed',
      'operator_route_activated',
      'operator_route_revoked'
    )
  );

CREATE OR REPLACE FUNCTION guard_community_canonical_route_binding_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community canonical route binding is immutable';
  END IF;

  IF ROW(
    NEW.route_binding_id,
    NEW.community_id,
    NEW.family,
    NEW.root_label,
    NEW.root_label_display,
    NEW.route_authority_kind,
    NEW.authority_reference,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_binding_id,
    OLD.community_id,
    OLD.family,
    OLD.root_label,
    OLD.root_label_display,
    OLD.route_authority_kind,
    OLD.authority_reference,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  authority_changed := ROW(
    NEW.ownership_status,
    NEW.route_lifecycle_status,
    NEW.verified_evidence_ref,
    NEW.authority_generation
  ) IS DISTINCT FROM ROW(
    OLD.ownership_status,
    OLD.route_lifecycle_status,
    OLD.verified_evidence_ref,
    OLD.authority_generation
  );

  IF authority_changed AND NEW.binding_generation <> OLD.binding_generation + 1 THEN
    RAISE EXCEPTION 'community canonical route generation must advance exactly once';
  END IF;
  IF NOT authority_changed AND NEW.binding_generation <> OLD.binding_generation THEN
    RAISE EXCEPTION 'community canonical route generation cannot advance without authority change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  activation_record operator_managed_route_activations%ROWTYPE;
  community_record communities%ROWTYPE;
  binding_id TEXT;
  guard_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    SELECT * INTO community_record FROM communities WHERE community_id = NEW.community_id;
    binding_id := NEW.canonical_route_binding_id;
  ELSE
    binding_id := NEW.route_binding_id;
    SELECT * INTO community_record FROM communities WHERE community_id = NEW.community_id;
  END IF;

  IF community_record.community_id IS NULL THEN
    RAISE EXCEPTION 'community canonical route owner is missing';
  END IF;
  IF community_record.route_authority_version = 'route_v1'
    AND community_record.status = 'active'
    AND binding_id IS NULL THEN
    RAISE EXCEPTION 'active route-v1 community requires a canonical route binding';
  END IF;
  IF binding_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = binding_id;
  IF NOT FOUND
    OR community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR community_record.community_id IS DISTINCT FROM binding_record.community_id THEN
    RAISE EXCEPTION 'community canonical route reference is not reciprocal';
  END IF;

  IF binding_record.route_lifecycle_status <> 'active' THEN
    RETURN NULL;
  END IF;

  IF binding_record.route_authority_kind = 'verified_namespace_v1' THEN
    SELECT * INTO evidence_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = binding_record.verified_evidence_ref;
    IF NOT FOUND
      OR binding_record.ownership_status <> 'verified'
      OR evidence_record.family <> binding_record.family
      OR evidence_record.root_label <> binding_record.root_label
      OR evidence_record.root_label_display <> binding_record.root_label_display
      OR evidence_record.path_segment <> binding_record.path_segment
      OR evidence_record.binding_generation <> binding_record.binding_generation
      OR (
        community_record.route_authority_version = 'route_v1'
        AND (
          evidence_record.verified_at > guard_at
          OR evidence_record.expires_at IS NULL
          OR evidence_record.expires_at <= guard_at
        )
      ) THEN
      RAISE EXCEPTION 'active community route lacks matching verified ownership evidence';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO activation_record
    FROM operator_managed_route_activations
   WHERE operator_route_activation_id = binding_record.authority_reference;
  IF activation_record.operator_route_activation_id IS NULL
    OR activation_record.operator_route_activation_generation <> binding_record.authority_generation
    OR activation_record.community_id <> binding_record.community_id
    OR activation_record.route_binding_id <> binding_record.route_binding_id
    OR activation_record.family <> binding_record.family
    OR activation_record.canonical_root <> binding_record.root_label
    OR activation_record.canonical_path_segment <> binding_record.path_segment
    OR activation_record.status <> 'active' THEN
    RAISE EXCEPTION 'active community route lacks matching operator activation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION effective_active_route(
  expected_community_id TEXT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE(
  community_id TEXT,
  route_binding_id TEXT,
  family TEXT,
  root_label TEXT,
  root_label_display TEXT,
  path_segment TEXT,
  href TEXT,
  verified_evidence_ref TEXT,
  binding_generation BIGINT,
  evidence_expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT community.community_id,
         binding.route_binding_id,
         binding.family,
         binding.root_label,
         binding.root_label_display,
         binding.path_segment,
         binding.href,
         binding.verified_evidence_ref,
         binding.binding_generation,
         evidence.expires_at
    FROM communities AS community
    JOIN community_canonical_route_bindings AS binding
      ON community.canonical_route_binding_id = binding.route_binding_id
     AND community.community_id = binding.community_id
    JOIN community_route_ownership_evidence AS evidence
      ON evidence.evidence_ref = binding.verified_evidence_ref
   WHERE (expected_community_id IS NULL OR community.community_id = expected_community_id)
     AND database_now IS NOT NULL
     AND community.status = 'active'
     AND binding.route_authority_kind = 'verified_namespace_v1'
     AND binding.route_lifecycle_status = 'active'
     AND binding.ownership_status = 'verified'
     AND binding.verified_evidence_ref IS NOT NULL
     AND evidence.family = binding.family
     AND evidence.root_label = binding.root_label
     AND evidence.root_label_display = binding.root_label_display
     AND evidence.path_segment = binding.path_segment
     AND evidence.binding_generation = binding.binding_generation
     AND evidence.expires_at IS NOT NULL
     AND evidence.expires_at > database_now
$$;

CREATE FUNCTION effective_route_authority_v2(
  expected_community_id TEXT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE(
  community_id TEXT,
  route_binding_id TEXT,
  family TEXT,
  root_label TEXT,
  root_label_display TEXT,
  path_segment TEXT,
  href TEXT,
  route_authority_kind TEXT,
  authority_reference TEXT,
  authority_generation BIGINT,
  verified_evidence_ref TEXT,
  binding_generation BIGINT,
  evidence_expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT verified.community_id,
         verified.route_binding_id,
         verified.family,
         verified.root_label,
         verified.root_label_display,
         verified.path_segment,
         verified.href,
         'verified_namespace_v1'::TEXT,
         NULL::TEXT,
         NULL::BIGINT,
         verified.verified_evidence_ref,
         verified.binding_generation,
         verified.evidence_expires_at
    FROM effective_active_route(expected_community_id, database_now) AS verified
  UNION ALL
  SELECT community.community_id,
         binding.route_binding_id,
         binding.family,
         binding.root_label,
         binding.root_label_display,
         binding.path_segment,
         binding.href,
         binding.route_authority_kind,
         binding.authority_reference,
         binding.authority_generation,
         NULL::TEXT,
         binding.binding_generation,
         NULL::TIMESTAMPTZ
    FROM communities AS community
    JOIN community_canonical_route_bindings AS binding
      ON binding.route_binding_id = community.canonical_route_binding_id
     AND binding.community_id = community.community_id
    JOIN operator_managed_route_activations AS activation
      ON activation.operator_route_activation_id = binding.authority_reference
     AND activation.operator_route_activation_generation = binding.authority_generation
     AND activation.community_id = binding.community_id
     AND activation.route_binding_id = binding.route_binding_id
     AND activation.family = binding.family
     AND activation.canonical_root = binding.root_label
     AND activation.canonical_path_segment = binding.path_segment
     AND activation.status = 'active'
   WHERE (expected_community_id IS NULL OR community.community_id = expected_community_id)
     AND database_now IS NOT NULL
     AND community.status = 'active'
     AND binding.route_authority_kind = 'operator_managed_route_v1'
     AND binding.route_lifecycle_status = 'active'
     AND binding.ownership_status <> 'verified'
     AND binding.verified_evidence_ref IS NULL
$$;

CREATE FUNCTION guard_operator_managed_route_activation_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operator-managed route activations are retained';
  END IF;
  IF ROW(
    NEW.operator_route_activation_id,
    NEW.community_id,
    NEW.route_binding_id,
    NEW.family,
    NEW.canonical_root,
    NEW.operator_principal_id,
    NEW.operator_authority_grant_id,
    NEW.operator_managed_root_registry_reference,
    NEW.operator_managed_root_registry_version,
    NEW.operator_managed_root_registry_digest,
    NEW.activated_at
  ) IS DISTINCT FROM ROW(
    OLD.operator_route_activation_id,
    OLD.community_id,
    OLD.route_binding_id,
    OLD.family,
    OLD.canonical_root,
    OLD.operator_principal_id,
    OLD.operator_authority_grant_id,
    OLD.operator_managed_root_registry_reference,
    OLD.operator_managed_root_registry_version,
    OLD.operator_managed_root_registry_digest,
    OLD.activated_at
  ) THEN
    RAISE EXCEPTION 'operator-managed route activation identity is immutable';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'revoked operator-managed route activation is terminal';
  END IF;
  IF NEW.status <> 'revoked'
    OR NEW.operator_route_activation_generation <> OLD.operator_route_activation_generation + 1 THEN
    RAISE EXCEPTION 'operator-managed route revocation must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operator_managed_route_activations_change_guard
BEFORE UPDATE OR DELETE ON operator_managed_route_activations
FOR EACH ROW EXECUTE FUNCTION guard_operator_managed_route_activation_change();

CREATE FUNCTION guard_operator_managed_root_registry_current_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operator-managed root registry current authority cannot be deleted';
  END IF;
  IF NEW.registry_kind <> OLD.registry_kind
    OR NEW.activated_at < OLD.activated_at THEN
    RAISE EXCEPTION 'operator-managed root registry current identity is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM operator_managed_route_activations AS activation
     WHERE activation.status = 'active'
       AND NOT operator_managed_registry_has_active_root(
         NEW.registry_reference,
         NEW.registry_version,
         NEW.registry_digest,
         activation.canonical_root
       )
  ) THEN
    RAISE EXCEPTION 'current operator-managed registry cannot remove an active route';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operator_managed_root_registry_current_change_guard
BEFORE UPDATE OR DELETE ON operator_managed_root_registry_current
FOR EACH ROW EXECUTE FUNCTION guard_operator_managed_root_registry_current_change();

CREATE FUNCTION activate_operator_managed_route_v1(
  input_operation_id TEXT,
  input_operator_principal_id TEXT,
  input_operator_authority_grant_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_community_id TEXT,
  input_canonical_root TEXT,
  input_root_label_display TEXT,
  input_registry_reference TEXT,
  input_registry_version BIGINT,
  input_registry_digest TEXT,
  input_activation_id TEXT,
  input_route_binding_id TEXT,
  input_reason_code TEXT
)
RETURNS TABLE(
  outcome TEXT,
  operator_route_activation_id TEXT,
  route_binding_id TEXT,
  activation_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay operator_managed_route_operations%ROWTYPE;
  authority platform_operator_route_authority_grants%ROWTYPE;
  current_registry operator_managed_root_registry_current%ROWTYPE;
  community_record communities%ROWTYPE;
  committed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO replay
    FROM operator_managed_route_operations
   WHERE operator_principal_id = input_operator_principal_id
     AND operation_kind = 'activate'
     AND idempotency_key = input_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF replay.operation_id <> input_operation_id
      OR replay.request_hash <> input_request_hash
      OR replay.operator_authority_grant_id <> input_operator_authority_grant_id
      OR replay.community_id <> input_community_id
      OR replay.canonical_root <> input_canonical_root
      OR replay.registry_reference <> input_registry_reference
      OR replay.registry_version <> input_registry_version
      OR replay.registry_digest <> input_registry_digest
      OR replay.operator_route_activation_id <> input_activation_id
      OR replay.route_binding_id <> input_route_binding_id
      OR replay.reason_code <> input_reason_code THEN
      RAISE EXCEPTION 'operator-managed route activation idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.operator_route_activation_id,
      replay.route_binding_id, 1::BIGINT;
    RETURN;
  END IF;

  SELECT * INTO authority
    FROM platform_operator_route_authority_grants
   WHERE grant_id = input_operator_authority_grant_id
   FOR SHARE;
  IF authority.grant_id IS NULL
    OR authority.operator_principal_id <> input_operator_principal_id
    OR authority.authority <> 'manage_operator_routes'
    OR authority.status <> 'active' THEN
    RAISE EXCEPTION 'operator-managed route requires active platform authority';
  END IF;

  SELECT * INTO current_registry
    FROM operator_managed_root_registry_current
   WHERE registry_kind = 'pirate-operator-managed-root-registry-v1'
   FOR SHARE;
  IF current_registry.registry_reference IS NULL
    OR current_registry.registry_reference <> input_registry_reference
    OR current_registry.registry_version <> input_registry_version
    OR current_registry.registry_digest <> input_registry_digest
    OR NOT operator_managed_registry_has_active_root(
      input_registry_reference,
      input_registry_version,
      input_registry_digest,
      input_canonical_root
    ) THEN
    RAISE EXCEPTION 'operator-managed root registry authority does not match';
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = input_community_id
   FOR UPDATE;
  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR community_record.canonical_route_binding_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM community_route_attachment_intents
       WHERE community_id = input_community_id
         AND status IN ('verification_required', 'commit_ready')
    )
    OR NOT is_community_route_root_label('hns', input_canonical_root)
    OR NOT is_community_route_root_label_display(input_root_label_display) THEN
    RAISE EXCEPTION 'operator-managed route activation is not available';
  END IF;

  INSERT INTO community_canonical_route_bindings (
    route_binding_id,
    community_id,
    family,
    root_label,
    root_label_display,
    ownership_status,
    route_lifecycle_status,
    binding_generation,
    verified_evidence_ref,
    route_authority_kind,
    authority_reference,
    authority_generation,
    created_at,
    updated_at
  ) VALUES (
    input_route_binding_id,
    input_community_id,
    'hns',
    input_canonical_root,
    input_root_label_display,
    'pending',
    'active',
    1,
    NULL,
    'operator_managed_route_v1',
    input_activation_id,
    1,
    committed_at,
    committed_at
  );

  INSERT INTO operator_managed_route_activations (
    operator_route_activation_id,
    operator_route_activation_generation,
    community_id,
    route_binding_id,
    family,
    canonical_root,
    operator_principal_id,
    operator_authority_grant_id,
    operator_managed_root_registry_reference,
    operator_managed_root_registry_version,
    operator_managed_root_registry_digest,
    status,
    activated_at
  ) VALUES (
    input_activation_id,
    1,
    input_community_id,
    input_route_binding_id,
    'hns',
    input_canonical_root,
    input_operator_principal_id,
    input_operator_authority_grant_id,
    input_registry_reference,
    input_registry_version,
    input_registry_digest,
    'active',
    committed_at
  );

  UPDATE communities
     SET canonical_route_binding_id = input_route_binding_id,
         updated_at = committed_at
   WHERE community_id = input_community_id;

  INSERT INTO community_route_operator_override_audit (
    override_audit_id,
    community_id,
    operator_principal_id,
    action_kind,
    reason,
    request_hash,
    occurred_at
  ) VALUES (
    input_operation_id,
    input_community_id,
    input_operator_principal_id,
    'operator_route_activated',
    input_reason_code,
    input_request_hash,
    committed_at
  );

  INSERT INTO operator_managed_route_operations (
    operation_id,
    operation_kind,
    operator_principal_id,
    operator_authority_grant_id,
    idempotency_key,
    request_hash,
    community_id,
    family,
    canonical_root,
    operator_route_activation_id,
    route_binding_id,
    registry_reference,
    registry_version,
    registry_digest,
    expected_activation_generation,
    reason_code,
    committed_at
  ) VALUES (
    input_operation_id,
    'activate',
    input_operator_principal_id,
    input_operator_authority_grant_id,
    input_idempotency_key,
    input_request_hash,
    input_community_id,
    'hns',
    input_canonical_root,
    input_activation_id,
    input_route_binding_id,
    input_registry_reference,
    input_registry_version,
    input_registry_digest,
    NULL,
    input_reason_code,
    committed_at
  );

  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN QUERY SELECT 'activated'::TEXT, input_activation_id,
    input_route_binding_id, 1::BIGINT;
END;
$$;

CREATE FUNCTION revoke_operator_managed_route_v1(
  input_operation_id TEXT,
  input_operator_principal_id TEXT,
  input_operator_authority_grant_id TEXT,
  input_idempotency_key TEXT,
  input_request_hash TEXT,
  input_community_id TEXT,
  input_canonical_root TEXT,
  input_activation_id TEXT,
  input_route_binding_id TEXT,
  input_expected_activation_generation BIGINT,
  input_reason_code TEXT
)
RETURNS TABLE(
  outcome TEXT,
  operator_route_activation_id TEXT,
  route_binding_id TEXT,
  activation_generation BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  replay operator_managed_route_operations%ROWTYPE;
  authority platform_operator_route_authority_grants%ROWTYPE;
  activation operator_managed_route_activations%ROWTYPE;
  binding community_canonical_route_bindings%ROWTYPE;
  community_record communities%ROWTYPE;
  committed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO replay
    FROM operator_managed_route_operations
   WHERE operator_principal_id = input_operator_principal_id
     AND operation_kind = 'revoke'
     AND idempotency_key = input_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF replay.operation_id <> input_operation_id
      OR replay.request_hash <> input_request_hash
      OR replay.operator_authority_grant_id <> input_operator_authority_grant_id
      OR replay.community_id <> input_community_id
      OR replay.canonical_root <> input_canonical_root
      OR replay.operator_route_activation_id <> input_activation_id
      OR replay.route_binding_id <> input_route_binding_id
      OR replay.expected_activation_generation <> input_expected_activation_generation
      OR replay.reason_code <> input_reason_code THEN
      RAISE EXCEPTION 'operator-managed route revocation idempotency conflict';
    END IF;
    RETURN QUERY SELECT 'replayed'::TEXT, replay.operator_route_activation_id,
      replay.route_binding_id, input_expected_activation_generation + 1;
    RETURN;
  END IF;

  SELECT * INTO authority
    FROM platform_operator_route_authority_grants
   WHERE grant_id = input_operator_authority_grant_id
   FOR SHARE;
  IF authority.grant_id IS NULL
    OR authority.operator_principal_id <> input_operator_principal_id
    OR authority.authority <> 'manage_operator_routes'
    OR authority.status <> 'active' THEN
    RAISE EXCEPTION 'operator-managed route revocation requires active platform authority';
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = input_community_id
   FOR UPDATE;
  SELECT * INTO activation
    FROM operator_managed_route_activations AS stored_activation
   WHERE stored_activation.operator_route_activation_id = input_activation_id
   FOR UPDATE;
  SELECT * INTO binding
    FROM community_canonical_route_bindings AS stored_binding
   WHERE stored_binding.route_binding_id = input_route_binding_id
   FOR UPDATE;

  IF community_record.community_id IS NULL
    OR community_record.canonical_route_binding_id <> input_route_binding_id
    OR activation.operator_route_activation_id IS NULL
    OR activation.status <> 'active'
    OR activation.operator_route_activation_generation <> input_expected_activation_generation
    OR activation.community_id <> input_community_id
    OR activation.route_binding_id <> input_route_binding_id
    OR activation.canonical_root <> input_canonical_root
    OR binding.route_binding_id IS NULL
    OR binding.route_authority_kind <> 'operator_managed_route_v1'
    OR binding.authority_reference <> input_activation_id
    OR binding.authority_generation <> input_expected_activation_generation
    OR binding.binding_generation <> input_expected_activation_generation
    OR binding.route_lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'operator-managed route revocation fence does not match';
  END IF;

  UPDATE operator_managed_route_activations AS stored_activation
     SET status = 'revoked',
         reason_code = input_reason_code,
         revoked_at = committed_at,
         operator_route_activation_generation = input_expected_activation_generation + 1
   WHERE stored_activation.operator_route_activation_id = input_activation_id;

  UPDATE community_canonical_route_bindings AS stored_binding
     SET route_lifecycle_status = 'suspended',
         ownership_status = 'revoked',
         binding_generation = binding_generation + 1,
         authority_generation = authority_generation + 1,
         updated_at = committed_at
   WHERE stored_binding.route_binding_id = input_route_binding_id;

  INSERT INTO community_route_operator_override_audit (
    override_audit_id,
    community_id,
    operator_principal_id,
    action_kind,
    reason,
    request_hash,
    occurred_at
  ) VALUES (
    input_operation_id,
    input_community_id,
    input_operator_principal_id,
    'operator_route_revoked',
    input_reason_code,
    input_request_hash,
    committed_at
  );

  INSERT INTO operator_managed_route_operations (
    operation_id,
    operation_kind,
    operator_principal_id,
    operator_authority_grant_id,
    idempotency_key,
    request_hash,
    community_id,
    family,
    canonical_root,
    operator_route_activation_id,
    route_binding_id,
    registry_reference,
    registry_version,
    registry_digest,
    expected_activation_generation,
    reason_code,
    committed_at
  ) VALUES (
    input_operation_id,
    'revoke',
    input_operator_principal_id,
    input_operator_authority_grant_id,
    input_idempotency_key,
    input_request_hash,
    input_community_id,
    'hns',
    input_canonical_root,
    input_activation_id,
    input_route_binding_id,
    NULL,
    NULL,
    NULL,
    input_expected_activation_generation,
    input_reason_code,
    committed_at
  );

  RETURN QUERY SELECT 'revoked'::TEXT, input_activation_id,
    input_route_binding_id, input_expected_activation_generation + 1;
END;
$$;

COMMENT ON FUNCTION effective_route_authority_v2(TEXT, TIMESTAMPTZ) IS
  'Exactly one verified-namespace or operator-managed route authority branch. This is not a sale-namespace predicate.';
