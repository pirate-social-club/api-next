-- Make subject identity independent from account ownership, then add the
-- recoverable binding and proof-completion lifecycles required before the
-- first production provider.

ALTER TABLE evidence_receipts
  DROP CONSTRAINT evidence_receipts_subject_fk;

ALTER TABLE assertion_bindings
  DROP CONSTRAINT assertion_bindings_subject_fk;

ALTER TABLE assertions
  DROP CONSTRAINT assertions_subject_user_fk;

DROP INDEX subject_keys_user_scope_idx;

ALTER TABLE subject_keys
  DROP CONSTRAINT subject_keys_id_user_unique,
  DROP CONSTRAINT subject_keys_user_fk,
  DROP COLUMN user_id;

ALTER TABLE subject_keys
  ADD CONSTRAINT subject_keys_sha256_digest_check CHECK (
    digest_algorithm = 'sha256' AND subject_digest ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE proof_sessions
  ADD COLUMN subject_binding_intent TEXT NOT NULL
    CHECK (subject_binding_intent IN ('establish', 'recover', 'none'));

CREATE INDEX subject_keys_scope_created_idx
  ON subject_keys (issuer, method, scope_kind, created_at DESC, subject_key_id);

CREATE TABLE subject_key_binding_events (
  binding_event_id TEXT PRIMARY KEY,
  subject_key_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  user_id TEXT NOT NULL,
  proof_session_id TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('initial', 'recovery')),
  previous_binding_event_id TEXT,
  idempotency_key TEXT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subject_key_binding_events_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  CONSTRAINT subject_key_binding_events_user_fk
    FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT subject_key_binding_events_session_actor_fk
    FOREIGN KEY (proof_session_id, user_id)
    REFERENCES proof_sessions (proof_session_id, actor_id),
  CONSTRAINT subject_key_binding_events_not_blank CHECK (
    btrim(binding_event_id) <> '' AND btrim(idempotency_key) <> ''
  ),
  CONSTRAINT subject_key_binding_events_subject_epoch_unique
    UNIQUE (subject_key_id, binding_epoch),
  CONSTRAINT subject_key_binding_events_subject_idempotency_unique
    UNIQUE (subject_key_id, idempotency_key),
  CONSTRAINT subject_key_binding_events_event_subject_unique
    UNIQUE (binding_event_id, subject_key_id),
  CONSTRAINT subject_key_binding_events_receipt_identity_unique
    UNIQUE (binding_event_id, subject_key_id, binding_epoch, user_id),
  CONSTRAINT subject_key_binding_events_previous_fk
    FOREIGN KEY (previous_binding_event_id, subject_key_id)
    REFERENCES subject_key_binding_events (binding_event_id, subject_key_id)
);

CREATE INDEX subject_key_binding_events_user_bound_idx
  ON subject_key_binding_events (user_id, bound_at DESC, binding_event_id);

CREATE TABLE active_subject_key_bindings (
  subject_key_id TEXT PRIMARY KEY,
  binding_event_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  user_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT active_subject_key_bindings_event_fk
    FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  CONSTRAINT active_subject_key_bindings_subject_user_unique
    UNIQUE (subject_key_id, user_id)
);

CREATE INDEX active_subject_key_bindings_user_idx
  ON active_subject_key_bindings (user_id, activated_at DESC, subject_key_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_subject_key_binding_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_binding active_subject_key_bindings%ROWTYPE;
  session_record proof_sessions%ROWTYPE;
BEGIN
  PERFORM 1
    FROM subject_keys
   WHERE subject_key_id = NEW.subject_key_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject key binding refers to a missing subject key'
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject key binding session is missing or belongs to another actor'
      USING ERRCODE = '23503';
  END IF;

  IF session_record.status <> 'pending'
    OR NEW.bound_at < session_record.started_at
    OR NEW.bound_at >= session_record.expires_at THEN
    RAISE EXCEPTION 'subject key binding requires a live pending proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_live_session';
  END IF;

  SELECT * INTO current_binding
    FROM active_subject_key_bindings
   WHERE subject_key_id = NEW.subject_key_id
   FOR UPDATE;

  IF NOT FOUND THEN
    IF NEW.binding_epoch <> 1
      OR NEW.binding_kind <> 'initial'
      OR session_record.subject_binding_intent <> 'establish'
      OR NEW.previous_binding_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'first subject key binding must be initial epoch 1'
        USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_sequence';
    END IF;
  ELSE
    IF NEW.binding_epoch <> current_binding.binding_epoch + 1
      OR NEW.binding_kind <> 'recovery'
      OR session_record.subject_binding_intent <> 'recover'
      OR NEW.previous_binding_event_id IS DISTINCT FROM current_binding.binding_event_id
      OR NEW.user_id = current_binding.user_id
      OR NEW.bound_at < current_binding.activated_at THEN
      RAISE EXCEPTION 'subject key recovery must advance the active binding exactly once'
        USING ERRCODE = '23514', CONSTRAINT = 'subject_key_binding_events_sequence';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER subject_key_binding_events_validate
BEFORE INSERT ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_subject_key_binding_event();

CREATE OR REPLACE FUNCTION gates_v2_project_subject_key_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO active_subject_key_bindings (
    subject_key_id,
    binding_event_id,
    binding_epoch,
    user_id,
    activated_at,
    updated_at
  ) VALUES (
    NEW.subject_key_id,
    NEW.binding_event_id,
    NEW.binding_epoch,
    NEW.user_id,
    NEW.bound_at,
    now()
  )
  ON CONFLICT (subject_key_id) DO UPDATE SET
    binding_event_id = EXCLUDED.binding_event_id,
    binding_epoch = EXCLUDED.binding_epoch,
    user_id = EXCLUDED.user_id,
    activated_at = EXCLUDED.activated_at,
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER subject_key_binding_events_project
AFTER INSERT ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_project_subject_key_binding();

CREATE OR REPLACE FUNCTION gates_v2_active_binding_projection_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'active subject key bindings are trigger-maintained'
      USING ERRCODE = '23514', CONSTRAINT = 'active_subject_key_bindings_projection_only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER active_subject_key_bindings_projection_only
BEFORE INSERT OR UPDATE OR DELETE ON active_subject_key_bindings
FOR EACH ROW EXECUTE FUNCTION gates_v2_active_binding_projection_guard();

CREATE TRIGGER subject_key_binding_events_append_only
BEFORE UPDATE OR DELETE ON subject_key_binding_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

ALTER TABLE evidence_receipts
  ADD COLUMN subject_binding_event_id TEXT,
  ADD COLUMN subject_binding_epoch BIGINT,
  ADD CONSTRAINT evidence_receipts_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  ADD CONSTRAINT evidence_receipts_subject_binding_shape_check CHECK (
    (subject_key_id IS NULL
      AND subject_binding_event_id IS NULL
      AND subject_binding_epoch IS NULL)
    OR (subject_key_id IS NOT NULL
      AND subject_binding_event_id IS NOT NULL
      AND subject_binding_epoch IS NOT NULL)
  ),
  ADD CONSTRAINT evidence_receipts_subject_binding_fk
    FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  ADD CONSTRAINT evidence_receipts_binding_identity_unique
    UNIQUE (
      evidence_receipt_id,
      subject_key_id,
      subject_binding_event_id,
      subject_binding_epoch,
      user_id
    );

CREATE UNIQUE INDEX evidence_receipts_provider_evidence_uidx
  ON evidence_receipts (provider_id, environment, evidence_hash);

ALTER TABLE assertion_bindings
  DROP CONSTRAINT assertion_bindings_anchor_shape_check,
  ADD COLUMN subject_binding_event_id TEXT,
  ADD COLUMN subject_binding_epoch BIGINT,
  ADD CONSTRAINT assertion_bindings_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id),
  ADD CONSTRAINT assertion_bindings_subject_binding_fk
    FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  ADD CONSTRAINT assertion_bindings_anchor_shape_check CHECK (
    (binding_mode = 'same_subject'
      AND subject_key_id IS NOT NULL
      AND subject_binding_event_id IS NOT NULL
      AND subject_binding_epoch IS NOT NULL
      AND evidence_receipt_id IS NULL)
    OR (binding_mode = 'same_receipt'
      AND subject_key_id IS NULL
      AND subject_binding_event_id IS NULL
      AND subject_binding_epoch IS NULL
      AND evidence_receipt_id IS NOT NULL)
  );

ALTER TABLE assertions
  ADD CONSTRAINT assertions_subject_fk
    FOREIGN KEY (subject_key_id) REFERENCES subject_keys (subject_key_id);

CREATE OR REPLACE FUNCTION gates_v2_validate_evidence_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record proof_sessions%ROWTYPE;
  subject_record subject_keys%ROWTYPE;
  active_binding active_subject_key_bindings%ROWTYPE;
BEGIN
  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence receipt session is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.provider_id IS DISTINCT FROM session_record.provider_id
    OR NEW.issuer IS DISTINCT FROM session_record.issuer
    OR NEW.method IS DISTINCT FROM session_record.method
    OR NEW.scope_kind IS DISTINCT FROM session_record.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM session_record.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM session_record.issuer_rp_action_scope
    OR NEW.protocol_version IS DISTINCT FROM session_record.protocol_version
    OR NEW.environment IS DISTINCT FROM session_record.environment THEN
    RAISE EXCEPTION 'evidence receipt metadata must match its proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_session_metadata_match';
  END IF;

  IF NEW.subject_key_id IS NOT NULL THEN
    SELECT * INTO subject_record
      FROM subject_keys
     WHERE subject_key_id = NEW.subject_key_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'evidence receipt subject key is missing'
        USING ERRCODE = '23503';
    END IF;

    IF NEW.issuer IS DISTINCT FROM subject_record.issuer
      OR NEW.method IS DISTINCT FROM subject_record.method
      OR NEW.scope_kind IS DISTINCT FROM subject_record.scope_kind
      OR NEW.issuer_rp_scope IS DISTINCT FROM subject_record.issuer_rp_scope
      OR NEW.issuer_rp_action_scope IS DISTINCT FROM subject_record.issuer_rp_action_scope THEN
      RAISE EXCEPTION 'evidence receipt metadata must match its subject key'
        USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_subject_metadata_match';
    END IF;

    SELECT * INTO active_binding
      FROM active_subject_key_bindings
     WHERE subject_key_id = NEW.subject_key_id;

    IF NOT FOUND
      OR active_binding.binding_event_id IS DISTINCT FROM NEW.subject_binding_event_id
      OR active_binding.binding_epoch IS DISTINCT FROM NEW.subject_binding_epoch
      OR active_binding.user_id IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'evidence receipt must use the active subject binding epoch'
        USING ERRCODE = '23514', CONSTRAINT = 'evidence_receipts_active_binding_match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION gates_v2_validate_assertion_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_mode_value TEXT;
  binding_subject_key_id TEXT;
  binding_receipt_id TEXT;
  binding_event_id TEXT;
  binding_epoch BIGINT;
  receipt_subject_key_id TEXT;
  receipt_binding_event_id TEXT;
  receipt_binding_epoch BIGINT;
BEGIN
  SELECT
      binding_mode,
      subject_key_id,
      evidence_receipt_id,
      subject_binding_event_id,
      subject_binding_epoch
    INTO
      binding_mode_value,
      binding_subject_key_id,
      binding_receipt_id,
      binding_event_id,
      binding_epoch
    FROM assertion_bindings
   WHERE binding_group_id = NEW.binding_group_id
     AND user_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assertion binding group is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  SELECT subject_key_id, subject_binding_event_id, subject_binding_epoch
    INTO receipt_subject_key_id, receipt_binding_event_id, receipt_binding_epoch
    FROM evidence_receipts
   WHERE evidence_receipt_id = NEW.evidence_receipt_id
     AND user_id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assertion evidence receipt is missing or belongs to another user'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.subject_key_id IS DISTINCT FROM receipt_subject_key_id THEN
    RAISE EXCEPTION 'assertion subject key must match its evidence receipt subject key'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_receipt_subject_match';
  END IF;

  IF binding_mode_value = 'same_subject'
    AND (
      NEW.subject_key_id IS DISTINCT FROM binding_subject_key_id
      OR binding_event_id IS DISTINCT FROM receipt_binding_event_id
      OR binding_epoch IS DISTINCT FROM receipt_binding_epoch
    ) THEN
    RAISE EXCEPTION 'assertion subject binding must match its receipt binding epoch'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_subject_binding_match';
  END IF;

  IF binding_mode_value = 'same_receipt'
    AND NEW.evidence_receipt_id IS DISTINCT FROM binding_receipt_id THEN
    RAISE EXCEPTION 'assertion receipt must match its same-receipt binding anchor'
      USING ERRCODE = '23514', CONSTRAINT = 'assertions_same_receipt_binding_match';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE proof_sessions
  ADD COLUMN completion_idempotency_key TEXT,
  ADD COLUMN completion_result_hash TEXT,
  ADD COLUMN terminal_at TIMESTAMPTZ,
  ADD CONSTRAINT proof_sessions_actor_intent_unique UNIQUE (actor_id, intent_id),
  ADD CONSTRAINT proof_sessions_terminal_shape_check CHECK (
    (status = 'pending'
      AND completion_idempotency_key IS NULL
      AND completion_result_hash IS NULL
      AND terminal_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed'
      AND completion_idempotency_key IS NOT NULL
      AND btrim(completion_idempotency_key) <> ''
      AND completion_result_hash ~ '^[0-9a-f]{64}$'
      AND terminal_at IS NOT NULL
      AND completed_at = terminal_at)
    OR (status IN ('failed', 'expired')
      AND completion_idempotency_key IS NOT NULL
      AND btrim(completion_idempotency_key) <> ''
      AND completion_result_hash ~ '^[0-9a-f]{64}$'
      AND terminal_at IS NOT NULL
      AND completed_at IS NULL)
  );

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proof sessions cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'proof sessions must begin pending'
        USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.proof_session_id IS DISTINCT FROM OLD.proof_session_id
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM OLD.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM OLD.issuer_rp_action_scope
    OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.upstream_session_ref IS DISTINCT FROM OLD.upstream_session_ref
    OR NEW.requested_claim_ids IS DISTINCT FROM OLD.requested_claim_ids
    OR NEW.subject_binding_intent IS DISTINCT FROM OLD.subject_binding_intent
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'proof session identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'terminal proof sessions are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF NEW.status = 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('completed', 'failed', 'expired') THEN
    RAISE EXCEPTION 'invalid proof session transition'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_sessions_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON proof_sessions
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_lifecycle();

CREATE TABLE proof_session_completion_events (
  completion_event_id TEXT PRIMARY KEY,
  proof_session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('completed', 'failed', 'expired')),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  terminal_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_session_completion_events_session_actor_fk
    FOREIGN KEY (proof_session_id, actor_id)
    REFERENCES proof_sessions (proof_session_id, actor_id),
  CONSTRAINT proof_session_completion_events_not_blank CHECK (
    btrim(completion_event_id) <> '' AND btrim(idempotency_key) <> ''
  ),
  CONSTRAINT proof_session_completion_events_session_unique UNIQUE (proof_session_id),
  CONSTRAINT proof_session_completion_events_idempotency_unique
    UNIQUE (proof_session_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_completion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_record proof_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session_record
    FROM proof_sessions
   WHERE proof_session_id = NEW.proof_session_id
     AND actor_id = NEW.actor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'completion event session is missing or belongs to another actor'
      USING ERRCODE = '23503';
  END IF;

  IF session_record.status IS DISTINCT FROM NEW.terminal_status
    OR session_record.completion_idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR session_record.completion_result_hash IS DISTINCT FROM NEW.result_hash
    OR session_record.terminal_at IS DISTINCT FROM NEW.terminal_at THEN
    RAISE EXCEPTION 'completion event must match the terminal proof session'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_session_completion_events_session_match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proof_session_completion_events_validate
BEFORE INSERT ON proof_session_completion_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_completion_event();

CREATE TRIGGER proof_session_completion_events_append_only
BEFORE UPDATE OR DELETE ON proof_session_completion_events
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE OR REPLACE FUNCTION gates_v2_require_terminal_completion_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'pending' AND NOT EXISTS (
    SELECT 1
      FROM proof_session_completion_events
     WHERE proof_session_id = NEW.proof_session_id
       AND actor_id = NEW.actor_id
       AND terminal_status = NEW.status
       AND idempotency_key = NEW.completion_idempotency_key
       AND result_hash = NEW.completion_result_hash
       AND terminal_at = NEW.terminal_at
  ) THEN
    RAISE EXCEPTION 'terminal proof session requires its matching completion event'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_terminal_completion_event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER proof_sessions_terminal_completion_event
AFTER INSERT OR UPDATE ON proof_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION gates_v2_require_terminal_completion_event();

CREATE TABLE reward_uniqueness_authorities (
  campaign_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  method TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('issuer_rp_scope', 'issuer_rp_action_scope')
  ),
  issuer_rp_scope TEXT NOT NULL,
  issuer_rp_action_scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reward_uniqueness_authorities_not_blank CHECK (
    btrim(campaign_id) <> '' AND btrim(issuer) <> '' AND btrim(method) <> ''
    AND btrim(issuer_rp_scope) <> ''
    AND (issuer_rp_action_scope IS NULL OR btrim(issuer_rp_action_scope) <> '')
  ),
  CONSTRAINT reward_uniqueness_authorities_scope_shape_check CHECK (
    (scope_kind = 'issuer_rp_scope' AND issuer_rp_action_scope IS NULL)
    OR (scope_kind = 'issuer_rp_action_scope' AND issuer_rp_action_scope IS NOT NULL)
  )
);

ALTER TABLE policy_versions
  ADD COLUMN policy_purpose TEXT NOT NULL
    CHECK (policy_purpose IN ('access', 'reward')),
  ADD COLUMN uniqueness_authority_id TEXT,
  ADD CONSTRAINT policy_versions_uniqueness_authority_fk
    FOREIGN KEY (uniqueness_authority_id)
    REFERENCES reward_uniqueness_authorities (campaign_id),
  ADD CONSTRAINT policy_versions_reward_authority_check CHECK (
    (policy_purpose = 'access' AND uniqueness_authority_id IS NULL)
    OR (policy_purpose = 'reward'
      AND uniqueness_authority_id IS NOT NULL
      AND uniqueness_model ->> 'kind' = 'single_authority'
      AND uniqueness_model ->> 'authority_id' = uniqueness_authority_id)
  );

CREATE TABLE reward_subject_consumptions (
  reward_subject_consumption_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subject_key_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  binding_event_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  evidence_receipt_id TEXT,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reward_subject_consumptions_campaign_fk
    FOREIGN KEY (campaign_id)
    REFERENCES reward_uniqueness_authorities (campaign_id),
  CONSTRAINT reward_subject_consumptions_binding_fk
    FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id)
    REFERENCES subject_key_binding_events (
      binding_event_id, subject_key_id, binding_epoch, user_id
    ),
  CONSTRAINT reward_subject_consumptions_receipt_fk
    FOREIGN KEY (
      evidence_receipt_id,
      subject_key_id,
      binding_event_id,
      binding_epoch,
      user_id
    ) REFERENCES evidence_receipts (
      evidence_receipt_id,
      subject_key_id,
      subject_binding_event_id,
      subject_binding_epoch,
      user_id
    ),
  CONSTRAINT reward_subject_consumptions_campaign_subject_unique
    UNIQUE (campaign_id, subject_key_id)
);

CREATE OR REPLACE FUNCTION gates_v2_validate_reward_subject_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority reward_uniqueness_authorities%ROWTYPE;
  subject_record subject_keys%ROWTYPE;
BEGIN
  SELECT * INTO authority
    FROM reward_uniqueness_authorities
   WHERE campaign_id = NEW.campaign_id;
  SELECT * INTO subject_record
    FROM subject_keys
   WHERE subject_key_id = NEW.subject_key_id;

  IF authority.issuer IS DISTINCT FROM subject_record.issuer
    OR authority.method IS DISTINCT FROM subject_record.method
    OR authority.scope_kind IS DISTINCT FROM subject_record.scope_kind
    OR authority.issuer_rp_scope IS DISTINCT FROM subject_record.issuer_rp_scope
    OR authority.issuer_rp_action_scope IS DISTINCT FROM subject_record.issuer_rp_action_scope THEN
    RAISE EXCEPTION 'reward subject must match the campaign uniqueness authority'
      USING ERRCODE = '23514', CONSTRAINT = 'reward_subject_consumptions_authority_match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reward_subject_consumptions_validate
BEFORE INSERT ON reward_subject_consumptions
FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_reward_subject_consumption();

CREATE TRIGGER reward_uniqueness_authorities_append_only
BEFORE UPDATE OR DELETE ON reward_uniqueness_authorities
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER reward_subject_consumptions_append_only
BEFORE UPDATE OR DELETE ON reward_subject_consumptions
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();
