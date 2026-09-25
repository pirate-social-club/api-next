-- Native Spaces sale-namespace activation, members-only qualification, operator
-- assignment facts, and persona Taproot recipient storage.
--
-- Spec 012 §5.3.13.2-§5.3.13.4 and §5.3.13.12, Spec 014 §12.4-§12.5. Every
-- composition stays disabled: the Spaces issuance driver revision is seeded
-- disabled, no root enablement row exists, and no network is configured, so no
-- Spaces activation, offering, or Taproot assignment can be written until an
-- authorized operator records those facts. Every HNS predicate, branch, and
-- seed is preserved verbatim.

-- One Spaces network per database (§5.3.13.3). Every Spaces fact references the
-- single configured network, so no database can hold Spaces state for two
-- networks and the (family, canonical_root) activation uniqueness stays
-- sufficient. The row is written by an authorized operator, never by migration.
CREATE TABLE spaces_network_configuration (
  configuration_key TEXT PRIMARY KEY CHECK (configuration_key = 'spaces_network_v1'),
  network TEXT NOT NULL UNIQUE CHECK (network IN ('mainnet', 'testnet4', 'regtest')),
  configured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER spaces_network_configuration_append_only
BEFORE UPDATE OR DELETE ON spaces_network_configuration
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Members-only qualification (§5.3.13.12). Each hash is SHA-256 of the compact
-- UTF-8 JSON array under the §5.1.8 byte rule.
CREATE FUNCTION handle_spaces_membership_source_hash_v1(input_source_revision BIGINT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT encode(
    sha256(convert_to(
      '["pirate-handle-spaces-membership-source-v1","spec-016-active-membership-v1",'
        || input_source_revision::TEXT
        || ']',
      'UTF8'
    )),
    'hex'
  )
$$;

CREATE FUNCTION handle_spaces_membership_policy_hash_v1(
  input_policy_id TEXT,
  input_policy_revision BIGINT,
  input_requirement_id TEXT,
  input_requirement_revision BIGINT,
  input_source_revision BIGINT,
  input_source_hash TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT encode(
    sha256(convert_to(
      '["pirate-handle-spaces-membership-policy-v1",'
        || to_json(input_policy_id)::TEXT || ','
        || input_policy_revision::TEXT
        || ',["community_membership_v1",'
        || to_json(input_requirement_id)::TEXT || ','
        || input_requirement_revision::TEXT
        || '],["membership_source_v1",'
        || input_source_revision::TEXT || ','
        || to_json(input_source_hash)::TEXT
        || ']]',
      'UTF8'
    )),
    'hex'
  )
$$;

-- The versioned local Spec 016 active-membership predicate. The current
-- revision is the highest one; a stale revision cannot inherit new meaning.
CREATE TABLE handle_spaces_membership_source_revisions (
  source_revision BIGINT PRIMARY KEY CHECK (
    source_revision BETWEEN 1 AND 9007199254740991
  ),
  source_id TEXT NOT NULL CHECK (source_id = 'spec-016-active-membership-v1'),
  source_hash TEXT NOT NULL UNIQUE CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT handle_spaces_membership_source_hash_check CHECK (
    source_hash = handle_spaces_membership_source_hash_v1(source_revision)
  )
);

CREATE TRIGGER handle_spaces_membership_source_revisions_append_only
BEFORE UPDATE OR DELETE ON handle_spaces_membership_source_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

INSERT INTO handle_spaces_membership_source_revisions (
  source_revision,
  source_id,
  source_hash
) VALUES (
  1,
  'spec-016-active-membership-v1',
  '19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75'
);

-- The private spaces_membership_v1 record carries exactly one
-- community_membership_v1 requirement and one membership_source_v1 binding.
-- Its public reference keeps the five-member curated_policy_v1 shape, whose
-- provider_binding_hash member binds the local membership source.
ALTER TABLE handle_qualification_policy_revisions
  DROP CONSTRAINT handle_qualification_policy_revisions_policy_kind_check,
  ADD CONSTRAINT handle_qualification_policy_revisions_policy_kind_check
    CHECK (policy_kind IN (
      'none_v1','curated_policy_v1','curated_nationality_v1','spaces_membership_v1'
    )),
  DROP CONSTRAINT handle_qualification_policy_shape;

ALTER TABLE handle_qualification_policy_revisions
  ADD CONSTRAINT handle_qualification_policy_shape CHECK (
    ((((policy_kind = 'none_v1'::text) AND (community_id IS NULL) AND (requirement_id IS NULL) AND (requirement_revision IS NULL) AND (requirement_kind IS NULL) AND (subject_account_id IS NULL) AND (provider_binding_kind IS NULL) AND (provider_binding_version IS NULL) AND (provider_binding_hash IS NULL) AND (created_by_account_id IS NULL)) OR ((policy_kind = 'curated_policy_v1'::text) AND (community_id IS NOT NULL) AND is_handle_sales_identifier_v1(requirement_id, 128) AND (requirement_revision = 1) AND (requirement_kind = 'account_allowlist_v1'::text) AND (subject_account_id IS NOT NULL) AND (provider_binding_kind = 'account_directory_v1'::text) AND is_handle_sales_identifier_v1(provider_binding_version, 128) AND (provider_binding_hash ~ '^[0-9a-f]{64}$'::text) AND (created_by_account_id IS NOT NULL))) AND nationality_policy IS NULL)
    OR ((policy_kind='curated_nationality_v1' AND community_id IS NOT NULL
      AND created_by_account_id IS NOT NULL AND policy_revision > 0
      AND requirement_kind='nationality_allowed_v1'
      AND requirement_id IS NULL AND requirement_revision IS NULL
      AND subject_account_id IS NULL AND provider_binding_kind IS NULL
      AND provider_binding_version IS NULL AND provider_binding_hash IS NULL
      AND jsonb_typeof(nationality_policy)='object'
      AND nationality_policy->>'policy_version_id'='curated-nationality-v1'
      AND nationality_policy->>'policy_hash'=policy_hash
      AND (nationality_policy->>'policy_revision')::bigint=policy_revision
      AND nationality_policy->>'requirement_hash' ~ '^[0-9a-f]{64}$'
      AND nationality_policy->>'required_assurance'='document_zk'
      AND nationality_policy->'requirement'->>'claim_id'='nationality.allowed'
      AND jsonb_typeof(nationality_policy->'requirement'->'allowed_countries')='array'
      AND jsonb_array_length(nationality_policy->'requirement'->'allowed_countries') BETWEEN 1 AND 256
      AND nationality_policy->'evidence_lifetime'->>'kind'='max_age_seconds'
      AND (nationality_policy->'evidence_lifetime'->>'seconds')::bigint BETWEEN 1 AND 9007199254740991
      AND jsonb_array_length(nationality_policy->'provider_bindings')=2
      AND nationality_policy->'provider_bindings'->0->>'provider_id'='self.pass'
      AND nationality_policy->'provider_bindings'->1->>'provider_id'='zkpassport') IS TRUE)
    OR ((policy_kind = 'spaces_membership_v1'
      AND community_id IS NULL
      AND created_by_account_id IS NULL
      AND subject_account_id IS NULL
      AND nationality_policy IS NULL
      AND is_handle_sales_identifier_v1(policy_id, 128)
      AND policy_revision BETWEEN 1 AND 9007199254740991
      AND is_handle_sales_identifier_v1(requirement_id, 128)
      AND requirement_revision BETWEEN 1 AND 9007199254740991
      AND requirement_kind = 'community_membership_v1'
      AND provider_binding_kind = 'membership_source_v1'
      AND CASE
        WHEN provider_binding_version ~ '^[1-9][0-9]{0,15}$' THEN
          provider_binding_hash = handle_spaces_membership_source_hash_v1(
            provider_binding_version::BIGINT
          )
          AND policy_hash = handle_spaces_membership_policy_hash_v1(
            policy_id,
            policy_revision,
            requirement_id,
            requirement_revision,
            provider_binding_version::BIGINT,
            provider_binding_hash
          )
        ELSE FALSE
      END
      AND request_hash = policy_hash) IS TRUE)
  );

CREATE FUNCTION guard_handle_spaces_membership_policy_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.policy_kind <> 'spaces_membership_v1' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM handle_spaces_membership_source_revisions AS source
     WHERE source.source_revision::TEXT = NEW.provider_binding_version
       AND source.source_hash = NEW.provider_binding_hash
  ) THEN
    RAISE EXCEPTION 'Spaces membership policy requires a recorded membership source revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_spaces_membership_policy_insert_guard
BEFORE INSERT ON handle_qualification_policy_revisions
FOR EACH ROW EXECUTE FUNCTION guard_handle_spaces_membership_policy_insert_v1();

-- The platform-global Spaces first-come policy (ruling Q8). It names no
-- account or community; each offering binds its own community.
INSERT INTO handle_qualification_policy_revisions (
  policy_id,
  policy_revision,
  community_id,
  policy_kind,
  request_hash,
  policy_hash,
  requirement_id,
  requirement_revision,
  requirement_kind,
  subject_account_id,
  provider_binding_kind,
  provider_binding_version,
  provider_binding_hash,
  status,
  created_by_account_id,
  created_at,
  nationality_policy
) VALUES (
  'qualification_policy_spaces_members_01',
  1,
  NULL,
  'spaces_membership_v1',
  'f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482',
  'f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482',
  'requirement_spaces_membership_01',
  1,
  'community_membership_v1',
  NULL,
  'membership_source_v1',
  '1',
  '19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75',
  'active',
  NULL,
  clock_timestamp(),
  NULL
);

-- The Spaces reserved-label document starts as a copy of the HNS list (Q8).
ALTER TABLE handle_reserved_label_revisions
  DROP CONSTRAINT handle_reserved_label_revisions_family_check,
  ADD CONSTRAINT handle_reserved_label_revisions_family_check
    CHECK (family IN ('hns', 'spaces'));

WITH document AS (
  SELECT '["pirate-handle-reserved-labels-v1","reserved_labels_spaces_01",1,"spaces",["abuse","admin","api","app","auth","billing","blog","cdn","dev","docs","gateway","help","hns","login","logout","mail","mod","moderator","new","official","pirate","root","security","settings","staff","staging","status","support","system","www"],[]]'::TEXT AS bytes
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
SELECT 'reserved_labels_spaces_01',
       1,
       encode(sha256(convert_to(document.bytes, 'UTF8')), 'hex'),
       'spaces',
       ARRAY[
         'abuse','admin','api','app','auth','billing','blog','cdn','dev','docs',
         'gateway','help','hns','login','logout','mail','mod','moderator','new',
         'official','pirate','root','security','settings','staff','staging',
         'status','support','system','www'
       ]::TEXT[],
       ARRAY[]::TEXT[],
       'active'
  FROM document;

-- The Spaces issuance driver revision is registered disabled (§5.3.13.12).
-- Enablement is scoped to one root (ruling Q3), never a global status flip.
ALTER TABLE handle_issuance_driver_revisions
  ADD CONSTRAINT handle_issuance_driver_family_fulfillment CHECK (
    (family = 'spaces') = (fulfillment_kind = 'spaces_native_v1')
  );

INSERT INTO handle_issuance_driver_revisions (
  family,
  driver_id,
  driver_version,
  fulfillment_kind,
  status
) VALUES ('spaces', 'spaces_native-local', '1', 'spaces_native_v1', 'disabled');

CREATE TABLE spaces_issuance_driver_root_enablements (
  enablement_id TEXT PRIMARY KEY,
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  canonical_root TEXT NOT NULL,
  driver_family TEXT NOT NULL CHECK (driver_family = 'spaces'),
  driver_id TEXT NOT NULL,
  driver_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  authorization_reference TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT spaces_driver_root_enablement_driver_fk FOREIGN KEY (
    driver_family,
    driver_id,
    driver_version
  ) REFERENCES handle_issuance_driver_revisions (family, driver_id, driver_version),
  CONSTRAINT spaces_driver_root_enablement_identity_check CHECK (
    is_handle_sales_identifier_v1(enablement_id, 128)
    AND is_community_route_root_label('spaces', canonical_root)
    AND is_handle_sales_identifier_v1(authorization_reference, 512)
  ),
  CONSTRAINT spaces_driver_root_enablement_status_shape CHECK (
    (status = 'enabled' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL AND disabled_at >= enabled_at)
  )
);

CREATE UNIQUE INDEX spaces_driver_root_enablement_live_uidx
  ON spaces_issuance_driver_root_enablements (network, canonical_root)
  WHERE status = 'enabled';

CREATE FUNCTION guard_spaces_issuance_driver_root_enablement_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  driver handle_issuance_driver_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces driver root enablement cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO driver
      FROM handle_issuance_driver_revisions
     WHERE family = NEW.driver_family
       AND driver_id = NEW.driver_id
       AND driver_version = NEW.driver_version
     FOR SHARE;
    IF driver.driver_id IS NULL
      OR driver.fulfillment_kind <> 'spaces_native_v1'
      OR driver.status = 'retired'
      OR NEW.status <> 'enabled' THEN
      RAISE EXCEPTION 'Spaces driver root enablement requires a live Spaces driver revision';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.enablement_id,
    NEW.network,
    NEW.canonical_root,
    NEW.driver_family,
    NEW.driver_id,
    NEW.driver_version,
    NEW.authorization_reference,
    NEW.enabled_at
  ) IS DISTINCT FROM ROW(
    OLD.enablement_id,
    OLD.network,
    OLD.canonical_root,
    OLD.driver_family,
    OLD.driver_id,
    OLD.driver_version,
    OLD.authorization_reference,
    OLD.enabled_at
  ) OR OLD.status <> 'enabled' OR NEW.status <> 'disabled' THEN
    RAISE EXCEPTION 'Spaces driver root enablement may only be disabled once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_driver_root_enablement_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON spaces_issuance_driver_root_enablements
FOR EACH ROW EXECUTE FUNCTION guard_spaces_issuance_driver_root_enablement_v1();

-- Spaces namespace-authority evidence (§5.3.13.3 item 2). Append-only. One
-- evidence reference continues per root; each generation records the live
-- root outpoint and key at an accepted anchor, the owner-signed challenge under
-- that key completed after the key last changed, successful publication
-- verification under that key, and the privately recorded controlling account.
-- The ceremony wire and envelope bytes are frozen by the implementing contract
-- checkpoint; the raw verifier bytes are retained privately here.
CREATE TABLE spaces_namespace_authority_evidence (
  namespace_authority_reference TEXT NOT NULL,
  namespace_authority_generation BIGINT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  canonical_root TEXT NOT NULL,
  display_root TEXT NOT NULL,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  controlling_account_id TEXT NOT NULL REFERENCES users (user_id),
  challenge_environment TEXT NOT NULL,
  challenge_nonce_digest TEXT NOT NULL CHECK (challenge_nonce_digest ~ '^[0-9a-f]{64}$'),
  root_outpoint TEXT NOT NULL CHECK (root_outpoint ~ '^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$'),
  root_key_hex TEXT NOT NULL CHECK (root_key_hex ~ '^[0-9a-f]{64}$'),
  anchor_block_hash TEXT NOT NULL CHECK (anchor_block_hash ~ '^[0-9a-f]{64}$'),
  anchor_height BIGINT NOT NULL CHECK (anchor_height BETWEEN 0 AND 9007199254740991),
  anchored_at TIMESTAMPTZ NOT NULL,
  key_last_changed_at TIMESTAMPTZ NOT NULL,
  challenge_completed_at TIMESTAMPTZ NOT NULL,
  publication_verified_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ NOT NULL,
  raw_verifier_evidence BYTEA NOT NULL CHECK (
    octet_length(raw_verifier_evidence) BETWEEN 1 AND 65536
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_namespace_authority_evidence_pk PRIMARY KEY (
    namespace_authority_reference,
    namespace_authority_generation
  ),
  CONSTRAINT spaces_namespace_authority_evidence_identity_check CHECK (
    is_handle_sales_identifier_v1(namespace_authority_reference, 512)
    AND namespace_authority_generation BETWEEN 1 AND 9007199254740991
    AND is_community_route_root_label('spaces', canonical_root)
    AND is_community_route_root_label_display(display_root)
    AND canonical_root <> 'pirate'
    AND is_handle_sales_identifier_v1(challenge_environment, 64)
  ),
  CONSTRAINT spaces_namespace_authority_evidence_time_order CHECK (
    challenge_completed_at > key_last_changed_at
    AND publication_verified_at >= key_last_changed_at
    AND anchored_at <= observed_at
    AND challenge_completed_at <= recorded_at
    AND publication_verified_at <= recorded_at
    AND observed_at <= recorded_at
    AND fresh_until > observed_at
  )
);

CREATE UNIQUE INDEX spaces_namespace_authority_evidence_root_uidx
  ON spaces_namespace_authority_evidence (network, canonical_root)
  WHERE namespace_authority_generation = 1;

CREATE FUNCTION guard_spaces_namespace_authority_evidence_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior spaces_namespace_authority_evidence%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('spaces-namespace-authority:' || NEW.network || ':' || NEW.canonical_root, 20202)
  );
  SELECT * INTO prior
    FROM spaces_namespace_authority_evidence
   WHERE namespace_authority_reference = NEW.namespace_authority_reference
   ORDER BY namespace_authority_generation DESC
   LIMIT 1
   FOR SHARE;
  IF prior.namespace_authority_reference IS NULL THEN
    IF NEW.namespace_authority_generation <> 1 THEN
      RAISE EXCEPTION 'Spaces namespace authority must begin at generation one';
    END IF;
    IF EXISTS (
      SELECT 1 FROM spaces_namespace_authority_evidence
       WHERE network = NEW.network AND canonical_root = NEW.canonical_root
    ) THEN
      RAISE EXCEPTION 'Spaces namespace authority continues one evidence reference per root';
    END IF;
  ELSIF NEW.namespace_authority_generation <> prior.namespace_authority_generation + 1
    OR NEW.network <> prior.network
    OR NEW.canonical_root <> prior.canonical_root
    OR NEW.display_root <> prior.display_root
    OR NEW.observed_at < prior.observed_at
    OR NEW.key_last_changed_at < prior.key_last_changed_at THEN
    RAISE EXCEPTION 'Spaces namespace authority generation or identity is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_namespace_authority_evidence_insert_guard
BEFORE INSERT ON spaces_namespace_authority_evidence
FOR EACH ROW EXECUTE FUNCTION guard_spaces_namespace_authority_evidence_insert_v1();

CREATE TRIGGER spaces_namespace_authority_evidence_append_only
BEFORE UPDATE OR DELETE ON spaces_namespace_authority_evidence
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Operator instances (§5.3.13.2). Registry credentials arrive with the
-- registry contract; an instance only scopes the assignments it serves.
CREATE TABLE spaces_operator_instances (
  operator_instance_id TEXT PRIMARY KEY,
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  CONSTRAINT spaces_operator_instance_identity_check CHECK (
    is_handle_sales_identifier_v1(operator_instance_id, 128)
  ),
  CONSTRAINT spaces_operator_instance_status_shape CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retired_at >= created_at)
  )
);

CREATE FUNCTION guard_spaces_operator_instance_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces operator instance cannot be deleted';
  END IF;
  IF NEW.operator_instance_id <> OLD.operator_instance_id
    OR NEW.network <> OLD.network
    OR NEW.created_at <> OLD.created_at
    OR OLD.status <> 'active'
    OR NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'Spaces operator instance may only be retired once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_instance_change_guard
BEFORE UPDATE OR DELETE ON spaces_operator_instances
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_instance_change_v1();

-- Operator assignments (§5.3.13.2 and §5.3.13.3 item 3). One dedicated wallet
-- receives the owner's delegation for one space and never serves another. A
-- new generation records a re-established delegation cycle; an operator change
-- is a new assignment.
CREATE TABLE spaces_operator_assignment_revisions (
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  canonical_root TEXT NOT NULL,
  operator_instance_id TEXT NOT NULL REFERENCES spaces_operator_instances (operator_instance_id),
  operator_wallet_reference TEXT NOT NULL,
  delegation_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_operator_assignment_revisions_pk PRIMARY KEY (
    operator_assignment_id,
    operator_assignment_generation
  ),
  CONSTRAINT spaces_operator_assignment_identity_check CHECK (
    is_handle_sales_identifier_v1(operator_assignment_id, 128)
    AND operator_assignment_generation BETWEEN 1 AND 9007199254740991
    AND is_community_route_root_label('spaces', canonical_root)
    AND is_handle_sales_identifier_v1(operator_wallet_reference, 256)
    AND delegation_address ~ '^[a-z0-9]{8,128}$'
    AND recorded_at >= created_at
  ),
  CONSTRAINT spaces_operator_assignment_status_shape CHECK (
    (status = 'active' AND reason_code IS NULL)
    OR (status = 'retired' AND is_handle_sales_identifier_v1(reason_code, 128))
  )
);

CREATE TABLE spaces_operator_assignment_current (
  operator_assignment_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  operator_wallet_reference TEXT NOT NULL UNIQUE,
  delegation_address TEXT NOT NULL UNIQUE,
  current_generation BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_operator_assignment_current_revision_fk FOREIGN KEY (
    operator_assignment_id,
    current_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX spaces_operator_assignment_live_root_uidx
  ON spaces_operator_assignment_current (network, canonical_root)
  WHERE status = 'active';

CREATE FUNCTION guard_spaces_operator_assignment_revision_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior spaces_operator_assignment_revisions%ROWTYPE;
  instance spaces_operator_instances%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('spaces-operator-assignment', 20202));
  SELECT * INTO instance
    FROM spaces_operator_instances
   WHERE operator_instance_id = NEW.operator_instance_id
   FOR SHARE;
  IF instance.operator_instance_id IS NULL
    OR instance.network <> NEW.network
    OR (NEW.status = 'active' AND instance.status <> 'active') THEN
    RAISE EXCEPTION 'Spaces operator assignment requires a live operator instance on its network';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM spaces_operator_assignment_revisions AS other
     WHERE other.operator_assignment_id <> NEW.operator_assignment_id
       AND (other.operator_wallet_reference = NEW.operator_wallet_reference
         OR other.delegation_address = NEW.delegation_address)
  ) THEN
    RAISE EXCEPTION 'a Spaces operator wallet serves exactly one space';
  END IF;
  SELECT * INTO prior
    FROM spaces_operator_assignment_revisions
   WHERE operator_assignment_id = NEW.operator_assignment_id
   ORDER BY operator_assignment_generation DESC
   LIMIT 1
   FOR SHARE;
  IF prior.operator_assignment_id IS NULL THEN
    IF NEW.operator_assignment_generation <> 1 OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Spaces operator assignment must begin active at generation one';
    END IF;
  ELSIF NEW.operator_assignment_generation <> prior.operator_assignment_generation + 1
    OR NEW.network <> prior.network
    OR NEW.canonical_root <> prior.canonical_root
    OR NEW.operator_instance_id <> prior.operator_instance_id
    OR NEW.operator_wallet_reference <> prior.operator_wallet_reference
    OR NEW.delegation_address <> prior.delegation_address
    OR NEW.created_at <> prior.created_at
    OR prior.status = 'retired' THEN
    RAISE EXCEPTION 'Spaces operator assignment identity and generation are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_assignment_revision_insert_guard
BEFORE INSERT ON spaces_operator_assignment_revisions
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_assignment_revision_insert_v1();

CREATE TRIGGER spaces_operator_assignment_revisions_append_only
BEFORE UPDATE OR DELETE ON spaces_operator_assignment_revisions
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE FUNCTION guard_spaces_operator_assignment_current_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision spaces_operator_assignment_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces operator assignment current state cannot be deleted';
  END IF;
  SELECT * INTO revision
    FROM spaces_operator_assignment_revisions
   WHERE operator_assignment_id = NEW.operator_assignment_id
     AND operator_assignment_generation = NEW.current_generation;
  IF revision.operator_assignment_id IS NULL
    OR revision.network <> NEW.network
    OR revision.canonical_root <> NEW.canonical_root
    OR revision.operator_wallet_reference <> NEW.operator_wallet_reference
    OR revision.delegation_address <> NEW.delegation_address
    OR revision.status <> NEW.status THEN
    RAISE EXCEPTION 'Spaces operator assignment current revision does not match';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.operator_assignment_id <> OLD.operator_assignment_id
    OR NEW.network <> OLD.network
    OR NEW.canonical_root <> OLD.canonical_root
    OR NEW.operator_wallet_reference <> OLD.operator_wallet_reference
    OR NEW.delegation_address <> OLD.delegation_address
    OR NEW.current_generation <> OLD.current_generation + 1
    OR NEW.updated_at <= OLD.updated_at
    OR OLD.status = 'retired'
  ) THEN
    RAISE EXCEPTION 'Spaces operator assignment current generation is fenced';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_assignment_current_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON spaces_operator_assignment_current
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_assignment_current_change_v1();

-- Per-assignment deployment records (§5.3.13.12): the upstream operator
-- revision, node version, prover image digest, and adapter revision an
-- assignment was accepted against. Append-only.
CREATE TABLE spaces_operator_deployment_records (
  operator_assignment_id TEXT NOT NULL,
  deployment_generation BIGINT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  driver_family TEXT NOT NULL CHECK (driver_family = 'spaces'),
  driver_id TEXT NOT NULL,
  driver_version TEXT NOT NULL,
  upstream_operator_revision TEXT NOT NULL,
  node_version TEXT NOT NULL,
  prover_image_digest TEXT NOT NULL CHECK (prover_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  adapter_revision TEXT NOT NULL,
  acceptance_reference TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_operator_deployment_records_pk PRIMARY KEY (
    operator_assignment_id,
    deployment_generation
  ),
  CONSTRAINT spaces_operator_deployment_assignment_fk FOREIGN KEY (
    operator_assignment_id,
    operator_assignment_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  ),
  CONSTRAINT spaces_operator_deployment_driver_fk FOREIGN KEY (
    driver_family,
    driver_id,
    driver_version
  ) REFERENCES handle_issuance_driver_revisions (family, driver_id, driver_version),
  CONSTRAINT spaces_operator_deployment_identity_check CHECK (
    is_handle_sales_identifier_v1(upstream_operator_revision, 128)
    AND deployment_generation BETWEEN 1 AND 9007199254740991
    AND is_handle_sales_identifier_v1(node_version, 128)
    AND is_handle_sales_identifier_v1(adapter_revision, 128)
    AND is_handle_sales_identifier_v1(acceptance_reference, 512)
    AND recorded_at >= accepted_at
  )
);

CREATE FUNCTION guard_spaces_operator_deployment_record_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_generation BIGINT;
BEGIN
  SELECT max(deployment_generation) INTO prior_generation
    FROM spaces_operator_deployment_records
   WHERE operator_assignment_id = NEW.operator_assignment_id;
  IF NEW.deployment_generation <> COALESCE(prior_generation, 0) + 1 THEN
    RAISE EXCEPTION 'Spaces operator deployment generation is not contiguous';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_operator_deployment_record_insert_guard
BEFORE INSERT ON spaces_operator_deployment_records
FOR EACH ROW EXECUTE FUNCTION guard_spaces_operator_deployment_record_insert_v1();

CREATE TRIGGER spaces_operator_deployment_records_append_only
BEFORE UPDATE OR DELETE ON spaces_operator_deployment_records
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Readiness observations (§5.3.13.3 item 3 and §5.3.13.4). Chain facts come
-- from a node independent of the operator host that answers delegation and
-- commitment-history queries. An observation is usable only until its
-- freshness bound; an unobserved or stale fact never counts as satisfied.
CREATE TABLE spaces_root_observations (
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  canonical_root TEXT NOT NULL,
  observation_generation BIGINT NOT NULL,
  observer_reference TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ NOT NULL,
  root_state TEXT NOT NULL CHECK (root_state IN ('resolved', 'unresolved')),
  root_outpoint TEXT,
  root_key_hex TEXT,
  anchored_at TIMESTAMPTZ,
  anchor_state TEXT,
  publication_state TEXT,
  delegation_address TEXT,
  commitment_history_state TEXT NOT NULL CHECK (
    commitment_history_state IN ('verified', 'unverified')
  ),
  commitment_count BIGINT,
  latest_commitment_root_hex TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_root_observations_pk PRIMARY KEY (
    network,
    canonical_root,
    observation_generation
  ),
  CONSTRAINT spaces_root_observation_identity_check CHECK (
    is_community_route_root_label('spaces', canonical_root)
    AND observation_generation BETWEEN 1 AND 9007199254740991
    AND is_handle_sales_identifier_v1(observer_reference, 256)
    AND fresh_until > observed_at
    AND observed_at <= recorded_at
  ),
  CONSTRAINT spaces_root_observation_shape CHECK (
    ((root_state = 'resolved'
      AND root_outpoint ~ '^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$'
      AND root_key_hex ~ '^[0-9a-f]{64}$'
      AND anchored_at <= observed_at
      AND anchor_state IN ('covers_root_outpoint', 'pending', 'stale')
      AND publication_state IN ('verified', 'failed')
      AND (delegation_address IS NULL
        OR delegation_address ~ '^[a-z0-9]{8,128}$')) IS TRUE)
    OR ((root_state = 'unresolved'
      AND root_outpoint IS NULL
      AND root_key_hex IS NULL
      AND anchored_at IS NULL
      AND anchor_state IS NULL
      AND publication_state IS NULL
      AND delegation_address IS NULL
      AND commitment_history_state = 'unverified') IS TRUE)
  ),
  CONSTRAINT spaces_root_observation_history_shape CHECK (
    ((commitment_history_state = 'verified'
      AND commitment_count BETWEEN 0 AND 9007199254740991
      AND (latest_commitment_root_hex ~ '^[0-9a-f]{64}$'
        OR (commitment_count = 0 AND latest_commitment_root_hex IS NULL))) IS TRUE)
    OR (commitment_history_state = 'unverified'
      AND commitment_count IS NULL
      AND latest_commitment_root_hex IS NULL)
  )
);

CREATE TABLE spaces_operator_capability_observations (
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  observation_generation BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  fresh_until TIMESTAMPTZ NOT NULL,
  capability_state TEXT NOT NULL CHECK (capability_state IN ('observed', 'absent')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_operator_capability_observations_pk PRIMARY KEY (
    operator_assignment_id,
    operator_assignment_generation,
    observation_generation
  ),
  CONSTRAINT spaces_operator_capability_assignment_fk FOREIGN KEY (
    operator_assignment_id,
    operator_assignment_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  ),
  CONSTRAINT spaces_operator_capability_observation_check CHECK (
    fresh_until > observed_at
    AND observation_generation BETWEEN 1 AND 9007199254740991
    AND observed_at <= recorded_at
  )
);

-- Commit fees come only from the space's confirmed balance (§5.3.13.2).
-- Unconfirmed deposits never count, and a pause never fails a claim.
CREATE TABLE spaces_operator_funding_observations (
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  observation_generation BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  confirmed_balance_sats NUMERIC(20, 0) NOT NULL CHECK (confirmed_balance_sats >= 0),
  next_commit_fee_sats NUMERIC(20, 0) NOT NULL CHECK (next_commit_fee_sats >= 0),
  funding_status TEXT NOT NULL CHECK (
    funding_status IN ('funded_v1', 'commits_paused_insufficient_funds_v1')
  ),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_operator_funding_observations_pk PRIMARY KEY (
    operator_assignment_id,
    operator_assignment_generation,
    observation_generation
  ),
  CONSTRAINT spaces_operator_funding_assignment_fk FOREIGN KEY (
    operator_assignment_id,
    operator_assignment_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  ),
  CONSTRAINT spaces_operator_funding_observation_check CHECK (
    observed_at <= recorded_at
    AND observation_generation BETWEEN 1 AND 9007199254740991
    AND (funding_status = 'funded_v1') = (confirmed_balance_sats >= next_commit_fee_sats)
  )
);

CREATE FUNCTION guard_spaces_observation_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_generation BIGINT;
  prior_observed_at TIMESTAMPTZ;
BEGIN
  IF TG_TABLE_NAME = 'spaces_root_observations' THEN
    SELECT observation.observation_generation, observation.observed_at
      INTO prior_generation, prior_observed_at
      FROM spaces_root_observations AS observation
     WHERE observation.network = NEW.network
       AND observation.canonical_root = NEW.canonical_root
     ORDER BY observation.observation_generation DESC
     LIMIT 1;
  ELSIF TG_TABLE_NAME = 'spaces_operator_capability_observations' THEN
    SELECT observation.observation_generation, observation.observed_at
      INTO prior_generation, prior_observed_at
      FROM spaces_operator_capability_observations AS observation
     WHERE observation.operator_assignment_id = NEW.operator_assignment_id
       AND observation.operator_assignment_generation = NEW.operator_assignment_generation
     ORDER BY observation.observation_generation DESC
     LIMIT 1;
  ELSE
    SELECT observation.observation_generation, observation.observed_at
      INTO prior_generation, prior_observed_at
      FROM spaces_operator_funding_observations AS observation
     WHERE observation.operator_assignment_id = NEW.operator_assignment_id
       AND observation.operator_assignment_generation = NEW.operator_assignment_generation
     ORDER BY observation.observation_generation DESC
     LIMIT 1;
  END IF;
  IF NEW.observation_generation <> COALESCE(prior_generation, 0) + 1
    OR NEW.observed_at < prior_observed_at THEN
    RAISE EXCEPTION 'Spaces observation is stale or out of order';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_root_observation_insert_guard
BEFORE INSERT ON spaces_root_observations
FOR EACH ROW EXECUTE FUNCTION guard_spaces_observation_insert_v1();

CREATE TRIGGER spaces_root_observations_append_only
BEFORE UPDATE OR DELETE ON spaces_root_observations
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER spaces_operator_capability_observation_insert_guard
BEFORE INSERT ON spaces_operator_capability_observations
FOR EACH ROW EXECUTE FUNCTION guard_spaces_observation_insert_v1();

CREATE TRIGGER spaces_operator_capability_observations_append_only
BEFORE UPDATE OR DELETE ON spaces_operator_capability_observations
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER spaces_operator_funding_observation_insert_guard
BEFORE INSERT ON spaces_operator_funding_observations
FOR EACH ROW EXECUTE FUNCTION guard_spaces_observation_insert_v1();

CREATE TRIGGER spaces_operator_funding_observations_append_only
BEFORE UPDATE OR DELETE ON spaces_operator_funding_observations
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Readiness is derived from current facts every time (§5.3.13.4). Each fact
-- is TRUE only when affirmatively observed; the reason order is the ratified
-- SpacesSaleReadinessReasonV1 order.
CREATE FUNCTION spaces_sale_namespace_readiness_facts_v1(
  input_network TEXT,
  input_canonical_root TEXT,
  input_community_id TEXT,
  input_namespace_authority_reference TEXT,
  input_namespace_authority_generation BIGINT,
  input_operator_assignment_id TEXT,
  input_operator_assignment_generation BIGINT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE (
  namespace_authority_current BOOLEAN,
  owner_challenge_current BOOLEAN,
  anchor_covers_root_outpoint BOOLEAN,
  publication_verified BOOLEAN,
  delegation_observed BOOLEAN,
  operator_capability_observed BOOLEAN,
  commitment_history_verified BOOLEAN,
  driver_enabled BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH evidence AS (
    SELECT candidate.*
      FROM spaces_namespace_authority_evidence AS candidate
     WHERE candidate.namespace_authority_reference = input_namespace_authority_reference
       AND candidate.namespace_authority_generation = input_namespace_authority_generation
       AND candidate.network = input_network
       AND candidate.canonical_root = input_canonical_root
       AND candidate.namespace_authority_generation = (
         SELECT max(latest.namespace_authority_generation)
           FROM spaces_namespace_authority_evidence AS latest
          WHERE latest.namespace_authority_reference = candidate.namespace_authority_reference
       )
  ),
  latest_observation AS (
    SELECT observation.*
      FROM spaces_root_observations AS observation
     WHERE observation.network = input_network
       AND observation.canonical_root = input_canonical_root
     ORDER BY observation.observation_generation DESC
     LIMIT 1
  ),
  observation AS (
    SELECT latest_observation.*
      FROM latest_observation
     WHERE latest_observation.fresh_until > database_now
  ),
  assignment AS (
    SELECT revision.*
      FROM spaces_operator_assignment_current AS current_assignment
      JOIN spaces_operator_assignment_revisions AS revision
        ON revision.operator_assignment_id = current_assignment.operator_assignment_id
       AND revision.operator_assignment_generation = current_assignment.current_generation
     WHERE current_assignment.operator_assignment_id = input_operator_assignment_id
       AND current_assignment.current_generation = input_operator_assignment_generation
       AND revision.status = 'active'
       AND revision.network = input_network
       AND revision.canonical_root = input_canonical_root
  ),
  capability AS (
    SELECT observation.*
      FROM spaces_operator_capability_observations AS observation
     WHERE observation.operator_assignment_id = input_operator_assignment_id
       AND observation.operator_assignment_generation = input_operator_assignment_generation
     ORDER BY observation.observation_generation DESC
     LIMIT 1
  )
  SELECT
    COALESCE((
      SELECT evidence.community_id = input_community_id
             AND evidence.fresh_until > database_now
             AND EXISTS (
               SELECT 1 FROM communities AS community
                WHERE community.community_id = input_community_id
                  AND community.status = 'active'
             )
             AND NOT EXISTS (
               SELECT 1 FROM observation
                WHERE observation.root_state = 'unresolved'
                   OR observation.anchor_state = 'stale'
             )
        FROM evidence
    ), FALSE),
    COALESCE((
      SELECT NOT EXISTS (
               SELECT 1 FROM observation
                WHERE observation.root_state = 'resolved'
                  AND observation.root_key_hex <> evidence.root_key_hex
             )
        FROM evidence
    ), FALSE),
    COALESCE((
      SELECT observation.root_state = 'resolved'
             AND observation.anchor_state = 'covers_root_outpoint'
        FROM observation
    ), FALSE),
    COALESCE((
      SELECT observation.publication_state = 'verified'
        FROM observation
    ), FALSE),
    COALESCE((
      SELECT observation.delegation_address = assignment.delegation_address
        FROM observation, assignment
    ), FALSE),
    COALESCE((
      SELECT capability.capability_state = 'observed'
             AND capability.fresh_until > database_now
        FROM capability, assignment
    ), FALSE),
    COALESCE((
      SELECT observation.commitment_history_state = 'verified'
        FROM observation
    ), FALSE),
    EXISTS (
      SELECT 1
        FROM spaces_issuance_driver_root_enablements AS enablement
        JOIN handle_issuance_driver_revisions AS driver
          ON driver.family = enablement.driver_family
         AND driver.driver_id = enablement.driver_id
         AND driver.driver_version = enablement.driver_version
       WHERE enablement.network = input_network
         AND enablement.canonical_root = input_canonical_root
         AND enablement.status = 'enabled'
         AND driver.fulfillment_kind = 'spaces_native_v1'
         AND driver.status <> 'retired'
    )
$$;

CREATE FUNCTION spaces_sale_namespace_readiness_reason_v1(
  input_network TEXT,
  input_canonical_root TEXT,
  input_community_id TEXT,
  input_namespace_authority_reference TEXT,
  input_namespace_authority_generation BIGINT,
  input_operator_assignment_id TEXT,
  input_operator_assignment_generation BIGINT,
  database_now TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN facts.namespace_authority_current IS NOT TRUE THEN 'namespace_authority_unavailable'
    WHEN facts.owner_challenge_current IS NOT TRUE THEN 'owner_challenge_required'
    WHEN facts.anchor_covers_root_outpoint IS NOT TRUE THEN 'anchor_pending'
    WHEN facts.publication_verified IS NOT TRUE THEN 'publication_unverified'
    WHEN facts.delegation_observed IS NOT TRUE THEN 'delegation_required'
    WHEN facts.operator_capability_observed IS NOT TRUE THEN 'operator_capability_unverified'
    WHEN facts.commitment_history_verified IS NOT TRUE THEN 'commitment_history_unverified'
    WHEN facts.driver_enabled IS NOT TRUE THEN 'driver_disabled'
    ELSE NULL
  END
    FROM spaces_sale_namespace_readiness_facts_v1(
      input_network,
      input_canonical_root,
      input_community_id,
      input_namespace_authority_reference,
      input_namespace_authority_generation,
      input_operator_assignment_id,
      input_operator_assignment_generation,
      database_now
    ) AS facts
$$;

-- The checked Spaces sibling of the HNS activation (§5.3.13.3). The Spaces
-- shape carries none of the HNS DNS-zone, root-replacement, or HNS
-- namespace-evidence columns, the HNS shape carries none of the Spaces
-- columns, and no placeholder fills a column of the other family. The HNS
-- namespace-authority reference keeps its route-ownership evidence foreign
-- key, so the Spaces reference lives in its own column with its own key.
ALTER TABLE community_handle_sale_namespace_activation_revisions
  ALTER COLUMN namespace_authority_reference DROP NOT NULL,
  ALTER COLUMN namespace_authority_generation DROP NOT NULL,
  ALTER COLUMN serving_kind DROP NOT NULL,
  ALTER COLUMN dns_zone_activation_id DROP NOT NULL,
  ALTER COLUMN dns_zone_activation_generation DROP NOT NULL,
  ALTER COLUMN root_replacement_kind DROP NOT NULL,
  ALTER COLUMN dedicated_root_replacement_confirmed DROP NOT NULL,
  ADD COLUMN spaces_network TEXT REFERENCES spaces_network_configuration (network),
  ADD COLUMN spaces_namespace_authority_reference TEXT,
  ADD COLUMN spaces_namespace_authority_generation BIGINT,
  ADD COLUMN spaces_operator_assignment_kind TEXT,
  ADD COLUMN spaces_operator_assignment_id TEXT,
  ADD COLUMN spaces_operator_assignment_generation BIGINT,
  ADD COLUMN spaces_operator_funding_terms_kind TEXT,
  ADD COLUMN spaces_operator_funding_terms_confirmed BOOLEAN,
  DROP CONSTRAINT community_handle_sale_namespace_activation_revisio_family_check,
  DROP CONSTRAINT community_handle_sale_namespace_activation_r_serving_kind_check,
  DROP CONSTRAINT community_handle_sale_namespace_act_root_replacement_kind_check,
  DROP CONSTRAINT community_handle_sale_namesp_dedicated_root_replacement_c_check,
  DROP CONSTRAINT community_handle_sale_namespace_activation_identity_check,
  ADD CONSTRAINT community_handle_sale_namespace_activation_family_shape CHECK (
    ((family = 'hns'
      AND serving_kind = 'hns_dns_zone_activation_v1'
      AND root_replacement_kind = 'dedicated_root_replace_v1'
      AND dedicated_root_replacement_confirmed IS TRUE
      AND is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
      AND sale_namespace_activation_generation BETWEEN 1 AND 9007199254740991
      AND sale_namespace_activation_hash ~ '^[0-9a-f]{64}$'
      AND is_community_route_root_label('hns', canonical_root)
      AND is_community_route_root_label_display(display_root)
      AND canonical_root <> 'pirate'
      AND is_handle_sales_identifier_v1(namespace_authority_reference, 512)
      AND namespace_authority_generation BETWEEN 1 AND 9007199254740991
      AND is_handle_sales_identifier_v1(dns_zone_activation_id, 256)
      AND dns_zone_activation_generation BETWEEN 1 AND 9007199254740991
      AND spaces_network IS NULL
      AND spaces_namespace_authority_reference IS NULL
      AND spaces_namespace_authority_generation IS NULL
      AND spaces_operator_assignment_kind IS NULL
      AND spaces_operator_assignment_id IS NULL
      AND spaces_operator_assignment_generation IS NULL
      AND spaces_operator_funding_terms_kind IS NULL
      AND spaces_operator_funding_terms_confirmed IS NULL) IS TRUE)
    OR ((family = 'spaces'
      AND namespace_authority_reference IS NULL
      AND namespace_authority_generation IS NULL
      AND serving_kind IS NULL
      AND dns_zone_activation_id IS NULL
      AND dns_zone_activation_generation IS NULL
      AND root_replacement_kind IS NULL
      AND dedicated_root_replacement_confirmed IS NULL
      AND is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
      AND sale_namespace_activation_generation BETWEEN 1 AND 9007199254740991
      AND sale_namespace_activation_hash ~ '^[0-9a-f]{64}$'
      AND is_community_route_root_label('spaces', canonical_root)
      AND is_community_route_root_label_display(display_root)
      AND canonical_root <> 'pirate'
      AND spaces_network IN ('mainnet', 'testnet4', 'regtest')
      AND is_handle_sales_identifier_v1(spaces_namespace_authority_reference, 512)
      AND spaces_namespace_authority_generation BETWEEN 1 AND 9007199254740991
      AND spaces_operator_assignment_kind = 'spaces_operator_assignment_v1'
      AND is_handle_sales_identifier_v1(spaces_operator_assignment_id, 128)
      AND spaces_operator_assignment_generation BETWEEN 1 AND 9007199254740991
      AND spaces_operator_funding_terms_kind = 'spaces_operator_funding_confirm_v1'
      AND spaces_operator_funding_terms_confirmed IS TRUE) IS TRUE)
  ),
  ADD CONSTRAINT community_handle_sale_namespace_activation_spaces_authority_fk FOREIGN KEY (
    spaces_namespace_authority_reference,
    spaces_namespace_authority_generation
  ) REFERENCES spaces_namespace_authority_evidence (
    namespace_authority_reference,
    namespace_authority_generation
  ),
  ADD CONSTRAINT community_handle_sale_namespace_activation_spaces_assignment_fk FOREIGN KEY (
    spaces_operator_assignment_id,
    spaces_operator_assignment_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  );

ALTER TABLE community_handle_sale_namespace_activation_current
  DROP CONSTRAINT community_handle_sale_namespace_activation_current_family_check,
  ADD CONSTRAINT community_handle_sale_namespace_activation_current_family_check
    CHECK (family IN ('hns', 'spaces'));

-- Items 2 to 4 of §5.3.13.3 are checked at every transition that creates,
-- restores, or keeps an activation active; item 1 binds the transition to the
-- controlling account recorded by the current evidence, and an activation
-- never transfers to another account.
CREATE FUNCTION assert_spaces_sale_namespace_revision_insert_v1(
  candidate community_handle_sale_namespace_activation_revisions
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  authority_grant community_handle_sales_authority_grants%ROWTYPE;
  prior community_handle_sale_namespace_activation_revisions%ROWTYPE;
  origin community_handle_sale_namespace_activation_revisions%ROWTYPE;
  evidence spaces_namespace_authority_evidence%ROWTYPE;
  readiness_reason TEXT;
BEGIN
  SELECT * INTO community_record
    FROM communities
   WHERE community_id = candidate.community_id
   FOR SHARE;
  SELECT * INTO authority_grant
    FROM community_handle_sales_authority_grants
   WHERE grant_id = candidate.authority_grant_id
   FOR SHARE;
  IF authority_grant.grant_id IS NULL
    OR authority_grant.community_id <> candidate.community_id
    OR authority_grant.principal_account_id <> candidate.actor_account_id
    OR authority_grant.authority <> 'manage_handle_sales'
    OR (candidate.status IN ('pending', 'active') AND authority_grant.status <> 'active') THEN
    RAISE EXCEPTION 'Spaces sale namespace requires manage_handle_sales authority';
  END IF;

  SELECT * INTO prior
    FROM community_handle_sale_namespace_activation_revisions AS revision
   WHERE revision.sale_namespace_activation_id = candidate.sale_namespace_activation_id
   ORDER BY revision.sale_namespace_activation_generation DESC
   LIMIT 1
   FOR SHARE;
  IF prior.sale_namespace_activation_id IS NULL THEN
    IF candidate.sale_namespace_activation_generation <> 1
      OR candidate.status NOT IN ('pending', 'active') THEN
      RAISE EXCEPTION 'Spaces sale namespace must begin ready at generation one';
    END IF;
  ELSE
    IF candidate.sale_namespace_activation_generation
         <> prior.sale_namespace_activation_generation + 1
      OR candidate.community_id <> prior.community_id
      OR candidate.family <> prior.family
      OR candidate.canonical_root <> prior.canonical_root
      OR candidate.display_root <> prior.display_root
      OR candidate.spaces_network <> prior.spaces_network
      OR candidate.created_at <> prior.created_at THEN
      RAISE EXCEPTION 'Spaces sale namespace identity and generation are immutable';
    END IF;
    IF prior.status = 'revoked' THEN
      RAISE EXCEPTION 'revoked Spaces sale namespace is terminal';
    END IF;
    IF candidate.status = 'pending'
      OR (candidate.status = prior.status AND candidate.status <> 'active') THEN
      RAISE EXCEPTION 'Spaces sale namespace revision must advance state';
    END IF;
    IF candidate.status = 'active' THEN
      IF prior.activated_at IS NOT NULL
        AND candidate.activated_at IS DISTINCT FROM prior.activated_at THEN
        RAISE EXCEPTION 'Spaces sale namespace must preserve its activation time';
      END IF;
      IF (candidate.spaces_namespace_authority_reference = prior.spaces_namespace_authority_reference
          AND candidate.spaces_namespace_authority_generation
            < prior.spaces_namespace_authority_generation)
        OR (candidate.spaces_operator_assignment_id = prior.spaces_operator_assignment_id
          AND candidate.spaces_operator_assignment_generation
            < prior.spaces_operator_assignment_generation) THEN
        RAISE EXCEPTION 'Spaces sale namespace authority cannot regress';
      END IF;
      IF prior.status = 'active'
        AND candidate.spaces_namespace_authority_reference = prior.spaces_namespace_authority_reference
        AND candidate.spaces_namespace_authority_generation = prior.spaces_namespace_authority_generation
        AND candidate.spaces_operator_assignment_id = prior.spaces_operator_assignment_id
        AND candidate.spaces_operator_assignment_generation
          = prior.spaces_operator_assignment_generation THEN
        RAISE EXCEPTION 'active Spaces sale namespace refresh must advance authority or assignment';
      END IF;
      IF prior.status = 'suspended' AND (
        (candidate.spaces_namespace_authority_reference = prior.spaces_namespace_authority_reference
          AND candidate.spaces_namespace_authority_generation
            <= prior.spaces_namespace_authority_generation)
        OR (candidate.spaces_operator_assignment_id = prior.spaces_operator_assignment_id
          AND candidate.spaces_operator_assignment_generation
            <= prior.spaces_operator_assignment_generation)
      ) THEN
        RAISE EXCEPTION 'Spaces sale namespace restoration requires fresh authority and assignment generations';
      END IF;
    END IF;
  END IF;

  IF candidate.status IN ('pending', 'active') THEN
    IF community_record.community_id IS NULL OR community_record.status <> 'active' THEN
      RAISE EXCEPTION 'Spaces sale namespace requires an active community';
    END IF;
    SELECT * INTO evidence
      FROM spaces_namespace_authority_evidence
     WHERE namespace_authority_reference = candidate.spaces_namespace_authority_reference
       AND namespace_authority_generation = candidate.spaces_namespace_authority_generation
     FOR SHARE;
    IF evidence.namespace_authority_reference IS NULL
      OR evidence.network <> candidate.spaces_network
      OR evidence.canonical_root <> candidate.canonical_root
      OR evidence.display_root <> candidate.display_root
      OR evidence.community_id <> candidate.community_id
      OR evidence.controlling_account_id <> candidate.actor_account_id THEN
      RAISE EXCEPTION 'Spaces sale namespace requires evidence naming the controlling account';
    END IF;
    IF prior.sale_namespace_activation_id IS NOT NULL THEN
      SELECT * INTO origin
        FROM community_handle_sale_namespace_activation_revisions AS revision
       WHERE revision.sale_namespace_activation_id = candidate.sale_namespace_activation_id
         AND revision.sale_namespace_activation_generation = 1;
      IF origin.actor_account_id <> candidate.actor_account_id THEN
        RAISE EXCEPTION 'Spaces sale namespace never transfers to another controlling account';
      END IF;
    END IF;
    readiness_reason := spaces_sale_namespace_readiness_reason_v1(
      candidate.spaces_network,
      candidate.canonical_root,
      candidate.community_id,
      candidate.spaces_namespace_authority_reference,
      candidate.spaces_namespace_authority_generation,
      candidate.spaces_operator_assignment_id,
      candidate.spaces_operator_assignment_generation,
      clock_timestamp()
    );
    IF readiness_reason IS NOT NULL THEN
      RAISE EXCEPTION 'Spaces sale namespace is not ready: %', readiness_reason;
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_handle_sale_namespace_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  authority_grant community_handle_sales_authority_grants%ROWTYPE;
  dependency RECORD;
  prior community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_sale_namespace_revision_insert_v1(NEW);
    RETURN NEW;
  END IF;

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
    IF NEW.status = 'pending' THEN
      RAISE EXCEPTION 'handle sale namespace revision must advance state';
    END IF;
    IF NEW.status = prior.status THEN
      IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'handle sale namespace revision must advance state';
      END IF;
      IF NEW.activated_at <> prior.activated_at THEN
        RAISE EXCEPTION 'active handle sale namespace refresh must preserve activation time';
      END IF;
      IF NEW.namespace_authority_reference = prior.namespace_authority_reference
        AND NEW.namespace_authority_generation = prior.namespace_authority_generation
        AND NEW.dns_zone_activation_id = prior.dns_zone_activation_id
        AND NEW.dns_zone_activation_generation = prior.dns_zone_activation_generation THEN
        RAISE EXCEPTION 'active handle sale namespace refresh must advance authority';
      END IF;
      IF NEW.namespace_authority_reference = prior.namespace_authority_reference
        AND NEW.namespace_authority_generation < prior.namespace_authority_generation THEN
        RAISE EXCEPTION 'active handle sale namespace namespace authority cannot regress';
      END IF;
      IF NEW.dns_zone_activation_id = prior.dns_zone_activation_id
        AND NEW.dns_zone_activation_generation < prior.dns_zone_activation_generation THEN
        RAISE EXCEPTION 'active handle sale namespace DNS authority cannot regress';
      END IF;
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

-- The HNS branch is unchanged. A Spaces activation is effective only while it
-- is current, active, and ready; anchor lag blocks commerce without suspension.
CREATE OR REPLACE FUNCTION effective_community_handle_sale_namespace_v1(
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
  UNION ALL
  SELECT revision.*
    FROM community_handle_sale_namespace_activation_current AS current_activation
    JOIN community_handle_sale_namespace_activation_revisions AS revision
      ON revision.sale_namespace_activation_id
          = current_activation.sale_namespace_activation_id
     AND revision.sale_namespace_activation_generation
          = current_activation.current_generation
   WHERE current_activation.sale_namespace_activation_id
       = input_sale_namespace_activation_id
     AND revision.family = 'spaces'
     AND revision.status = 'active'
     AND spaces_sale_namespace_readiness_reason_v1(
       revision.spaces_network,
       revision.canonical_root,
       revision.community_id,
       revision.spaces_namespace_authority_reference,
       revision.spaces_namespace_authority_generation,
       revision.spaces_operator_assignment_id,
       revision.spaces_operator_assignment_generation,
       database_now
     ) IS NULL
$$;

-- Offerings: the Spaces grammar is admitted only with family spaces, and only
-- the free first-come members-only combination (§5.3.13.11-§5.3.13.12).
ALTER TABLE community_handle_offering_revisions
  DROP CONSTRAINT community_handle_offering_revisions_label_grammar_id_check,
  ADD CONSTRAINT community_handle_offering_revisions_label_grammar_id_check
    CHECK (label_grammar_id IN ('hns_ascii_ldh_1_63_v1', 'spaces_subspace_label_v1')),
  DROP CONSTRAINT community_handle_offering_label_scope_shape,
  ADD CONSTRAINT community_handle_offering_label_scope_shape CHECK (
    (label_grammar_id = 'hns_ascii_ldh_1_63_v1'
      AND family = 'hns'
      AND ((label_scope_kind = 'exact_label_v2'
        AND exact_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        AND exact_label !~ '^xn--'
        AND octet_length(exact_label) BETWEEN 1 AND 63
        AND min_label_length IS NULL
        AND max_label_length IS NULL)
      OR (label_scope_kind = 'label_rule_v2'
        AND exact_label IS NULL
        AND min_label_length BETWEEN 8 AND 32
        AND max_label_length BETWEEN min_label_length AND 32)))
    OR ((label_grammar_id = 'spaces_subspace_label_v1'
      AND family = 'spaces'
      AND label_scope_kind = 'label_rule_v2'
      AND exact_label IS NULL
      AND min_label_length BETWEEN 8 AND 32
      AND max_label_length BETWEEN min_label_length AND 32) IS TRUE)
  ),
  DROP CONSTRAINT community_handle_offering_supported_shape,
  ADD CONSTRAINT community_handle_offering_supported_shape CHECK (
    ((family = 'hns'::text) AND (namespace_root <> 'pirate'::text) AND (fulfillment_kind = 'hosted_persona_v1'::text) AND (atomic_amount = (0)::numeric) AND (((label_scope_kind = 'label_rule_v2'::text) AND (allocation_kind = 'first_come_v1'::text) AND ((max_active_grants_per_account IS NULL) OR ((max_active_grants_per_account >= 1) AND (max_active_grants_per_account <= '9007199254740991'::bigint)))) OR ((label_scope_kind = 'exact_label_v2'::text) AND (allocation_kind = 'direct_grant_v1'::text) AND (qualification_policy_id <> 'none_v1'::text) AND (max_active_grants_per_account IS NULL))))
    OR ((family = 'spaces'
      AND namespace_root <> 'pirate'
      AND fulfillment_kind = 'spaces_native_v1'
      AND atomic_amount = 0
      AND label_grammar_id = 'spaces_subspace_label_v1'
      AND label_scope_kind = 'label_rule_v2'
      AND allocation_kind = 'first_come_v1'
      AND qualification_policy_id <> 'none_v1'
      AND provider_binding_hash ~ '^[0-9a-f]{64}$'
      AND (max_active_grants_per_account IS NULL
        OR max_active_grants_per_account BETWEEN 1 AND 9007199254740991)) IS TRUE)
  );

-- The Spaces offering compiler (§5.3.13.12): the offering pins the current
-- platform members-only policy, whose hash is in the Spaces membership domain
-- and whose membership source is the current revision; none_v1, the account
-- allowlist, nationality, exact-label, and direct-grant combinations are
-- refused, and an active offering needs its root's driver enablement.
CREATE FUNCTION assert_spaces_handle_offering_revision_insert_v1(
  candidate community_handle_offering_revisions
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  activation community_handle_sale_namespace_activation_revisions%ROWTYPE;
  reserved_document handle_reserved_label_revisions%ROWTYPE;
  policy handle_qualification_policy_revisions%ROWTYPE;
  membership_source handle_spaces_membership_source_revisions%ROWTYPE;
  current_source_revision BIGINT;
  pricing handle_pricing_revisions%ROWTYPE;
  driver handle_issuance_driver_revisions%ROWTYPE;
  prior community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NOT has_community_handle_sales_authority(candidate.community_id, candidate.actor_account_id) THEN
    RAISE EXCEPTION 'handle offering requires active manage_handle_sales authority';
  END IF;
  SELECT * INTO activation
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = candidate.sale_namespace_activation_id
     AND sale_namespace_activation_generation = candidate.sale_namespace_activation_generation
   FOR SHARE;
  IF activation.sale_namespace_activation_id IS NULL
    OR activation.family <> 'spaces'
    OR activation.community_id <> candidate.community_id
    OR activation.canonical_root <> candidate.namespace_root
    OR activation.display_root <> candidate.display_root THEN
    RAISE EXCEPTION 'handle offering sale activation reference is inconsistent';
  END IF;
  IF candidate.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM effective_community_handle_sale_namespace_v1(
      candidate.sale_namespace_activation_id,
      clock_timestamp()
    ) AS effective
     WHERE effective.sale_namespace_activation_generation
         = candidate.sale_namespace_activation_generation
  ) THEN
    RAISE EXCEPTION 'active handle offering requires the current effective sale activation';
  END IF;

  IF candidate.label_grammar_id <> 'spaces_subspace_label_v1'
    OR candidate.label_scope_kind <> 'label_rule_v2'
    OR candidate.allocation_kind <> 'first_come_v1'
    OR candidate.fulfillment_kind <> 'spaces_native_v1' THEN
    RAISE EXCEPTION 'Spaces offerings admit only free first-come subspace labels';
  END IF;

  SELECT * INTO reserved_document
    FROM handle_reserved_label_revisions
   WHERE reserved_labels_id = candidate.reserved_labels_id
     AND reserved_labels_revision = candidate.reserved_labels_revision
   FOR SHARE;
  IF reserved_document.reserved_labels_id IS NULL
    OR reserved_document.family <> 'spaces'
    OR reserved_document.status <> 'active'
    OR reserved_document.reserved_labels_hash <> candidate.reserved_labels_hash THEN
    RAISE EXCEPTION 'handle offering reserved-label reference is inconsistent';
  END IF;

  SELECT * INTO policy
    FROM handle_qualification_policy_revisions
   WHERE policy_id = candidate.qualification_policy_id
     AND policy_revision = candidate.qualification_policy_revision
   FOR SHARE;
  IF policy.policy_id IS NULL
    OR policy.status <> 'active'
    OR policy.policy_kind <> 'spaces_membership_v1'
    OR policy.community_id IS NOT NULL
    OR policy.requirement_kind IS DISTINCT FROM 'community_membership_v1'
    OR policy.requirement_id IS NULL
    OR policy.policy_hash <> candidate.qualification_policy_hash THEN
    RAISE EXCEPTION 'Spaces offerings require the members-only qualification policy';
  END IF;
  SELECT max(source_revision) INTO current_source_revision
    FROM handle_spaces_membership_source_revisions;
  SELECT * INTO membership_source
    FROM handle_spaces_membership_source_revisions
   WHERE source_revision::TEXT = policy.provider_binding_version
   FOR SHARE;
  IF membership_source.source_revision IS NULL
    OR membership_source.source_revision <> current_source_revision THEN
    RAISE EXCEPTION 'Spaces offering pins a stale membership source revision';
  END IF;
  IF membership_source.source_hash <> policy.provider_binding_hash
    OR candidate.provider_binding_hash IS DISTINCT FROM membership_source.source_hash THEN
    RAISE EXCEPTION 'Spaces offering membership source hash does not match';
  END IF;
  IF policy.policy_hash <> handle_spaces_membership_policy_hash_v1(
    policy.policy_id,
    policy.policy_revision,
    policy.requirement_id,
    policy.requirement_revision,
    membership_source.source_revision,
    membership_source.source_hash
  ) THEN
    RAISE EXCEPTION 'Spaces offering policy is outside the Spaces membership hash domain';
  END IF;

  SELECT * INTO pricing
    FROM handle_pricing_revisions
   WHERE pricing_id = candidate.pricing_id
     AND pricing_revision = candidate.pricing_revision
   FOR SHARE;
  IF pricing.pricing_id IS NULL
    OR pricing.status <> 'active'
    OR pricing.pricing_kind <> 'free_v1'
    OR pricing.pricing_hash <> candidate.pricing_hash
    OR pricing.atomic_amount <> candidate.atomic_amount THEN
    RAISE EXCEPTION 'handle offering pricing reference is inconsistent';
  END IF;

  SELECT * INTO driver
    FROM handle_issuance_driver_revisions
   WHERE family = 'spaces'
     AND driver_id = candidate.issuance_driver_id
     AND driver_version = candidate.issuance_driver_version
   FOR SHARE;
  IF driver.driver_id IS NULL
    OR driver.status = 'retired'
    OR driver.fulfillment_kind <> candidate.fulfillment_kind THEN
    RAISE EXCEPTION 'handle offering issuance-driver reference is inconsistent';
  END IF;
  IF candidate.status = 'active' AND NOT EXISTS (
    SELECT 1
      FROM spaces_issuance_driver_root_enablements AS enablement
     WHERE enablement.network = activation.spaces_network
       AND enablement.canonical_root = activation.canonical_root
       AND enablement.driver_id = candidate.issuance_driver_id
       AND enablement.driver_version = candidate.issuance_driver_version
       AND enablement.status = 'enabled'
  ) THEN
    RAISE EXCEPTION 'active Spaces offering requires its root''s driver enablement';
  END IF;

  SELECT * INTO prior
    FROM community_handle_offering_revisions
   WHERE offering_id = candidate.offering_id
   ORDER BY offering_revision DESC
   LIMIT 1
   FOR SHARE;
  IF prior.offering_id IS NULL THEN
    IF candidate.offering_revision <> 1 THEN
      RAISE EXCEPTION 'handle offering must begin at revision one';
    END IF;
  ELSIF candidate.offering_revision <> prior.offering_revision + 1
    OR candidate.community_id <> prior.community_id
    OR candidate.created_at <> prior.created_at
    OR prior.status = 'retired' THEN
    RAISE EXCEPTION 'handle offering revision sequence or identity is invalid';
  END IF;
  IF candidate.recorded_at < candidate.created_at THEN
    RAISE EXCEPTION 'handle offering recorded time precedes creation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_community_handle_offering_revision_insert_v3() RETURNS trigger
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
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_handle_offering_revision_insert_v1(NEW);
    RETURN NEW;
  END IF;

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

  IF (NEW.label_scope_kind='label_rule_v2' AND policy.policy_kind NOT IN ('none_v1','curated_nationality_v1'))
    OR (NEW.label_scope_kind='exact_label_v2' AND policy.policy_kind <> 'curated_policy_v1') THEN
    RAISE EXCEPTION 'handle allocation does not admit this qualification policy';
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

-- Persona Taproot recipient storage (Spec 014 §12.5). A persona holds at most
-- one live bitcoin-taproot assignment through the existing single-live-row
-- index; addresses and scripts are unique across the table and never
-- recycled; the index column is nullable only for Taproot; every EVM check
-- stays in the EVM arm.
ALTER TABLE persona_wallet_assignments
  ADD COLUMN bitcoin_network TEXT REFERENCES spaces_network_configuration (network),
  ADD COLUMN output_script_hex TEXT,
  ALTER COLUMN hd_wallet_index DROP NOT NULL,
  DROP CONSTRAINT persona_wallet_assignments_chain_account_kind_check,
  ADD CONSTRAINT persona_wallet_assignments_chain_account_kind_check
    CHECK (chain_account_kind IN ('evm', 'bitcoin-taproot')),
  DROP CONSTRAINT persona_wallet_assignments_address_check,
  ADD CONSTRAINT persona_wallet_assignments_kind_shape CHECK (
    ((chain_account_kind = 'evm'
      AND hd_wallet_index IS NOT NULL
      AND ((address IS NULL) OR (address ~ '^0x[0-9a-f]{40}$'))
      AND bitcoin_network IS NULL
      AND output_script_hex IS NULL) IS TRUE)
    OR ((chain_account_kind = 'bitcoin-taproot'
      AND bitcoin_network IN ('mainnet', 'testnet4', 'regtest')
      AND ((address IS NULL AND output_script_hex IS NULL)
        OR (output_script_hex ~ '^5120[0-9a-f]{64}$'
          AND address ~ CASE bitcoin_network
            WHEN 'mainnet' THEN '^bc1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$'
            WHEN 'testnet4' THEN '^tb1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$'
            ELSE '^bcrt1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$'
          END))) IS TRUE)
  );

CREATE UNIQUE INDEX persona_wallet_assignments_output_script_uidx
  ON persona_wallet_assignments (output_script_hex)
  WHERE output_script_hex IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_persona_wallet_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'persona wallet assignment cannot be deleted';
  END IF;
  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.persona_id IS DISTINCT FROM OLD.persona_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.chain_account_kind IS DISTINCT FROM OLD.chain_account_kind
     OR NEW.hd_wallet_index IS DISTINCT FROM OLD.hd_wallet_index
     OR NEW.reservation_idempotency_key IS DISTINCT FROM OLD.reservation_idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.bitcoin_network IS DISTINCT FROM OLD.bitcoin_network THEN
    RAISE EXCEPTION 'persona wallet assignment identity is immutable';
  END IF;
  IF OLD.status = 'tombstoned' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'tombstoned persona wallet assignment is immutable';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'tombstoned') THEN
    RAISE EXCEPTION 'active persona wallet assignment cannot be reopened';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'active', 'tombstoned') THEN
    RAISE EXCEPTION 'invalid persona wallet assignment transition';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.privy_wallet_id IS DISTINCT FROM OLD.privy_wallet_id
       OR NEW.address IS DISTINCT FROM OLD.address
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.output_script_hex IS DISTINCT FROM OLD.output_script_hex) THEN
    RAISE EXCEPTION 'assigned persona wallet authority is immutable';
  END IF;
  RETURN NEW;
END
$$;

-- Ruling Q10: a Taproot assignment never advances the public-linkage
-- footprint. The trigger function is unchanged and now sees EVM rows only.
DROP TRIGGER handle_persona_wallet_footprint ON persona_wallet_assignments;

CREATE TRIGGER handle_persona_wallet_footprint
AFTER INSERT OR UPDATE ON persona_wallet_assignments
FOR EACH ROW
WHEN (NEW.chain_account_kind = 'evm')
EXECUTE FUNCTION track_handle_persona_wallet_footprint_v1();

-- A live Taproot assignment belongs to an active or suspended persona, so
-- retirement must tombstone it in the same transaction (Spec 014 §12.4).
CREATE FUNCTION validate_persona_taproot_lifecycle_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_persona_id TEXT := COALESCE(NEW.persona_id, OLD.persona_id);
  target_status TEXT;
BEGIN
  SELECT status INTO target_status FROM personas WHERE persona_id = target_persona_id;
  IF target_status IS NULL THEN
    RETURN NULL;
  END IF;
  IF target_status NOT IN ('active', 'suspended') AND EXISTS (
    SELECT 1
      FROM persona_wallet_assignments AS assignment
     WHERE assignment.persona_id = target_persona_id
       AND assignment.chain_account_kind = 'bitcoin-taproot'
       AND assignment.status IN ('pending', 'active')
  ) THEN
    RAISE EXCEPTION 'a live Taproot assignment requires an active or suspended persona'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_taproot_lifecycle_invariant';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER personas_taproot_lifecycle_invariant
AFTER UPDATE OF status ON personas
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_persona_taproot_lifecycle_v1();

CREATE CONSTRAINT TRIGGER persona_wallets_taproot_lifecycle_invariant
AFTER INSERT OR UPDATE OF status ON persona_wallet_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.chain_account_kind = 'bitcoin-taproot')
EXECUTE FUNCTION validate_persona_taproot_lifecycle_v1();
