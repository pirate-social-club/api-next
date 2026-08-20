-- Canonical community-route authority and two independently fenced creation
-- requirements. This is the additive half of the clean break: legacy
-- communities.route_slug and the single-requirement creation columns remain
-- physically present until the runtime cutover migration.

-- SQL owns the protocol-syntactic ACE envelope. The application-owned,
-- exact-pinned route-label-codec-v1 additionally proves ACE/display/ACE
-- round-trip equality before any write; PostgreSQL cannot express that
-- Unicode-versioned invariant in a CHECK constraint.
CREATE FUNCTION is_community_route_root_label(
  route_family TEXT,
  root_label TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE route_family
    WHEN 'hns' THEN
      octet_length(root_label) BETWEEN 1 AND 63
      AND root_label ~ '^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$'
      AND root_label NOT IN ('example', 'invalid', 'local', 'localhost', 'test')
    WHEN 'spaces' THEN
      octet_length(root_label) BETWEEN 1 AND 62
      AND root_label ~ '^[a-z0-9-]+$'
      AND CASE
        WHEN left(root_label, 4) = 'xn--' AND octet_length(root_label) > 4
          THEN substring(root_label FROM 5)
        ELSE root_label
      END ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    ELSE FALSE
  END;
$$;

CREATE FUNCTION is_community_route_root_label_display(root_label_display TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT octet_length(root_label_display) BETWEEN 1 AND 255
    AND root_label_display = btrim(root_label_display)
    AND root_label_display !~ '[[:cntrl:]]'
    AND position('@' IN root_label_display) = 0
    AND position('.' IN root_label_display) = 0
    AND position('%' IN root_label_display) = 0
    AND position('/' IN root_label_display) = 0
    AND position(E'\\' IN root_label_display) = 0;
$$;

CREATE TABLE community_creation_requirement_states (
  intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  status TEXT NOT NULL
    CHECK (status IN ('unmet', 'pending', 'satisfied', 'failed', 'expired')),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  route_family TEXT CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT,
  route_root_label_display TEXT,
  route_path_segment TEXT,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_ceremony_intent_id TEXT,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (intent_id, requirement_kind),
  CONSTRAINT community_creation_requirement_states_actor_intent_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_requirement_states_identifiers_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_requirement_states_route_shape CHECK (
    (
      requirement_kind = 'human_identity'
      AND route_family IS NULL
      AND route_root_label IS NULL
      AND route_root_label_display IS NULL
      AND route_path_segment IS NULL
    )
    OR (
      requirement_kind = 'namespace_ownership'
      AND route_family IS NOT NULL
      AND route_root_label IS NOT NULL
      AND route_root_label_display IS NOT NULL
      AND route_path_segment IS NOT NULL
      AND is_community_route_root_label(route_family, route_root_label) IS TRUE
      AND is_community_route_root_label_display(route_root_label_display) IS TRUE
      AND route_path_segment = CASE route_family
        WHEN 'hns' THEN 'app.' || route_root_label
        WHEN 'spaces' THEN '@' || route_root_label
      END
    )
  ),
  CONSTRAINT community_creation_requirement_states_progress_shape CHECK (
    (
      status = 'unmet'
      AND current_ceremony_intent_id IS NULL
      AND satisfied_at IS NULL
    )
    OR (
      status IN ('pending', 'failed', 'expired')
      AND generation > 0
      AND current_ceremony_intent_id IS NOT NULL
      AND btrim(current_ceremony_intent_id) <> ''
      AND current_ceremony_intent_id = btrim(current_ceremony_intent_id)
      AND satisfied_at IS NULL
    )
    OR (
      status = 'satisfied'
      AND generation > 0
      AND current_ceremony_intent_id IS NOT NULL
      AND btrim(current_ceremony_intent_id) <> ''
      AND current_ceremony_intent_id = btrim(current_ceremony_intent_id)
      AND satisfied_at IS NOT NULL
    )
  ),
  CONSTRAINT community_creation_requirement_states_time_order
    CHECK (updated_at >= created_at)
);

CREATE TABLE community_creation_ceremony_attempts (
  ceremony_intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  route_family TEXT CHECK (route_family IN ('hns', 'spaces')),
  route_root_label TEXT,
  route_root_label_display TEXT,
  route_path_segment TEXT,
  reservation_request_hash TEXT NOT NULL
    CHECK (reservation_request_hash ~ '^[0-9a-f]{64}$'),
  reservation_request JSONB NOT NULL CHECK (jsonb_typeof(reservation_request) = 'object'),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_ceremony_attempts_identity_unique
    UNIQUE (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id),
  CONSTRAINT community_creation_ceremony_attempts_actor_ceremony_unique
    UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT community_creation_ceremony_attempts_generation_unique
    UNIQUE (intent_id, requirement_kind, generation),
  CONSTRAINT community_creation_ceremony_attempts_state_fk
    FOREIGN KEY (intent_id, requirement_kind)
    REFERENCES community_creation_requirement_states (intent_id, requirement_kind),
  CONSTRAINT community_creation_ceremony_attempts_actor_intent_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_ceremony_attempts_identifiers_not_blank CHECK (
    btrim(ceremony_intent_id) <> ''
    AND ceremony_intent_id = btrim(ceremony_intent_id)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_ceremony_attempts_route_shape CHECK (
    (
      requirement_kind = 'human_identity'
      AND route_family IS NULL
      AND route_root_label IS NULL
      AND route_root_label_display IS NULL
      AND route_path_segment IS NULL
    )
    OR (
      requirement_kind = 'namespace_ownership'
      AND route_family IS NOT NULL
      AND route_root_label IS NOT NULL
      AND route_root_label_display IS NOT NULL
      AND route_path_segment IS NOT NULL
      AND is_community_route_root_label(route_family, route_root_label) IS TRUE
      AND is_community_route_root_label_display(route_root_label_display) IS TRUE
      AND route_path_segment = CASE route_family
        WHEN 'hns' THEN 'app.' || route_root_label
        WHEN 'spaces' THEN '@' || route_root_label
      END
    )
  ),
  CONSTRAINT community_creation_ceremony_attempts_time_order CHECK (
    expires_at > reserved_at
    AND created_at >= reserved_at
  )
);

ALTER TABLE community_creation_requirement_states
  ADD CONSTRAINT community_creation_requirement_states_current_ceremony_fk
  FOREIGN KEY (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    current_ceremony_intent_id
  )
  REFERENCES community_creation_ceremony_attempts (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  )
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE verification_start_reservations
  ADD COLUMN creation_intent_id TEXT,
  ADD COLUMN creation_requirement_kind TEXT,
  ADD COLUMN creation_generation BIGINT,
  ADD COLUMN client_idempotency_key TEXT,
  ADD CONSTRAINT verification_start_reservations_creation_shape CHECK (
    (
      creation_intent_id IS NULL
      AND creation_requirement_kind IS NULL
      AND creation_generation IS NULL
      AND client_idempotency_key IS NULL
    )
    OR (
      creation_intent_id IS NOT NULL
      AND creation_requirement_kind IN ('human_identity', 'namespace_ownership')
      AND creation_generation > 0
      AND client_idempotency_key IS NOT NULL
      AND btrim(client_idempotency_key) <> ''
      AND client_idempotency_key = btrim(client_idempotency_key)
    )
  ),
  ADD CONSTRAINT verification_start_reservations_creation_ceremony_fk
  FOREIGN KEY (
    actor_id,
    creation_intent_id,
    creation_requirement_kind,
    creation_generation,
    intent_id
  )
  REFERENCES community_creation_ceremony_attempts (
    actor_id,
    intent_id,
    requirement_kind,
    generation,
    ceremony_intent_id
  );

CREATE UNIQUE INDEX verification_start_reservations_creation_idempotency_uidx
  ON verification_start_reservations (
    actor_id,
    creation_intent_id,
    creation_requirement_kind,
    client_idempotency_key
  )
  WHERE creation_intent_id IS NOT NULL;

ALTER TABLE proof_sessions
  ADD COLUMN creation_ceremony_intent_id TEXT UNIQUE
    REFERENCES community_creation_ceremony_attempts (ceremony_intent_id),
  ADD CONSTRAINT proof_sessions_creation_ceremony_actor_fk
    FOREIGN KEY (actor_id, creation_ceremony_intent_id)
    REFERENCES community_creation_ceremony_attempts (actor_id, ceremony_intent_id),
  ADD CONSTRAINT proof_sessions_creation_ceremony_identity CHECK (
    creation_ceremony_intent_id IS NULL
    OR creation_ceremony_intent_id = intent_id
  );

CREATE TABLE community_creation_ceremony_results (
  ceremony_intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  requirement_kind TEXT NOT NULL
    CHECK (requirement_kind IN ('human_identity', 'namespace_ownership')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_version TEXT NOT NULL,
  callback_idempotency_key TEXT NOT NULL,
  callback_request_hash TEXT NOT NULL CHECK (callback_request_hash ~ '^[0-9a-f]{64}$'),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('satisfied', 'failed', 'expired')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  proof_session_id TEXT UNIQUE REFERENCES proof_sessions (proof_session_id),
  evidence_receipt_id TEXT,
  evidence_ref TEXT,
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_identity_digest TEXT
    CHECK (provider_identity_digest IS NULL OR provider_identity_digest ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ NOT NULL,
  satisfied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_ceremony_results_attempt_fk
    FOREIGN KEY (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id)
    REFERENCES community_creation_ceremony_attempts (
      actor_id,
      intent_id,
      requirement_kind,
      generation,
      ceremony_intent_id
    ),
  CONSTRAINT community_creation_ceremony_results_receipt_actor_fk
    FOREIGN KEY (evidence_receipt_id, actor_id)
    REFERENCES evidence_receipts (evidence_receipt_id, user_id),
  CONSTRAINT community_creation_ceremony_results_identifiers_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(callback_idempotency_key) <> ''
    AND callback_idempotency_key = btrim(callback_idempotency_key)
    AND (evidence_ref IS NULL OR (btrim(evidence_ref) <> '' AND evidence_ref = btrim(evidence_ref)))
  ),
  CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK (
    (
      outcome_status = 'satisfied'
      AND evidence_ref IS NOT NULL
      AND evidence_digest IS NOT NULL
      AND provider_identity_digest IS NOT NULL
      AND satisfied_at IS NOT NULL
      AND (requirement_kind <> 'human_identity' OR evidence_receipt_id IS NOT NULL)
    )
    OR (
      outcome_status IN ('failed', 'expired')
      AND proof_session_id IS NULL
      AND evidence_receipt_id IS NULL
      AND evidence_ref IS NULL
      AND evidence_digest IS NULL
      AND provider_identity_digest IS NULL
      AND satisfied_at IS NULL
    )
  ),
  CONSTRAINT community_creation_ceremony_results_time_order CHECK (
    created_at >= terminal_at
    AND (satisfied_at IS NULL OR satisfied_at = terminal_at)
  )
);

CREATE UNIQUE INDEX community_creation_ceremony_results_callback_uidx
  ON community_creation_ceremony_results (
    actor_id,
    ceremony_intent_id,
    callback_idempotency_key
  );

CREATE TABLE community_route_ownership_evidence (
  evidence_ref TEXT PRIMARY KEY,
  creation_ceremony_intent_id TEXT NOT NULL
    REFERENCES community_creation_ceremony_attempts (ceremony_intent_id),
  verified_by_actor_id TEXT NOT NULL REFERENCES users (user_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  requirement_hash TEXT NOT NULL CHECK (requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_binding_hash TEXT NOT NULL CHECK (provider_binding_hash ~ '^[0-9a-f]{64}$'),
  provider_configuration_version TEXT NOT NULL,
  provider_identity_digest TEXT NOT NULL CHECK (provider_identity_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_receipt_id TEXT REFERENCES evidence_receipts (evidence_receipt_id),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_ownership_evidence_identifiers_not_blank CHECK (
    btrim(evidence_ref) <> ''
    AND evidence_ref = btrim(evidence_ref)
    AND btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_route_ownership_evidence_route_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ),
  CONSTRAINT community_route_ownership_evidence_time_order CHECK (
    created_at >= verified_at
    AND (expires_at IS NULL OR expires_at > verified_at)
  )
);

CREATE TABLE community_canonical_route_bindings (
  route_binding_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL UNIQUE REFERENCES communities (community_id),
  family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT GENERATED ALWAYS AS (
    CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  href TEXT GENERATED ALWAYS AS (
    '/c/' || CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  ownership_status TEXT NOT NULL
    CHECK (ownership_status IN ('pending', 'verified', 'expired', 'disputed', 'revoked')),
  route_lifecycle_status TEXT NOT NULL DEFAULT 'suspended'
    CHECK (route_lifecycle_status IN ('active', 'suspended')),
  binding_generation BIGINT NOT NULL DEFAULT 1 CHECK (binding_generation > 0),
  verified_evidence_ref TEXT REFERENCES community_route_ownership_evidence (evidence_ref),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_canonical_route_bindings_id_not_blank CHECK (
    btrim(route_binding_id) <> ''
    AND route_binding_id = btrim(route_binding_id)
  ),
  CONSTRAINT community_canonical_route_bindings_root_shape CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
  ),
  CONSTRAINT community_canonical_route_bindings_active_shape CHECK (
    route_lifecycle_status <> 'active'
    OR (ownership_status = 'verified' AND verified_evidence_ref IS NOT NULL)
  ),
  CONSTRAINT community_canonical_route_bindings_time_order
    CHECK (updated_at >= created_at),
  CONSTRAINT community_canonical_route_bindings_id_family_unique
    UNIQUE (route_binding_id, family),
  CONSTRAINT community_canonical_route_bindings_community_id_unique
    UNIQUE (community_id, route_binding_id),
  CONSTRAINT community_canonical_route_bindings_path_unique UNIQUE (path_segment)
);

ALTER TABLE communities
  ADD COLUMN canonical_route_binding_id TEXT,
  ADD CONSTRAINT communities_canonical_route_binding_fk
  FOREIGN KEY (community_id, canonical_route_binding_id)
  REFERENCES community_canonical_route_bindings (community_id, route_binding_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE community_route_app_host_health (
  route_binding_id TEXT PRIMARY KEY,
  family TEXT NOT NULL DEFAULT 'hns' CHECK (family = 'hns'),
  health_status TEXT NOT NULL
    CHECK (health_status IN ('unconfigured', 'pending', 'healthy', 'unhealthy', 'stale')),
  health_generation BIGINT NOT NULL DEFAULT 0 CHECK (health_generation >= 0),
  observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_route_app_host_health_route_fk
    FOREIGN KEY (route_binding_id, family)
    REFERENCES community_canonical_route_bindings (route_binding_id, family)
);

CREATE OR REPLACE FUNCTION guard_community_creation_requirement_state_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_changed BOOLEAN;
BEGIN
  IF ROW(NEW.intent_id, NEW.actor_id, NEW.requirement_kind, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.intent_id, OLD.actor_id, OLD.requirement_kind, OLD.created_at) THEN
    RAISE EXCEPTION 'community creation requirement identity is immutable';
  END IF;

  binding_changed := ROW(
    NEW.requirement_hash,
    NEW.provider_id,
    NEW.provider_binding_hash,
    NEW.provider_configuration_kind,
    NEW.provider_configuration_ref,
    NEW.provider_configuration_version,
    NEW.route_family,
    NEW.route_root_label,
    NEW.route_root_label_display,
    NEW.route_path_segment
  ) IS DISTINCT FROM ROW(
    OLD.requirement_hash,
    OLD.provider_id,
    OLD.provider_binding_hash,
    OLD.provider_configuration_kind,
    OLD.provider_configuration_ref,
    OLD.provider_configuration_version,
    OLD.route_family,
    OLD.route_root_label,
    OLD.route_root_label_display,
    OLD.route_path_segment
  );

  IF binding_changed THEN
    IF NEW.status <> 'unmet'
      OR NEW.generation <> OLD.generation
      OR NEW.current_ceremony_intent_id IS NOT NULL
      OR NEW.satisfied_at IS NOT NULL THEN
      RAISE EXCEPTION 'changed requirement binding must invalidate current evidence';
    END IF;
    RETURN NEW;
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
    RAISE EXCEPTION 'community creation requirement transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_requirement_state_update_guard
BEFORE UPDATE ON community_creation_requirement_states
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_requirement_state_update();

CREATE TRIGGER community_creation_requirement_state_delete_guard
BEFORE DELETE ON community_creation_requirement_states
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE intent_id = NEW.intent_id
     AND requirement_kind = NEW.requirement_kind
   FOR UPDATE;

  IF NOT FOUND
    OR state_record.actor_id <> NEW.actor_id
    OR state_record.status NOT IN ('unmet', 'failed', 'expired')
    OR NEW.generation <> state_record.generation + 1
    OR NEW.requirement_hash <> state_record.requirement_hash
    OR NEW.provider_id <> state_record.provider_id
    OR NEW.provider_binding_hash <> state_record.provider_binding_hash
    OR NEW.provider_configuration_kind <> state_record.provider_configuration_kind
    OR NEW.provider_configuration_ref <> state_record.provider_configuration_ref
    OR NEW.provider_configuration_version <> state_record.provider_configuration_version
    OR NEW.route_family IS DISTINCT FROM state_record.route_family
    OR NEW.route_root_label IS DISTINCT FROM state_record.route_root_label
    OR NEW.route_root_label_display IS DISTINCT FROM state_record.route_root_label_display
    OR NEW.route_path_segment IS DISTINCT FROM state_record.route_path_segment THEN
    RAISE EXCEPTION 'ceremony reservation does not match the current requirement binding';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_ceremony_attempt_insert_guard
BEFORE INSERT ON community_creation_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_attempt_insert();

CREATE TRIGGER community_creation_ceremony_attempt_append_only
BEFORE UPDATE OR DELETE ON community_creation_ceremony_attempts
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_ceremony_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record proof_sessions%ROWTYPE;
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

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO session_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_configuration_kind <>
        attempt_record.provider_configuration_kind
      OR session_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR session_record.provider_configuration_version <>
        attempt_record.provider_configuration_version THEN
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
      OR receipt_record.provider_configuration_kind <>
        attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <>
        attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <>
        attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_ceremony_result_insert_guard
BEFORE INSERT ON community_creation_ceremony_results
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_result_insert();

CREATE TRIGGER community_creation_ceremony_result_append_only
BEFORE UPDATE OR DELETE ON community_creation_ceremony_results
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_route_ownership_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
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
    OR NEW.verified_at <> result_record.satisfied_at THEN
    RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_route_ownership_evidence_insert_guard
BEFORE INSERT ON community_route_ownership_evidence
FOR EACH ROW EXECUTE FUNCTION validate_community_route_ownership_evidence_insert();

CREATE TRIGGER community_route_ownership_evidence_append_only
BEFORE UPDATE OR DELETE ON community_route_ownership_evidence
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN
      RETURN NULL;
    END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;

  IF NOT FOUND THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
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
      OR result_record.provider_configuration_version <>
        state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_creation_requirement_result_state_guard
AFTER INSERT OR UPDATE ON community_creation_requirement_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

CREATE CONSTRAINT TRIGGER community_creation_ceremony_result_state_guard
AFTER INSERT ON community_creation_ceremony_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

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
    NEW.created_at
  )
    IS DISTINCT FROM
    ROW(
      OLD.route_binding_id,
      OLD.community_id,
      OLD.family,
      OLD.root_label,
      OLD.root_label_display,
      OLD.created_at
    ) THEN
    RAISE EXCEPTION 'community canonical route identity is immutable';
  END IF;

  authority_changed := ROW(
    NEW.ownership_status,
    NEW.route_lifecycle_status,
    NEW.verified_evidence_ref
  ) IS DISTINCT FROM ROW(
    OLD.ownership_status,
    OLD.route_lifecycle_status,
    OLD.verified_evidence_ref
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

CREATE TRIGGER community_canonical_route_binding_update_guard
BEFORE UPDATE ON community_canonical_route_bindings
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE TRIGGER community_canonical_route_binding_delete_guard
BEFORE DELETE ON community_canonical_route_bindings
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE OR REPLACE FUNCTION guard_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.canonical_route_binding_id IS NOT NULL
    AND NEW.canonical_route_binding_id IS DISTINCT FROM OLD.canonical_route_binding_id THEN
    RAISE EXCEPTION 'community canonical route cannot be rebound or cleared';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_canonical_route_reference_guard
BEFORE UPDATE OF canonical_route_binding_id ON communities
FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_reference();

CREATE OR REPLACE FUNCTION validate_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  community_binding_id TEXT;
  binding_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    binding_id := NEW.canonical_route_binding_id;
    IF binding_id IS NULL THEN
      RETURN NULL;
    END IF;
  ELSE
    binding_id := NEW.route_binding_id;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community canonical route binding is missing';
  END IF;

  SELECT canonical_route_binding_id INTO community_binding_id
    FROM communities
   WHERE community_id = binding_record.community_id;
  IF community_binding_id IS DISTINCT FROM binding_record.route_binding_id THEN
    RAISE EXCEPTION 'community canonical route reference is not reciprocal';
  END IF;

  IF binding_record.route_lifecycle_status = 'active' THEN
    SELECT * INTO evidence_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = binding_record.verified_evidence_ref;
    IF NOT FOUND
      OR binding_record.ownership_status <> 'verified'
      OR evidence_record.family <> binding_record.family
      OR evidence_record.root_label <> binding_record.root_label
      OR evidence_record.root_label_display <> binding_record.root_label_display
      OR evidence_record.path_segment <> binding_record.path_segment
      OR evidence_record.binding_generation <> binding_record.binding_generation THEN
      RAISE EXCEPTION 'active community route lacks matching verified ownership evidence';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER community_canonical_route_reference_guard
AFTER INSERT OR UPDATE ON community_canonical_route_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

CREATE CONSTRAINT TRIGGER communities_canonical_route_binding_guard
AFTER INSERT OR UPDATE OF canonical_route_binding_id ON communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();
