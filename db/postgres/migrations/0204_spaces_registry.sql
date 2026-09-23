-- The private Spaces registry contract.
--
-- Spec 012 §5.3.13.5, §5.3.13.7, and §5.3.13.8, against the upstream wire of
-- subs 4dcc923 (`REGISTRY.md`). The operator host polls four private
-- endpoints; api-next never calls it. This migration stores the operator
-- credential verifiers, every delivery of a registry item, the applied
-- acknowledgments and the occupancy they report, commit hints, and scope
-- anomalies. It links external conflicts to their evidence and tightens the
-- registry-item guard: an item is withdrawn only while it has never been
-- delivered, redelivery is recorded as a higher delivery generation, and an
-- item settles only with an acknowledgment. No row here creates a grant, and
-- every composition that reads or writes these tables stays disabled.

-- Registry credentials (§5.3.13.5, ruling Q12). One bearer credential per
-- operator instance and environment, scoped to explicitly allowed spaces that
-- must also be currently assigned to the instance. Only a SHA-256 verifier of
-- the high-entropy token is stored. Rotation keeps one active and at most one
-- retiring credential, which is accepted until its bound. Credentials are
-- minted only by an authorized operator script; there is no HTTP surface.
CREATE FUNCTION spaces_registry_allowed_roots_valid_v1(input_roots TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT input_roots IS NOT NULL
     AND array_ndims(input_roots) = 1
     AND cardinality(input_roots) BETWEEN 1 AND 64
     AND array_position(input_roots, NULL) IS NULL
     AND (SELECT bool_and(is_community_route_root_label('spaces', root) IS TRUE)
            FROM unnest(input_roots) AS root)
     AND (SELECT count(DISTINCT root) FROM unnest(input_roots) AS root)
           = cardinality(input_roots)
$$;

CREATE TABLE spaces_registry_credentials (
  credential_id TEXT PRIMARY KEY,
  operator_instance_id TEXT NOT NULL
    REFERENCES spaces_operator_instances (operator_instance_id),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  allowed_roots TEXT[] NOT NULL,
  verifier_sha256_hex TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'retiring', 'revoked')),
  authorization_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  retiring_at TIMESTAMPTZ,
  accept_until TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT spaces_registry_credential_identity_check CHECK (
    credential_id ~ '^srcred_[0-9a-f]{32}$'
    AND verifier_sha256_hex ~ '^[0-9a-f]{64}$'
    AND spaces_registry_allowed_roots_valid_v1(allowed_roots)
    AND is_handle_sales_identifier_v1(authorization_reference, 512)
  ),
  CONSTRAINT spaces_registry_credential_status_shape CHECK (
    (status = 'active'
      AND retiring_at IS NULL
      AND accept_until IS NULL
      AND revoked_at IS NULL)
    OR ((status = 'retiring'
      AND retiring_at >= created_at
      AND accept_until > retiring_at
      AND revoked_at IS NULL) IS TRUE)
    OR ((status = 'revoked'
      AND revoked_at >= created_at
      AND (retiring_at IS NULL OR revoked_at >= retiring_at)) IS TRUE)
  )
);

CREATE UNIQUE INDEX spaces_registry_credentials_active_uidx
  ON spaces_registry_credentials (operator_instance_id, environment)
  WHERE status = 'active';

CREATE UNIQUE INDEX spaces_registry_credentials_retiring_uidx
  ON spaces_registry_credentials (operator_instance_id, environment)
  WHERE status = 'retiring';

-- A credential never changes its identity, scope, or verifier. It moves from
-- active to retiring or revoked, and from retiring to revoked, once each.
CREATE FUNCTION guard_spaces_registry_credential_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  instance spaces_operator_instances%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces registry credential cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO instance
      FROM spaces_operator_instances
     WHERE operator_instance_id = NEW.operator_instance_id
     FOR SHARE;
    IF instance.operator_instance_id IS NULL
      OR instance.status <> 'active'
      OR NEW.status <> 'active' THEN
      RAISE EXCEPTION 'Spaces registry credential must begin active on a live operator instance';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.credential_id,
    NEW.operator_instance_id,
    NEW.environment,
    NEW.allowed_roots,
    NEW.verifier_sha256_hex,
    NEW.authorization_reference,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.credential_id,
    OLD.operator_instance_id,
    OLD.environment,
    OLD.allowed_roots,
    OLD.verifier_sha256_hex,
    OLD.authorization_reference,
    OLD.created_at
  )
    OR OLD.status = 'revoked'
    OR NEW.status = 'active'
    OR (OLD.status = 'retiring' AND NEW.status <> 'revoked')
    OR (OLD.status = 'retiring' AND (
      NEW.retiring_at IS DISTINCT FROM OLD.retiring_at
      OR NEW.accept_until IS DISTINCT FROM OLD.accept_until
    )) THEN
    RAISE EXCEPTION 'Spaces registry credential transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_credential_guard
BEFORE INSERT OR UPDATE OR DELETE ON spaces_registry_credentials
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_credential_v1();

-- Delivery generations (§5.3.13.5). An item's delivery generation is zero
-- until a `/pending` response first includes it and rises by exactly one on
-- each redelivery; the page transaction records the delivery before the
-- response is sent. Undelivered and withdrawn items have never been delivered.
ALTER TABLE spaces_registry_items
  ADD COLUMN delivery_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN last_delivered_at TIMESTAMPTZ,
  ADD CONSTRAINT spaces_registry_item_delivery_shape CHECK (
    (delivery_generation >= 0 AND delivery_generation <= 9007199254740991)
    AND (delivery_generation = 0) = (last_delivered_at IS NULL)
    AND (state IN ('undelivered', 'withdrawn')) = (delivery_generation = 0)
    AND (last_delivered_at IS NULL OR last_delivered_at >= created_at)
  );

-- Oldest-first `/pending` selection for one space.
CREATE INDEX spaces_registry_items_pending_idx
  ON spaces_registry_items (network, namespace_root, created_at, claim_id)
  WHERE state IN ('undelivered', 'delivered');

-- One row per delivery of an item: the delivery generation, the credential
-- and operator instance that pulled it, and the operator-assignment
-- generation it was delivered under. Append-only.
CREATE TABLE spaces_registry_deliveries (
  claim_id TEXT NOT NULL REFERENCES spaces_registry_items (claim_id),
  delivery_generation BIGINT NOT NULL,
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES spaces_registry_credentials (credential_id),
  operator_instance_id TEXT NOT NULL
    REFERENCES spaces_operator_instances (operator_instance_id),
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_registry_deliveries_pk PRIMARY KEY (claim_id, delivery_generation),
  CONSTRAINT spaces_registry_delivery_assignment_fk FOREIGN KEY (
    operator_assignment_id,
    operator_assignment_generation
  ) REFERENCES spaces_operator_assignment_revisions (
    operator_assignment_id,
    operator_assignment_generation
  ),
  CONSTRAINT spaces_registry_delivery_generation_check CHECK (
    delivery_generation BETWEEN 1 AND 9007199254740991
  )
);

CREATE INDEX spaces_registry_deliveries_key_idx
  ON spaces_registry_deliveries (network, namespace_root, handle_label, operator_assignment_id);

CREATE FUNCTION guard_spaces_registry_delivery_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item spaces_registry_items%ROWTYPE;
  assignment spaces_operator_assignment_revisions%ROWTYPE;
  current_assignment spaces_operator_assignment_current%ROWTYPE;
  credential spaces_registry_credentials%ROWTYPE;
BEGIN
  SELECT * INTO item FROM spaces_registry_items WHERE claim_id = NEW.claim_id FOR SHARE;
  SELECT * INTO assignment
    FROM spaces_operator_assignment_revisions
   WHERE operator_assignment_id = NEW.operator_assignment_id
     AND operator_assignment_generation = NEW.operator_assignment_generation;
  SELECT * INTO current_assignment
    FROM spaces_operator_assignment_current
   WHERE operator_assignment_id = NEW.operator_assignment_id
   FOR SHARE;
  SELECT * INTO credential
    FROM spaces_registry_credentials
   WHERE credential_id = NEW.credential_id
   FOR SHARE;
  IF item.claim_id IS NULL
    OR item.state IS DISTINCT FROM 'delivered'
    OR item.delivery_generation IS DISTINCT FROM NEW.delivery_generation
    OR item.last_delivered_at IS DISTINCT FROM NEW.delivered_at
    OR item.network IS DISTINCT FROM NEW.network
    OR item.namespace_root IS DISTINCT FROM NEW.namespace_root
    OR item.handle_label IS DISTINCT FROM NEW.handle_label
    OR assignment.operator_assignment_id IS NULL
    OR assignment.status IS DISTINCT FROM 'active'
    OR assignment.network IS DISTINCT FROM NEW.network
    OR assignment.canonical_root IS DISTINCT FROM NEW.namespace_root
    OR assignment.operator_instance_id IS DISTINCT FROM NEW.operator_instance_id
    OR current_assignment.current_generation IS DISTINCT FROM NEW.operator_assignment_generation
    OR current_assignment.status IS DISTINCT FROM 'active'
    OR credential.credential_id IS NULL
    OR credential.operator_instance_id IS DISTINCT FROM NEW.operator_instance_id
    OR credential.status NOT IN ('active', 'retiring')
    OR NOT (NEW.namespace_root = ANY (credential.allowed_roots)) THEN
    RAISE EXCEPTION 'Spaces registry delivery must match its item, current assignment, and credential scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_delivery_insert_guard
BEFORE INSERT ON spaces_registry_deliveries
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_delivery_insert_v1();

CREATE TRIGGER spaces_registry_deliveries_append_only
BEFORE UPDATE OR DELETE ON spaces_registry_deliveries
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Applied acknowledgments (§5.3.13.7). Every upstream outcome is terminal, so
-- an item has at most one applied acknowledgment. It acknowledges the item's
-- latest delivery under the operator-assignment generation that delivery used;
-- stale generations and duplicates are never recorded. The row is the
-- acknowledgment observation that backs an external conflict.
CREATE TABLE spaces_registry_acknowledgments (
  acknowledgment_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL UNIQUE,
  delivery_generation BIGINT NOT NULL,
  network TEXT NOT NULL,
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'staged',
      'already_staged_same_spk',
      'already_committed_same_spk',
      'already_staged_different_spk',
      'already_committed_different_spk',
      'invalid'
    )
  ),
  credential_id TEXT NOT NULL REFERENCES spaces_registry_credentials (credential_id),
  operator_instance_id TEXT NOT NULL,
  operator_assignment_id TEXT NOT NULL,
  operator_assignment_generation BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_registry_acknowledgment_delivery_fk FOREIGN KEY (
    claim_id,
    delivery_generation
  ) REFERENCES spaces_registry_deliveries (claim_id, delivery_generation),
  CONSTRAINT spaces_registry_acknowledgment_key_unique UNIQUE (
    acknowledgment_id,
    network,
    namespace_root,
    handle_label
  ),
  CONSTRAINT spaces_registry_acknowledgment_identity_check CHECK (
    acknowledgment_id ~ '^srack_[0-9a-f]{32}$'
  )
);

CREATE FUNCTION guard_spaces_registry_acknowledgment_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item spaces_registry_items%ROWTYPE;
  delivery spaces_registry_deliveries%ROWTYPE;
  current_assignment spaces_operator_assignment_current%ROWTYPE;
  credential spaces_registry_credentials%ROWTYPE;
BEGIN
  SELECT * INTO item FROM spaces_registry_items WHERE claim_id = NEW.claim_id FOR SHARE;
  SELECT * INTO delivery
    FROM spaces_registry_deliveries
   WHERE claim_id = NEW.claim_id
     AND delivery_generation = NEW.delivery_generation;
  SELECT * INTO current_assignment
    FROM spaces_operator_assignment_current
   WHERE operator_assignment_id = NEW.operator_assignment_id
   FOR SHARE;
  SELECT * INTO credential
    FROM spaces_registry_credentials
   WHERE credential_id = NEW.credential_id
   FOR SHARE;
  IF item.claim_id IS NULL
    OR item.state NOT IN ('delivered', 'redelivery_stopped')
    OR item.delivery_generation IS DISTINCT FROM NEW.delivery_generation
    OR delivery.claim_id IS NULL
    OR delivery.network IS DISTINCT FROM NEW.network
    OR delivery.namespace_root IS DISTINCT FROM NEW.namespace_root
    OR delivery.handle_label IS DISTINCT FROM NEW.handle_label
    OR delivery.operator_instance_id IS DISTINCT FROM NEW.operator_instance_id
    OR delivery.operator_assignment_id IS DISTINCT FROM NEW.operator_assignment_id
    OR delivery.operator_assignment_generation IS DISTINCT FROM NEW.operator_assignment_generation
    OR current_assignment.current_generation IS DISTINCT FROM NEW.operator_assignment_generation
    OR current_assignment.status IS DISTINCT FROM 'active'
    OR credential.operator_instance_id IS DISTINCT FROM NEW.operator_instance_id
    OR credential.status NOT IN ('active', 'retiring')
    OR NEW.received_at < delivery.delivered_at THEN
    RAISE EXCEPTION 'Spaces registry acknowledgment must answer the latest delivery under the current assignment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_acknowledgment_insert_guard
BEFORE INSERT ON spaces_registry_acknowledgments
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_acknowledgment_insert_v1();

CREATE TRIGGER spaces_registry_acknowledgments_append_only
BEFORE UPDATE OR DELETE ON spaces_registry_acknowledgments
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Occupancy reported by an acknowledgment: whether the key is staged or
-- committed, and whether to the claim's own script or another one. Final
-- verification remains independent; an occupancy observation never grants.
CREATE TABLE spaces_registry_occupancy_observations (
  occupancy_observation_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'registry_acknowledgment_v1'),
  registry_acknowledgment_id TEXT NOT NULL UNIQUE,
  occupancy TEXT NOT NULL CHECK (occupancy IN ('staged', 'committed')),
  owner_relation TEXT NOT NULL CHECK (owner_relation IN ('same_script', 'different_script')),
  compared_script_pubkey_hex TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_registry_occupancy_acknowledgment_fk FOREIGN KEY (
    registry_acknowledgment_id,
    network,
    namespace_root,
    handle_label
  ) REFERENCES spaces_registry_acknowledgments (
    acknowledgment_id,
    network,
    namespace_root,
    handle_label
  ),
  CONSTRAINT spaces_registry_occupancy_key_unique UNIQUE (
    occupancy_observation_id,
    network,
    namespace_root,
    handle_label
  ),
  CONSTRAINT spaces_registry_occupancy_identity_check CHECK (
    occupancy_observation_id ~ '^srocc_[0-9a-f]{32}$'
    AND compared_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
    AND observed_at <= recorded_at
  )
);

CREATE FUNCTION guard_spaces_registry_occupancy_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  acknowledgment spaces_registry_acknowledgments%ROWTYPE;
  item spaces_registry_items%ROWTYPE;
BEGIN
  SELECT * INTO acknowledgment
    FROM spaces_registry_acknowledgments
   WHERE acknowledgment_id = NEW.registry_acknowledgment_id;
  SELECT * INTO item FROM spaces_registry_items WHERE claim_id = acknowledgment.claim_id;
  IF acknowledgment.acknowledgment_id IS NULL
    OR acknowledgment.outcome = 'invalid'
    OR NEW.occupancy IS DISTINCT FROM (CASE
      WHEN acknowledgment.outcome IN (
        'staged',
        'already_staged_same_spk',
        'already_staged_different_spk'
      ) THEN 'staged'
      ELSE 'committed'
    END)
    OR NEW.owner_relation IS DISTINCT FROM (CASE
      WHEN acknowledgment.outcome IN (
        'already_staged_different_spk',
        'already_committed_different_spk'
      ) THEN 'different_script'
      ELSE 'same_script'
    END)
    OR NEW.compared_script_pubkey_hex IS DISTINCT FROM item.script_pubkey_hex
    OR NEW.observed_at IS DISTINCT FROM acknowledgment.received_at THEN
    RAISE EXCEPTION 'Spaces registry occupancy must restate its acknowledgment';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_occupancy_insert_guard
BEFORE INSERT ON spaces_registry_occupancy_observations
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_occupancy_insert_v1();

CREATE TRIGGER spaces_registry_occupancy_observations_append_only
BEFORE UPDATE OR DELETE ON spaces_registry_occupancy_observations
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- The evidence link for external conflicts (§5.3.13.8). A conflict is backed by
-- exactly one observation of its own key: the acknowledgment for a registry
-- outcome, or an occupancy observation. It never stands on a timeout, a
-- missing response, or an unverified report.
ALTER TABLE spaces_external_conflict_observations
  ADD COLUMN registry_acknowledgment_id TEXT,
  ADD COLUMN occupancy_observation_id TEXT,
  ADD CONSTRAINT spaces_external_conflict_evidence_shape CHECK (
    ((evidence_kind = 'registry_acknowledgment_v1'
      AND registry_acknowledgment_id IS NOT NULL
      AND occupancy_observation_id IS NULL) IS TRUE)
    OR ((evidence_kind = 'occupancy_observation_v1'
      AND occupancy_observation_id IS NOT NULL
      AND registry_acknowledgment_id IS NULL) IS TRUE)
  ),
  ADD CONSTRAINT spaces_external_conflict_acknowledgment_fk FOREIGN KEY (
    registry_acknowledgment_id,
    network,
    namespace_root,
    handle_label
  ) REFERENCES spaces_registry_acknowledgments (
    acknowledgment_id,
    network,
    namespace_root,
    handle_label
  ),
  ADD CONSTRAINT spaces_external_conflict_occupancy_fk FOREIGN KEY (
    occupancy_observation_id,
    network,
    namespace_root,
    handle_label
  ) REFERENCES spaces_registry_occupancy_observations (
    occupancy_observation_id,
    network,
    namespace_root,
    handle_label
  );

-- Commit hints (§5.3.13.5). `/committed` records the reported commitment root
-- and the claims it named as a reconciliation hint and makes them due for
-- verification. A hint never creates a grant. Append-only.
CREATE TABLE spaces_registry_commit_hints (
  commit_hint_id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES spaces_registry_credentials (credential_id),
  operator_instance_id TEXT NOT NULL
    REFERENCES spaces_operator_instances (operator_instance_id),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  commitment_root_hex TEXT NOT NULL,
  reported_handle_count BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_registry_commit_hint_identity_check CHECK (
    commit_hint_id ~ '^srhint_[0-9a-f]{32}$'
    AND commitment_root_hex ~ '^[0-9a-f]{64}$'
    AND reported_handle_count BETWEEN 0 AND 10000
  )
);

CREATE TABLE spaces_registry_commit_hint_claims (
  commit_hint_id TEXT NOT NULL REFERENCES spaces_registry_commit_hints (commit_hint_id),
  claim_id TEXT NOT NULL REFERENCES spaces_registry_items (claim_id),
  CONSTRAINT spaces_registry_commit_hint_claims_pk PRIMARY KEY (commit_hint_id, claim_id)
);

CREATE INDEX spaces_registry_commit_hint_claims_claim_idx
  ON spaces_registry_commit_hint_claims (claim_id);

CREATE TRIGGER spaces_registry_commit_hints_append_only
BEFORE UPDATE OR DELETE ON spaces_registry_commit_hints
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

CREATE TRIGGER spaces_registry_commit_hint_claims_append_only
BEFORE UPDATE OR DELETE ON spaces_registry_commit_hint_claims
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- Scope anomalies (§5.3.13.5, ruling Q14). A space, acknowledgment, or commit
-- entry outside the credential's scope, or matching no delivered item, is
-- never applied; it is recorded here and alerted by the reconciler. A repeat
-- of the same anomaly by the same credential counts on one row, so a
-- misconfigured operator polling every cycle cannot grow the table without
-- bound. The raw subject is kept as a digest, with a printable copy only when
-- it is short printable ASCII.
CREATE TABLE spaces_registry_scope_anomalies (
  anomaly_id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES spaces_registry_credentials (credential_id),
  operator_instance_id TEXT NOT NULL
    REFERENCES spaces_operator_instances (operator_instance_id),
  endpoint TEXT NOT NULL CHECK (endpoint IN ('pending', 'ack', 'committed')),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'numeric_space',
      'invalid_space',
      'space_not_assigned',
      'malformed_entry',
      'handle_unparseable',
      'handle_out_of_scope',
      'no_delivered_item',
      'contradicts_recorded_outcome',
      'claim_terminal'
    )
  ),
  subject_digest TEXT NOT NULL,
  subject_text TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  occurrence_count BIGINT NOT NULL,
  alerted_at TIMESTAMPTZ,
  CONSTRAINT spaces_registry_scope_anomaly_subject_unique UNIQUE (
    credential_id,
    endpoint,
    reason,
    subject_digest
  ),
  CONSTRAINT spaces_registry_scope_anomaly_identity_check CHECK (
    anomaly_id ~ '^sranom_[0-9a-f]{32}$'
    AND subject_digest ~ '^[0-9a-f]{64}$'
    AND (subject_text IS NULL OR (
      (char_length(subject_text) >= 1 AND char_length(subject_text) <= 300)
      AND subject_text ~ '^[!-~]+$'
    ))
    AND occurrence_count BETWEEN 1 AND 9007199254740991
    AND last_seen_at >= first_seen_at
    AND (alerted_at IS NULL OR alerted_at >= first_seen_at)
  )
);

CREATE INDEX spaces_registry_scope_anomalies_unalerted_idx
  ON spaces_registry_scope_anomalies (last_seen_at, anomaly_id)
  WHERE alerted_at IS NULL;

-- A repeat only counts and moves last_seen_at forward; the alert mark is set
-- once by the reconciler.
CREATE FUNCTION guard_spaces_registry_scope_anomaly_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces registry scope anomaly cannot be deleted';
  END IF;
  IF to_jsonb(NEW) - ARRAY['last_seen_at','occurrence_count','alerted_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['last_seen_at','occurrence_count','alerted_at']
    OR NEW.last_seen_at < OLD.last_seen_at
    OR NEW.occurrence_count < OLD.occurrence_count
    OR (OLD.alerted_at IS NOT NULL AND NEW.alerted_at IS DISTINCT FROM OLD.alerted_at) THEN
    RAISE EXCEPTION 'Spaces registry scope anomaly transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_scope_anomaly_change_guard
BEFORE UPDATE OR DELETE ON spaces_registry_scope_anomalies
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_scope_anomaly_change_v1();

-- Registry-item transitions, tightened for delivery (§5.3.13.5, §5.3.13.8).
-- An item is created undelivered at generation zero. `delivered` is reached
-- only by recording a delivery, which raises the generation by exactly one.
-- It is withdrawn only while no `/pending` response has included it,
-- redelivery stops only after a delivery, and it settles only from a delivered
-- or redelivery-stopped state with the acknowledgment that settles it. A
-- settled or withdrawn item is final.
CREATE OR REPLACE FUNCTION guard_spaces_registry_item_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces registry item cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
    IF claim.claim_id IS NULL
      OR claim.family <> 'spaces'
      OR claim.state <> 'issuance_pending'
      OR claim.issuance_operation_id <> NEW.issuance_operation_id
      OR claim.recipient_network <> NEW.network
      OR claim.recipient_script_pubkey_hex <> NEW.script_pubkey_hex
      OR claim.namespace_root <> NEW.namespace_root
      OR claim.handle_label <> NEW.handle_label
      OR NEW.state <> 'undelivered'
      OR NEW.delivery_generation <> 0
      OR NEW.last_delivered_at IS NOT NULL
      OR NEW.created_at <> claim.created_at
      OR NEW.updated_at <> claim.created_at THEN
      RAISE EXCEPTION 'Spaces registry item must match its pending claim';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - ARRAY['state','updated_at','delivery_generation','last_delivered_at']
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['state','updated_at','delivery_generation','last_delivered_at']
    OR NEW.updated_at < OLD.updated_at
    OR OLD.state IN ('settled_same_spk', 'settled_different_spk', 'settled_invalid', 'withdrawn')
    OR NEW.delivery_generation NOT IN (OLD.delivery_generation, OLD.delivery_generation + 1)
    OR (NEW.delivery_generation = OLD.delivery_generation
      AND NEW.last_delivered_at IS DISTINCT FROM OLD.last_delivered_at)
    OR (NEW.delivery_generation = OLD.delivery_generation + 1 AND (
      NEW.state <> 'delivered'
      OR OLD.state NOT IN ('undelivered', 'delivered')
      OR NEW.last_delivered_at IS NULL
      OR NEW.last_delivered_at < COALESCE(OLD.last_delivered_at, OLD.created_at)))
    OR (NEW.state = 'undelivered' AND OLD.state <> 'undelivered')
    OR (NEW.state = 'delivered' AND NEW.delivery_generation = OLD.delivery_generation)
    OR (NEW.state = 'withdrawn' AND (OLD.state <> 'undelivered' OR OLD.delivery_generation <> 0))
    OR (NEW.state = 'redelivery_stopped' AND OLD.state <> 'delivered')
    OR (NEW.state IN ('settled_same_spk', 'settled_different_spk', 'settled_invalid')
      AND OLD.state NOT IN ('delivered', 'redelivery_stopped')) THEN
    RAISE EXCEPTION 'Spaces registry item transition is invalid';
  END IF;
  IF NEW.state IN ('settled_same_spk', 'settled_different_spk', 'settled_invalid')
    AND NOT EXISTS (
      SELECT 1
        FROM spaces_registry_acknowledgments AS acknowledgment
       WHERE acknowledgment.claim_id = NEW.claim_id
         AND acknowledgment.delivery_generation = NEW.delivery_generation
         AND NEW.state = CASE
           WHEN acknowledgment.outcome IN (
             'staged',
             'already_staged_same_spk',
             'already_committed_same_spk'
           ) THEN 'settled_same_spk'
           WHEN acknowledgment.outcome IN (
             'already_staged_different_spk',
             'already_committed_different_spk'
           ) THEN 'settled_different_spk'
           ELSE 'settled_invalid'
         END
    ) THEN
    RAISE EXCEPTION 'Spaces registry item settles only with its acknowledgment';
  END IF;
  RETURN NEW;
END;
$$;
