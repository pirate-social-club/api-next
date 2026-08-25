-- Community HNS handle sales: seller authority and sale-namespace activation.
--
-- Commerce state is a sibling of canonical route state. An active sale root
-- requires its own verified namespace evidence plus a current, healthy Pirate
-- DNS-zone activation. No canonical route is required or inferred.

CREATE FUNCTION is_handle_sales_identifier_v1(input_value TEXT, maximum_bytes INTEGER)
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

CREATE FUNCTION community_handle_sales_creator_grant_id_v1(
  input_community_id TEXT,
  input_account_id TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT 'handle_sales_grant_' || encode(
    sha256(convert_to(
      'pirate-handle-sales-authority-grant-v1' || chr(0)
      || input_community_id || chr(0) || input_account_id,
      'UTF8'
    )),
    'hex'
  )
$$;

CREATE TABLE community_handle_sales_authority_grants (
  grant_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  principal_account_id TEXT NOT NULL REFERENCES users (user_id),
  authority TEXT NOT NULL CHECK (authority = 'manage_handle_sales'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('creator_owner', 'community_policy')),
  source_policy_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by_account_id TEXT NOT NULL REFERENCES users (user_id),
  revoked_at TIMESTAMPTZ,
  revoked_by_account_id TEXT REFERENCES users (user_id),
  CONSTRAINT community_handle_sales_authority_grants_identity_check CHECK (
    is_handle_sales_identifier_v1(grant_id, 128)
  ),
  CONSTRAINT community_handle_sales_authority_grants_source_shape CHECK (
    (source_kind = 'creator_owner' AND source_policy_ref IS NULL)
    OR (source_kind = 'community_policy'
      AND is_handle_sales_identifier_v1(source_policy_ref, 256))
  ),
  CONSTRAINT community_handle_sales_authority_grants_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_account_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL)
  ),
  CONSTRAINT community_handle_sales_authority_grants_tuple_unique UNIQUE (
    community_id,
    principal_account_id,
    authority
  )
);

CREATE INDEX community_handle_sales_authority_grants_principal_idx
  ON community_handle_sales_authority_grants (
    principal_account_id,
    community_id,
    status
  );

CREATE FUNCTION guard_community_handle_sales_authority_grant_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community handle-sales authority grant cannot be deleted';
  END IF;
  IF ROW(
    NEW.grant_id,
    NEW.community_id,
    NEW.principal_account_id,
    NEW.authority,
    NEW.source_kind,
    NEW.source_policy_ref,
    NEW.granted_at,
    NEW.granted_by_account_id
  ) IS DISTINCT FROM ROW(
    OLD.grant_id,
    OLD.community_id,
    OLD.principal_account_id,
    OLD.authority,
    OLD.source_kind,
    OLD.source_policy_ref,
    OLD.granted_at,
    OLD.granted_by_account_id
  ) THEN
    RAISE EXCEPTION 'community handle-sales authority grant identity is immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked community handle-sales authority grant is terminal';
  END IF;
  IF OLD.status = 'active' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'community handle-sales authority grant transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_handle_sales_authority_grants_change_guard
BEFORE UPDATE OR DELETE ON community_handle_sales_authority_grants
FOR EACH ROW EXECUTE FUNCTION guard_community_handle_sales_authority_grant_change();

CREATE FUNCTION has_community_handle_sales_authority(
  expected_community_id TEXT,
  expected_principal_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM community_handle_sales_authority_grants AS authority_grant
     WHERE authority_grant.community_id = expected_community_id
       AND authority_grant.principal_account_id = expected_principal_account_id
       AND authority_grant.authority = 'manage_handle_sales'
       AND authority_grant.status = 'active'
  )
$$;

COMMENT ON FUNCTION has_community_handle_sales_authority(TEXT, TEXT) IS
  'Community-scoped manage_handle_sales authority, independent of manage_routes and public persona roles.';

-- Existing communities receive exactly the authority their original private
-- creator account would have received at creation. Route managers, moderator
-- personas, and current route owners are deliberately not consulted.
INSERT INTO community_handle_sales_authority_grants (
  grant_id,
  community_id,
  principal_account_id,
  authority,
  source_kind,
  source_policy_ref,
  status,
  granted_at,
  granted_by_account_id
)
SELECT community_handle_sales_creator_grant_id_v1(
         community.community_id,
         community.created_by_user_id
       ),
       community.community_id,
       community.created_by_user_id,
       'manage_handle_sales',
       'creator_owner',
       NULL,
       'active',
       community.created_at,
       community.created_by_user_id
  FROM communities AS community
ON CONFLICT (community_id, principal_account_id, authority) DO NOTHING;

CREATE TABLE community_handle_sale_namespace_activation_revisions (
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  sale_namespace_activation_hash TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  family TEXT NOT NULL CHECK (family = 'hns'),
  canonical_root TEXT NOT NULL,
  display_root TEXT NOT NULL,
  namespace_authority_kind TEXT NOT NULL CHECK (
    namespace_authority_kind = 'verified_namespace_v1'
  ),
  namespace_authority_reference TEXT NOT NULL
    REFERENCES community_route_ownership_evidence (evidence_ref),
  namespace_authority_generation BIGINT NOT NULL,
  serving_kind TEXT NOT NULL CHECK (serving_kind = 'hns_dns_zone_activation_v1'),
  dns_zone_activation_id TEXT NOT NULL,
  dns_zone_activation_generation BIGINT NOT NULL,
  root_replacement_kind TEXT NOT NULL CHECK (
    root_replacement_kind = 'dedicated_root_replace_v1'
  ),
  dedicated_root_replacement_confirmed BOOLEAN NOT NULL CHECK (
    dedicated_root_replacement_confirmed IS TRUE
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  reason_code TEXT,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  authority_grant_id TEXT NOT NULL
    REFERENCES community_handle_sales_authority_grants (grant_id),
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_handle_sale_namespace_activation_revisions_pk PRIMARY KEY (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ),
  CONSTRAINT community_handle_sale_namespace_activation_revisions_dns_fk FOREIGN KEY (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ) REFERENCES hns_dns_zone_activation_revisions (
    dns_zone_activation_id,
    dns_zone_activation_generation
  ),
  CONSTRAINT community_handle_sale_namespace_activation_identity_check CHECK (
    is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
    AND sale_namespace_activation_generation BETWEEN 1 AND 9007199254740991
    AND sale_namespace_activation_hash ~ '^[0-9a-f]{64}$'
    AND is_community_route_root_label('hns', canonical_root)
    AND is_community_route_root_label_display(display_root)
    AND canonical_root <> 'pirate'
    AND is_handle_sales_identifier_v1(namespace_authority_reference, 512)
    AND namespace_authority_generation BETWEEN 1 AND 9007199254740991
    AND is_handle_sales_identifier_v1(dns_zone_activation_id, 256)
    AND dns_zone_activation_generation BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT community_handle_sale_namespace_activation_status_shape CHECK (
    (status = 'pending'
      AND reason_code IS NULL
      AND activated_at IS NULL
      AND suspended_at IS NULL
      AND revoked_at IS NULL)
    OR (status = 'active'
      AND reason_code IS NULL
      AND activated_at IS NOT NULL
      AND suspended_at IS NULL
      AND revoked_at IS NULL)
    OR (status = 'suspended'
      AND is_handle_sales_identifier_v1(reason_code, 128)
      AND activated_at IS NOT NULL
      AND suspended_at IS NOT NULL
      AND revoked_at IS NULL)
    OR (status = 'revoked'
      AND is_handle_sales_identifier_v1(reason_code, 128)
      AND activated_at IS NOT NULL
      AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT community_handle_sale_namespace_activation_time_order CHECK (
    recorded_at >= created_at
    AND (activated_at IS NULL OR activated_at >= created_at)
    AND (suspended_at IS NULL OR suspended_at >= activated_at)
    AND (revoked_at IS NULL OR revoked_at >= activated_at)
  )
);

CREATE TABLE community_handle_sale_namespace_activation_current (
  sale_namespace_activation_id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family = 'hns'),
  canonical_root TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  current_generation BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_handle_sale_namespace_activation_current_root_unique UNIQUE (
    family,
    canonical_root
  ),
  CONSTRAINT community_handle_sale_namespace_activation_current_revision_fk FOREIGN KEY (
    sale_namespace_activation_id,
    current_generation
  ) REFERENCES community_handle_sale_namespace_activation_revisions (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT handle_sale_activation_current_identity_check CHECK (
    is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
    AND is_community_route_root_label(family, canonical_root)
    AND canonical_root <> 'pirate'
    AND current_generation BETWEEN 1 AND 9007199254740991
  )
);

CREATE INDEX handle_sale_activation_current_community_idx
  ON community_handle_sale_namespace_activation_current (community_id, updated_at DESC);

CREATE TABLE community_handle_sale_namespace_activation_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template IN (
      '/communities/:communityId/handle-sale-namespaces',
      '/communities/:communityId/handle-sale-namespaces/:activationId/revisions'
    )
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  sale_namespace_activation_id TEXT NOT NULL,
  expected_activation_generation BIGINT NOT NULL,
  result_activation_generation BIGINT NOT NULL,
  result_activation_hash TEXT NOT NULL CHECK (result_activation_hash ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_sale_activation_actions_identity_check CHECK (
    is_handle_sales_identifier_v1(action_id, 128)
    AND is_handle_sales_identifier_v1(idempotency_key, 128)
    AND is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
    AND expected_activation_generation BETWEEN 0 AND 9007199254740990
    AND result_activation_generation = expected_activation_generation + 1
  ),
  CONSTRAINT handle_sale_activation_actions_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  ),
  CONSTRAINT community_handle_sale_namespace_activation_actions_result_fk FOREIGN KEY (
    sale_namespace_activation_id,
    result_activation_generation
  ) REFERENCES community_handle_sale_namespace_activation_revisions (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION reject_community_handle_sale_namespace_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community handle sale-namespace evidence is append-only';
END;
$$;

CREATE TRIGGER handle_sale_activation_revisions_append_only
BEFORE UPDATE OR DELETE ON community_handle_sale_namespace_activation_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_handle_sale_namespace_append_only_change();

CREATE TRIGGER handle_sale_activation_actions_append_only
BEFORE UPDATE OR DELETE ON community_handle_sale_namespace_activation_actions
FOR EACH ROW EXECUTE FUNCTION reject_community_handle_sale_namespace_append_only_change();

CREATE FUNCTION current_hns_sale_namespace_dependency_v1(
  input_community_id TEXT,
  input_namespace_authority_reference TEXT,
  input_namespace_authority_generation BIGINT,
  input_dns_zone_activation_id TEXT,
  input_dns_zone_activation_generation BIGINT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE (
  canonical_root TEXT,
  display_root TEXT,
  namespace_authority_current BOOLEAN,
  dns_zone_current BOOLEAN,
  dns_delegation_current BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH authority AS (
    SELECT evidence.root_label,
           evidence.root_label_display,
           evidence.binding_generation,
           evidence.expires_at,
           evidence.origin,
           binding.community_id AS bound_community_id,
           attachment.community_id AS attachment_community_id
      FROM community_route_ownership_evidence AS evidence
      LEFT JOIN community_canonical_route_bindings AS binding
        ON binding.verified_evidence_ref = evidence.evidence_ref
      LEFT JOIN community_route_attachment_ceremony_attempts AS ceremony
        ON ceremony.ceremony_intent_id = evidence.route_attachment_ceremony_intent_id
      LEFT JOIN community_route_attachment_intents AS attachment
        ON attachment.attachment_intent_id = ceremony.attachment_intent_id
     WHERE evidence.evidence_ref = input_namespace_authority_reference
       AND evidence.family = 'hns'
       AND evidence.binding_generation = input_namespace_authority_generation
       AND evidence.expires_at IS NOT NULL
       AND evidence.expires_at > database_now
       AND (
         binding.community_id = input_community_id
         OR (evidence.origin = 'route_attachment'
           AND attachment.community_id = input_community_id)
       )
  ),
  dns AS (
    SELECT revision.*,
           inventory.published_at AS inventory_published_at,
           inventory.expires_at AS inventory_expires_at
      FROM hns_dns_zone_activation_current AS current_dns
      JOIN hns_dns_zone_activation_revisions AS revision
        ON revision.dns_zone_activation_id = current_dns.dns_zone_activation_id
       AND revision.dns_zone_activation_generation = current_dns.current_generation
      JOIN hns_authority_inventories AS inventory
        ON inventory.authority_inventory_reference
            = revision.pirate_dns_authority_inventory_reference
       AND inventory.authority_inventory_version
            = revision.pirate_dns_authority_inventory_version
       AND inventory.authority_inventory_digest
            = revision.pirate_dns_authority_inventory_digest
     WHERE current_dns.dns_zone_activation_id = input_dns_zone_activation_id
       AND current_dns.current_generation = input_dns_zone_activation_generation
       AND revision.status = 'active'
       AND inventory.published_at <= database_now
       AND inventory.expires_at > database_now
  ),
  health AS (
    SELECT observation.*
      FROM hns_dns_zone_health_observations AS observation
     WHERE observation.dns_zone_activation_id = input_dns_zone_activation_id
       AND observation.activation_generation = input_dns_zone_activation_generation
     ORDER BY observation.health_generation DESC
     LIMIT 1
  )
  SELECT authority.root_label,
         authority.root_label_display,
         TRUE,
         COALESCE(dns.canonical_root = authority.root_label, FALSE),
         COALESCE(
           dns.canonical_root = authority.root_label
           AND health.valid_until > database_now
           AND health.delegation_matches
           AND health.ds_authenticates_zone
           AND health.retained_zone_digest_matches
           AND health.gateway_healthy
           AND health.stable_chain_delegation_snapshot_reference
               = dns.stable_chain_delegation_snapshot_reference
           AND health.stable_chain_delegation_snapshot_digest
               = dns.stable_chain_delegation_snapshot_digest
           AND health.observed_dnssec_keyset_reference = dns.dnssec_keyset_reference
           AND health.observed_dnssec_keyset_version = dns.dnssec_keyset_version
           AND health.observed_zone_bytes_digest = dns.zone_bytes_digest
           AND health.observed_gateway_deployment_reference
               = dns.gateway_deployment_reference
           AND health.observed_gateway_certificate_spki_sha256
               = dns.gateway_certificate_spki_sha256,
           FALSE
         )
    FROM authority
    LEFT JOIN dns ON dns.canonical_root = authority.root_label
    LEFT JOIN health ON TRUE
   WHERE database_now IS NOT NULL
$$;

COMMENT ON FUNCTION current_hns_sale_namespace_dependency_v1(
  TEXT, TEXT, BIGINT, TEXT, BIGINT, TIMESTAMPTZ
) IS
  'Source-closed HNS seller authority and Pirate NS/glue/DS/zone/gateway health. It does not require a canonical route.';

CREATE FUNCTION validate_community_handle_sale_namespace_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  authority_grant community_handle_sales_authority_grants%ROWTYPE;
  dependency RECORD;
  prior community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id
   FOR SHARE;
  SELECT * INTO authority_grant
    FROM community_handle_sales_authority_grants
   WHERE grant_id = NEW.authority_grant_id
   FOR SHARE;
  IF community_record.community_id IS NULL OR community_record.status <> 'active' THEN
    RAISE EXCEPTION 'handle sale namespace requires an active community';
  END IF;
  IF authority_grant.grant_id IS NULL
    OR authority_grant.community_id <> NEW.community_id
    OR authority_grant.principal_account_id <> NEW.actor_account_id
    OR authority_grant.authority <> 'manage_handle_sales'
    OR authority_grant.status <> 'active' THEN
    RAISE EXCEPTION 'handle sale namespace requires active manage_handle_sales authority';
  END IF;

  SELECT * INTO prior
    FROM community_handle_sale_namespace_activation_revisions AS revision
   WHERE revision.sale_namespace_activation_id = NEW.sale_namespace_activation_id
   ORDER BY revision.sale_namespace_activation_generation DESC
   LIMIT 1
   FOR SHARE;
  IF prior.sale_namespace_activation_id IS NULL THEN
    IF NEW.sale_namespace_activation_generation <> 1 THEN
      RAISE EXCEPTION 'handle sale namespace must begin at generation one';
    END IF;
  ELSE
    IF NEW.sale_namespace_activation_generation
         <> prior.sale_namespace_activation_generation + 1
      OR NEW.community_id <> prior.community_id
      OR NEW.family <> prior.family
      OR NEW.canonical_root <> prior.canonical_root
      OR NEW.display_root <> prior.display_root
      OR NEW.created_at <> prior.created_at THEN
      RAISE EXCEPTION 'handle sale namespace identity and generation are immutable';
    END IF;
    IF prior.status = 'revoked' THEN
      RAISE EXCEPTION 'revoked handle sale namespace is terminal';
    END IF;
    IF NEW.status = 'pending' OR NEW.status = prior.status THEN
      RAISE EXCEPTION 'handle sale namespace revision must advance state';
    END IF;
  END IF;

  IF NEW.status = 'active' THEN
    SELECT * INTO dependency
      FROM current_hns_sale_namespace_dependency_v1(
        NEW.community_id,
        NEW.namespace_authority_reference,
        NEW.namespace_authority_generation,
        NEW.dns_zone_activation_id,
        NEW.dns_zone_activation_generation,
        clock_timestamp()
      );
    IF dependency.canonical_root IS NULL
      OR dependency.canonical_root <> NEW.canonical_root
      OR dependency.display_root <> NEW.display_root
      OR dependency.namespace_authority_current IS DISTINCT FROM TRUE
      OR dependency.dns_zone_current IS DISTINCT FROM TRUE
      OR dependency.dns_delegation_current IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'handle sale namespace requires current verified HNS and DNS delegation authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_sale_activation_revision_insert_guard
BEFORE INSERT ON community_handle_sale_namespace_activation_revisions
FOR EACH ROW EXECUTE FUNCTION validate_community_handle_sale_namespace_revision_insert();

CREATE FUNCTION guard_community_handle_sale_namespace_current_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community handle sale-namespace current authority cannot be deleted';
  END IF;
  SELECT * INTO revision
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = NEW.sale_namespace_activation_id
     AND sale_namespace_activation_generation = NEW.current_generation;
  IF revision.sale_namespace_activation_id IS NULL
    OR revision.family <> NEW.family
    OR revision.canonical_root <> NEW.canonical_root
    OR revision.community_id <> NEW.community_id THEN
    RAISE EXCEPTION 'community handle sale-namespace current revision does not match';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.sale_namespace_activation_id <> OLD.sale_namespace_activation_id
    OR NEW.family <> OLD.family
    OR NEW.canonical_root <> OLD.canonical_root
    OR NEW.community_id <> OLD.community_id
    OR NEW.current_generation <> OLD.current_generation + 1
    OR NEW.updated_at <= OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'community handle sale-namespace current generation is fenced';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_sale_activation_current_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_handle_sale_namespace_activation_current
FOR EACH ROW EXECUTE FUNCTION guard_community_handle_sale_namespace_current_change();

CREATE FUNCTION effective_community_handle_sale_namespace_v1(
  input_sale_namespace_activation_id TEXT,
  database_now TIMESTAMPTZ
)
RETURNS SETOF community_handle_sale_namespace_activation_revisions
LANGUAGE sql
STABLE
AS $$
  SELECT revision.*
    FROM community_handle_sale_namespace_activation_current AS current_activation
    JOIN community_handle_sale_namespace_activation_revisions AS revision
      ON revision.sale_namespace_activation_id
          = current_activation.sale_namespace_activation_id
     AND revision.sale_namespace_activation_generation
          = current_activation.current_generation
    JOIN LATERAL current_hns_sale_namespace_dependency_v1(
      revision.community_id,
      revision.namespace_authority_reference,
      revision.namespace_authority_generation,
      revision.dns_zone_activation_id,
      revision.dns_zone_activation_generation,
      database_now
    ) AS dependency ON TRUE
   WHERE current_activation.sale_namespace_activation_id
       = input_sale_namespace_activation_id
     AND revision.status = 'active'
     AND dependency.canonical_root = revision.canonical_root
     AND dependency.display_root = revision.display_root
     AND dependency.namespace_authority_current
     AND dependency.dns_zone_current
     AND dependency.dns_delegation_current
$$;

COMMENT ON FUNCTION effective_community_handle_sale_namespace_v1(TEXT, TIMESTAMPTZ) IS
  'Current active HNS sale namespace. Route presence is deliberately absent; stale evidence, DNS, inventory, delegation, DS, zone, or gateway state fails closed.';
