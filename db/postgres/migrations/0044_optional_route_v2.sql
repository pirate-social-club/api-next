-- Optional-route community creation and the sibling route-attachment aggregate.
-- The creation result is permanently /c/<community_id>; namespace authority is
-- current state owned by a separate intent family.

ALTER TABLE community_creation_intents
  DROP CONSTRAINT community_creation_intents_creation_contract_version_check,
  ADD CONSTRAINT community_creation_intents_creation_contract_version_check CHECK (
    creation_contract_version IN ('legacy_slug_v1', 'route_v1', 'optional_route_v2')
  ),
  ADD CONSTRAINT community_creation_intents_optional_route_v2_draft_shape CHECK (
    creation_contract_version <> 'optional_route_v2'
    OR (
      jsonb_typeof(draft) = 'object'
      AND draft ? 'name'
      AND draft ? 'description'
      AND draft ? 'policy'
      AND (draft - 'name' - 'description' - 'policy') = '{}'::jsonb
      AND jsonb_typeof(draft -> 'name') = 'string'
      AND btrim(draft ->> 'name') <> ''
      AND jsonb_typeof(draft -> 'description') IN ('string', 'null')
      AND jsonb_typeof(draft -> 'policy') = 'object'
      AND NOT (draft ? 'slug')
      AND NOT (draft ? 'route_request')
    )
  ),
  ADD CONSTRAINT community_creation_intents_optional_route_v2_committed_shape CHECK (
    creation_contract_version <> 'optional_route_v2'
    OR status <> 'committed'
    OR (
      committed_community_id ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND committed_resource_href = '/c/' || committed_community_id
    )
  );

COMMENT ON COLUMN community_creation_intents.creation_contract_version IS
  'Immutable creation authority fence. route_v1 retains historical route-bound replay; optional_route_v2 creates a permanent generated-id resource without namespace authority.';

CREATE OR REPLACE FUNCTION validate_route_v1_creation_requirement_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_intent_id TEXT;
  contract_version TEXT;
  human_count BIGINT;
  namespace_count BIGINT;
BEGIN
  checked_intent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.intent_id ELSE NEW.intent_id END;

  SELECT creation_contract_version INTO contract_version
    FROM community_creation_intents
   WHERE intent_id = checked_intent_id;

  IF NOT FOUND OR contract_version = 'legacy_slug_v1' THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE requirement_kind = 'human_identity'),
    COUNT(*) FILTER (WHERE requirement_kind = 'namespace_ownership')
    INTO human_count, namespace_count
    FROM community_creation_requirement_states
   WHERE intent_id = checked_intent_id;

  IF contract_version = 'route_v1'
    AND (human_count <> 1 OR namespace_count <> 1) THEN
    RAISE EXCEPTION 'route-v1 community creation requires one human and one namespace requirement row';
  END IF;

  IF contract_version = 'optional_route_v2'
    AND (human_count <> 1 OR namespace_count <> 0) THEN
    RAISE EXCEPTION 'optional-route-v2 community creation requires exactly one human requirement row and no namespace requirement row';
  END IF;

  RETURN NULL;
END;
$$;

ALTER TABLE communities
  DROP CONSTRAINT communities_route_authority_version_check,
  DROP CONSTRAINT communities_route_v1_binding_presence,
  ADD CONSTRAINT communities_route_authority_version_check CHECK (
    route_authority_version IN ('legacy_slug_v1', 'route_v1', 'optional_route_v2')
  ),
  ADD CONSTRAINT communities_route_authority_binding_shape CHECK (
    route_authority_version <> 'route_v1'
    OR status <> 'active'
    OR canonical_route_binding_id IS NOT NULL
  ),
  ADD CONSTRAINT communities_optional_route_v2_identity_shape CHECK (
    route_authority_version <> 'optional_route_v2'
    OR (
      community_id ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND route_slug IS NULL
    )
  );

COMMENT ON COLUMN communities.route_authority_version IS
  'Immutable route model. optional_route_v2 reserves community_ UUID identifiers and permits zero or one canonical binding.';

CREATE TABLE community_route_authority_grants (
  grant_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  principal_user_id TEXT NOT NULL REFERENCES users (user_id),
  authority TEXT NOT NULL CHECK (authority = 'manage_routes'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('creator_owner', 'community_policy')),
  source_policy_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by_user_id TEXT NOT NULL REFERENCES users (user_id),
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT REFERENCES users (user_id),
  CONSTRAINT community_route_authority_grants_id_shape CHECK (
    btrim(grant_id) <> ''
    AND grant_id = btrim(grant_id)
    AND octet_length(grant_id) <= 512
  ),
  CONSTRAINT community_route_authority_grants_source_shape CHECK (
    (source_kind = 'creator_owner' AND source_policy_ref IS NULL)
    OR (source_kind = 'community_policy' AND btrim(source_policy_ref) <> '')
  ),
  CONSTRAINT community_route_authority_grants_status_shape CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX community_route_authority_grants_active_uidx
  ON community_route_authority_grants (community_id, principal_user_id, authority)
  WHERE status = 'active';

CREATE INDEX community_route_authority_grants_principal_idx
  ON community_route_authority_grants (principal_user_id, community_id, status);

CREATE FUNCTION guard_community_route_authority_grant_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.grant_id,
    NEW.community_id,
    NEW.principal_user_id,
    NEW.authority,
    NEW.source_kind,
    NEW.source_policy_ref,
    NEW.granted_at,
    NEW.granted_by_user_id
  ) IS DISTINCT FROM ROW(
    OLD.grant_id,
    OLD.community_id,
    OLD.principal_user_id,
    OLD.authority,
    OLD.source_kind,
    OLD.source_policy_ref,
    OLD.granted_at,
    OLD.granted_by_user_id
  ) THEN
    RAISE EXCEPTION 'community route authority grant identity is immutable';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'revoked community route authority grants are terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_authority_grants_change_guard
BEFORE UPDATE ON community_route_authority_grants
FOR EACH ROW EXECUTE FUNCTION guard_community_route_authority_grant_change();

CREATE OR REPLACE FUNCTION has_community_route_authority(
  expected_community_id TEXT,
  expected_principal_user_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM community_route_authority_grants AS authority_grant
     WHERE authority_grant.community_id = expected_community_id
       AND authority_grant.principal_user_id = expected_principal_user_id
       AND authority_grant.authority = 'manage_routes'
       AND authority_grant.status = 'active'
  )
$$;

COMMENT ON FUNCTION has_community_route_authority(TEXT, TEXT) IS
  'Community-scoped manage_routes authority. Platform-operator overrides are intentionally outside this predicate.';

CREATE TABLE community_route_operator_override_audit (
  override_audit_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  operator_principal_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('attachment_intent_created', 'attachment_committed')
  ),
  reason TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_route_operator_override_audit_identity_shape CHECK (
    btrim(override_audit_id) <> ''
    AND override_audit_id = btrim(override_audit_id)
    AND btrim(operator_principal_id) <> ''
    AND operator_principal_id = btrim(operator_principal_id)
    AND btrim(reason) <> ''
  )
);

CREATE FUNCTION reject_community_route_operator_override_audit_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community route operator override audit is append-only';
END;
$$;

CREATE TRIGGER community_route_operator_override_audit_change_guard
BEFORE UPDATE OR DELETE ON community_route_operator_override_audit
FOR EACH ROW EXECUTE FUNCTION reject_community_route_operator_override_audit_change();

CREATE TABLE community_route_attachment_intents (
  attachment_intent_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  authority_grant_id TEXT NOT NULL REFERENCES community_route_authority_grants (grant_id),
  create_idempotency_key TEXT NOT NULL,
  create_request_hash TEXT NOT NULL CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (
    status IN ('verification_required', 'commit_ready', 'committed', 'failed', 'expired', 'cancelled')
  ),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT GENERATED ALWAYS AS (
    CASE family WHEN 'hns' THEN 'app.' || root_label WHEN 'spaces' THEN '@' || root_label END
  ) STORED,
  href TEXT GENERATED ALWAYS AS (
    '/c/' || CASE family WHEN 'hns' THEN 'app.' || root_label WHEN 'spaces' THEN '@' || root_label END
  ) STORED,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_route_binding_id TEXT,
  committed_resource JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_intents_actor_identity_unique UNIQUE (
    actor_id,
    attachment_intent_id
  ),
  CONSTRAINT community_route_attachment_intents_create_idempotency_unique UNIQUE (
    actor_id,
    create_idempotency_key
  ),
  CONSTRAINT community_route_attachment_intents_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
  ),
  CONSTRAINT community_route_attachment_intents_provider_shape CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
  ),
  CONSTRAINT community_route_attachment_intents_time_order CHECK (
    updated_at >= created_at
    AND expires_at > created_at
  ),
  CONSTRAINT community_route_attachment_intents_commit_shape CHECK (
    (
      status = 'committed'
      AND committed_route_binding_id IS NOT NULL
      AND jsonb_typeof(committed_resource) = 'object'
    )
    OR (
      status <> 'committed'
      AND committed_route_binding_id IS NULL
      AND committed_resource IS NULL
    )
  )
);

CREATE UNIQUE INDEX community_route_attachment_intents_one_open_per_community_uidx
  ON community_route_attachment_intents (community_id)
  WHERE status IN ('verification_required', 'commit_ready');

CREATE TABLE community_route_attachment_requirement_states (
  attachment_intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL CHECK (requirement_kind = 'namespace_ownership'),
  status TEXT NOT NULL CHECK (status IN ('unmet', 'pending', 'satisfied', 'failed', 'expired')),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_ceremony_intent_id TEXT,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attachment_intent_id, requirement_kind),
  CONSTRAINT community_route_attachment_requirement_states_intent_fk FOREIGN KEY (
    actor_id,
    attachment_intent_id
  ) REFERENCES community_route_attachment_intents (
    actor_id,
    attachment_intent_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_attachment_requirement_states_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ),
  CONSTRAINT community_route_attachment_requirement_states_progress_shape CHECK (
    (status = 'unmet' AND generation = 0 AND current_ceremony_intent_id IS NULL AND satisfied_at IS NULL)
    OR (status = 'pending' AND generation > 0 AND current_ceremony_intent_id IS NOT NULL AND satisfied_at IS NULL)
    OR (status = 'satisfied' AND generation > 0 AND current_ceremony_intent_id IS NOT NULL AND satisfied_at IS NOT NULL)
    OR (status IN ('failed', 'expired') AND generation > 0 AND current_ceremony_intent_id IS NOT NULL AND satisfied_at IS NULL)
  )
);

CREATE TABLE community_route_attachment_ceremony_attempts (
  ceremony_intent_id TEXT PRIMARY KEY,
  attachment_intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  reservation_request_hash TEXT NOT NULL CHECK (reservation_request_hash ~ '^[0-9a-f]{64}$'),
  reservation_request JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_ceremony_attempts_intent_fk FOREIGN KEY (
    actor_id,
    attachment_intent_id
  ) REFERENCES community_route_attachment_intents (
    actor_id,
    attachment_intent_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_attachment_ceremony_attempts_state_fk FOREIGN KEY (
    attachment_intent_id,
    requirement_kind
  ) REFERENCES community_route_attachment_requirement_states (
    attachment_intent_id,
    requirement_kind
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_attachment_ceremony_attempts_identity_unique UNIQUE (
    actor_id,
    attachment_intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  ),
  CONSTRAINT community_route_attachment_ceremony_attempts_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  )
);

ALTER TABLE community_route_attachment_requirement_states
  ADD CONSTRAINT community_route_attachment_requirement_current_ceremony_fk
  FOREIGN KEY (current_ceremony_intent_id)
  REFERENCES community_route_attachment_ceremony_attempts (ceremony_intent_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE community_route_attachment_ceremony_results (
  ceremony_intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  attachment_intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL CHECK (requirement_kind = 'namespace_ownership'),
  generation BIGINT NOT NULL CHECK (generation > 0),
  callback_idempotency_key TEXT NOT NULL,
  callback_request_hash TEXT NOT NULL CHECK (callback_request_hash ~ '^[0-9a-f]{64}$'),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('satisfied', 'failed', 'expired')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref TEXT,
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT
    CHECK (provider_identity_digest IS NULL OR provider_identity_digest ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ NOT NULL,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_attachment_ceremony_results_attempt_fk FOREIGN KEY (
    actor_id,
    attachment_intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  ) REFERENCES community_route_attachment_ceremony_attempts (
    actor_id,
    attachment_intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT community_route_attachment_ceremony_results_callback_unique UNIQUE (
    actor_id,
    ceremony_intent_id,
    callback_idempotency_key
  ),
  CONSTRAINT community_route_attachment_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at = terminal_at
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
    )
  )
);

CREATE FUNCTION reject_community_route_attachment_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community route attachment evidence is append-only';
END;
$$;

CREATE FUNCTION guard_community_route_attachment_requirement_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'community route attachment requirement state cannot be deleted';
  END IF;
  IF ROW(
    NEW.attachment_intent_id, NEW.actor_id, NEW.requirement_kind,
    NEW.requirement_hash, NEW.provider_id, NEW.provider_binding_hash,
    NEW.provider_configuration_kind, NEW.provider_configuration_ref,
    NEW.provider_configuration_version, NEW.family, NEW.root_label,
    NEW.root_label_display, NEW.path_segment, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.attachment_intent_id, OLD.actor_id, OLD.requirement_kind,
    OLD.requirement_hash, OLD.provider_id, OLD.provider_binding_hash,
    OLD.provider_configuration_kind, OLD.provider_configuration_ref,
    OLD.provider_configuration_version, OLD.family, OLD.root_label,
    OLD.root_label_display, OLD.path_segment, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community route attachment requirement authority is immutable';
  END IF;
  IF NOT (
    (
      OLD.status IN ('unmet', 'failed', 'expired')
      AND NEW.status = 'pending'
      AND NEW.generation = OLD.generation + 1
      AND NEW.current_ceremony_intent_id IS NOT NULL
      AND NEW.satisfied_at IS NULL
    )
    OR (
      OLD.status = 'pending'
      AND NEW.status IN ('satisfied', 'failed', 'expired')
      AND NEW.generation = OLD.generation
      AND NEW.current_ceremony_intent_id = OLD.current_ceremony_intent_id
    )
  ) THEN
    RAISE EXCEPTION 'community route attachment requirement transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_requirement_state_guard
BEFORE UPDATE OR DELETE ON community_route_attachment_requirement_states
FOR EACH ROW EXECUTE FUNCTION guard_community_route_attachment_requirement_state();

CREATE FUNCTION validate_community_route_attachment_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_route_attachment_intents%ROWTYPE;
  state_record community_route_attachment_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO intent_record
    FROM community_route_attachment_intents
   WHERE attachment_intent_id = NEW.attachment_intent_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_route_attachment_requirement_states
   WHERE attachment_intent_id = NEW.attachment_intent_id
     AND requirement_kind = NEW.requirement_kind
   FOR UPDATE;
  IF intent_record.attachment_intent_id IS NULL
    OR intent_record.status <> 'verification_required'
    OR intent_record.expires_at <= clock_timestamp()
    OR NEW.expires_at > intent_record.expires_at
    OR state_record.attachment_intent_id IS NULL
    OR state_record.actor_id <> NEW.actor_id
    OR state_record.status NOT IN ('unmet', 'failed', 'expired')
    OR NEW.generation <> state_record.generation + 1
    OR NEW.requirement_hash <> state_record.requirement_hash
    OR NEW.provider_id <> state_record.provider_id
    OR NEW.provider_binding_hash <> state_record.provider_binding_hash
    OR NEW.provider_configuration_kind <> state_record.provider_configuration_kind
    OR NEW.provider_configuration_ref <> state_record.provider_configuration_ref
    OR NEW.provider_configuration_version <> state_record.provider_configuration_version
    OR NEW.family <> state_record.family
    OR NEW.root_label <> state_record.root_label
    OR NEW.root_label_display <> state_record.root_label_display
    OR NEW.path_segment <> state_record.path_segment THEN
    RAISE EXCEPTION 'route attachment ceremony does not match its current requirement authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_attempt_insert_guard
BEFORE INSERT ON community_route_attachment_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_attempt_insert();

CREATE TRIGGER community_route_attachment_attempt_append_only
BEFORE UPDATE OR DELETE ON community_route_attachment_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

CREATE FUNCTION validate_community_route_attachment_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_route_attachment_ceremony_attempts%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_route_attachment_ceremony_attempts
   WHERE ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;
  IF attempt_record.ceremony_intent_id IS NULL
    OR NEW.actor_id <> attempt_record.actor_id
    OR NEW.attachment_intent_id <> attempt_record.attachment_intent_id
    OR NEW.requirement_kind <> attempt_record.requirement_kind
    OR NEW.generation <> attempt_record.generation THEN
    RAISE EXCEPTION 'route attachment result does not match its immutable ceremony';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_result_insert_guard
BEFORE INSERT ON community_route_attachment_ceremony_results
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_result_insert();

CREATE TRIGGER community_route_attachment_result_append_only
BEFORE UPDATE OR DELETE ON community_route_attachment_ceremony_results
FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

CREATE FUNCTION validate_community_route_attachment_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ceremony_id TEXT;
  state_record community_route_attachment_requirement_states%ROWTYPE;
  result_record community_route_attachment_ceremony_results%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'community_route_attachment_ceremony_results' THEN
    ceremony_id := NEW.ceremony_intent_id;
  ELSE
    ceremony_id := NEW.current_ceremony_intent_id;
  END IF;
  IF ceremony_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO state_record
    FROM community_route_attachment_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;
  SELECT * INTO result_record
    FROM community_route_attachment_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;
  IF state_record.attachment_intent_id IS NULL THEN
    IF TG_TABLE_NAME = 'community_route_attachment_ceremony_results' THEN
      RAISE EXCEPTION 'route attachment result does not match current requirement state';
    END IF;
    RETURN NULL;
  END IF;
  IF state_record.status IN ('satisfied', 'failed', 'expired') THEN
    IF result_record.ceremony_intent_id IS NULL
      OR result_record.actor_id <> state_record.actor_id
      OR result_record.attachment_intent_id <> state_record.attachment_intent_id
      OR result_record.requirement_kind <> state_record.requirement_kind
      OR result_record.generation <> state_record.generation
      OR result_record.outcome_status <> state_record.status
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at THEN
      RAISE EXCEPTION 'route attachment terminal result does not match requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal route attachment requirement cannot have a result';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_route_attachment_requirement_result_state_guard
AFTER INSERT OR UPDATE ON community_route_attachment_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_result();

CREATE CONSTRAINT TRIGGER community_route_attachment_result_state_guard
AFTER INSERT ON community_route_attachment_ceremony_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_result();

CREATE TABLE community_route_attachment_intent_revisions (
  attachment_intent_id TEXT NOT NULL REFERENCES community_route_attachment_intents (attachment_intent_id),
  revision BIGINT NOT NULL CHECK (revision > 0),
  actor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN ('create', 'verification', 'commit', 'expire', 'cancel')
  ),
  idempotency_key TEXT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL,
  state_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attachment_intent_id, revision),
  CONSTRAINT community_route_attachment_intent_revisions_operation_shape CHECK (
    (operation_kind IN ('create', 'commit') AND idempotency_key IS NOT NULL)
    OR (operation_kind NOT IN ('create', 'commit') AND idempotency_key IS NULL)
  )
);

CREATE UNIQUE INDEX community_route_attachment_intent_replay_uidx
  ON community_route_attachment_intent_revisions (actor_id, operation_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER community_route_attachment_revision_append_only
BEFORE UPDATE OR DELETE ON community_route_attachment_intent_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

ALTER TABLE community_route_ownership_evidence
  ADD COLUMN route_attachment_ceremony_intent_id TEXT;

ALTER TABLE community_route_ownership_evidence
  DROP CONSTRAINT community_route_ownership_evidence_origin_shape,
  ADD CONSTRAINT community_route_ownership_evidence_origin_shape CHECK (
    (
      origin = 'creation_ceremony'
      AND creation_ceremony_intent_id IS NOT NULL
      AND route_revalidation_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND verified_by_actor_id IS NOT NULL
    )
    OR (
      origin = 'route_revalidation'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NOT NULL
      AND route_attachment_ceremony_intent_id IS NULL
      AND verified_by_actor_id IS NULL
    )
    OR (
      origin = 'route_attachment'
      AND creation_ceremony_intent_id IS NULL
      AND route_revalidation_attempt_id IS NULL
      AND route_attachment_ceremony_intent_id IS NOT NULL
      AND verified_by_actor_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT community_route_ownership_evidence_attachment_ceremony_fk
    FOREIGN KEY (route_attachment_ceremony_intent_id)
    REFERENCES community_route_attachment_ceremony_attempts (ceremony_intent_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX community_route_ownership_evidence_attachment_ceremony_uidx
  ON community_route_ownership_evidence (route_attachment_ceremony_intent_id)
  WHERE origin = 'route_attachment';

DROP TRIGGER community_route_ownership_evidence_insert_guard
  ON community_route_ownership_evidence;

CREATE TRIGGER community_route_ownership_evidence_insert_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW
WHEN (NEW.origin IN ('creation_ceremony', 'route_revalidation'))
EXECUTE FUNCTION validate_community_route_ownership_evidence_insert();

CREATE FUNCTION validate_community_route_attachment_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent_record community_route_attachment_intents%ROWTYPE;
  attempt_record community_route_attachment_ceremony_attempts%ROWTYPE;
  result_record community_route_attachment_ceremony_results%ROWTYPE;
  state_record community_route_attachment_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record
    FROM community_route_attachment_ceremony_attempts
   WHERE ceremony_intent_id = NEW.route_attachment_ceremony_intent_id;
  SELECT * INTO intent_record
    FROM community_route_attachment_intents
   WHERE attachment_intent_id = attempt_record.attachment_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_route_attachment_requirement_states
   WHERE attachment_intent_id = attempt_record.attachment_intent_id
     AND requirement_kind = attempt_record.requirement_kind
   FOR SHARE;
  SELECT * INTO result_record
    FROM community_route_attachment_ceremony_results
   WHERE ceremony_intent_id = attempt_record.ceremony_intent_id;
  IF intent_record.attachment_intent_id IS NULL
    OR intent_record.actor_id <> attempt_record.actor_id
    OR intent_record.status NOT IN ('verification_required', 'commit_ready')
    OR attempt_record.ceremony_intent_id IS NULL
    OR state_record.attachment_intent_id IS NULL
    OR state_record.status <> 'satisfied'
    OR state_record.generation <> attempt_record.generation
    OR state_record.current_ceremony_intent_id <> attempt_record.ceremony_intent_id
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.outcome_status <> 'satisfied'
    OR result_record.evidence_ref <> NEW.evidence_ref
    OR result_record.evidence_digest <> NEW.evidence_digest
    OR result_record.provider_identity_digest <> NEW.provider_identity_digest
    OR result_record.satisfied_at <> NEW.verified_at
    OR NEW.verified_by_actor_id <> attempt_record.actor_id
    OR NEW.family <> attempt_record.family
    OR NEW.root_label <> attempt_record.root_label
    OR NEW.root_label_display <> attempt_record.root_label_display
    OR NEW.path_segment <> attempt_record.path_segment
    OR NEW.requirement_hash <> attempt_record.requirement_hash
    OR NEW.provider_id <> attempt_record.provider_id
    OR NEW.provider_binding_hash <> attempt_record.provider_binding_hash
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
    OR NEW.binding_generation <> attempt_record.generation THEN
    RAISE EXCEPTION 'route ownership evidence does not match its attachment ceremony';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_evidence_insert_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW
WHEN (NEW.origin = 'route_attachment')
EXECUTE FUNCTION validate_community_route_attachment_evidence_insert();

CREATE FUNCTION validate_community_route_attachment_binding_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  attempt_record community_route_attachment_ceremony_attempts%ROWTYPE;
  intent_record community_route_attachment_intents%ROWTYPE;
BEGIN
  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = NEW.verified_evidence_ref;
  IF evidence_record.evidence_ref IS NULL
    OR evidence_record.origin <> 'route_attachment' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO attempt_record
    FROM community_route_attachment_ceremony_attempts
   WHERE ceremony_intent_id = evidence_record.route_attachment_ceremony_intent_id;
  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id
   FOR UPDATE;
  SELECT * INTO intent_record
    FROM community_route_attachment_intents
   WHERE attachment_intent_id = attempt_record.attachment_intent_id
   FOR SHARE;
  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR community_record.canonical_route_binding_id IS NOT NULL
    OR intent_record.attachment_intent_id IS NULL
    OR intent_record.community_id <> NEW.community_id
    OR intent_record.status <> 'commit_ready'
    OR intent_record.committed_route_binding_id IS NOT NULL
    OR attempt_record.actor_id <> intent_record.actor_id
    OR evidence_record.family <> NEW.family
    OR evidence_record.root_label <> NEW.root_label
    OR evidence_record.root_label_display <> NEW.root_label_display
    OR evidence_record.path_segment <> NEW.path_segment
    OR evidence_record.binding_generation <> NEW.binding_generation
    OR NEW.ownership_status <> 'verified'
    OR NEW.route_lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'route attachment commit requires the community to remain unrouted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_binding_insert_guard
BEFORE INSERT ON community_canonical_route_bindings
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_binding_insert();

ALTER TABLE community_route_attachment_ceremony_results
  ADD CONSTRAINT community_route_attachment_ceremony_results_evidence_fk
  FOREIGN KEY (evidence_ref)
  REFERENCES community_route_ownership_evidence (evidence_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION validate_community_route_attachment_requirement_cardinality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checked_intent_id TEXT;
  requirement_count BIGINT;
BEGIN
  checked_intent_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.attachment_intent_id
    ELSE NEW.attachment_intent_id
  END;
  IF NOT EXISTS (
    SELECT 1 FROM community_route_attachment_intents
     WHERE attachment_intent_id = checked_intent_id
  ) THEN
    RETURN NULL;
  END IF;
  SELECT COUNT(*) INTO requirement_count
    FROM community_route_attachment_requirement_states
   WHERE attachment_intent_id = checked_intent_id
     AND requirement_kind = 'namespace_ownership';
  IF requirement_count <> 1 THEN
    RAISE EXCEPTION 'route attachment requires exactly one namespace ownership requirement row';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_route_attachment_intent_requirement_cardinality
AFTER INSERT OR UPDATE ON community_route_attachment_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_cardinality();

CREATE CONSTRAINT TRIGGER community_route_attachment_requirement_cardinality
AFTER INSERT OR UPDATE OR DELETE ON community_route_attachment_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_cardinality();

CREATE FUNCTION guard_community_route_attachment_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  grant_record community_route_authority_grants%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  attempt_record community_route_attachment_ceremony_attempts%ROWTYPE;
  result_record community_route_attachment_ceremony_results%ROWTYPE;
  state_record community_route_attachment_requirement_states%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.attachment_intent_id,
    NEW.community_id,
    NEW.actor_id,
    NEW.authority_grant_id,
    NEW.create_idempotency_key,
    NEW.create_request_hash,
    NEW.family,
    NEW.root_label,
    NEW.root_label_display,
    NEW.requirement_hash,
    NEW.provider_id,
    NEW.provider_binding_hash,
    NEW.provider_configuration_kind,
    NEW.provider_configuration_ref,
    NEW.provider_configuration_version,
    NEW.protocol_version,
    NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.attachment_intent_id,
    OLD.community_id,
    OLD.actor_id,
    OLD.authority_grant_id,
    OLD.create_idempotency_key,
    OLD.create_request_hash,
    OLD.family,
    OLD.root_label,
    OLD.root_label_display,
    OLD.requirement_hash,
    OLD.provider_id,
    OLD.provider_binding_hash,
    OLD.provider_configuration_kind,
    OLD.provider_configuration_ref,
    OLD.provider_configuration_version,
    OLD.protocol_version,
    OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route attachment authority and requested root are immutable';
  END IF;

  IF TG_OP = 'INSERT'
    AND (NEW.revision <> 1 OR NEW.status <> 'verification_required') THEN
    RAISE EXCEPTION 'route attachment must begin at revision one awaiting verification';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.revision <> OLD.revision + 1
    OR OLD.status IN ('committed', 'failed', 'expired', 'cancelled')
    OR NOT (
      (OLD.status = 'verification_required'
        AND NEW.status IN (
          'verification_required', 'commit_ready', 'failed', 'expired', 'cancelled'
        ))
      OR (OLD.status = 'commit_ready'
        AND NEW.status IN ('committed', 'failed', 'expired', 'cancelled'))
    )
  ) THEN
    RAISE EXCEPTION 'route attachment intent transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id;
  SELECT * INTO grant_record
    FROM community_route_authority_grants
   WHERE grant_id = NEW.authority_grant_id;

  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR grant_record.grant_id IS NULL
    OR grant_record.community_id <> NEW.community_id
    OR grant_record.principal_user_id <> NEW.actor_id
    OR grant_record.authority <> 'manage_routes'
    OR grant_record.status <> 'active' THEN
    RAISE EXCEPTION 'route attachment requires active community manage_routes authority';
  END IF;

  IF TG_OP = 'INSERT' AND community_record.canonical_route_binding_id IS NOT NULL THEN
    RAISE EXCEPTION 'route attachment is only available to an unrouted community';
  END IF;

  IF NEW.status <> 'committed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = NEW.committed_route_binding_id
     AND community_id = NEW.community_id;
  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  SELECT * INTO attempt_record
    FROM community_route_attachment_ceremony_attempts
   WHERE ceremony_intent_id = evidence_record.route_attachment_ceremony_intent_id;
  SELECT * INTO result_record
    FROM community_route_attachment_ceremony_results
   WHERE ceremony_intent_id = attempt_record.ceremony_intent_id;
  SELECT * INTO state_record
    FROM community_route_attachment_requirement_states
   WHERE attachment_intent_id = NEW.attachment_intent_id
     AND requirement_kind = 'namespace_ownership';
  IF binding_record.route_binding_id IS NULL
    OR community_record.canonical_route_binding_id <> binding_record.route_binding_id
    OR binding_record.family <> NEW.family
    OR binding_record.root_label <> NEW.root_label
    OR binding_record.root_label_display <> NEW.root_label_display
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR evidence_record.origin <> 'route_attachment'
    OR evidence_record.route_attachment_ceremony_intent_id IS NULL
    OR attempt_record.ceremony_intent_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR state_record.attachment_intent_id IS NULL
    OR attempt_record.attachment_intent_id <> NEW.attachment_intent_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR result_record.attachment_intent_id <> NEW.attachment_intent_id
    OR result_record.outcome_status <> 'satisfied'
    OR result_record.evidence_ref <> evidence_record.evidence_ref
    OR result_record.evidence_digest <> evidence_record.evidence_digest
    OR result_record.provider_identity_digest <> evidence_record.provider_identity_digest
    OR state_record.status <> 'satisfied'
    OR state_record.generation <> attempt_record.generation
    OR state_record.current_ceremony_intent_id <> attempt_record.ceremony_intent_id
    OR evidence_record.family <> binding_record.family
    OR evidence_record.root_label <> binding_record.root_label
    OR evidence_record.root_label_display <> binding_record.root_label_display
    OR evidence_record.path_segment <> binding_record.path_segment
    OR evidence_record.binding_generation <> binding_record.binding_generation
    OR evidence_record.verified_at > clock_timestamp()
    OR (evidence_record.expires_at IS NOT NULL AND evidence_record.expires_at <= clock_timestamp())
    OR NEW.committed_resource <> jsonb_build_object(
      'authority_version', 'optional_route_v2',
      'community_id', NEW.community_id,
      'href', '/c/' || NEW.community_id,
      'canonical_route', jsonb_build_object(
        'family', binding_record.family,
        'root_label', binding_record.root_label,
        'root_label_display', binding_record.root_label_display,
        'path_segment', binding_record.path_segment,
        'href', binding_record.href,
        'app_host', NULL
      )
    ) THEN
    RAISE EXCEPTION 'committed route attachment lacks matching active verified authority';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_attachment_intent_guard
BEFORE INSERT OR UPDATE ON community_route_attachment_intents
FOR EACH ROW EXECUTE FUNCTION guard_community_route_attachment_intent();

CREATE FUNCTION validate_optional_route_v2_committed_community()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  human_count BIGINT;
  membership_count BIGINT;
  authority_count BIGINT;
  claim_count BIGINT;
BEGIN
  IF NEW.creation_contract_version <> 'optional_route_v2'
    OR NEW.status <> 'committed' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.committed_community_id;
  IF community_record.community_id IS NULL
    OR community_record.status <> 'active'
    OR community_record.route_authority_version <> 'optional_route_v2'
    OR community_record.created_by_user_id <> NEW.actor_id
    OR community_record.canonical_route_binding_id IS NOT NULL
    OR NEW.committed_resource_href <> '/c/' || community_record.community_id THEN
    RAISE EXCEPTION 'optional-route-v2 commit requires an active unrouted generated-id community';
  END IF;

  SELECT COUNT(*) INTO human_count
    FROM community_creation_requirement_states
   WHERE intent_id = NEW.intent_id
     AND actor_id = NEW.actor_id
     AND requirement_kind = 'human_identity'
     AND status = 'satisfied';
  SELECT COUNT(*) INTO membership_count
    FROM community_memberships
   WHERE community_id = community_record.community_id
     AND user_id = NEW.actor_id
     AND status = 'member';
  SELECT COUNT(*) INTO authority_count
    FROM community_route_authority_grants
   WHERE community_id = community_record.community_id
     AND principal_user_id = NEW.actor_id
     AND authority = 'manage_routes'
     AND source_kind = 'creator_owner'
     AND status = 'active';
  SELECT COUNT(*) INTO claim_count
    FROM community_creation_subject_claims AS claim
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = claim.evidence_receipt_id
     AND receipt.proof_session_id = claim.proof_session_id
     AND receipt.user_id = NEW.actor_id
    JOIN active_subject_key_bindings AS active_binding
      ON active_binding.subject_key_id = claim.subject_key_id
     AND active_binding.user_id = NEW.actor_id
     AND active_binding.binding_event_id = receipt.subject_binding_event_id
     AND active_binding.binding_epoch = receipt.subject_binding_epoch
   WHERE claim.intent_id = NEW.intent_id
     AND claim.community_id = community_record.community_id
     AND claim.actor_id = NEW.actor_id
     AND claim.verification_requirement_hash = NEW.verification_requirement_hash
     AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp());

  IF human_count <> 1
    OR membership_count <> 1
    OR authority_count <> 1
    OR claim_count <> 1 THEN
    RAISE EXCEPTION 'optional-route-v2 commit lacks human, membership, quota, or route authority state';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_creation_optional_route_v2_commit_guard
AFTER INSERT OR UPDATE ON community_creation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_optional_route_v2_committed_community();

CREATE OR REPLACE FUNCTION active_community_effect(
  expected_community_id TEXT,
  expected_user_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM communities AS community
      JOIN community_memberships AS membership
        ON membership.community_id = community.community_id
       AND membership.user_id = expected_user_id
       AND membership.status = 'member'
     WHERE community.community_id = expected_community_id
       AND community.status = 'active'
  )
$$;

COMMENT ON FUNCTION active_community_effect(TEXT, TEXT) IS
  'Generic active-community effect: active community plus active membership only. Posting, moderation, and voting repositories retain their effect-specific policy checks.';
