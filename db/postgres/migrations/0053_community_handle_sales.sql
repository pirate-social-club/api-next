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
    sha256(
      convert_to('pirate-handle-sales-authority-grant-v1', 'UTF8')
      || decode('00', 'hex')
      || convert_to(input_community_id, 'UTF8')
      || decode('00', 'hex')
      || convert_to(input_account_id, 'UTF8')
    ),
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
 WHERE community.status IN ('active', 'hidden')
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

-- Private persona linkage generations. The counter is deliberately separate
-- from profile revisions: it changes only when the public correlation surface
-- changes and is never projected outside an owner-authorized handle flow.
CREATE TABLE handle_persona_public_linkage_states (
  persona_id TEXT PRIMARY KEY REFERENCES personas (persona_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  public_linkage_generation BIGINT NOT NULL DEFAULT 0 CHECK (
    public_linkage_generation BETWEEN 0 AND 9007199254740991
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT handle_persona_public_linkage_account_persona_unique UNIQUE (
    account_id,
    persona_id
  )
);

INSERT INTO handle_persona_public_linkage_states (
  persona_id,
  account_id,
  public_linkage_generation,
  updated_at
)
SELECT persona.persona_id,
       persona.account_id,
       CASE WHEN
         EXISTS (
           SELECT 1 FROM public_handle_index AS public_handle
            WHERE public_handle.owner_persona_id = persona.persona_id
         )
         OR EXISTS (
           SELECT 1 FROM persona_profiles AS profile
            WHERE profile.persona_id = persona.persona_id
              AND ROW(
                profile.display_name,
                profile.avatar_ref,
                profile.cover_ref,
                profile.bio
              ) IS DISTINCT FROM ROW(NULL, NULL, NULL, NULL)
         )
         OR EXISTS (
           SELECT 1 FROM posts AS post
            WHERE post.author_persona_id = persona.persona_id
         )
         OR EXISTS (
           SELECT 1 FROM comments AS comment
            WHERE comment.author_persona_id = persona.persona_id
         )
         OR EXISTS (
           SELECT 1 FROM persona_wallet_assignments AS wallet
            WHERE wallet.persona_id = persona.persona_id
              AND wallet.status = 'active'
         )
       THEN 1 ELSE 0 END,
       clock_timestamp()
  FROM personas AS persona
ON CONFLICT (persona_id) DO NOTHING;

CREATE FUNCTION initialize_handle_persona_public_linkage_state_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO handle_persona_public_linkage_states (
    persona_id,
    account_id,
    public_linkage_generation,
    updated_at
  ) VALUES (NEW.persona_id, NEW.account_id, 0, clock_timestamp())
  ON CONFLICT (persona_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_persona_public_linkage_persona_insert
AFTER INSERT ON personas
FOR EACH ROW EXECUTE FUNCTION initialize_handle_persona_public_linkage_state_v1();

CREATE FUNCTION ensure_handle_persona_public_footprint_v1(
  input_persona_id TEXT,
  input_occurred_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE handle_persona_public_linkage_states
     SET public_linkage_generation = CASE
           WHEN public_linkage_generation = 0 THEN 1
           ELSE public_linkage_generation
         END,
         updated_at = GREATEST(updated_at, input_occurred_at)
   WHERE persona_id = input_persona_id;
END;
$$;

CREATE FUNCTION advance_handle_persona_public_linkage_v1(
  input_persona_id TEXT,
  input_occurred_at TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  next_generation BIGINT;
BEGIN
  UPDATE handle_persona_public_linkage_states
     SET public_linkage_generation = public_linkage_generation + 1,
         updated_at = GREATEST(updated_at, input_occurred_at)
   WHERE persona_id = input_persona_id
     AND public_linkage_generation < 9007199254740991
  RETURNING public_linkage_generation INTO next_generation;
  IF next_generation IS NULL THEN
    RAISE EXCEPTION 'persona public-linkage generation is unavailable';
  END IF;
  RETURN next_generation;
END;
$$;

CREATE FUNCTION track_handle_persona_profile_footprint_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF ROW(NEW.display_name, NEW.avatar_ref, NEW.cover_ref, NEW.bio)
       IS DISTINCT FROM ROW(NULL, NULL, NULL, NULL) THEN
      PERFORM ensure_handle_persona_public_footprint_v1(
        NEW.persona_id,
        NEW.updated_at
      );
    END IF;
  ELSIF ROW(NEW.display_name, NEW.avatar_ref, NEW.cover_ref, NEW.bio)
      IS DISTINCT FROM ROW(OLD.display_name, OLD.avatar_ref, OLD.cover_ref, OLD.bio) THEN
    PERFORM advance_handle_persona_public_linkage_v1(
      NEW.persona_id,
      NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_persona_profile_footprint
AFTER INSERT OR UPDATE ON persona_profiles
FOR EACH ROW EXECUTE FUNCTION track_handle_persona_profile_footprint_v1();

CREATE FUNCTION track_handle_persona_wallet_footprint_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    PERFORM ensure_handle_persona_public_footprint_v1(NEW.persona_id, NEW.updated_at);
  ELSIF NEW.status = 'active'
    AND ROW(NEW.address, NEW.privy_wallet_id)
      IS DISTINCT FROM ROW(OLD.address, OLD.privy_wallet_id) THEN
    PERFORM advance_handle_persona_public_linkage_v1(NEW.persona_id, NEW.updated_at);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_persona_wallet_footprint
AFTER INSERT OR UPDATE ON persona_wallet_assignments
FOR EACH ROW EXECUTE FUNCTION track_handle_persona_wallet_footprint_v1();

CREATE FUNCTION track_handle_platform_label_footprint_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM advance_handle_persona_public_linkage_v1(
      NEW.owner_persona_id,
      NEW.updated_at
    );
  ELSIF ROW(NEW.label_normalized, NEW.status, NEW.redirect_target_handle_id)
      IS DISTINCT FROM ROW(OLD.label_normalized, OLD.status, OLD.redirect_target_handle_id) THEN
    PERFORM advance_handle_persona_public_linkage_v1(
      NEW.owner_persona_id,
      NEW.updated_at
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_platform_label_footprint
AFTER INSERT OR UPDATE ON public_handle_index
FOR EACH ROW EXECUTE FUNCTION track_handle_platform_label_footprint_v1();

CREATE FUNCTION track_handle_authored_content_footprint_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.author_persona_id IS NOT NULL THEN
    PERFORM ensure_handle_persona_public_footprint_v1(
      NEW.author_persona_id,
      COALESCE(NEW.created_at, clock_timestamp())
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_post_author_footprint
AFTER INSERT ON posts
FOR EACH ROW EXECUTE FUNCTION track_handle_authored_content_footprint_v1();

CREATE TRIGGER handle_comment_author_footprint
AFTER INSERT ON comments
FOR EACH ROW EXECUTE FUNCTION track_handle_authored_content_footprint_v1();

-- Server-owned authority documents. Seller commands carry ids and expected
-- revisions, while the database resolves hashes and exact immutable content.
CREATE TABLE handle_account_directory_bindings (
  binding_kind TEXT NOT NULL CHECK (binding_kind = 'account_directory_v1'),
  binding_version TEXT NOT NULL,
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_kind, binding_version),
  CONSTRAINT handle_account_directory_binding_version_check CHECK (
    is_handle_sales_identifier_v1(binding_version, 128)
  )
);

INSERT INTO handle_account_directory_bindings (
  binding_kind,
  binding_version,
  binding_hash,
  status
) VALUES (
  'account_directory_v1',
  '1',
  'c81ff980a56025b99dcd24d27979a302ca28f162ca7238dda354686082496d3d',
  'active'
);

CREATE TABLE handle_reserved_label_revisions (
  reserved_labels_id TEXT NOT NULL,
  reserved_labels_revision BIGINT NOT NULL,
  reserved_labels_hash TEXT NOT NULL CHECK (reserved_labels_hash ~ '^[0-9a-f]{64}$'),
  family TEXT NOT NULL CHECK (family = 'hns'),
  platform_labels TEXT[] NOT NULL,
  namespace_labels TEXT[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reserved_labels_id, reserved_labels_revision),
  CONSTRAINT handle_reserved_label_revision_check CHECK (
    reserved_labels_revision BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT handle_reserved_label_arrays_check CHECK (
    array_position(platform_labels, NULL) IS NULL
    AND array_position(namespace_labels, NULL) IS NULL
  )
);

WITH document AS (
  SELECT '["pirate-handle-reserved-labels-v1","reserved_labels_01",1,"hns",["abuse","admin","api","app","auth","billing","blog","cdn","dev","docs","gateway","help","hns","login","logout","mail","mod","moderator","new","official","pirate","root","security","settings","staff","staging","status","support","system","www"],[]]'::TEXT AS bytes
)
INSERT INTO handle_reserved_label_revisions (
  reserved_labels_id,
  reserved_labels_revision,
  reserved_labels_hash,
  family,
  platform_labels,
  namespace_labels,
  status
)
SELECT 'reserved_labels_01',
       1,
       encode(sha256(convert_to(document.bytes, 'UTF8')), 'hex'),
       'hns',
       ARRAY[
         'abuse','admin','api','app','auth','billing','blog','cdn','dev','docs',
         'gateway','help','hns','login','logout','mail','mod','moderator','new',
         'official','pirate','root','security','settings','staff','staging',
         'status','support','system','www'
       ]::TEXT[],
       ARRAY[]::TEXT[],
       'active'
  FROM document;

CREATE TABLE handle_pricing_revisions (
  pricing_id TEXT NOT NULL,
  pricing_revision BIGINT NOT NULL,
  pricing_hash TEXT NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  pricing_kind TEXT NOT NULL CHECK (pricing_kind = 'free_v1'),
  atomic_amount NUMERIC(78, 0) NOT NULL CHECK (atomic_amount = 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pricing_id, pricing_revision)
);

INSERT INTO handle_pricing_revisions (
  pricing_id,
  pricing_revision,
  pricing_hash,
  pricing_kind,
  atomic_amount,
  status
) VALUES (
  'platform_free_handles_v1',
  1,
  'cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8',
  'free_v1',
  0,
  'active'
);

CREATE TABLE handle_issuance_driver_revisions (
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  driver_id TEXT NOT NULL,
  driver_version TEXT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (
    fulfillment_kind IN ('hosted_persona_v1', 'delegated_zone_v1', 'spaces_native_v1')
  ),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (family, driver_id, driver_version)
);

INSERT INTO handle_issuance_driver_revisions (
  family,
  driver_id,
  driver_version,
  fulfillment_kind,
  status
) VALUES ('hns', 'hosted_persona-local', '1', 'hosted_persona_v1', 'enabled');

-- Recipient tokens are private bearer transport authority. The raw token is
-- never stored. A versioned HMAC digest supports lookup and the independently
-- versioned envelope ciphertext exists only for exact creation replay.
CREATE TABLE handle_direct_grant_recipient_tokens (
  token_id TEXT PRIMARY KEY,
  recipient_account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  token_lookup_digest TEXT NOT NULL CHECK (token_lookup_digest ~ '^[0-9a-f]{64}$'),
  token_hmac_key_version TEXT NOT NULL,
  token_ciphertext BYTEA,
  token_envelope_key_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'consumed')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  consumed_by_seller_account_id TEXT REFERENCES users (user_id),
  consuming_idempotency_key TEXT,
  qualification_policy_id TEXT,
  policy_request_hash TEXT,
  CONSTRAINT handle_recipient_token_identity_check CHECK (
    is_handle_sales_identifier_v1(token_id, 128)
    AND is_handle_sales_identifier_v1(token_hmac_key_version, 64)
    AND expires_at = created_at + interval '600 seconds'
  ),
  CONSTRAINT handle_recipient_token_cipher_shape CHECK (
    (token_ciphertext IS NULL AND token_envelope_key_version IS NULL)
    OR ((octet_length(token_ciphertext) >= 29 AND octet_length(token_ciphertext) <= 1024)
      AND is_handle_sales_identifier_v1(token_envelope_key_version, 64))
  ),
  CONSTRAINT handle_recipient_token_state_shape CHECK (
    (status = 'current'
      AND superseded_at IS NULL
      AND consumed_at IS NULL
      AND consumed_by_seller_account_id IS NULL
      AND consuming_idempotency_key IS NULL
      AND qualification_policy_id IS NULL
      AND policy_request_hash IS NULL
      AND token_ciphertext IS NOT NULL)
    OR (status = 'superseded'
      AND superseded_at IS NOT NULL
      AND consumed_at IS NULL
      AND consumed_by_seller_account_id IS NULL
      AND consuming_idempotency_key IS NULL
      AND qualification_policy_id IS NULL
      AND policy_request_hash IS NULL)
    OR (status = 'consumed'
      AND superseded_at IS NULL
      AND consumed_at IS NOT NULL
      AND consumed_by_seller_account_id IS NOT NULL
      AND is_handle_sales_identifier_v1(consuming_idempotency_key, 128)
      AND is_handle_sales_identifier_v1(qualification_policy_id, 128)
      AND policy_request_hash ~ '^[0-9a-f]{64}$'
      AND token_ciphertext IS NULL)
  ),
  CONSTRAINT handle_recipient_token_time_order CHECK (
    expires_at > created_at
    AND (superseded_at IS NULL OR superseded_at >= created_at)
    AND (consumed_at IS NULL OR consumed_at >= created_at)
  )
);

CREATE UNIQUE INDEX handle_recipient_token_digest_unique
  ON handle_direct_grant_recipient_tokens (
    token_hmac_key_version,
    token_lookup_digest
  );

CREATE UNIQUE INDEX handle_recipient_token_current_unique
  ON handle_direct_grant_recipient_tokens (recipient_account_id, community_id)
  WHERE status = 'current';

CREATE INDEX handle_recipient_token_expiry_cleanup_idx
  ON handle_direct_grant_recipient_tokens (expires_at, token_id)
  WHERE status IN ('current', 'superseded');

CREATE TABLE handle_direct_grant_recipient_token_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template = '/communities/:communityId/handle-direct-grant-recipient-tokens'
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  token_id TEXT NOT NULL REFERENCES handle_direct_grant_recipient_tokens (token_id)
    ON DELETE CASCADE,
  token_lookup_digest TEXT NOT NULL CHECK (token_lookup_digest ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_recipient_token_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  )
);

CREATE TABLE handle_qualification_policy_revisions (
  policy_id TEXT NOT NULL,
  policy_revision BIGINT NOT NULL,
  community_id TEXT REFERENCES communities (community_id),
  policy_kind TEXT NOT NULL CHECK (policy_kind IN ('none_v1', 'curated_policy_v1')),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  requirement_id TEXT,
  requirement_revision BIGINT,
  requirement_kind TEXT,
  subject_account_id TEXT REFERENCES users (user_id),
  provider_binding_kind TEXT,
  provider_binding_version TEXT,
  provider_binding_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by_account_id TEXT REFERENCES users (user_id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (policy_id, policy_revision),
  CONSTRAINT handle_qualification_policy_shape CHECK (
    (policy_kind = 'none_v1'
      AND community_id IS NULL
      AND requirement_id IS NULL
      AND requirement_revision IS NULL
      AND requirement_kind IS NULL
      AND subject_account_id IS NULL
      AND provider_binding_kind IS NULL
      AND provider_binding_version IS NULL
      AND provider_binding_hash IS NULL
      AND created_by_account_id IS NULL)
    OR (policy_kind = 'curated_policy_v1'
      AND community_id IS NOT NULL
      AND is_handle_sales_identifier_v1(requirement_id, 128)
      AND requirement_revision = 1
      AND requirement_kind = 'account_allowlist_v1'
      AND subject_account_id IS NOT NULL
      AND provider_binding_kind = 'account_directory_v1'
      AND is_handle_sales_identifier_v1(provider_binding_version, 128)
      AND provider_binding_hash ~ '^[0-9a-f]{64}$'
      AND created_by_account_id IS NOT NULL)
  )
);

WITH none_policy AS (
  SELECT '["pirate-handle-none-policy-v1","none_v1",1]'::TEXT AS bytes
)
INSERT INTO handle_qualification_policy_revisions (
  policy_id,
  policy_revision,
  community_id,
  policy_kind,
  request_hash,
  policy_hash,
  status,
  created_at
)
SELECT 'none_v1',
       1,
       NULL,
       'none_v1',
       encode(sha256(convert_to(none_policy.bytes, 'UTF8')), 'hex'),
       encode(sha256(convert_to(none_policy.bytes, 'UTF8')), 'hex'),
       'active',
       clock_timestamp()
  FROM none_policy;

CREATE TABLE handle_qualification_policy_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template = '/communities/:communityId/handle-qualification-policies'
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  submitted_token_hmac_key_version TEXT NOT NULL,
  submitted_token_lookup_digest TEXT NOT NULL CHECK (
    submitted_token_lookup_digest ~ '^[0-9a-f]{64}$'
  ),
  policy_id TEXT NOT NULL,
  policy_revision BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_qualification_policy_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  ),
  CONSTRAINT handle_qualification_policy_action_result_fk FOREIGN KEY (
    policy_id,
    policy_revision
  ) REFERENCES handle_qualification_policy_revisions (policy_id, policy_revision)
);

-- Offering revisions are immutable. The compact current table duplicates only
-- fields needed for unique active broad/exact classification and is guarded
-- against divergence from the referenced revision.
CREATE TABLE community_handle_offering_revisions (
  offering_id TEXT NOT NULL,
  offering_revision BIGINT NOT NULL,
  offering_hash TEXT NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  namespace_root TEXT NOT NULL,
  display_root TEXT NOT NULL,
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  label_scope_kind TEXT NOT NULL CHECK (
    label_scope_kind IN ('exact_label_v2', 'label_rule_v2')
  ),
  label_grammar_id TEXT NOT NULL CHECK (label_grammar_id = 'hns_ascii_ldh_1_63_v1'),
  exact_label TEXT,
  min_label_length INTEGER,
  max_label_length INTEGER,
  reserved_labels_id TEXT NOT NULL,
  reserved_labels_revision BIGINT NOT NULL,
  reserved_labels_hash TEXT NOT NULL CHECK (reserved_labels_hash ~ '^[0-9a-f]{64}$'),
  allocation_kind TEXT NOT NULL CHECK (
    allocation_kind IN ('first_come_v1', 'direct_grant_v1', 'auction_v1')
  ),
  max_active_grants_per_account BIGINT,
  fulfillment_kind TEXT NOT NULL CHECK (
    fulfillment_kind IN ('hosted_persona_v1', 'delegated_zone_v1', 'spaces_native_v1')
  ),
  qualification_policy_id TEXT NOT NULL,
  qualification_policy_revision BIGINT NOT NULL,
  qualification_policy_hash TEXT NOT NULL CHECK (
    qualification_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  provider_binding_hash TEXT,
  pricing_id TEXT NOT NULL,
  pricing_revision BIGINT NOT NULL,
  pricing_hash TEXT NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  atomic_amount NUMERIC(78, 0) NOT NULL,
  issuance_driver_id TEXT NOT NULL,
  issuance_driver_version TEXT NOT NULL,
  quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds BETWEEN 30 AND 900),
  reservation_ttl_seconds INTEGER NOT NULL CHECK (
    reservation_ttl_seconds BETWEEN 30 AND 300
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (offering_id, offering_revision),
  CONSTRAINT community_handle_offering_activation_fk FOREIGN KEY (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ) REFERENCES community_handle_sale_namespace_activation_revisions (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ),
  CONSTRAINT community_handle_offering_reserved_fk FOREIGN KEY (
    reserved_labels_id,
    reserved_labels_revision
  ) REFERENCES handle_reserved_label_revisions (
    reserved_labels_id,
    reserved_labels_revision
  ),
  CONSTRAINT community_handle_offering_policy_fk FOREIGN KEY (
    qualification_policy_id,
    qualification_policy_revision
  ) REFERENCES handle_qualification_policy_revisions (policy_id, policy_revision),
  CONSTRAINT community_handle_offering_pricing_fk FOREIGN KEY (
    pricing_id,
    pricing_revision
  ) REFERENCES handle_pricing_revisions (pricing_id, pricing_revision),
  CONSTRAINT community_handle_offering_driver_fk FOREIGN KEY (
    family,
    issuance_driver_id,
    issuance_driver_version
  ) REFERENCES handle_issuance_driver_revisions (family, driver_id, driver_version),
  CONSTRAINT community_handle_offering_label_scope_shape CHECK (
    (label_scope_kind = 'exact_label_v2'
      AND exact_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
      AND exact_label !~ '^xn--'
      AND octet_length(exact_label) BETWEEN 1 AND 63
      AND min_label_length IS NULL
      AND max_label_length IS NULL)
    OR (label_scope_kind = 'label_rule_v2'
      AND exact_label IS NULL
      AND min_label_length BETWEEN 8 AND 32
      AND max_label_length BETWEEN min_label_length AND 32)
  ),
  CONSTRAINT community_handle_offering_supported_shape CHECK (
    family = 'hns'
    AND namespace_root <> 'pirate'
    AND fulfillment_kind = 'hosted_persona_v1'
    AND atomic_amount = 0
    AND (
      (label_scope_kind = 'label_rule_v2'
        AND allocation_kind = 'first_come_v1'
        AND qualification_policy_id = 'none_v1'
        AND (max_active_grants_per_account IS NULL
          OR max_active_grants_per_account BETWEEN 1 AND 9007199254740991))
      OR (label_scope_kind = 'exact_label_v2'
        AND allocation_kind = 'direct_grant_v1'
        AND qualification_policy_id <> 'none_v1'
        AND max_active_grants_per_account IS NULL)
    )
  )
);

CREATE FUNCTION validate_community_handle_offering_revision_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation community_handle_sale_namespace_activation_revisions%ROWTYPE;
  reserved_document handle_reserved_label_revisions%ROWTYPE;
  policy handle_qualification_policy_revisions%ROWTYPE;
  pricing handle_pricing_revisions%ROWTYPE;
  driver handle_issuance_driver_revisions%ROWTYPE;
  prior community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NOT has_community_handle_sales_authority(NEW.community_id, NEW.actor_account_id) THEN
    RAISE EXCEPTION 'handle offering requires active manage_handle_sales authority';
  END IF;
  SELECT * INTO activation
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = NEW.sale_namespace_activation_id
     AND sale_namespace_activation_generation = NEW.sale_namespace_activation_generation
   FOR SHARE;
  IF activation.sale_namespace_activation_id IS NULL
    OR activation.community_id <> NEW.community_id
    OR activation.family <> NEW.family
    OR activation.canonical_root <> NEW.namespace_root
    OR activation.display_root <> NEW.display_root THEN
    RAISE EXCEPTION 'handle offering sale activation reference is inconsistent';
  END IF;
  IF NEW.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM effective_community_handle_sale_namespace_v1(
      NEW.sale_namespace_activation_id,
      clock_timestamp()
    ) AS effective
     WHERE effective.sale_namespace_activation_generation
         = NEW.sale_namespace_activation_generation
  ) THEN
    RAISE EXCEPTION 'active handle offering requires the current effective sale activation';
  END IF;

  SELECT * INTO reserved_document
    FROM handle_reserved_label_revisions
   WHERE reserved_labels_id = NEW.reserved_labels_id
     AND reserved_labels_revision = NEW.reserved_labels_revision
   FOR SHARE;
  IF reserved_document.reserved_labels_id IS NULL
    OR reserved_document.family <> NEW.family
    OR reserved_document.status <> 'active'
    OR reserved_document.reserved_labels_hash <> NEW.reserved_labels_hash
    OR (NEW.label_scope_kind = 'exact_label_v2' AND (
      NEW.exact_label = ANY(reserved_document.platform_labels)
      OR NEW.exact_label = ANY(reserved_document.namespace_labels)
    )) THEN
    RAISE EXCEPTION 'handle offering reserved-label reference is inconsistent';
  END IF;

  SELECT * INTO policy
    FROM handle_qualification_policy_revisions
   WHERE policy_id = NEW.qualification_policy_id
     AND policy_revision = NEW.qualification_policy_revision
   FOR SHARE;
  IF policy.policy_id IS NULL
    OR policy.status <> 'active'
    OR (policy.community_id IS NOT NULL AND policy.community_id <> NEW.community_id)
    OR policy.policy_hash <> NEW.qualification_policy_hash
    OR policy.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash THEN
    RAISE EXCEPTION 'handle offering qualification reference is inconsistent';
  END IF;

  SELECT * INTO pricing
    FROM handle_pricing_revisions
   WHERE pricing_id = NEW.pricing_id
     AND pricing_revision = NEW.pricing_revision
   FOR SHARE;
  IF pricing.pricing_id IS NULL
    OR pricing.status <> 'active'
    OR pricing.pricing_kind <> 'free_v1'
    OR pricing.pricing_hash <> NEW.pricing_hash
    OR pricing.atomic_amount <> NEW.atomic_amount THEN
    RAISE EXCEPTION 'handle offering pricing reference is inconsistent';
  END IF;

  SELECT * INTO driver
    FROM handle_issuance_driver_revisions
   WHERE family = NEW.family
     AND driver_id = NEW.issuance_driver_id
     AND driver_version = NEW.issuance_driver_version
   FOR SHARE;
  IF driver.driver_id IS NULL
    OR driver.status <> 'enabled'
    OR driver.fulfillment_kind <> NEW.fulfillment_kind THEN
    RAISE EXCEPTION 'handle offering issuance-driver reference is inconsistent';
  END IF;

  SELECT * INTO prior
    FROM community_handle_offering_revisions
   WHERE offering_id = NEW.offering_id
   ORDER BY offering_revision DESC
   LIMIT 1
   FOR SHARE;
  IF prior.offering_id IS NULL THEN
    IF NEW.offering_revision <> 1 THEN
      RAISE EXCEPTION 'handle offering must begin at revision one';
    END IF;
  ELSIF NEW.offering_revision <> prior.offering_revision + 1
    OR NEW.community_id <> prior.community_id
    OR NEW.created_at <> prior.created_at
    OR prior.status = 'retired' THEN
    RAISE EXCEPTION 'handle offering revision sequence or identity is invalid';
  END IF;
  IF NEW.recorded_at < NEW.created_at THEN
    RAISE EXCEPTION 'handle offering recorded time precedes creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_handle_offering_revision_insert_guard
BEFORE INSERT ON community_handle_offering_revisions
FOR EACH ROW EXECUTE FUNCTION validate_community_handle_offering_revision_insert_v2();

CREATE TABLE community_handle_offering_current (
  offering_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  sale_namespace_activation_id TEXT NOT NULL,
  current_revision BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
  label_scope_kind TEXT NOT NULL CHECK (
    label_scope_kind IN ('exact_label_v2', 'label_rule_v2')
  ),
  exact_label TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_handle_offering_current_revision_fk FOREIGN KEY (
    offering_id,
    current_revision
  ) REFERENCES community_handle_offering_revisions (
    offering_id,
    offering_revision
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX community_handle_offering_active_broad_unique
  ON community_handle_offering_current (sale_namespace_activation_id)
  WHERE status = 'active' AND label_scope_kind = 'label_rule_v2';

CREATE UNIQUE INDEX community_handle_offering_active_exact_unique
  ON community_handle_offering_current (sale_namespace_activation_id, exact_label)
  WHERE status = 'active' AND label_scope_kind = 'exact_label_v2';

CREATE TABLE community_handle_offering_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template IN (
      '/communities/:communityId/handle-offerings',
      '/communities/:communityId/handle-offerings/:offeringId/revisions'
    )
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  offering_id TEXT NOT NULL,
  result_offering_revision BIGINT NOT NULL,
  result_offering_hash TEXT NOT NULL CHECK (result_offering_hash ~ '^[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_handle_offering_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  ),
  CONSTRAINT community_handle_offering_action_result_fk FOREIGN KEY (
    offering_id,
    result_offering_revision
  ) REFERENCES community_handle_offering_revisions (offering_id, offering_revision)
);

CREATE FUNCTION guard_community_handle_offering_current_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision community_handle_offering_revisions%ROWTYPE;
  prior_revision community_handle_offering_revisions%ROWTYPE;
  other_revision community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community handle offering current pointer cannot be deleted';
  END IF;
  SELECT * INTO revision
    FROM community_handle_offering_revisions
   WHERE offering_id = NEW.offering_id
     AND offering_revision = NEW.current_revision;
  IF revision.offering_id IS NULL
    OR NEW.community_id <> revision.community_id
    OR NEW.sale_namespace_activation_id <> revision.sale_namespace_activation_id
    OR NEW.status <> revision.status
    OR NEW.label_scope_kind <> revision.label_scope_kind
    OR NEW.exact_label IS DISTINCT FROM revision.exact_label THEN
    RAISE EXCEPTION 'community handle offering current pointer does not match revision';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT * INTO prior_revision
      FROM community_handle_offering_revisions
     WHERE offering_id = OLD.offering_id
       AND offering_revision = OLD.current_revision;
    IF NEW.offering_id <> OLD.offering_id
      OR NEW.community_id <> OLD.community_id
      OR NEW.current_revision <> OLD.current_revision + 1
      OR NEW.updated_at <= OLD.updated_at
      OR prior_revision.status = 'retired' THEN
      RAISE EXCEPTION 'community handle offering current generation is fenced';
    END IF;
  END IF;
  IF NEW.status = 'active' THEN
    SELECT active_revision.* INTO other_revision
      FROM community_handle_offering_current AS other_current
      JOIN community_handle_offering_revisions AS active_revision
        ON active_revision.offering_id = other_current.offering_id
       AND active_revision.offering_revision = other_current.current_revision
     WHERE other_current.sale_namespace_activation_id = NEW.sale_namespace_activation_id
       AND other_current.status = 'active'
       AND other_current.offering_id <> NEW.offering_id
     LIMIT 1;
    IF other_revision.offering_id IS NOT NULL AND (
      other_revision.reserved_labels_id <> revision.reserved_labels_id
      OR other_revision.reserved_labels_revision <> revision.reserved_labels_revision
    ) THEN
      RAISE EXCEPTION 'active handle offerings require one reserved-label authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_handle_offering_current_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON community_handle_offering_current
FOR EACH ROW EXECUTE FUNCTION guard_community_handle_offering_current_change_v1();

-- The confirmation is private and single-use. The action row preserves exact
-- creation replay even after the live confirmation has been consumed.
CREATE TABLE handle_persona_link_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  confirmation_hash TEXT NOT NULL CHECK (confirmation_hash ~ '^[0-9a-f]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  target_community_id TEXT NOT NULL REFERENCES communities (community_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  namespace_root TEXT NOT NULL,
  public_linkage_generation BIGINT NOT NULL,
  persona_public_identity_digest TEXT NOT NULL CHECK (
    persona_public_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  status TEXT NOT NULL CHECK (status IN ('available', 'consumed', 'expired')),
  confirmed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_quote_id TEXT,
  CONSTRAINT handle_persona_link_confirmation_owner_fk FOREIGN KEY (
    actor_account_id,
    persona_id
  ) REFERENCES personas (account_id, persona_id),
  CONSTRAINT handle_persona_link_confirmation_time_check CHECK (
    expires_at = confirmed_at + interval '600 seconds'
    AND (consumed_at IS NULL OR consumed_at >= confirmed_at)
  ),
  CONSTRAINT handle_persona_link_confirmation_state_shape CHECK (
    (status = 'available' AND consumed_at IS NULL AND consumed_by_quote_id IS NULL)
    OR (status = 'consumed'
      AND consumed_at IS NOT NULL
      AND is_handle_sales_identifier_v1(consumed_by_quote_id, 128))
    OR (status = 'expired' AND consumed_at IS NULL AND consumed_by_quote_id IS NULL)
  )
);

CREATE TABLE handle_persona_link_confirmation_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL CHECK (
    endpoint_template = '/handle-persona-link-confirmations'
  ),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmation_id TEXT NOT NULL REFERENCES handle_persona_link_confirmations (confirmation_id),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_persona_link_confirmation_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  )
);

CREATE TABLE handle_quotes (
  quote_id TEXT PRIMARY KEY,
  quote_hash TEXT NOT NULL CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  owner_persona_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_revision BIGINT NOT NULL,
  offering_hash TEXT NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind = 'hosted_persona_v1'),
  family TEXT NOT NULL CHECK (family = 'hns'),
  namespace_root TEXT NOT NULL,
  display_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  display_identifier TEXT NOT NULL,
  pricing_id TEXT NOT NULL,
  pricing_revision BIGINT NOT NULL,
  pricing_hash TEXT NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  atomic_amount NUMERIC(78, 0) NOT NULL CHECK (atomic_amount = 0),
  eligibility_policy_revision BIGINT NOT NULL,
  eligibility_policy_hash TEXT NOT NULL CHECK (eligibility_policy_hash ~ '^[0-9a-f]{64}$'),
  evidence_use_ids TEXT[] NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  public_link_confirmation_id TEXT REFERENCES handle_persona_link_confirmations (confirmation_id),
  public_link_confirmation_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('quoted', 'consumed', 'expired')),
  quoted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT handle_quote_owner_fk FOREIGN KEY (
    actor_account_id,
    owner_persona_id
  ) REFERENCES personas (account_id, persona_id),
  CONSTRAINT handle_quote_offering_fk FOREIGN KEY (
    offering_id,
    offering_revision
  ) REFERENCES community_handle_offering_revisions (offering_id, offering_revision),
  CONSTRAINT handle_quote_activation_fk FOREIGN KEY (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ) REFERENCES community_handle_sale_namespace_activation_revisions (
    sale_namespace_activation_id,
    sale_namespace_activation_generation
  ),
  CONSTRAINT handle_quote_link_shape CHECK (
    (public_link_confirmation_id IS NULL AND public_link_confirmation_hash IS NULL)
    OR (public_link_confirmation_id IS NOT NULL
      AND public_link_confirmation_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT handle_quote_state_shape CHECK (
    (status = 'quoted' AND consumed_at IS NULL)
    OR (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status = 'expired' AND consumed_at IS NULL)
  ),
  CONSTRAINT handle_quote_time_order CHECK (
    expires_at > quoted_at AND evaluated_at = quoted_at
  )
);

CREATE TABLE handle_quote_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template = '/handle-quotes'),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('quoted', 'eligibility_required')),
  quote_id TEXT REFERENCES handle_quotes (quote_id),
  offering_id TEXT NOT NULL,
  owner_persona_id TEXT NOT NULL,
  eligibility_reason TEXT CHECK (
    eligibility_reason IN ('evidence_required', 'qualification_unsatisfied')
  ),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_quote_action_result_shape CHECK (
    (result_kind = 'quoted' AND quote_id IS NOT NULL AND eligibility_reason IS NULL)
    OR (result_kind = 'eligibility_required'
      AND quote_id IS NULL
      AND eligibility_reason IS NOT NULL)
  ),
  CONSTRAINT handle_quote_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  )
);

CREATE TABLE handle_reservations (
  reservation_id TEXT PRIMARY KEY,
  reservation_hash TEXT NOT NULL CHECK (reservation_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  owner_persona_id TEXT NOT NULL,
  quote_id TEXT NOT NULL REFERENCES handle_quotes (quote_id),
  quote_hash TEXT NOT NULL CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  offering_id TEXT NOT NULL,
  offering_hash TEXT NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind = 'hosted_persona_v1'),
  family TEXT NOT NULL CHECK (family = 'hns'),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'consumed', 'expired', 'cancelled', 'blocked')
  ),
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  transitioned_at TIMESTAMPTZ,
  CONSTRAINT handle_reservation_owner_fk FOREIGN KEY (
    actor_account_id,
    owner_persona_id
  ) REFERENCES personas (account_id, persona_id),
  CONSTRAINT handle_reservation_state_shape CHECK (
    (status = 'reserved' AND transitioned_at IS NULL)
    OR (status <> 'reserved' AND transitioned_at IS NOT NULL)
  ),
  CONSTRAINT handle_reservation_time_order CHECK (expires_at > reserved_at)
);

CREATE TABLE handle_reservation_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template = '/handle-reservations'),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reservation_id TEXT NOT NULL REFERENCES handle_reservations (reservation_id),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_reservation_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  )
);

CREATE TABLE handle_key_fences (
  family TEXT NOT NULL,
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  live_reservation_id TEXT REFERENCES handle_reservations (reservation_id),
  permanent_grant_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (family, namespace_root, handle_label),
  CONSTRAINT handle_key_fence_family_check CHECK (family IN ('hns', 'spaces')),
  CONSTRAINT handle_key_fence_shape CHECK (
    live_reservation_id IS NOT NULL OR permanent_grant_id IS NOT NULL
  )
);

CREATE TABLE handle_claims (
  claim_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  owner_persona_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_hash TEXT NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  quote_id TEXT NOT NULL REFERENCES handle_quotes (quote_id),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES handle_reservations (reservation_id),
  reservation_hash TEXT NOT NULL CHECK (reservation_hash ~ '^[0-9a-f]{64}$'),
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind = 'hosted_persona_v1'),
  family TEXT NOT NULL CHECK (family = 'hns'),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  display_identifier TEXT NOT NULL,
  pricing_revision BIGINT NOT NULL,
  pricing_hash TEXT NOT NULL CHECK (pricing_hash ~ '^[0-9a-f]{64}$'),
  atomic_amount NUMERIC(78, 0) NOT NULL CHECK (atomic_amount = 0),
  payment_status TEXT NOT NULL CHECK (payment_status = 'not_applicable'),
  state TEXT NOT NULL CHECK (
    state IN ('issuance_pending', 'issued', 'blocked', 'issuance_failed')
  ),
  safe_reason TEXT,
  issuance_operation_id TEXT NOT NULL UNIQUE,
  grant_finalize_hash TEXT NOT NULL CHECK (grant_finalize_hash ~ '^[0-9a-f]{64}$'),
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_claim_owner_fk FOREIGN KEY (
    actor_account_id,
    owner_persona_id
  ) REFERENCES personas (account_id, persona_id),
  CONSTRAINT handle_claim_state_shape CHECK (
    (state = 'issued' AND grant_id IS NOT NULL AND safe_reason IS NULL)
    OR (state = 'issuance_pending' AND grant_id IS NULL AND safe_reason = 'issuance_pending')
    OR (state IN ('blocked', 'issuance_failed')
      AND grant_id IS NULL
      AND is_handle_sales_identifier_v1(safe_reason, 64))
  )
);

CREATE TABLE handle_claim_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template = '/handle-claims'),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  claim_id TEXT NOT NULL REFERENCES handle_claims (claim_id),
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_claim_action_replay_unique UNIQUE (
    actor_account_id,
    endpoint_template,
    idempotency_key
  )
);

CREATE TABLE handle_grants (
  grant_id TEXT PRIMARY KEY,
  grant_generation BIGINT NOT NULL CHECK (grant_generation = 1),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  offering_id TEXT NOT NULL,
  offering_hash TEXT NOT NULL CHECK (offering_hash ~ '^[0-9a-f]{64}$'),
  claim_id TEXT NOT NULL UNIQUE REFERENCES handle_claims (claim_id),
  owner_account_id TEXT NOT NULL REFERENCES users (user_id),
  owner_persona_id TEXT NOT NULL,
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_generation BIGINT NOT NULL,
  fulfillment_kind TEXT NOT NULL CHECK (fulfillment_kind = 'hosted_persona_v1'),
  family TEXT NOT NULL CHECK (family = 'hns'),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  display_identifier TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'tombstoned')),
  issued_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT handle_grant_owner_fk FOREIGN KEY (
    owner_account_id,
    owner_persona_id
  ) REFERENCES personas (account_id, persona_id),
  CONSTRAINT handle_grant_key_permanent_unique UNIQUE (
    family,
    namespace_root,
    handle_label
  )
);

ALTER TABLE handle_key_fences
  ADD CONSTRAINT handle_key_fence_permanent_grant_fk
  FOREIGN KEY (permanent_grant_id) REFERENCES handle_grants (grant_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE handle_claims
  ADD CONSTRAINT handle_claim_grant_fk
  FOREIGN KEY (grant_id) REFERENCES handle_grants (grant_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE handle_account_offering_grant_counters (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  offering_id TEXT NOT NULL,
  active_grant_count BIGINT NOT NULL DEFAULT 0 CHECK (active_grant_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, offering_id)
);

CREATE INDEX handle_grants_persona_public_idx
  ON handle_grants (owner_persona_id, issued_at DESC, grant_id DESC)
  WHERE status = 'active';

CREATE INDEX handle_claims_owner_idx
  ON handle_claims (actor_account_id, created_at DESC, claim_id DESC);

CREATE FUNCTION validate_handle_quote_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = NEW.offering_id
     AND offering_revision = NEW.offering_revision
   FOR SHARE;
  IF offering.offering_id IS NULL
    OR offering.offering_hash <> NEW.offering_hash
    OR offering.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR offering.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR offering.fulfillment_kind <> NEW.fulfillment_kind
    OR offering.family <> NEW.family
    OR offering.namespace_root <> NEW.namespace_root
    OR offering.display_root <> NEW.display_root
    OR offering.pricing_id <> NEW.pricing_id
    OR offering.pricing_revision <> NEW.pricing_revision
    OR offering.pricing_hash <> NEW.pricing_hash
    OR offering.atomic_amount <> NEW.atomic_amount
    OR offering.qualification_policy_revision <> NEW.eligibility_policy_revision
    OR offering.qualification_policy_hash <> NEW.eligibility_policy_hash
    OR NEW.status <> 'quoted'
    OR NEW.expires_at <> NEW.quoted_at + make_interval(secs => offering.quote_ttl_seconds)
    OR NEW.display_identifier <> NEW.handle_label || '.' || offering.display_root
    OR NOT (
      (offering.label_scope_kind = 'exact_label_v2' AND offering.exact_label = NEW.handle_label)
      OR (offering.label_scope_kind = 'label_rule_v2'
        AND octet_length(NEW.handle_label)
            BETWEEN offering.min_label_length AND offering.max_label_length)
    ) THEN
    RAISE EXCEPTION 'handle quote does not match its immutable offering';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_quote_insert_guard
BEFORE INSERT ON handle_quotes
FOR EACH ROW EXECUTE FUNCTION validate_handle_quote_insert_v2();

CREATE FUNCTION validate_handle_reservation_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quote handle_quotes%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  SELECT * INTO quote FROM handle_quotes WHERE quote_id = NEW.quote_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = quote.offering_id
     AND offering_revision = quote.offering_revision
   FOR SHARE;
  IF quote.quote_id IS NULL
    OR quote.status <> 'quoted'
    OR quote.quote_hash <> NEW.quote_hash
    OR quote.actor_account_id <> NEW.actor_account_id
    OR quote.owner_persona_id <> NEW.owner_persona_id
    OR quote.offering_id <> NEW.offering_id
    OR quote.offering_hash <> NEW.offering_hash
    OR quote.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR quote.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR quote.fulfillment_kind <> NEW.fulfillment_kind
    OR quote.family <> NEW.family
    OR quote.namespace_root <> NEW.namespace_root
    OR quote.handle_label <> NEW.handle_label
    OR NEW.status <> 'reserved'
    OR NEW.expires_at <> NEW.reserved_at + make_interval(secs => offering.reservation_ttl_seconds)
    OR NEW.reserved_at >= quote.expires_at THEN
    RAISE EXCEPTION 'handle reservation does not match its immutable quote';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_reservation_insert_guard
BEFORE INSERT ON handle_reservations
FOR EACH ROW EXECUTE FUNCTION validate_handle_reservation_insert_v2();

CREATE FUNCTION validate_handle_claim_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation handle_reservations%ROWTYPE;
  quote handle_quotes%ROWTYPE;
BEGIN
  SELECT * INTO reservation
    FROM handle_reservations
   WHERE reservation_id = NEW.reservation_id
   FOR SHARE;
  SELECT * INTO quote FROM handle_quotes WHERE quote_id = reservation.quote_id FOR SHARE;
  IF reservation.reservation_id IS NULL
    OR reservation.status <> 'reserved'
    OR reservation.reservation_hash <> NEW.reservation_hash
    OR reservation.actor_account_id <> NEW.actor_account_id
    OR reservation.owner_persona_id <> NEW.owner_persona_id
    OR reservation.quote_id <> NEW.quote_id
    OR reservation.offering_id <> NEW.offering_id
    OR reservation.offering_hash <> NEW.offering_hash
    OR reservation.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR reservation.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR reservation.fulfillment_kind <> NEW.fulfillment_kind
    OR reservation.family <> NEW.family
    OR reservation.namespace_root <> NEW.namespace_root
    OR reservation.handle_label <> NEW.handle_label
    OR quote.display_identifier <> NEW.display_identifier
    OR quote.pricing_revision <> NEW.pricing_revision
    OR quote.pricing_hash <> NEW.pricing_hash
    OR quote.atomic_amount <> NEW.atomic_amount THEN
    RAISE EXCEPTION 'handle claim does not match its immutable reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_claim_insert_guard
BEFORE INSERT ON handle_claims
FOR EACH ROW EXECUTE FUNCTION validate_handle_claim_insert_v2();

CREATE FUNCTION validate_handle_grant_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = claim.offering_id
     AND offering_hash = claim.offering_hash
   FOR SHARE;
  IF claim.claim_id IS NULL
    OR claim.state <> 'issued'
    OR claim.grant_id <> NEW.grant_id
    OR offering.community_id <> NEW.community_id
    OR claim.actor_account_id <> NEW.owner_account_id
    OR claim.owner_persona_id <> NEW.owner_persona_id
    OR claim.offering_id <> NEW.offering_id
    OR claim.offering_hash <> NEW.offering_hash
    OR claim.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR claim.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR claim.fulfillment_kind <> NEW.fulfillment_kind
    OR claim.family <> NEW.family
    OR claim.namespace_root <> NEW.namespace_root
    OR claim.handle_label <> NEW.handle_label
    OR claim.display_identifier <> NEW.display_identifier
    OR NEW.status <> 'active'
    OR NEW.issued_at <> claim.created_at THEN
    RAISE EXCEPTION 'handle grant does not match its immutable claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_grant_insert_guard
BEFORE INSERT ON handle_grants
FOR EACH ROW EXECUTE FUNCTION validate_handle_grant_insert_v2();

CREATE FUNCTION guard_handle_quote_change_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR to_jsonb(NEW) - ARRAY['status','consumed_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','consumed_at']
    OR OLD.status <> 'quoted'
    OR NEW.status NOT IN ('consumed','expired') THEN
    RAISE EXCEPTION 'handle quote transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_quote_change_guard
BEFORE UPDATE OR DELETE ON handle_quotes
FOR EACH ROW EXECUTE FUNCTION guard_handle_quote_change_v2();

CREATE FUNCTION guard_handle_reservation_change_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR to_jsonb(NEW) - ARRAY['status','transitioned_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','transitioned_at']
    OR OLD.status <> 'reserved'
    OR NEW.status NOT IN ('consumed','expired','cancelled','blocked') THEN
    RAISE EXCEPTION 'handle reservation transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_reservation_change_guard
BEFORE UPDATE OR DELETE ON handle_reservations
FOR EACH ROW EXECUTE FUNCTION guard_handle_reservation_change_v2();

CREATE FUNCTION guard_handle_grant_change_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR to_jsonb(NEW) - ARRAY['status','updated_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','updated_at']
    OR OLD.status <> 'active'
    OR NEW.status NOT IN ('revoked','tombstoned')
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'handle grant transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_grant_change_guard
BEFORE UPDATE OR DELETE ON handle_grants
FOR EACH ROW EXECUTE FUNCTION guard_handle_grant_change_v2();

CREATE FUNCTION decrement_handle_account_offering_grant_counter_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE handle_account_offering_grant_counters
     SET active_grant_count = active_grant_count - 1,
         updated_at = NEW.updated_at
   WHERE account_id = OLD.owner_account_id
     AND offering_id = OLD.offering_id
     AND active_grant_count > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active handle grant counter is missing';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_grant_counter_decrement
AFTER UPDATE OF status ON handle_grants
FOR EACH ROW
WHEN (OLD.status = 'active' AND NEW.status IN ('revoked', 'tombstoned'))
EXECUTE FUNCTION decrement_handle_account_offering_grant_counter_v1();

CREATE FUNCTION guard_handle_recipient_token_update_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF to_jsonb(NEW) - ARRAY[
       'token_ciphertext','token_envelope_key_version','status','superseded_at','consumed_at',
       'consumed_by_seller_account_id','consuming_idempotency_key','qualification_policy_id',
       'policy_request_hash'
     ] IS DISTINCT FROM to_jsonb(OLD) - ARRAY[
       'token_ciphertext','token_envelope_key_version','status','superseded_at','consumed_at',
       'consumed_by_seller_account_id','consuming_idempotency_key','qualification_policy_id',
       'policy_request_hash'
     ]
    OR OLD.status <> 'current'
    OR NEW.status NOT IN ('superseded','consumed') THEN
    RAISE EXCEPTION 'handle recipient-token transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_recipient_token_update_guard
BEFORE UPDATE ON handle_direct_grant_recipient_tokens
FOR EACH ROW EXECUTE FUNCTION guard_handle_recipient_token_update_v1();

CREATE FUNCTION guard_handle_recipient_token_action_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1
        FROM handle_direct_grant_recipient_tokens AS token
       WHERE token.token_id = OLD.token_id
    ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'handle recipient-token action is append-only';
END;
$$;

CREATE FUNCTION guard_handle_persona_link_confirmation_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR to_jsonb(NEW) - ARRAY['status','consumed_at','consumed_by_quote_id']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status','consumed_at','consumed_by_quote_id']
    OR OLD.status <> 'available'
    OR NEW.status NOT IN ('consumed','expired') THEN
    RAISE EXCEPTION 'handle persona-link confirmation transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_persona_link_confirmation_change_guard
BEFORE UPDATE OR DELETE ON handle_persona_link_confirmations
FOR EACH ROW EXECUTE FUNCTION guard_handle_persona_link_confirmation_change_v1();

CREATE FUNCTION advance_handle_linkage_after_grant_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM advance_handle_persona_public_linkage_v1(
    NEW.owner_persona_id,
    NEW.issued_at
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_grant_public_linkage_advance
AFTER INSERT ON handle_grants
FOR EACH ROW EXECUTE FUNCTION advance_handle_linkage_after_grant_v1();

CREATE FUNCTION reject_handle_sales_append_only_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'handle-sales revision or action is append-only';
END;
$$;

CREATE TRIGGER handle_account_directory_bindings_append_only
BEFORE UPDATE OR DELETE ON handle_account_directory_bindings
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_reserved_label_revisions_append_only
BEFORE UPDATE OR DELETE ON handle_reserved_label_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_pricing_revisions_append_only
BEFORE UPDATE OR DELETE ON handle_pricing_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_issuance_driver_revisions_append_only
BEFORE UPDATE OR DELETE ON handle_issuance_driver_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_qualification_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON handle_qualification_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_direct_grant_recipient_token_actions_append_only
BEFORE UPDATE OR DELETE ON handle_direct_grant_recipient_token_actions
FOR EACH ROW EXECUTE FUNCTION guard_handle_recipient_token_action_change_v1();

CREATE TRIGGER handle_qualification_policy_actions_append_only
BEFORE UPDATE OR DELETE ON handle_qualification_policy_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER community_handle_offering_revisions_append_only
BEFORE UPDATE OR DELETE ON community_handle_offering_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER community_handle_offering_actions_append_only
BEFORE UPDATE OR DELETE ON community_handle_offering_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_persona_link_confirmation_actions_append_only
BEFORE UPDATE OR DELETE ON handle_persona_link_confirmation_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_quote_actions_append_only
BEFORE UPDATE OR DELETE ON handle_quote_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_reservation_actions_append_only
BEFORE UPDATE OR DELETE ON handle_reservation_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER handle_claim_actions_append_only
BEFORE UPDATE OR DELETE ON handle_claim_actions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();
