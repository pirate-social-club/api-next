-- Nationality authoring is independent of community admission and private direct grants.
ALTER TABLE handle_qualification_policy_revisions ADD COLUMN nationality_policy JSONB;
ALTER TABLE handle_qualification_policy_revisions
  DROP CONSTRAINT handle_qualification_policy_revisions_policy_kind_check,
  ADD CONSTRAINT handle_qualification_policy_revisions_policy_kind_check
    CHECK (policy_kind IN ('none_v1','curated_policy_v1','curated_nationality_v1')),
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
  );

CREATE TABLE handle_nationality_policy_actions (
  action_id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES users(user_id),
  community_id TEXT NOT NULL REFERENCES communities(community_id),
  endpoint_template TEXT NOT NULL CHECK (endpoint_template='/communities/:communityId/handle-nationality-qualification-policies'),
  idempotency_key TEXT NOT NULL CHECK (is_handle_sales_identifier_v1(idempotency_key,128)),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  authoring_reference TEXT NOT NULL CHECK (authoring_reference ~ '^[0-9a-f]{64}$'),
  policy_id TEXT NOT NULL,
  policy_revision BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (actor_account_id,endpoint_template,idempotency_key),
  FOREIGN KEY (policy_id,policy_revision) REFERENCES handle_qualification_policy_revisions(policy_id,policy_revision)
);

CREATE FUNCTION guard_handle_nationality_authoring_v1() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE policy handle_qualification_policy_revisions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='handle_qualification_policy_revisions' THEN
    IF NEW.policy_kind <> 'curated_nationality_v1' THEN RETURN NEW; END IF;
    IF NOT has_community_handle_sales_authority(NEW.community_id,NEW.created_by_account_id) THEN
      RAISE EXCEPTION 'nationality qualification requires active manage_handle_sales authority';
    END IF;
  ELSE
    SELECT * INTO policy FROM handle_qualification_policy_revisions
      WHERE policy_id=NEW.policy_id AND policy_revision=NEW.policy_revision FOR SHARE;
    IF policy.policy_id IS NULL OR policy.policy_kind <> 'curated_nationality_v1'
      OR policy.community_id IS DISTINCT FROM NEW.community_id
      OR policy.created_by_account_id IS DISTINCT FROM NEW.actor_account_id
      OR policy.request_hash IS DISTINCT FROM NEW.request_hash
      OR policy.created_at IS DISTINCT FROM NEW.committed_at
      OR NOT has_community_handle_sales_authority(NEW.community_id,NEW.actor_account_id) THEN
      RAISE EXCEPTION 'nationality authoring action does not match its authorized policy';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_nationality_policy_insert_guard
  BEFORE INSERT ON handle_qualification_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_handle_nationality_authoring_v1();
CREATE TRIGGER handle_nationality_policy_action_insert_guard
  BEFORE INSERT ON handle_nationality_policy_actions
  FOR EACH ROW EXECUTE FUNCTION guard_handle_nationality_authoring_v1();
CREATE TRIGGER handle_nationality_policy_actions_append_only
  BEFORE UPDATE OR DELETE ON handle_nationality_policy_actions
  FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Keep both admitted allocations; only free first-come gains the nationality successor.
ALTER TABLE community_handle_offering_revisions DROP CONSTRAINT community_handle_offering_supported_shape;
ALTER TABLE community_handle_offering_revisions ADD CONSTRAINT community_handle_offering_supported_shape CHECK (((family = 'hns'::text) AND (namespace_root <> 'pirate'::text) AND (fulfillment_kind = 'hosted_persona_v1'::text) AND (atomic_amount = (0)::numeric) AND (((label_scope_kind = 'label_rule_v2'::text) AND (allocation_kind = 'first_come_v1'::text) AND ((max_active_grants_per_account IS NULL) OR ((max_active_grants_per_account >= 1) AND (max_active_grants_per_account <= '9007199254740991'::bigint)))) OR ((label_scope_kind = 'exact_label_v2'::text) AND (allocation_kind = 'direct_grant_v1'::text) AND (qualification_policy_id <> 'none_v1'::text) AND (max_active_grants_per_account IS NULL)))));

CREATE FUNCTION validate_community_handle_offering_revision_insert_v3() RETURNS trigger
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

DROP TRIGGER community_handle_offering_revision_insert_guard ON community_handle_offering_revisions;
CREATE TRIGGER community_handle_offering_revision_insert_guard
  BEFORE INSERT ON community_handle_offering_revisions
  FOR EACH ROW EXECUTE FUNCTION validate_community_handle_offering_revision_insert_v3();
