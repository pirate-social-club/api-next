-- Durable, replay-safe community creation and immutable gate/provider binding.

CREATE TABLE community_creation_intents (
  intent_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  create_idempotency_key TEXT NOT NULL,
  create_request_hash TEXT NOT NULL CHECK (create_request_hash ~ '^[0-9a-f]{64}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    )
  ),
  draft JSONB NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  canonical_policy_revision INTEGER NOT NULL CHECK (canonical_policy_revision > 0),
  canonical_policy_hash TEXT NOT NULL CHECK (canonical_policy_hash ~ '^[0-9a-f]{64}$'),
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  verification_provider_id TEXT NOT NULL,
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_community_id TEXT REFERENCES communities (community_id),
  committed_resource_href TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_intents_identifiers_not_blank CHECK (
    btrim(intent_id) <> ''
    AND intent_id = btrim(intent_id)
    AND btrim(actor_id) <> ''
    AND actor_id = btrim(actor_id)
    AND btrim(create_idempotency_key) <> ''
    AND create_idempotency_key = btrim(create_idempotency_key)
    AND btrim(verification_provider_id) <> ''
    AND verification_provider_id = btrim(verification_provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
  ),
  CONSTRAINT community_creation_intents_committed_shape CHECK (
    (
      status = 'committed'
      AND committed_community_id IS NOT NULL
      AND committed_resource_href IS NOT NULL
      AND committed_resource_href LIKE '/%'
    )
    OR
    (
      status <> 'committed'
      AND committed_community_id IS NULL
      AND committed_resource_href IS NULL
    )
  ),
  CONSTRAINT community_creation_intents_actor_create_key_unique
    UNIQUE (actor_id, create_idempotency_key),
  CONSTRAINT community_creation_intents_actor_intent_unique UNIQUE (actor_id, intent_id)
);

CREATE INDEX community_creation_intents_actor_status_idx
  ON community_creation_intents (actor_id, status, updated_at DESC, intent_id);

CREATE INDEX community_creation_intents_expiry_idx
  ON community_creation_intents (expires_at, intent_id)
  WHERE status IN ('draft', 'verification_required', 'commit_ready');

CREATE TABLE community_creation_intent_revisions (
  intent_id TEXT NOT NULL REFERENCES community_creation_intents (intent_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  operation_kind TEXT NOT NULL CHECK (
    operation_kind IN (
      'create',
      'update',
      'preflight',
      'verification',
      'commit',
      'expire',
      'cancel'
    )
  ),
  idempotency_key TEXT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    )
  ),
  state_snapshot JSONB NOT NULL CHECK (jsonb_typeof(state_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (intent_id, revision),
  CONSTRAINT community_creation_intent_revisions_actor_fk
    FOREIGN KEY (actor_id, intent_id)
    REFERENCES community_creation_intents (actor_id, intent_id),
  CONSTRAINT community_creation_intent_revisions_idempotency_shape CHECK (
    (
      operation_kind IN ('create', 'update', 'commit')
      AND idempotency_key IS NOT NULL
      AND btrim(idempotency_key) <> ''
      AND idempotency_key = btrim(idempotency_key)
    )
    OR
    (
      operation_kind NOT IN ('create', 'update', 'commit')
      AND idempotency_key IS NULL
    )
  )
);

CREATE UNIQUE INDEX community_creation_intent_revisions_idempotency_uidx
  ON community_creation_intent_revisions (actor_id, operation_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE community_policy_provider_bindings (
  policy_version_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  provider_id TEXT NOT NULL,
  provider_configuration_kind TEXT NOT NULL
    CHECK (provider_configuration_kind IN ('managed', 'dynamic')),
  provider_configuration_ref TEXT NOT NULL,
  provider_configuration_version TEXT NOT NULL,
  method TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_policy_provider_bindings_policy_fk
    FOREIGN KEY (community_id, policy_key, policy_version_id)
    REFERENCES policy_versions (community_id, policy_key, policy_version_id),
  CONSTRAINT community_policy_provider_bindings_not_blank CHECK (
    btrim(provider_id) <> ''
    AND provider_id = btrim(provider_id)
    AND btrim(provider_configuration_ref) <> ''
    AND provider_configuration_ref = btrim(provider_configuration_ref)
    AND btrim(provider_configuration_version) <> ''
    AND provider_configuration_version = btrim(provider_configuration_version)
    AND btrim(method) <> ''
    AND method = btrim(method)
    AND btrim(protocol_version) <> ''
    AND protocol_version = btrim(protocol_version)
  )
);

CREATE TABLE community_creation_quota_approvals (
  approval_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL REFERENCES subject_keys (subject_key_id),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  slot_number INTEGER NOT NULL CHECK (slot_number > 1),
  approved_by_user_id TEXT NOT NULL REFERENCES users (user_id),
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_quota_approvals_not_blank CHECK (
    btrim(approval_id) <> ''
    AND approval_id = btrim(approval_id)
    AND btrim(reason) <> ''
    AND reason = btrim(reason)
  ),
  CONSTRAINT community_creation_quota_approvals_subject_slot_unique
    UNIQUE (subject_key_id, slot_number),
  CONSTRAINT community_creation_quota_approvals_binding_unique
    UNIQUE (approval_id, subject_key_id, actor_id, slot_number)
);

CREATE TABLE community_creation_subject_claims (
  claim_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL REFERENCES subject_keys (subject_key_id),
  actor_id TEXT NOT NULL REFERENCES users (user_id),
  slot_number INTEGER NOT NULL CHECK (slot_number > 0),
  approval_id TEXT UNIQUE,
  intent_id TEXT NOT NULL UNIQUE REFERENCES community_creation_intents (intent_id),
  community_id TEXT NOT NULL UNIQUE REFERENCES communities (community_id),
  proof_session_id TEXT NOT NULL REFERENCES proof_sessions (proof_session_id),
  evidence_receipt_id TEXT NOT NULL REFERENCES evidence_receipts (evidence_receipt_id),
  verification_requirement_hash TEXT NOT NULL
    CHECK (verification_requirement_hash ~ '^[0-9a-f]{64}$'),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT community_creation_subject_claims_not_blank CHECK (
    btrim(claim_id) <> ''
    AND claim_id = btrim(claim_id)
  ),
  CONSTRAINT community_creation_subject_claims_slot_shape CHECK (
    (slot_number = 1 AND approval_id IS NULL)
    OR (slot_number > 1 AND approval_id IS NOT NULL)
  ),
  CONSTRAINT community_creation_subject_claims_subject_slot_unique
    UNIQUE (subject_key_id, slot_number),
  CONSTRAINT community_creation_subject_claims_approval_fk
    FOREIGN KEY (approval_id, subject_key_id, actor_id, slot_number)
    REFERENCES community_creation_quota_approvals (
      approval_id,
      subject_key_id,
      actor_id,
      slot_number
    )
);

CREATE OR REPLACE FUNCTION guard_community_creation_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.intent_id,
    NEW.actor_id,
    NEW.create_idempotency_key,
    NEW.create_request_hash,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.intent_id,
    OLD.actor_id,
    OLD.create_idempotency_key,
    OLD.create_request_hash,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'community creation intent identity is immutable';
  END IF;

  IF OLD.status IN (
    'committed',
    'quota_exceeded',
    'gate_unsupported',
    'expired',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'terminal community creation intent is immutable';
  END IF;

  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'community creation intent revision must advance exactly once';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'verification_required' AND NEW.status IN (
      'draft',
      'commit_ready',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'commit_ready' AND NEW.status IN (
      'draft',
      'committed',
      'quota_exceeded',
      'expired',
      'cancelled'
    ))
  ) THEN
    RAISE EXCEPTION 'community creation intent transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER community_creation_intent_update_guard
BEFORE UPDATE ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_community_creation_intent_update();

CREATE OR REPLACE FUNCTION reject_community_creation_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_creation_intent_revision_append_only
BEFORE UPDATE OR DELETE ON community_creation_intent_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_policy_provider_binding_append_only
BEFORE UPDATE OR DELETE ON community_policy_provider_bindings
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_quota_approval_append_only
BEFORE UPDATE OR DELETE ON community_creation_quota_approvals
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_subject_claim_append_only
BEFORE UPDATE OR DELETE ON community_creation_subject_claims
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_intent_delete_guard
BEFORE DELETE ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();
