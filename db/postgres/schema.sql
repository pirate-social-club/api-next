-- GENERATED FILE. DO NOT EDIT. Regenerate with bun run db:generate:baseline.
-- Source of truth: db/postgres/migrations/*.sql

SET check_function_bodies = false;

CREATE FUNCTION active_community_effect(expected_community_id text, expected_user_id text) RETURNS boolean
    LANGUAGE sql STABLE
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

CREATE FUNCTION effective_active_route(expected_community_id text, database_now timestamp with time zone) RETURNS TABLE(community_id text, route_binding_id text, family text, root_label text, root_label_display text, path_segment text, href text, verified_evidence_ref text, binding_generation bigint, evidence_expires_at timestamp with time zone)
    LANGUAGE sql STABLE
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

CREATE FUNCTION gates_v2_active_binding_projection_guard() RETURNS trigger
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

CREATE FUNCTION gates_v2_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'gates_v2_append_only';
END;
$$;

CREATE FUNCTION gates_v2_project_subject_key_binding() RETURNS trigger
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

CREATE FUNCTION gates_v2_require_terminal_completion_event() RETURNS trigger
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

CREATE FUNCTION gates_v2_validate_assertion_binding() RETURNS trigger
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

CREATE FUNCTION gates_v2_validate_evidence_receipt() RETURNS trigger
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
    OR NEW.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
    OR NEW.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
    OR NEW.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
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

CREATE FUNCTION gates_v2_validate_proof_session_completion_event() RETURNS trigger
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

CREATE FUNCTION gates_v2_validate_proof_session_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'proof sessions cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_lifecycle';
  END IF;

  IF jsonb_typeof(NEW.requested_requirements) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.requested_requirements) = 0
    OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(NEW.requested_requirements) AS requirement(value)
       WHERE jsonb_typeof(requirement.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(requirement.value -> 'claim_id') IS DISTINCT FROM 'string'
          OR btrim(requirement.value ->> 'claim_id') = ''
    )
    OR (
      SELECT count(*)
        FROM jsonb_array_elements(NEW.requested_requirements)
    ) IS DISTINCT FROM (
      SELECT count(DISTINCT requirement.value ->> 'claim_id')
        FROM jsonb_array_elements(NEW.requested_requirements) AS requirement(value)
    )
    OR (
      SELECT jsonb_agg(requirement.value -> 'claim_id' ORDER BY requirement.ordinality)
        FROM jsonb_array_elements(NEW.requested_requirements)
          WITH ORDINALITY AS requirement(value, ordinality)
    ) IS DISTINCT FROM NEW.requested_claim_ids THEN
    RAISE EXCEPTION 'proof-session requirements must project exactly to requested claims'
      USING ERRCODE = '23514', CONSTRAINT = 'proof_sessions_requested_requirements_projection';
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
    OR NEW.provider_configuration_kind IS DISTINCT FROM OLD.provider_configuration_kind
    OR NEW.provider_configuration_ref IS DISTINCT FROM OLD.provider_configuration_ref
    OR NEW.provider_configuration_version IS DISTINCT FROM OLD.provider_configuration_version
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
    OR NEW.issuer_rp_scope IS DISTINCT FROM OLD.issuer_rp_scope
    OR NEW.issuer_rp_action_scope IS DISTINCT FROM OLD.issuer_rp_action_scope
    OR NEW.request_mode IS DISTINCT FROM OLD.request_mode
    OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
    OR NEW.environment IS DISTINCT FROM OLD.environment
    OR NEW.upstream_session_ref IS DISTINCT FROM OLD.upstream_session_ref
    OR NEW.requested_requirements IS DISTINCT FROM OLD.requested_requirements
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

CREATE FUNCTION gates_v2_validate_reward_subject_consumption() RETURNS trigger
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

CREATE FUNCTION gates_v2_validate_subject_key_binding_event() RETURNS trigger
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

CREATE FUNCTION guard_community_canonical_route_binding_change() RETURNS trigger
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

CREATE FUNCTION guard_community_canonical_route_reference() RETURNS trigger
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

CREATE FUNCTION guard_community_commerce_policy_revision_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.policy_version, NEW.source_revision, NEW.issued_by,
    NEW.effective_at
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.policy_version, OLD.source_revision, OLD.issued_by,
    OLD.effective_at
  ) THEN
    RAISE EXCEPTION 'community commerce policy revision identity is immutable';
  END IF;

  IF OLD.superseded_at IS NOT NULL
    AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession is immutable';
  END IF;

  IF NEW.superseded_at IS NOT NULL AND NEW.superseded_at < OLD.effective_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession precedes effectiveness';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_community_creation_contract_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.creation_contract_version <> OLD.creation_contract_version THEN
    RAISE EXCEPTION 'community creation contract version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_community_creation_intent_update() RETURNS trigger
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
      'verification_required',
      'commit_ready',
      'quota_exceeded',
      'gate_unsupported',
      'expired',
      'cancelled'
    ))
    OR (OLD.status = 'commit_ready' AND NEW.status IN (
      'draft',
      'verification_required',
      'commit_ready',
      'committed',
      'quota_exceeded',
      'gate_unsupported',
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

CREATE FUNCTION guard_community_creation_requirement_state_update() RETURNS trigger
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

CREATE FUNCTION guard_community_purchase_funding_journal_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.operation_id, NEW.community_id, NEW.actor_id, NEW.quote_id, NEW.purchase_id,
    NEW.policy_version, NEW.chain_id, NEW.token_contract, NEW.token_decimals,
    NEW.expected_sender, NEW.expected_recipient, NEW.expected_amount_atomic,
    NEW.required_confirmations
  ) IS DISTINCT FROM ROW(
    OLD.operation_id, OLD.community_id, OLD.actor_id, OLD.quote_id, OLD.purchase_id,
    OLD.policy_version, OLD.chain_id, OLD.token_contract, OLD.token_decimals,
    OLD.expected_sender, OLD.expected_recipient, OLD.expected_amount_atomic,
    OLD.required_confirmations
  ) THEN
    RAISE EXCEPTION 'community purchase funding identity is immutable';
  END IF;

  IF NEW.version = OLD.version THEN
    IF ROW(
      NEW.state, NEW.snapshot, NEW.failure_tag, NEW.failure_reason,
      NEW.funding_receipt_status,
      NEW.funding_transaction_hash, NEW.funding_log_index,
      NEW.funding_observation_id
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.snapshot, OLD.failure_tag, OLD.failure_reason,
      OLD.funding_receipt_status,
      OLD.funding_transaction_hash, OLD.funding_log_index,
      OLD.funding_observation_id
    ) THEN
      RAISE EXCEPTION 'journal state change requires a new version';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'journal version must advance exactly once';
  END IF;

  IF NOT (
    (OLD.state = 'planned' AND NEW.state IN (
      'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
      'reclaimable_failed'
    ))
    OR (OLD.state = 'dormant_unobserved'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
    OR (OLD.state = 'confirming'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required'))
    OR (OLD.state = 'confirmed' AND NEW.state IN ('confirmed', 'reconciliation_required'))
    OR (OLD.state = 'reverted' AND NEW.state IN ('reverted', 'reconciliation_required'))
    OR (OLD.state = 'reclaimable_failed' AND NEW.state = 'planned')
    OR (OLD.state = 'reconciliation_required'
      AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
  ) THEN
    RAISE EXCEPTION 'journal transition is not allowed: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_community_purchase_funding_plan_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.community_id, NEW.actor_id, NEW.buyer_wallet_address,
    NEW.buyer_chain_id, NEW.purchase_id, NEW.policy_version, NEW.chain_id, NEW.token_contract,
    NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.community_id, OLD.actor_id, OLD.buyer_wallet_address,
    OLD.buyer_chain_id, OLD.purchase_id, OLD.policy_version, OLD.chain_id, OLD.token_contract,
    OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase funding plan terms are immutable';
  END IF;

  IF OLD.status = 'active' THEN
    IF NEW.status IN ('active', 'cancelled') AND NEW.operation_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'bound'
      AND OLD.operation_id IS NULL AND NEW.operation_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.status = 'bound'
    AND NEW.status = 'bound'
    AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status = 'cancelled' AND NEW.operation_id IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'community purchase funding plan transition is not allowed: % -> %',
    OLD.status, NEW.status;
END;
$$;

CREATE FUNCTION guard_community_purchase_quote_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.purchase_id, NEW.community_id, NEW.actor_id, NEW.listing_id,
    NEW.policy_version, NEW.buyer_wallet_address, NEW.buyer_chain_id, NEW.chain_id,
    NEW.token_contract, NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.purchase_id, OLD.community_id, OLD.actor_id, OLD.listing_id,
    OLD.policy_version, OLD.buyer_wallet_address, OLD.buyer_chain_id, OLD.chain_id,
    OLD.token_contract, OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase quote terms are immutable';
  END IF;

  IF OLD.eligibility_snapshot_id IS NOT NULL
    AND NEW.eligibility_snapshot_id IS DISTINCT FROM OLD.eligibility_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.pricing_snapshot_id IS NOT NULL
    AND NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.verification_snapshot_id IS NOT NULL
    AND NEW.verification_snapshot_id IS DISTINCT FROM OLD.verification_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.route_snapshot_id IS NOT NULL
    AND NEW.route_snapshot_id IS DISTINCT FROM OLD.route_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.allocation_snapshot_id IS NOT NULL
    AND NEW.allocation_snapshot_id IS DISTINCT FROM OLD.allocation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.settlement_snapshot_id IS NOT NULL
    AND NEW.settlement_snapshot_id IS DISTINCT FROM OLD.settlement_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.donation_snapshot_id IS NOT NULL
    AND NEW.donation_snapshot_id IS DISTINCT FROM OLD.donation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('active', 'bound', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'community purchase quote transition is not allowed: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE FUNCTION guard_community_route_attachment_intent() RETURNS trigger
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

CREATE FUNCTION guard_community_route_attachment_requirement_state() RETURNS trigger
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

CREATE FUNCTION guard_community_route_authority_grant_change() RETURNS trigger
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

CREATE FUNCTION guard_community_route_authority_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.route_authority_version IS DISTINCT FROM OLD.route_authority_version THEN
    RAISE EXCEPTION 'community route authority version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_community_route_revalidation_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  db_now TIMESTAMPTZ;
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
  semantic_contradiction BOOLEAN;
BEGIN
  db_now := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation completion attempts cannot be deleted';
  END IF;
  SELECT * INTO session_record
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = COALESCE(NEW.route_revalidation_id, OLD.route_revalidation_id)
     AND revalidation_session_id = COALESCE(NEW.revalidation_session_id, OLD.revalidation_session_id)
   FOR UPDATE;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation completion attempt lacks its session';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    SELECT count(*)::integer INTO consumed_count
      FROM community_route_revalidation_completion_attempts
     WHERE route_revalidation_id = NEW.route_revalidation_id AND state = 'consumed';
    IF session_record.status <> 'pending'
      OR session_record.expires_at <= db_now
      OR NEW.route_binding_id IS DISTINCT FROM session_record.route_binding_id
      OR NEW.expected_binding_generation IS DISTINCT FROM session_record.expected_binding_generation
      OR NEW.expected_verified_evidence_ref IS DISTINCT FROM session_record.expected_verified_evidence_ref
      OR NEW.attempt_number IS DISTINCT FROM consumed_count + 1
      OR consumed_count >= 3
      OR NEW.state <> 'leased'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR NEW.lease_expires_at > db_now + INTERVAL '16 seconds'
      OR NEW.lease_expires_at > session_record.expires_at
      OR NEW.terminal_result_document IS NOT NULL
      OR NEW.terminal_observed_expires_at IS NOT NULL
    THEN RAISE EXCEPTION 'route revalidation completion attempt is not admissible'; END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_attempt_id, NEW.route_revalidation_id,
    NEW.revalidation_session_id, NEW.route_binding_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.attempt_number, NEW.idempotency_key, NEW.completion_request_hash,
    NEW.evidence_ref, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_attempt_id, OLD.route_revalidation_id,
    OLD.revalidation_session_id, OLD.route_binding_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.attempt_number, OLD.idempotency_key, OLD.completion_request_hash,
    OLD.evidence_ref, OLD.created_at
  ) THEN RAISE EXCEPTION 'route revalidation completion attempt authority is immutable'; END IF;

  IF OLD.state = 'leased' AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL AND NEW.terminal_at IS NULL
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  IF OLD.state IN ('released', 'leased') AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND NEW.lease_expires_at <= db_now + INTERVAL '16 seconds'
    AND NEW.lease_expires_at <= session_record.expires_at
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
    AND NEW.consumption_kind IS NULL AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL AND NEW.terminal_at IS NULL
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;

  semantic_contradiction := OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.consumption_kind = 'challenge_mismatch' AND NEW.result_hash IS NULL
    AND NEW.terminal_result_document IS NULL
    AND NEW.terminal_observed_expires_at IS NULL
    AND session_record.status = 'pending';
  IF semantic_contradiction THEN
    IF NEW.fence_token <> OLD.fence_token OR NEW.lease_expires_at <> OLD.lease_expires_at
       OR OLD.lease_expires_at <= db_now OR NEW.terminal_at IS NULL OR NEW.terminal_at > db_now
    THEN RAISE EXCEPTION 'semantic contradiction attempt transition is not allowed'; END IF;
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;

  IF OLD.state = 'leased' AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NOT NULL AND NEW.result_hash IS NOT NULL
    AND NEW.terminal_result_document IS NOT NULL AND NEW.terminal_at IS NOT NULL
    AND (
      (NEW.consumption_kind = 'database_time_expired'
       AND NEW.terminal_observed_expires_at IS NOT NULL
       AND NEW.terminal_observed_expires_at <= db_now)
      OR (NEW.consumption_kind <> 'database_time_expired'
          AND NEW.terminal_observed_expires_at IS NULL)
    )
    AND NEW.terminal_at <= db_now
    AND ((NEW.consumption_kind <> 'session_expired' AND OLD.lease_expires_at > db_now
          AND session_record.status = 'pending' AND session_record.expires_at > db_now)
      OR (NEW.consumption_kind = 'session_expired' AND session_record.expires_at <= db_now))
    AND validate_community_route_revalidation_terminal_document(
      NEW.terminal_result_document, NEW.result_hash, NEW.consumption_kind,
      NEW.route_revalidation_id, NEW.revalidation_session_id,
      NEW.route_revalidation_attempt_id, NEW.route_binding_id,
      NEW.expected_binding_generation, NEW.idempotency_key,
      NEW.completion_request_hash)
  THEN NEW.updated_at := db_now; RETURN NEW; END IF;
  RAISE EXCEPTION 'route revalidation completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE FUNCTION guard_community_route_revalidation_session_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation sessions cannot be deleted';
  END IF;
  IF ROW(
    NEW.revalidation_session_id, NEW.route_revalidation_id, NEW.start_fence_token,
    NEW.community_id, NEW.route_binding_id, NEW.principal_kind, NEW.principal_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.requirement_hash, NEW.start_request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_reference, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.family, NEW.root_label,
    NEW.root_label_display, NEW.path_segment, NEW.upstream_session_ref,
    NEW.start_presentation,
    NEW.started_at, NEW.expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.revalidation_session_id, OLD.route_revalidation_id, OLD.start_fence_token,
    OLD.community_id, OLD.route_binding_id, OLD.principal_kind, OLD.principal_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.requirement_hash, OLD.start_request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_reference, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.family, OLD.root_label,
    OLD.root_label_display, OLD.path_segment, OLD.upstream_session_ref,
    OLD.start_presentation,
    OLD.started_at, OLD.expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route revalidation session authority is immutable';
  END IF;
  IF OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.terminal_at IS NOT NULL
    AND NEW.terminal_at <= clock_timestamp()
    AND (NEW.status <> 'expired' OR NEW.terminal_at >= NEW.expires_at)
  THEN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'route revalidation session transition is not allowed: % -> %',
    OLD.status, NEW.status;
END;
$$;

CREATE FUNCTION guard_community_route_revalidation_start() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  db_now TIMESTAMPTZ;
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  creation_session namespace_ownership_sessions%ROWTYPE;
  prior_session community_route_revalidation_sessions%ROWTYPE;
  prior_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
BEGIN
  db_now := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'route revalidation start reservations cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    -- Common route lock order: community -> binding -> evidence/session authority.
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id
     FOR UPDATE;
    SELECT * INTO binding_record
      FROM community_canonical_route_bindings
     WHERE route_binding_id = NEW.route_binding_id
       AND community_id = NEW.community_id
     FOR UPDATE;

    IF community_record.community_id IS NULL
      OR binding_record.route_binding_id IS NULL
      OR community_record.status <> 'active'
      OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
      OR binding_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
      OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
      OR binding_record.family IS DISTINCT FROM NEW.family
      OR binding_record.root_label IS DISTINCT FROM NEW.root_label
      OR binding_record.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR binding_record.path_segment IS DISTINCT FROM NEW.path_segment
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= db_now
      OR NEW.lease_expires_at > db_now + INTERVAL '16 seconds'
    THEN
      RAISE EXCEPTION 'route revalidation reservation does not match the canonical binding';
    END IF;

    IF NEW.expected_verified_evidence_ref IS NOT NULL THEN
      SELECT * INTO evidence_record
        FROM community_route_ownership_evidence
       WHERE evidence_ref = NEW.expected_verified_evidence_ref
       FOR SHARE;
      IF evidence_record.evidence_ref IS NULL
        OR evidence_record.family IS DISTINCT FROM NEW.family
        OR evidence_record.root_label IS DISTINCT FROM NEW.root_label
        OR evidence_record.root_label_display IS DISTINCT FROM NEW.root_label_display
        OR evidence_record.path_segment IS DISTINCT FROM NEW.path_segment
        OR evidence_record.binding_generation IS DISTINCT FROM NEW.expected_binding_generation
        OR evidence_record.provider_id IS DISTINCT FROM NEW.provider_id
        OR evidence_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR evidence_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
      THEN
        RAISE EXCEPTION 'route revalidation reservation does not match current evidence';
      END IF;

      IF evidence_record.origin = 'creation_ceremony' THEN
        SELECT * INTO creation_session
          FROM namespace_ownership_sessions
         WHERE ceremony_intent_id = evidence_record.creation_ceremony_intent_id
         FOR SHARE;
        IF creation_session.namespace_session_id IS NULL
          OR creation_session.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
          OR creation_session.provider_configuration_ref IS DISTINCT FROM NEW.provider_configuration_reference
          OR creation_session.protocol_version IS DISTINCT FROM NEW.protocol_version
          OR creation_session.environment IS DISTINCT FROM NEW.environment
        THEN
          RAISE EXCEPTION 'route revalidation reservation lacks creation provider authority';
        END IF;
      ELSE
        SELECT * INTO prior_snapshot
          FROM community_route_revalidation_evidence_snapshots
         WHERE route_revalidation_attempt_id = evidence_record.route_revalidation_attempt_id
         FOR SHARE;
        IF prior_snapshot.evidence_ref IS NULL
          OR prior_snapshot.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
          OR prior_snapshot.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
          OR prior_snapshot.protocol_version IS DISTINCT FROM NEW.protocol_version
          OR prior_snapshot.environment IS DISTINCT FROM NEW.environment
        THEN
          RAISE EXCEPTION 'route revalidation reservation lacks prior snapshot authority';
        END IF;
      END IF;
    ELSE
      -- Same-root recovery inherits authority from the operation that moved the
      -- binding to this suspended generation; it never guesses from route text.
      SELECT session.* INTO prior_session
        FROM community_route_revalidation_completion_attempts AS attempt
        JOIN community_route_revalidation_sessions AS session
          ON session.route_revalidation_id = attempt.route_revalidation_id
         AND session.revalidation_session_id = attempt.revalidation_session_id
       WHERE attempt.route_binding_id = NEW.route_binding_id
         AND attempt.expected_binding_generation = NEW.expected_binding_generation - 1
         AND attempt.state = 'consumed'
         AND attempt.consumption_kind IN (
           'missing_root', 'control_failed', 'challenge_mismatch',
           'insufficient_expiry', 'disputed', 'revoked', 'database_time_expired'
         )
       ORDER BY attempt.terminal_at DESC
       LIMIT 1
       FOR SHARE OF session;
      IF prior_session.revalidation_session_id IS NULL
        OR binding_record.route_lifecycle_status <> 'suspended'
        OR prior_session.principal_kind IS DISTINCT FROM NEW.principal_kind
        OR prior_session.principal_id IS DISTINCT FROM NEW.principal_id
        OR prior_session.provider_id IS DISTINCT FROM NEW.provider_id
        OR prior_session.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
        OR prior_session.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
        OR prior_session.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
        OR prior_session.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
        OR prior_session.protocol_version IS DISTINCT FROM NEW.protocol_version
        OR prior_session.environment IS DISTINCT FROM NEW.environment
        OR prior_session.family IS DISTINCT FROM NEW.family
        OR prior_session.root_label IS DISTINCT FROM NEW.root_label
        OR prior_session.root_label_display IS DISTINCT FROM NEW.root_label_display
        OR prior_session.path_segment IS DISTINCT FROM NEW.path_segment
      THEN
        RAISE EXCEPTION 'route revalidation recovery lacks prior operation authority';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.route_revalidation_id, NEW.revalidation_session_id, NEW.community_id,
    NEW.route_binding_id, NEW.principal_kind, NEW.principal_id,
    NEW.expected_binding_generation, NEW.expected_verified_evidence_ref,
    NEW.requirement_hash, NEW.provider_id, NEW.provider_binding_hash,
    NEW.provider_configuration_kind, NEW.provider_configuration_reference,
    NEW.provider_configuration_version, NEW.protocol_version, NEW.environment,
    NEW.family, NEW.root_label, NEW.root_label_display, NEW.path_segment,
    NEW.start_request_hash, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.route_revalidation_id, OLD.revalidation_session_id, OLD.community_id,
    OLD.route_binding_id, OLD.principal_kind, OLD.principal_id,
    OLD.expected_binding_generation, OLD.expected_verified_evidence_ref,
    OLD.requirement_hash, OLD.provider_id, OLD.provider_binding_hash,
    OLD.provider_configuration_kind, OLD.provider_configuration_reference,
    OLD.provider_configuration_version, OLD.protocol_version, OLD.environment,
    OLD.family, OLD.root_label, OLD.root_label_display, OLD.path_segment,
    OLD.start_request_hash, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'route revalidation reservation authority is immutable';
  END IF;

  IF OLD.state = 'acquired'
    AND NEW.state IN ('released', 'finalized')
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND OLD.lease_expires_at > db_now
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('released', 'acquired')
    AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > db_now
    AND NEW.lease_expires_at <= db_now + INTERVAL '16 seconds'
    AND (OLD.state = 'released' OR OLD.lease_expires_at <= db_now)
  THEN
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'route revalidation reservation transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE FUNCTION guard_hns_control_observer_reservation_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  snapshot_record hns_control_observer_snapshots%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS observer reservations cannot be deleted';
  END IF;

  IF NEW.observation_id <> OLD.observation_id
    OR NEW.reservation_lease_seconds <> OLD.reservation_lease_seconds
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HNS observer reservation identity is immutable';
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'reserved' THEN
    IF OLD.lease_expires_at > NEW.reservation_database_time
      OR NEW.observer_fence <> OLD.observer_fence + 1
      OR NEW.reservation_database_time <= OLD.reservation_database_time
      OR NEW.lease_expires_at <> NEW.reservation_database_time
        + NEW.reservation_lease_seconds * INTERVAL '1 second'
      OR NEW.updated_at <> NEW.reservation_database_time THEN
      RAISE EXCEPTION 'HNS observer reservation reacquisition is not fenced';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'reserved' AND NEW.state = 'terminal' THEN
    IF NEW.observer_fence <> OLD.observer_fence
      OR NEW.reservation_database_time <> OLD.reservation_database_time
      OR NEW.lease_expires_at <> OLD.lease_expires_at
      OR OLD.lease_expires_at <= clock_timestamp()
      OR NEW.terminal_at IS NULL
      OR NEW.terminal_at > clock_timestamp()
      OR NEW.terminal_at >= OLD.lease_expires_at THEN
      RAISE EXCEPTION 'HNS observer terminal transition lost its lease or fence';
    END IF;
    SELECT * INTO snapshot_record
      FROM hns_control_observer_snapshots
     WHERE observation_id = NEW.observation_id
       AND snapshot_reference = NEW.terminal_snapshot_reference
       AND observer_fence = NEW.observer_fence;
    IF NOT FOUND OR snapshot_record.result_status <> NEW.terminal_status THEN
      RAISE EXCEPTION 'HNS observer terminal transition lacks its snapshot';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'HNS observer reservation transition is not allowed';
END;
$$;

CREATE FUNCTION guard_media_moderation_projection_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id) THEN RAISE EXCEPTION 'moderation projection identity is immutable'; END IF;
  IF NEW.status = 'none' THEN RAISE EXCEPTION 'moderation projection cannot return to none'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL THEN RAISE EXCEPTION 'moderation projection submission is missing'; END IF;
  IF NEW.status = 'open' AND (OLD.status IS DISTINCT FROM 'none' OR submission_record.status <> 'manual_review' OR NEW.review_ref IS DISTINCT FROM submission_record.review_ref OR NEW.held_revision IS DISTINCT FROM submission_record.held_revision OR NEW.review_exhaustion_code IS DISTINCT FROM submission_record.review_exhaustion_code OR NEW.review_exhaustion_attempt_id IS DISTINCT FROM submission_record.review_exhaustion_attempt_id OR NEW.action_kind IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.action_evidence_ref IS NOT NULL) THEN RAISE EXCEPTION 'open moderation projection does not match its held submission'; END IF;
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status <> 'processing' OR submission_record.phase <> 'publish' OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.review_ref IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS DISTINCT FROM submission_record.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM submission_record.moderator_actor_id OR NEW.action_evidence_ref IS DISTINCT FROM submission_record.moderator_evidence_ref OR NEW.action_kind IS DISTINCT FROM 'approve') THEN RAISE EXCEPTION 'approved moderation projection does not match its submission action'; END IF;
  IF NEW.status = 'blocked' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status <> 'blocked' OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.review_ref IS DISTINCT FROM OLD.review_ref OR NEW.held_revision IS DISTINCT FROM OLD.held_revision OR NEW.review_ref IS NULL OR NEW.held_revision IS NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS DISTINCT FROM submission_record.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM submission_record.moderator_actor_id OR NEW.action_evidence_ref IS DISTINCT FROM submission_record.moderator_evidence_ref OR NEW.action_kind IS DISTINCT FROM 'block') THEN RAISE EXCEPTION 'blocked moderation projection does not match its submission action'; END IF;
  IF NEW.status = 'closed' AND (OLD.status IS DISTINCT FROM 'open' OR submission_record.status NOT IN ('processing','action_required','manual_review') OR NEW.decision_revision IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.action_evidence_ref IS NOT NULL) THEN RAISE EXCEPTION 'closed moderation projection is not an exact supersession'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_media_outbox_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.outbox_event_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.creation_revision, NEW.audio_revision, NEW.analysis_revision, NEW.workflow_revision, NEW.workflow_instance_id, NEW.event_type, NEW.effect_identity, NEW.payload, NEW.created_at) IS DISTINCT FROM ROW(OLD.outbox_event_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.creation_revision, OLD.audio_revision, OLD.analysis_revision, OLD.workflow_revision, OLD.workflow_instance_id, OLD.event_type, OLD.effect_identity, OLD.payload, OLD.created_at) THEN RAISE EXCEPTION 'media outbox effect identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.claim_fence < OLD.claim_fence OR NEW.delivery_attempts < OLD.delivery_attempts OR NEW.delivery_attempts > 3 THEN RAISE EXCEPTION 'media outbox fence must advance'; END IF;
  IF (OLD.state = 'pending' AND (OLD.delivery_attempts >= 3 OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF (OLD.state = 'failed' AND (OLD.delivery_attempts >= 3 OR OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp() OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.delivery_attempts <> CASE WHEN OLD.delivery_attempts < 3 THEN OLD.delivery_attempts + 1 ELSE OLD.delivery_attempts END OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media outbox reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') AND (NEW.delivery_attempts <> OLD.delivery_attempts OR OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL OR (NEW.state = 'exhausted' AND OLD.delivery_attempts <> 3) OR (NEW.state = 'failed' AND OLD.delivery_attempts >= 3) OR (NEW.state = 'failed' AND NEW.next_eligible_at IS NULL) OR (NEW.state = 'exhausted' AND NEW.next_eligible_at IS NOT NULL)) THEN RAISE EXCEPTION 'media outbox completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'failed', 'running') THEN RAISE EXCEPTION 'media outbox is terminal'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_media_processing_attempt_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.audio_revision, NEW.analysis_revision, NEW.stage, NEW.attempt_number, NEW.input_hash, NEW.provider_idempotency_key, NEW.input_kind, NEW.input_revision, NEW.policy_revision, NEW.adapter_revision, NEW.created_at) IS DISTINCT FROM ROW(OLD.attempt_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.audio_revision, OLD.analysis_revision, OLD.stage, OLD.attempt_number, OLD.input_hash, OLD.provider_idempotency_key, OLD.input_kind, OLD.input_revision, OLD.policy_revision, OLD.adapter_revision, OLD.created_at) THEN RAISE EXCEPTION 'media processing attempt identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media processing attempt timestamp must advance'; END IF;
  IF NEW.state = 'retry_wait' AND NEW.attempt_number >= 3 THEN RAISE EXCEPTION 'media processing attempt retry bound is exhausted'; END IF;
  IF OLD.state = 'retry_wait' AND (OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt retry is not yet eligible'; END IF;
  IF (OLD.state = 'pending' OR OLD.state = 'retry_wait') AND (NEW.state <> 'running' OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media processing attempt reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('succeeded', 'retry_wait', 'exhausted') AND (OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL) THEN RAISE EXCEPTION 'media processing attempt completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'retry_wait', 'running') THEN RAISE EXCEPTION 'media processing attempt is terminal'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_media_publication_projection_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE alignment_record media_alignment_projections%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id,NEW.community_id,NEW.actor_user_id,NEW.operation_id,NEW.post_id,NEW.creation_revision,NEW.audio_revision,NEW.analysis_revision,NEW.decision_revision,NEW.canonical_audio_sha256,NEW.title,NEW.audio_asset_ref,NEW.cover_artifact_ref,NEW.language_status,NEW.primary_language_bcp47,NEW.secondary_language_bcp47,NEW.lyrics_explicitness,NEW.analysis_badges,NEW.data_registration,NEW.locked_delivery,NEW.projected_at) IS DISTINCT FROM ROW(OLD.submission_id,OLD.community_id,OLD.actor_user_id,OLD.operation_id,OLD.post_id,OLD.creation_revision,OLD.audio_revision,OLD.analysis_revision,OLD.decision_revision,OLD.canonical_audio_sha256,OLD.title,OLD.audio_asset_ref,OLD.cover_artifact_ref,OLD.language_status,OLD.primary_language_bcp47,OLD.secondary_language_bcp47,OLD.lyrics_explicitness,OLD.analysis_badges,OLD.data_registration,OLD.locked_delivery,OLD.projected_at) THEN RAISE EXCEPTION 'media publication accepted evidence is immutable'; END IF;
  IF NEW.alignment IS DISTINCT FROM OLD.alignment THEN
    SELECT * INTO alignment_record FROM media_alignment_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
    IF alignment_record.submission_id IS NULL OR alignment_record.status IS DISTINCT FROM NEW.alignment OR alignment_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR alignment_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR alignment_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256 THEN
      RAISE EXCEPTION 'publication alignment is not owned by the exact alignment projection';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_media_reservation_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF ROW(NEW.reservation_id, NEW.community_id, NEW.actor_user_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.expected_content_type, NEW.expected_size_bytes, NEW.expected_sha256, NEW.upload_url, NEW.upload_headers, NEW.expires_at, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.reservation_id, OLD.community_id, OLD.actor_user_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.expected_content_type, OLD.expected_size_bytes, OLD.expected_sha256, OLD.upload_url, OLD.upload_headers, OLD.expires_at, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media reservation authority is immutable'; END IF;
  IF OLD.state IN ('sealed', 'rejected', 'expired') OR NOT ((OLD.state = 'issued' AND NEW.state = 'claimed') OR (OLD.state = 'issued' AND NEW.state = 'expired' AND OLD.expires_at <= clock_timestamp()) OR (OLD.state = 'claimed' AND NEW.state IN ('sealed', 'rejected')) OR (OLD.state = 'claimed' AND NEW.state = 'expired' AND OLD.expires_at <= clock_timestamp())) OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media reservation transition is not allowed'; END IF;
  IF OLD.state = 'issued' AND NEW.state = 'claimed' AND (NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.terminal_reason IS NOT NULL OR NEW.terminal_evidence_ref IS NOT NULL OR NEW.terminal_evidence_digest IS NOT NULL OR NEW.terminal_at IS NOT NULL OR NEW.terminal_fence IS NOT NULL) THEN RAISE EXCEPTION 'media reservation claim fence is not exact'; END IF;
  IF OLD.state = 'claimed' AND (NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id) THEN RAISE EXCEPTION 'media reservation claim identity is immutable'; END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'rejected' THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence
       OR NEW.terminal_fence IS DISTINCT FROM submission_record.event_sequence
       OR NEW.terminal_at IS NULL
       OR NEW.terminal_evidence_ref IS NULL
       OR NEW.terminal_evidence_digest IS DISTINCT FROM encode(sha256(NEW.terminal_evidence_ref::bytea), 'hex')
       OR (submission_record.status = 'abandoned' AND NEW.terminal_reason IS DISTINCT FROM CASE submission_record.abandonment_reason WHEN 'upload_expectation_mismatch' THEN 'expectation_mismatch' WHEN 'upload_source_changed_before_finalize' THEN 'source_precondition_failed' ELSE NULL END)
       OR (submission_record.status = 'processing_failed' AND (NEW.terminal_reason IS DISTINCT FROM 'destination_conflict' OR submission_record.failure_code IS DISTINCT FROM 'upload_seal_conflict'))
       OR submission_record.status NOT IN ('abandoned', 'processing_failed')
       THEN
      RAISE EXCEPTION 'media reservation rejection is not bound to its terminal submission';
    END IF;
  END IF;
  IF OLD.state = 'claimed' AND NEW.state = 'expired' THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR submission_record.status IS DISTINCT FROM 'abandoned'
       OR submission_record.abandonment_reason IS DISTINCT FROM 'reservation_expired'
       OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence
       OR NEW.submission_id IS NULL OR NEW.operation_id IS NULL
       OR NEW.terminal_reason IS NOT NULL OR NEW.terminal_evidence_ref IS NOT NULL
       OR NEW.terminal_evidence_digest IS NOT NULL OR NEW.terminal_at IS NOT NULL
       OR NEW.terminal_fence IS NOT NULL
       OR NEW.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'media reservation expiry is not bound to its terminal submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_media_submission_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE allowed BOOLEAN := FALSE; community_active BOOLEAN; membership_active BOOLEAN; analysis_record media_analysis_evidence%ROWTYPE; decision_record media_publication_decisions%ROWTYPE; post_record posts%ROWTYPE; audio_record media_audio_revisions%ROWTYPE; terms_record media_submission_terms%ROWTYPE; moderation_action media_moderation_actions%ROWTYPE;
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.endpoint_template, NEW.idempotency_key, NEW.request_hash, NEW.title, NEW.song_type, NEW.start_input, NEW.audio_reservation_id, NEW.response_snapshot_bytes, NEW.response_snapshot_sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.endpoint_template, OLD.idempotency_key, OLD.request_hash, OLD.title, OLD.song_type, OLD.start_input, OLD.audio_reservation_id, OLD.response_snapshot_bytes, OLD.response_snapshot_sha256, OLD.created_at) THEN RAISE EXCEPTION 'media submission authority is immutable'; END IF;
  IF NEW.event_sequence <> OLD.event_sequence + 1 OR NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'media submission transition fence did not advance'; END IF;
  SELECT status = 'active' INTO community_active FROM communities WHERE community_id = NEW.community_id FOR SHARE;
  SELECT status = 'member' INTO membership_active FROM community_memberships WHERE community_id = NEW.community_id AND user_id = NEW.actor_user_id FOR SHARE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'media submission requires active community membership'; END IF;
  allowed :=
    (OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload'
      AND NEW.creation_revision = 1 AND NEW.audio_revision = 0 AND NEW.analysis_revision = 0 AND NEW.decision_revision = 0
      AND NEW.workflow_revision = 0 AND NEW.current_terms_revision IS NULL AND NEW.current_immutable_ref IS NULL
      AND NEW.current_analysis_revision IS NULL AND NEW.current_decision_revision IS NULL AND NEW.post_id IS NULL)
    OR ((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL))
      AND NEW.status = 'processing' AND NEW.phase = CASE WHEN OLD.audio_revision = 0 THEN 'awaiting_upload' ELSE 'analysis' END
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.current_terms_revision = NEW.creation_revision
      AND NEW.workflow_revision = OLD.workflow_revision AND NEW.post_id IS NULL
    OR (OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND OLD.audio_revision = 0 AND NEW.status = 'processing' AND NEW.phase = 'analysis'
      AND NEW.audio_revision = 1 AND NEW.analysis_revision = OLD.analysis_revision AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.creation_revision = OLD.creation_revision)
    OR (OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'processing' AND NEW.phase IN ('analysis', 'decision')
      AND NEW.analysis_revision = OLD.analysis_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'processing' AND NEW.phase = 'publish'
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('analysis', 'decision') AND NEW.status = 'manual_review' AND NEW.phase IS NULL
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'blocked' AND NEW.phase IS NULL
      AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision
      AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.phase IS NULL
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision
      AND NEW.analysis_revision = OLD.analysis_revision AND NEW.review_ref IS NOT NULL AND NEW.review_exhaustion_code = 'acr_exhausted' AND NEW.review_exhaustion_attempt_id IS NOT NULL
      AND NEW.held_revision = OLD.creation_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' AND NEW.phase IS NULL
      AND NEW.action_kind = 'reference_required' AND NEW.action_expires_at > clock_timestamp() AND NEW.held_revision = OLD.creation_revision
      AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.post_id IS NULL)
    OR (OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.phase = 'analysis'
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision AND NEW.bound_reference_asset_id IS NOT NULL AND NEW.post_id IS NULL)
    OR (OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.phase = 'publish'
      AND NEW.creation_revision = OLD.creation_revision AND NEW.decision_revision = OLD.decision_revision + 1 AND NEW.current_decision_revision = NEW.decision_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status = 'blocked' AND NEW.phase IS NULL
      AND NEW.creation_revision = OLD.creation_revision AND NEW.decision_revision = OLD.decision_revision AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' AND NEW.phase IS NULL
      AND NEW.workflow_revision = OLD.workflow_revision + 1 AND NEW.post_id IS NOT NULL AND NEW.decision_revision = OLD.decision_revision AND NEW.current_decision_revision = NEW.decision_revision AND NEW.creation_revision = OLD.creation_revision)
    OR (OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish') AND NEW.status = 'processing_failed' AND NEW.phase IS NULL
      AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision
      AND NEW.failure_code IS NOT NULL AND NEW.failure_retry_count IS NOT NULL AND NEW.last_safe_phase IS NOT NULL
      AND (NEW.failure_code IS DISTINCT FROM 'upload_seal_conflict' OR OLD.phase = 'finalize'))
    OR (OLD.status = 'processing_failed' AND OLD.phase IS NULL AND OLD.retryable = TRUE AND OLD.failure_retry_count < 3 AND OLD.retry_count < 3 AND NEW.status = 'processing' AND NEW.phase = OLD.last_safe_phase
      AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.retry_count = OLD.retry_count + 1 AND NEW.audio_revision = OLD.audio_revision AND NEW.analysis_revision = OLD.analysis_revision
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.workflow_revision = OLD.workflow_revision)
    OR (OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'abandoned' AND NEW.phase IS NULL AND OLD.action_kind = 'reference_required'
      AND OLD.action_expires_at <= clock_timestamp() AND NEW.abandonment_reason = 'action_deadline_elapsed' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload') AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'author_cancelled' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'reservation_expired' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize') AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'upload_expectation_mismatch' AND NEW.post_id IS NULL)
    OR (OLD.status = 'processing' AND OLD.phase = 'finalize' AND OLD.audio_revision = 0 AND NEW.status = 'abandoned' AND NEW.phase IS NULL
      AND NEW.abandonment_reason = 'upload_source_changed_before_finalize' AND NEW.post_id IS NULL);
  IF allowed IS NOT TRUE THEN RAISE EXCEPTION 'media submission transition is not allowed'; END IF;
  IF OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload' THEN
    IF NEW.creation_revision IS DISTINCT FROM OLD.creation_revision OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision OR NEW.decision_revision IS DISTINCT FROM OLD.decision_revision OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_decision_revision IS DISTINCT FROM OLD.current_decision_revision OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.retry_count IS DISTINCT FROM OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.action_kind IS DISTINCT FROM OLD.action_kind OR NEW.action_reference_request_ref IS DISTINCT FROM OLD.action_reference_request_ref OR NEW.action_expires_at IS DISTINCT FROM OLD.action_expires_at OR NEW.held_revision IS DISTINCT FROM OLD.held_revision OR NEW.review_ref IS DISTINCT FROM OLD.review_ref OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code OR NEW.review_exhaustion_code IS DISTINCT FROM OLD.review_exhaustion_code OR NEW.review_exhaustion_attempt_id IS DISTINCT FROM OLD.review_exhaustion_attempt_id OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref OR NEW.moderator_approval_kind IS DISTINCT FROM OLD.moderator_approval_kind OR NEW.moderator_reason_code IS DISTINCT FROM OLD.moderator_reason_code OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'reservation issued transition evidence is not exact'; END IF;
  ELSIF (((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL)) AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.current_terms_revision = NEW.creation_revision) THEN
    SELECT * INTO terms_record FROM media_submission_terms WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND creation_revision=NEW.creation_revision FOR SHARE;
    IF terms_record.submission_id IS NULL OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL OR terms_record.license_preset IS NULL OR terms_record.access_mode <> 'public' THEN RAISE EXCEPTION 'terms transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND NEW.status = 'processing' AND NEW.audio_revision = OLD.audio_revision + 1 THEN
    SELECT * INTO audio_record FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision FOR SHARE;
    IF audio_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> OLD.decision_revision OR NEW.current_decision_revision IS DISTINCT FROM OLD.current_decision_revision OR NEW.workflow_revision <> OLD.workflow_revision + 1 OR NEW.current_immutable_ref IS DISTINCT FROM audio_record.immutable_ref OR NEW.phase <> 'analysis' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'audio transition evidence is not exact'; END IF;
    IF NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision + 1 OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'audio transition pointers are not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'processing' AND NEW.analysis_revision = OLD.analysis_revision + 1 THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.current_analysis_revision <> NEW.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.phase NOT IN ('analysis','decision') OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.post_id IS NOT NULL OR analysis_record.audio_revision <> NEW.audio_revision OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) THEN RAISE EXCEPTION 'analysis transition evidence is not exact'; END IF;
    IF NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'analysis transition pointers are not exact'; END IF;
  ELSIF OLD.status = 'processing' AND (OLD.phase = 'decision' OR (OLD.phase = 'analysis' AND NEW.status = 'manual_review')) AND NEW.decision_revision = OLD.decision_revision + 1 THEN
    SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision FOR SHARE;
    IF decision_record.submission_id IS NULL
       OR NEW.creation_revision <> OLD.creation_revision
       OR NEW.audio_revision <> OLD.audio_revision
       OR NEW.analysis_revision <> OLD.analysis_revision
       OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps)
       OR NEW.workflow_revision <> OLD.workflow_revision
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count
       OR NEW.retryable IS DISTINCT FROM OLD.retryable
       OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase
       OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason
       OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition
       OR NEW.current_decision_revision <> NEW.decision_revision
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR decision_record.creation_revision <> NEW.creation_revision
       OR decision_record.audio_revision <> NEW.audio_revision
       OR decision_record.analysis_revision <> NEW.analysis_revision
       OR decision_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision)
       OR (decision_record.outcome = 'allow' AND (NEW.status <> 'processing' OR NEW.phase <> 'publish' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL))
       OR (decision_record.outcome = 'manual_review' AND (NEW.status <> 'manual_review' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NULL OR NEW.review_reason_code <> 'review_required' OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision <> NEW.creation_revision OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL))
       OR (decision_record.outcome = 'block' AND (NEW.status <> 'blocked' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL)) THEN RAISE EXCEPTION 'decision transition evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.decision_revision = 0 AND NEW.review_exhaustion_code = 'acr_exhausted' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR NOT EXISTS (SELECT 1 FROM media_submission_terms t WHERE t.community_id=NEW.community_id AND t.actor_user_id=NEW.actor_user_id AND t.submission_id=NEW.submission_id AND t.operation_id=NEW.operation_id AND t.creation_revision=NEW.creation_revision) OR analysis_record.acr_decision <> 'inconclusive' OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.current_decision_revision IS NOT NULL OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.review_exhaustion_attempt_id IS NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NOT EXISTS (SELECT 1 FROM media_processing_attempts a WHERE a.attempt_id=NEW.review_exhaustion_attempt_id AND a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.stage='acr' AND a.input_kind='audio' AND a.audio_revision=NEW.audio_revision AND a.analysis_revision=NEW.analysis_revision AND a.input_revision=NEW.audio_revision AND a.input_hash=(SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) AND a.state='exhausted' AND a.retryable=FALSE AND a.failure_code IS NOT NULL AND a.attempt_number=3 AND NOT EXISTS (SELECT 1 FROM media_processing_attempts later WHERE later.community_id=a.community_id AND later.actor_user_id=a.actor_user_id AND later.submission_id=a.submission_id AND later.operation_id=a.operation_id AND later.stage='acr' AND later.attempt_number>a.attempt_number)) THEN RAISE EXCEPTION 'ACR exhaustion evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR analysis_record.operation_id IS DISTINCT FROM NEW.operation_id OR analysis_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR analysis_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM (SELECT canonical_sha256 FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision) OR analysis_record.finalized_audio_ref IS DISTINCT FROM NEW.current_immutable_ref OR analysis_record.acr_decision IS DISTINCT FROM 'requires_reference' OR analysis_record.acr_evidence_ref IS NULL OR analysis_record.acr_policy_revision IS NULL OR analysis_record.acr_adapter_revision IS NULL THEN RAISE EXCEPTION 'reference action analysis evidence is not exact'; END IF;
    IF NEW.phase IS NOT NULL OR NEW.action_kind IS DISTINCT FROM 'reference_required' OR NEW.action_expires_at <= clock_timestamp() OR NEW.held_revision <> OLD.creation_revision OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.post_id IS NOT NULL THEN RAISE EXCEPTION 'reference action evidence is not exact'; END IF;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'reference action pointers are not exact'; END IF;
  ELSIF OLD.status = 'action_required' AND OLD.phase IS NULL AND NEW.status = 'processing' AND NEW.bound_reference_asset_id IS NOT NULL THEN
    IF NEW.creation_revision <> OLD.creation_revision + 1 OR OLD.action_expires_at <= clock_timestamp() OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase <> 'analysis' OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.bound_reference_audio_revision <> NEW.audio_revision OR NEW.bound_reference_analysis_revision > NEW.analysis_revision THEN RAISE EXCEPTION 'bound reference transition evidence is not exact'; END IF;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count OR NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'bound reference pointers are not exact'; END IF;
  ELSIF OLD.status = 'manual_review' AND OLD.phase IS NULL AND NEW.status IN ('processing','blocked') THEN
    SELECT * INTO moderation_action FROM media_moderation_actions WHERE action_id=NEW.moderator_action_id AND community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps)
       OR NEW.workflow_revision <> OLD.workflow_revision
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count
       OR NEW.retryable IS DISTINCT FROM OLD.retryable
       OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase
       OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason
       OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition
       OR moderation_action.action_id IS NULL
       OR moderation_action.authority_actor_user_id IS DISTINCT FROM NEW.moderator_actor_id
       OR moderation_action.held_revision IS DISTINCT FROM OLD.held_revision
       OR moderation_action.evidence_ref IS DISTINCT FROM NEW.moderator_evidence_ref
       OR (moderation_action.action_kind = 'approve' AND (NEW.status <> 'processing' OR NEW.phase <> 'publish' OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR moderation_action.decision_revision IS DISTINCT FROM NEW.decision_revision OR moderation_action.approval_kind IS DISTINCT FROM NEW.moderator_approval_kind OR moderation_action.reason_code IS DISTINCT FROM NEW.moderator_reason_code OR moderation_action.decision_snapshot IS DISTINCT FROM (SELECT decision_snapshot FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision)))
       OR (moderation_action.action_kind = 'block' AND (NEW.status <> 'blocked' OR NEW.phase IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS DISTINCT FROM 'policy_violation' OR moderation_action.decision_revision IS NOT NULL OR moderation_action.approval_kind IS NOT NULL OR moderation_action.reason_code IS DISTINCT FROM 'policy_violation' OR NEW.decision_revision <> OLD.decision_revision)) THEN RAISE EXCEPTION 'moderation action evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' THEN
    IF NEW.creation_revision <> OLD.creation_revision
       OR NEW.audio_revision <> OLD.audio_revision
       OR NEW.analysis_revision <> OLD.analysis_revision
       OR NEW.decision_revision <> OLD.decision_revision
       OR NEW.current_decision_revision IS DISTINCT FROM NEW.decision_revision
       OR NEW.workflow_revision <> OLD.workflow_revision + 1
       OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps)
       OR NEW.retry_count <> OLD.retry_count
       OR NEW.failure_code IS NOT NULL
       OR NEW.failure_retry_count IS NOT NULL
       OR NEW.retryable IS NOT NULL
       OR NEW.last_safe_phase IS NOT NULL
       OR NEW.action_kind IS NOT NULL
       OR NEW.action_reference_request_ref IS NOT NULL
       OR NEW.action_expires_at IS NOT NULL
       OR NEW.review_ref IS NOT NULL
       OR NEW.review_reason_code IS NOT NULL
       OR NEW.review_exhaustion_code IS NOT NULL
       OR NEW.review_exhaustion_attempt_id IS NOT NULL
       OR NEW.held_revision IS NOT NULL
       OR NEW.abandonment_reason IS NOT NULL
       OR NEW.retention_disposition IS NOT NULL
       OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id
       OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id
       OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref
       OR NEW.moderator_approval_kind IS DISTINCT FROM OLD.moderator_approval_kind
       OR NEW.moderator_reason_code IS DISTINCT FROM OLD.moderator_reason_code
       OR NEW.post_id IS NULL THEN
      RAISE EXCEPTION 'publication transition evidence is not exact';
    END IF;
  ELSIF OLD.status = 'processing' AND OLD.phase IN ('reserve', 'awaiting_upload', 'finalize', 'analysis', 'decision', 'publish') AND NEW.status = 'processing_failed' THEN
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.retry_count <> OLD.retry_count OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.moderator_action_id IS DISTINCT FROM OLD.moderator_action_id OR NEW.moderator_actor_id IS DISTINCT FROM OLD.moderator_actor_id OR NEW.moderator_evidence_ref IS DISTINCT FROM OLD.moderator_evidence_ref THEN RAISE EXCEPTION 'media failure pointers are not exact'; END IF;
    IF NEW.phase IS NOT NULL OR NEW.creation_revision <> OLD.creation_revision OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.failure_code IS NULL OR NEW.failure_retry_count IS NULL OR NEW.last_safe_phase IS NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.abandonment_reason IS NOT NULL OR NEW.retention_disposition IS NOT NULL THEN RAISE EXCEPTION 'media failure evidence is not exact'; END IF;
  ELSIF OLD.status = 'processing_failed' AND NEW.status = 'processing' THEN
    IF NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps) OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition THEN RAISE EXCEPTION 'retry transition pointers are not exact'; END IF;
    IF OLD.retryable IS DISTINCT FROM TRUE OR OLD.failure_retry_count IS NULL OR OLD.failure_retry_count >= 3 OR OLD.retry_count >= 3 OR NEW.creation_revision <> OLD.creation_revision + 1 OR NEW.retry_count <> OLD.retry_count + 1 OR NEW.audio_revision <> OLD.audio_revision OR NEW.analysis_revision <> OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.phase IS DISTINCT FROM OLD.last_safe_phase OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'retry transition evidence is not exact'; END IF;
  END IF;
  IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_ref = NEW.bound_reference_evidence_ref AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'bound reference evidence is missing'; END IF;
  IF (NEW.status = 'processing' AND NEW.phase = 'publish') OR NEW.status = 'published' THEN
    SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision = NEW.analysis_revision FOR SHARE;
    SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision = NEW.decision_revision FOR SHARE;
    IF analysis_record.submission_id IS NULL OR decision_record.submission_id IS NULL OR decision_record.outcome <> 'allow' OR decision_record.creation_revision <> NEW.creation_revision OR decision_record.audio_revision <> NEW.audio_revision OR decision_record.analysis_revision <> NEW.analysis_revision OR decision_record.canonical_audio_sha256 <> analysis_record.canonical_audio_sha256 OR analysis_record.media_safety <> 'allow' OR analysis_record.lyrics_safety NOT IN ('skipped', 'allow') OR analysis_record.speech_status = 'unavailable' OR analysis_record.explicitness NOT IN ('not_explicit', 'no_lyrics') OR (analysis_record.acr_decision = 'inconclusive' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.community_id=NEW.community_id AND m.actor_user_id=NEW.actor_user_id AND m.submission_id=NEW.submission_id AND m.operation_id=NEW.operation_id AND m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code IN ('acr_inconclusive','acr_exhausted'))) OR (analysis_record.acr_decision = 'skipped' AND NOT EXISTS (SELECT 1 FROM media_moderation_actions m WHERE m.community_id=NEW.community_id AND m.actor_user_id=NEW.actor_user_id AND m.submission_id=NEW.submission_id AND m.operation_id=NEW.operation_id AND m.action_id=NEW.moderator_action_id AND m.approval_kind='acr_override' AND m.reason_code='acr_skipped')) OR (analysis_record.acr_decision = 'requires_reference' AND NEW.bound_reference_asset_id IS NULL) OR NOT EXISTS (SELECT 1 FROM media_submission_terms WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id = NEW.submission_id AND operation_id=NEW.operation_id AND creation_revision = NEW.creation_revision) THEN RAISE EXCEPTION 'media publication evidence is not ratified'; END IF;
  END IF;
  IF NEW.status = 'published' THEN
    SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
    IF post_record.post_id IS NULL OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title <> NEW.title THEN RAISE EXCEPTION 'media publication Post is not owned by submission'; END IF;
  END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' AND NOT EXISTS (SELECT 1 FROM media_upload_reservations r WHERE r.community_id=NEW.community_id AND r.actor_user_id=NEW.actor_user_id AND r.reservation_id=NEW.audio_reservation_id AND r.expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'reservation is not expired'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('author_cancelled', 'reservation_expired') AND NEW.retention_disposition IS DISTINCT FROM 'no_object' THEN RAISE EXCEPTION 'pre-finalize abandonment retention is not exact'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('upload_expectation_mismatch', 'upload_source_changed_before_finalize') AND NEW.retention_disposition IS DISTINCT FROM 'retain_for_reconciliation' THEN RAISE EXCEPTION 'upload precondition abandonment retention is not exact'; END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'action_deadline_elapsed' AND NEW.retention_disposition IS DISTINCT FROM (CASE WHEN NEW.audio_revision > 0 THEN 'retain_until_expiry' ELSE 'no_object' END) THEN RAISE EXCEPTION 'action deadline retention is not exact'; END IF;
  IF NEW.status = 'abandoned' THEN
    IF NEW.phase IS NOT NULL OR NEW.post_id IS NOT NULL OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision OR NEW.decision_revision <> 0 OR NEW.current_decision_revision IS NOT NULL OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision OR ROW(NEW.bound_reference_asset_id, NEW.bound_reference_evidence_ref, NEW.bound_reference_audio_revision, NEW.bound_reference_analysis_revision, NEW.bound_reference_audio_sha256, NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id, OLD.bound_reference_evidence_ref, OLD.bound_reference_audio_revision, OLD.bound_reference_analysis_revision, OLD.bound_reference_audio_sha256, OLD.bound_reference_upstream_share_bps) OR NEW.workflow_revision <> OLD.workflow_revision OR NEW.retry_count <> OLD.retry_count OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL THEN RAISE EXCEPTION 'abandoned cleanup is not exact'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_namespace_ownership_completion_attempt_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  transition_at TIMESTAMPTZ;
BEGIN
  transition_at := clock_timestamp();
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership completion attempts are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := transition_at;
    NEW.updated_at := transition_at;
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT ci.* INTO intent_record
      FROM community_creation_intents AS ci
     WHERE ci.actor_id = NEW.actor_id
       AND ci.intent_id = (
         SELECT ns0.creation_intent_id
           FROM namespace_ownership_sessions AS ns0
          WHERE ns0.namespace_session_id = NEW.namespace_session_id
            AND ns0.actor_id = NEW.actor_id
       )
     FOR SHARE;
    SELECT crs.* INTO state_record
      FROM community_creation_requirement_states AS crs
     WHERE crs.actor_id = NEW.actor_id
       AND crs.intent_id = intent_record.intent_id
       AND crs.requirement_kind = 'namespace_ownership'
     FOR SHARE;
    SELECT ns.* INTO session_record
      FROM namespace_ownership_sessions AS ns
     WHERE ns.namespace_session_id = NEW.namespace_session_id
       AND ns.actor_id = NEW.actor_id
     FOR UPDATE;
    IF session_record.namespace_session_id IS NULL
      OR intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR session_record.status <> 'pending'
      OR session_record.expires_at <= transition_at
      OR NEW.state <> 'leased'
      OR NEW.consumption_kind IS NOT NULL
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= transition_at
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt requires a live pending session';
    END IF;
    IF NEW.lease_expires_at > session_record.expires_at THEN
      RAISE EXCEPTION 'completion lease exceeds its namespace session expiry';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.completion_attempt_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.idempotency_key, NEW.completion_request_hash, NEW.evidence_ref,
    NEW.submission_channel, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.completion_attempt_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.idempotency_key, OLD.completion_request_hash, OLD.evidence_ref,
    OLD.submission_channel, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership completion attempt identity is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
    AND OLD.consumption_kind IS NOT DISTINCT FROM NEW.consumption_kind
    AND OLD.updated_at = NEW.updated_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  IF session_record.namespace_session_id IS NULL
    OR session_record.status NOT IN ('pending', 'expired')
  THEN
    RAISE EXCEPTION 'completion attempt requires its pending or expired session';
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'released'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.state = 'leased'
    AND NEW.state = 'consumed'
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at = OLD.lease_expires_at
    AND OLD.consumption_kind IS NULL
  THEN
    IF NEW.consumption_kind IN ('semantic_contradiction', 'verified', 'rejected') THEN
      IF session_record.status = 'pending'
        AND OLD.lease_expires_at > transition_at
        AND session_record.expires_at > transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.consumption_kind = 'expired' THEN
      IF session_record.status IN ('pending', 'expired')
        AND session_record.expires_at <= transition_at
      THEN
        NEW.updated_at := transition_at;
        RETURN NEW;
      END IF;
      RETURN NULL;
    END IF;
  END IF;

  IF OLD.state IN ('released', 'leased')
    AND NEW.state = 'leased'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at <= session_record.expires_at
    AND NEW.consumption_kind IS NULL
  THEN
    IF session_record.status = 'pending'
      AND session_record.expires_at > transition_at
      AND NEW.lease_expires_at > transition_at
      AND (
        OLD.state = 'released'
        OR OLD.lease_expires_at <= transition_at
      )
    THEN
      NEW.updated_at := transition_at;
      RETURN NEW;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'namespace ownership completion attempt transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE FUNCTION guard_namespace_ownership_session_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership sessions are append-only';
  END IF;

  IF ROW(
    NEW.namespace_session_id, NEW.actor_id, NEW.creation_intent_id,
    NEW.ceremony_intent_id, NEW.start_reservation_id, NEW.start_fence_token,
    NEW.expected_revision, NEW.requirement_kind, NEW.generation,
    NEW.requirement_hash, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.upstream_session_ref,
    NEW.presentation_kind, NEW.presentation_payload, NEW.started_at, NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.namespace_session_id, OLD.actor_id, OLD.creation_intent_id,
    OLD.ceremony_intent_id, OLD.start_reservation_id, OLD.start_fence_token,
    OLD.expected_revision, OLD.requirement_kind, OLD.generation,
    OLD.requirement_hash, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.upstream_session_ref,
    OLD.presentation_kind, OLD.presentation_payload, OLD.started_at, OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership session identity and launch fields are immutable';
  END IF;

  IF NOT (
    OLD.status = 'pending'
    AND NEW.status IN ('completed', 'failed', 'expired')
    AND NEW.generation = OLD.generation
  ) THEN
    RAISE EXCEPTION 'namespace ownership session transition is not allowed: % -> %',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_namespace_ownership_start_reservation_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'namespace ownership start reservations are append-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Lock order: actor -> intent -> requirement state -> start reservation.
    PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
    SELECT * INTO intent_record
      FROM community_creation_intents
     WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
     FOR SHARE;
    SELECT * INTO state_record
      FROM community_creation_requirement_states
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
     FOR UPDATE;
    SELECT * INTO ceremony_record
      FROM community_creation_ceremony_attempts
     WHERE actor_id = NEW.actor_id
       AND intent_id = NEW.creation_intent_id
       AND requirement_kind = NEW.requirement_kind
       AND generation = NEW.generation
       AND ceremony_intent_id = NEW.ceremony_intent_id
     FOR SHARE;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
     FOR SHARE;

    IF intent_record.intent_id IS NULL
      OR state_record.intent_id IS NULL
      OR ceremony_record.ceremony_intent_id IS NULL
      OR state_record.status <> 'pending'
      OR intent_record.revision <> NEW.expected_revision
      OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
      OR state_record.generation <> NEW.generation
      OR state_record.requirement_hash <> NEW.requirement_hash
      OR state_record.provider_id <> NEW.provider_id
      OR state_record.provider_binding_hash <> NEW.provider_binding_hash
      OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR state_record.provider_configuration_version <> NEW.provider_configuration_version
      OR state_record.route_family <> NEW.route_family
      OR state_record.route_root_label <> NEW.route_root_label
      OR state_record.route_root_label_display <> NEW.route_root_label_display
      OR state_record.route_path_segment <> NEW.route_path_segment
      OR ceremony_record.requirement_hash <> NEW.requirement_hash
      OR ceremony_record.provider_id <> NEW.provider_id
      OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
      OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
      OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
      OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
      OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
      OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
      OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
      OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
      OR NEW.state <> 'acquired'
      OR NEW.fence_token <> 1
      OR NEW.lease_expires_at <= clock_timestamp()
      OR (
        session_record.namespace_session_id IS NOT NULL
        AND NEW.lease_expires_at > session_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its ceremony';
    END IF;

    IF session_record.namespace_session_id IS NOT NULL
      AND (
        session_record.start_reservation_id <> NEW.reservation_id
        OR session_record.start_fence_token <> NEW.fence_token
        OR session_record.expected_revision <> NEW.expected_revision
        OR session_record.requirement_hash <> NEW.requirement_hash
        OR session_record.request_hash <> NEW.request_hash
        OR session_record.provider_id <> NEW.provider_id
        OR session_record.provider_binding_hash <> NEW.provider_binding_hash
        OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR session_record.provider_configuration_version <> NEW.provider_configuration_version
        OR session_record.protocol_version <> NEW.protocol_version
        OR session_record.environment <> NEW.environment
        OR session_record.route_family <> NEW.route_family
        OR session_record.route_root_label <> NEW.route_root_label
        OR session_record.route_root_label_display <> NEW.route_root_label_display
        OR session_record.route_path_segment <> NEW.route_path_segment
        OR session_record.route_href <> NEW.route_href
        OR session_record.route_app_host IS DISTINCT FROM NEW.route_app_host
      )
    THEN
      RAISE EXCEPTION 'namespace ownership start reservation does not match its session';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.reservation_id, NEW.namespace_session_id, NEW.actor_id,
    NEW.creation_intent_id, NEW.ceremony_intent_id, NEW.requirement_kind,
    NEW.generation, NEW.requirement_hash, NEW.expected_revision,
    NEW.client_idempotency_key, NEW.request_hash, NEW.provider_id,
    NEW.provider_binding_hash, NEW.provider_configuration_kind,
    NEW.provider_configuration_ref, NEW.provider_configuration_version,
    NEW.protocol_version, NEW.environment, NEW.route_family,
    NEW.route_root_label, NEW.route_root_label_display, NEW.route_path_segment,
    NEW.route_href, NEW.route_app_host, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.reservation_id, OLD.namespace_session_id, OLD.actor_id,
    OLD.creation_intent_id, OLD.ceremony_intent_id, OLD.requirement_kind,
    OLD.generation, OLD.requirement_hash, OLD.expected_revision,
    OLD.client_idempotency_key, OLD.request_hash, OLD.provider_id,
    OLD.provider_binding_hash, OLD.provider_configuration_kind,
    OLD.provider_configuration_ref, OLD.provider_configuration_version,
    OLD.protocol_version, OLD.environment, OLD.route_family,
    OLD.route_root_label, OLD.route_root_label_display, OLD.route_path_segment,
    OLD.route_href, OLD.route_app_host, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'namespace ownership start reservation authority is immutable';
  END IF;

  IF OLD.state = NEW.state
    AND OLD.fence_token = NEW.fence_token
    AND OLD.lease_expires_at = NEW.lease_expires_at
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  IF session_record.namespace_session_id IS NOT NULL
    AND NEW.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start lease exceeds its session expiry';
  END IF;

  IF OLD.state = 'acquired'
    AND NEW.state IN ('released', 'finalized')
    AND NEW.fence_token = OLD.fence_token
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'released'
    AND NEW.state = 'acquired'
    AND NEW.fence_token = OLD.fence_token + 1
    AND NEW.lease_expires_at > clock_timestamp()
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'namespace ownership start reservation transition is not allowed: % -> %',
    OLD.state, NEW.state;
END;
$$;

CREATE FUNCTION guard_text_content_submission_response_snapshot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.response_snapshot_bytes IS DISTINCT FROM OLD.response_snapshot_bytes
    OR NEW.response_snapshot_sha256 IS DISTINCT FROM OLD.response_snapshot_sha256
  THEN
    RAISE EXCEPTION 'text content submission response snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_text_content_submission_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.submission_id, NEW.operation_id, NEW.actor_user_id,
    NEW.surface, NEW.idempotency_key, NEW.request_hash, NEW.moderation_decision,
    NEW.policy_revision_id, NEW.policy_hash, NEW.input_sha256,
    NEW.internal_reason_codes, NEW.evidence_ref, NEW.created_at,
    NEW.response_snapshot_bytes, NEW.response_snapshot_sha256
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.submission_id, OLD.operation_id, OLD.actor_user_id,
    OLD.surface, OLD.idempotency_key, OLD.request_hash, OLD.moderation_decision,
    OLD.policy_revision_id, OLD.policy_hash, OLD.input_sha256,
    OLD.internal_reason_codes, OLD.evidence_ref, OLD.created_at,
    OLD.response_snapshot_bytes, OLD.response_snapshot_sha256
  ) THEN
    RAISE EXCEPTION 'text content submission evidence and creation snapshot are immutable';
  END IF;
  IF OLD.status <> 'manual_review' OR NEW.status NOT IN ('published', 'blocked') THEN
    RAISE EXCEPTION 'text content submission transition is not allowed: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text content submission updated_at must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_text_moderation_case_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.community_id, NEW.case_id, NEW.submission_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.community_id, OLD.case_id, OLD.submission_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'text moderation case identity is immutable';
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('approved', 'dismissed', 'blocked') THEN
    RAISE EXCEPTION 'text moderation case transition is not allowed: % -> %',
      OLD.status,
      NEW.status;
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'text moderation case updated_at must advance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION has_community_route_authority(expected_community_id text, expected_principal_user_id text) RETURNS boolean
    LANGUAGE sql STABLE
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

CREATE FUNCTION identity_credentials_enforce_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity credentials cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_delete_forbidden';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'identity credentials must be inserted active'
        USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_insert_active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_app_id IS DISTINCT FROM OLD.provider_app_id
    OR NEW.provider_subject IS DISTINCT FROM OLD.provider_subject
    OR NEW.canonical_user_id IS DISTINCT FROM OLD.canonical_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity credential ownership and identity are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_identity_immutable';
  END IF;

  IF OLD.status = 'tombstoned' THEN
    RAISE EXCEPTION 'identity credential tombstones are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_tombstone_terminal';
  END IF;

  IF NEW.status = 'tombstoned' THEN
    NEW.tombstoned_at := now();
  ELSIF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid identity credential lifecycle transition'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_lifecycle';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION is_community_route_root_label(route_family text, root_label text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $_$
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
$_$;

CREATE FUNCTION is_community_route_root_label_display(root_label_display text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
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

CREATE FUNCTION prepare_hns_control_observer_operation_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  configuration_record hns_control_observer_configurations%ROWTYPE;
BEGIN
  IF NEW.snapshot_reference IS NOT NULL THEN
    RAISE EXCEPTION 'HNS observer snapshot reference is database-generated';
  END IF;

  SELECT * INTO configuration_record
    FROM hns_control_observer_configurations
   WHERE provider_configuration_reference = NEW.provider_configuration_reference
     AND provider_configuration_version = NEW.provider_configuration_version;
  IF NOT FOUND
    OR configuration_record.provider_configuration_digest <> NEW.provider_configuration_digest
    OR configuration_record.configuration_bytes IS DISTINCT FROM NEW.configuration_bytes THEN
    RAISE EXCEPTION 'HNS observer operation configuration authority mismatch';
  END IF;

  NEW.snapshot_reference := 'hns-observer:postgres:' || gen_random_uuid()::text;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public_handle_index_validate_redirects() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'redirect' AND NOT EXISTS (
    SELECT 1
      FROM public_handle_index AS target
     WHERE target.handle_id = NEW.redirect_target_handle_id
       AND target.status = 'active'
       AND target.owner_user_id = NEW.owner_user_id
       AND target.handle_id <> NEW.handle_id
  ) THEN
    RAISE EXCEPTION 'public handle redirect target is not an active handle owned by the same user'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
     WHERE source.status = 'redirect'
       AND source.redirect_target_handle_id = NEW.handle_id
       AND NOT EXISTS (
         SELECT 1
           FROM public_handle_index AS target
          WHERE target.handle_id = source.redirect_target_handle_id
            AND target.status = 'active'
            AND target.owner_user_id = source.owner_user_id
            AND target.handle_id <> source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'public handle redirect source points at an invalid target'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_community_commerce_immutable_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION reject_community_creation_immutable_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION reject_community_purchase_funding_append_only_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'community purchase funding evidence is append-only';
END;
$$;

CREATE FUNCTION reject_community_route_attachment_immutable_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'community route attachment evidence is append-only';
END;
$$;

CREATE FUNCTION reject_community_route_lifecycle_transition_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'community route lifecycle transitions are append-only';
END;
$$;

CREATE FUNCTION reject_community_route_operator_override_audit_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'community route operator override audit is append-only';
END;
$$;

CREATE FUNCTION reject_hns_control_observer_append_only_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'HNS control observer evidence is append-only';
END;
$$;

CREATE FUNCTION reject_media_append_only_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
$$;

CREATE FUNCTION reject_namespace_ownership_evidence_snapshot_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'namespace ownership evidence snapshots are append-only';
END;
$$;

CREATE FUNCTION reject_text_moderation_append_only_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION valid_text_moderation_reason_codes(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(value) AS reason(code)
     WHERE code NOT IN (
       'sexual_minors', 'adult_sexual', 'graphic_violence', 'harassment',
       'threat', 'hate', 'self_harm', 'illicit', 'spam', 'other_policy',
       'age_gate_required', 'provider_unavailable', 'provider_timeout',
       'provider_invalid'
     )
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN (
    SELECT count(*) = count(DISTINCT code)
      FROM jsonb_array_elements_text(value) AS reason(code)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

CREATE FUNCTION validate_community_canonical_route_reference() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  community_record communities%ROWTYPE;
  binding_id TEXT;
  guard_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
    binding_id := NEW.canonical_route_binding_id;
  ELSE
    binding_id := NEW.route_binding_id;
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community canonical route binding is missing';
  END IF;

  IF community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR community_record.community_id IS DISTINCT FROM binding_record.community_id THEN
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
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_community_creation_ceremony_attempt_insert() RETURNS trigger
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

CREATE FUNCTION validate_community_creation_ceremony_result_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  proof_record proof_sessions%ROWTYPE;
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
    OR NEW.provider_configuration_version <> attempt_record.provider_configuration_version
  THEN
    RAISE EXCEPTION 'ceremony result does not match its immutable attempt';
  END IF;

  IF NEW.requirement_kind = 'namespace_ownership' THEN
    IF NEW.proof_session_id IS NOT NULL
      OR NEW.namespace_session_id IS NULL
      OR NEW.submission_channel <> 'poll_result'
      OR NEW.evidence_receipt_id IS NOT NULL
      OR (NEW.outcome_status <> 'expired' AND NEW.completion_attempt_id IS NULL)
    THEN
      RAISE EXCEPTION 'namespace ceremony result must use its poll completion authority';
    END IF;

    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
     FOR SHARE;
    IF NEW.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO completion_record
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = NEW.completion_attempt_id
       FOR SHARE;
    END IF;
    IF session_record.namespace_session_id IS NULL
      OR session_record.actor_id <> NEW.actor_id
      OR session_record.creation_intent_id <> NEW.intent_id
      OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
      OR session_record.generation <> NEW.generation
      OR session_record.requirement_hash <> NEW.requirement_hash
      OR session_record.provider_id <> NEW.provider_id
      OR session_record.provider_binding_hash <> NEW.provider_binding_hash
      OR session_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR (
        NEW.completion_attempt_id IS NOT NULL
        AND (
          completion_record.completion_attempt_id IS NULL
          OR completion_record.namespace_session_id <> session_record.namespace_session_id
          OR completion_record.actor_id <> NEW.actor_id
          OR completion_record.submission_channel <> 'poll_result'
          OR completion_record.state <> 'consumed'
          OR completion_record.consumption_kind IS DISTINCT FROM CASE NEW.outcome_status
            WHEN 'satisfied' THEN 'verified'
            WHEN 'failed' THEN 'rejected'
            WHEN 'expired' THEN 'expired'
            ELSE NULL
          END
          OR NEW.callback_idempotency_key <> completion_record.idempotency_key
          OR NEW.callback_request_hash <> completion_record.completion_request_hash
        )
      )
    THEN
      RAISE EXCEPTION 'namespace ceremony result does not match its session and attempt';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.namespace_session_id IS NOT NULL
    OR NEW.completion_attempt_id IS NOT NULL
    OR NEW.submission_channel IS NOT NULL
  THEN
    RAISE EXCEPTION 'human ceremony result cannot use namespace ownership columns';
  END IF;

  IF NEW.requirement_kind = 'human_identity'
    AND NEW.outcome_status = 'satisfied'
    AND NEW.proof_session_id IS NULL
  THEN
    RAISE EXCEPTION 'satisfied human ceremony requires its proof session';
  END IF;

  IF NEW.proof_session_id IS NOT NULL THEN
    SELECT * INTO proof_record
      FROM proof_sessions
     WHERE proof_session_id = NEW.proof_session_id;
    IF NOT FOUND
      OR proof_record.actor_id <> NEW.actor_id
      OR proof_record.creation_ceremony_intent_id <> NEW.ceremony_intent_id
      OR proof_record.provider_id <> NEW.provider_id
      OR proof_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR proof_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR proof_record.provider_configuration_version <> attempt_record.provider_configuration_version
    THEN
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
      OR receipt_record.provider_configuration_kind <> attempt_record.provider_configuration_kind
      OR receipt_record.provider_configuration_ref <> attempt_record.provider_configuration_ref
      OR receipt_record.provider_configuration_version <> attempt_record.provider_configuration_version
      OR receipt_record.evidence_hash <> NEW.evidence_digest
    THEN
      RAISE EXCEPTION 'ceremony result evidence receipt does not match its attempt';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_community_creation_requirement_result() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  state_record community_creation_requirement_states%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  ceremony_id TEXT;
  state_found BOOLEAN;
  result_found BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'community_creation_requirement_states' THEN
    IF NEW.current_ceremony_intent_id IS NULL THEN RETURN NULL; END IF;
    ceremony_id := NEW.current_ceremony_intent_id;
  ELSE
    ceremony_id := NEW.ceremony_intent_id;
  END IF;

  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE current_ceremony_intent_id = ceremony_id;
  state_found := FOUND;
  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = ceremony_id;
  result_found := FOUND;

  IF NOT result_found THEN
    IF TG_TABLE_NAME = 'community_creation_ceremony_results' THEN
      RAISE EXCEPTION 'ceremony result does not match current requirement state';
    END IF;

    IF state_found
      AND state_record.status IN ('satisfied', 'failed', 'expired') THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
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
      OR result_record.provider_configuration_version <> state_record.provider_configuration_version
      OR result_record.satisfied_at IS DISTINCT FROM state_record.satisfied_at
    THEN
      RAISE EXCEPTION 'ceremony result does not match terminal requirement state';
    END IF;
  ELSIF result_record.ceremony_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'nonterminal requirement cannot have a terminal ceremony result';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_community_route_attachment_attempt_insert() RETURNS trigger
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

CREATE FUNCTION validate_community_route_attachment_binding_insert() RETURNS trigger
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

CREATE FUNCTION validate_community_route_attachment_evidence_insert() RETURNS trigger
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

CREATE FUNCTION validate_community_route_attachment_requirement_cardinality() RETURNS trigger
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

CREATE FUNCTION validate_community_route_attachment_requirement_result() RETURNS trigger
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

CREATE FUNCTION validate_community_route_attachment_result_insert() RETURNS trigger
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

CREATE FUNCTION validate_community_route_lifecycle_transition_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
BEGIN
  IF NEW.transitioned_at > clock_timestamp() THEN
    RAISE EXCEPTION 'route lifecycle transition time is in the future';
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id;
  IF NOT FOUND
    OR community_record.status <> 'active'
    OR community_record.canonical_route_binding_id <> NEW.route_binding_id THEN
    RAISE EXCEPTION 'route lifecycle transition community authority mismatch';
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE community_id = NEW.community_id
     AND route_binding_id = NEW.route_binding_id;
  IF NOT FOUND
    OR binding_record.family <> NEW.family
    OR binding_record.root_label <> NEW.root_label
    OR binding_record.root_label_display <> NEW.root_label_display
    OR binding_record.path_segment <> NEW.path_segment
    OR binding_record.binding_generation <> NEW.resulting_binding_generation
    OR binding_record.verified_evidence_ref IS NOT NULL
    OR binding_record.ownership_status <> NEW.ownership_status
    OR binding_record.route_lifecycle_status <> NEW.route_lifecycle_status
    OR binding_record.updated_at <> NEW.transitioned_at THEN
    RAISE EXCEPTION 'route lifecycle transition resulting binding mismatch';
  END IF;

  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = NEW.expected_verified_evidence_ref;
  IF NOT FOUND
    OR evidence_record.family <> NEW.family
    OR evidence_record.root_label <> NEW.root_label
    OR evidence_record.root_label_display <> NEW.root_label_display
    OR evidence_record.path_segment <> NEW.path_segment
    OR evidence_record.binding_generation <> NEW.expected_binding_generation
    OR evidence_record.expires_at IS NULL
    OR evidence_record.expires_at <> NEW.observed_evidence_expires_at
    OR evidence_record.expires_at > NEW.transitioned_at THEN
    RAISE EXCEPTION 'route lifecycle transition evidence authority mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_community_route_ownership_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  creation_attempt community_creation_ceremony_attempts%ROWTYPE;
  creation_result community_creation_ceremony_results%ROWTYPE;
  creation_state community_creation_requirement_states%ROWTYPE;
  creation_completion namespace_ownership_completion_attempts%ROWTYPE;
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  revalidation_attempt community_route_revalidation_completion_attempts%ROWTYPE;
  revalidation_session community_route_revalidation_sessions%ROWTYPE;
  revalidation_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  community_record communities%ROWTYPE;
BEGIN
  IF NEW.origin = 'creation_ceremony' THEN
    SELECT * INTO creation_attempt
      FROM community_creation_ceremony_attempts
     WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
    SELECT * INTO creation_result
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.creation_ceremony_intent_id;
    SELECT * INTO creation_state
      FROM community_creation_requirement_states
     WHERE intent_id = creation_attempt.intent_id
       AND requirement_kind = creation_attempt.requirement_kind
     FOR SHARE;
    IF creation_result.completion_attempt_id IS NOT NULL THEN
      SELECT * INTO creation_completion
        FROM namespace_ownership_completion_attempts
       WHERE completion_attempt_id = creation_result.completion_attempt_id;
    END IF;

    IF creation_attempt.ceremony_intent_id IS NULL
      OR creation_result.ceremony_intent_id IS NULL
      OR creation_state.intent_id IS NULL
      OR creation_attempt.requirement_kind <> 'namespace_ownership'
      OR creation_result.outcome_status <> 'satisfied'
      OR creation_state.status <> 'satisfied'
      OR creation_state.generation IS DISTINCT FROM creation_attempt.generation
      OR creation_state.current_ceremony_intent_id IS DISTINCT FROM NEW.creation_ceremony_intent_id
      OR NEW.verified_by_actor_id IS DISTINCT FROM creation_attempt.actor_id
      OR NEW.family IS DISTINCT FROM creation_attempt.route_family
      OR NEW.root_label IS DISTINCT FROM creation_attempt.route_root_label
      OR NEW.root_label_display IS DISTINCT FROM creation_attempt.route_root_label_display
      OR NEW.path_segment IS DISTINCT FROM creation_attempt.route_path_segment
      OR NEW.requirement_hash IS DISTINCT FROM creation_attempt.requirement_hash
      OR NEW.provider_id IS DISTINCT FROM creation_attempt.provider_id
      OR NEW.provider_binding_hash IS DISTINCT FROM creation_attempt.provider_binding_hash
      OR NEW.provider_configuration_version IS DISTINCT FROM creation_attempt.provider_configuration_version
      OR NEW.provider_identity_digest IS DISTINCT FROM creation_result.provider_identity_digest
      OR NEW.evidence_ref IS DISTINCT FROM creation_result.evidence_ref
      OR NEW.evidence_digest IS DISTINCT FROM creation_result.evidence_digest
      OR NEW.evidence_receipt_id IS DISTINCT FROM creation_result.evidence_receipt_id
      OR NEW.binding_generation IS DISTINCT FROM creation_attempt.generation
      OR NEW.verified_at IS DISTINCT FROM creation_result.satisfied_at
      OR creation_completion.completion_attempt_id IS NULL
      OR creation_completion.namespace_session_id IS DISTINCT FROM creation_result.namespace_session_id
      OR creation_completion.actor_id IS DISTINCT FROM creation_result.actor_id
      OR creation_completion.state IS DISTINCT FROM 'consumed'
      OR creation_completion.consumption_kind IS DISTINCT FROM 'verified'
    THEN
      RAISE EXCEPTION 'route ownership evidence does not match its creation ceremony';
    END IF;

    SELECT * INTO creation_snapshot
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = NEW.evidence_ref
       AND namespace_session_id = creation_result.namespace_session_id
       AND completion_attempt_id = creation_result.completion_attempt_id;
    IF creation_snapshot.evidence_ref IS NULL
      OR creation_snapshot.evidence_digest IS DISTINCT FROM NEW.evidence_digest
      OR creation_snapshot.provider_identity_digest IS DISTINCT FROM NEW.provider_identity_digest
      OR creation_snapshot.actor_id IS DISTINCT FROM creation_result.actor_id
      OR creation_snapshot.creation_intent_id IS DISTINCT FROM creation_result.intent_id
      OR creation_snapshot.ceremony_intent_id IS DISTINCT FROM creation_result.ceremony_intent_id
      OR creation_snapshot.generation IS DISTINCT FROM NEW.binding_generation
      OR creation_snapshot.requirement_hash IS DISTINCT FROM NEW.requirement_hash
      OR creation_snapshot.provider_id IS DISTINCT FROM NEW.provider_id
      OR creation_snapshot.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
      OR creation_snapshot.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
      OR creation_snapshot.family IS DISTINCT FROM NEW.family
      OR creation_snapshot.root_label IS DISTINCT FROM NEW.root_label
      OR creation_snapshot.root_label_display IS DISTINCT FROM NEW.root_label_display
      OR creation_snapshot.path_segment IS DISTINCT FROM NEW.path_segment
      OR (NEW.expires_at IS NOT NULL AND creation_snapshot.expires_at IS DISTINCT FROM NEW.expires_at)
    THEN
      RAISE EXCEPTION 'route ownership evidence requires its matching namespace snapshot';
    END IF;
    RETURN NEW;
  END IF;

  -- Resolve immutable identifiers without row locks, then acquire the common
  -- route lock order: community -> binding -> session -> attempt -> snapshot.
  SELECT * INTO revalidation_attempt
    FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id;
  SELECT * INTO revalidation_session
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = revalidation_attempt.route_revalidation_id
     AND revalidation_session_id = revalidation_attempt.revalidation_session_id;
  SELECT * INTO community_record
    FROM communities
   WHERE community_id = revalidation_session.community_id
   FOR UPDATE;
  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = revalidation_attempt.route_binding_id
     AND community_id = revalidation_session.community_id
   FOR UPDATE;
  SELECT * INTO revalidation_session
    FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = revalidation_attempt.route_revalidation_id
     AND revalidation_session_id = revalidation_attempt.revalidation_session_id
   FOR SHARE;
  SELECT * INTO revalidation_attempt
    FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id
   FOR SHARE;
  SELECT * INTO revalidation_snapshot
    FROM community_route_revalidation_evidence_snapshots
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id
     AND evidence_ref = NEW.evidence_ref
   FOR SHARE;

  IF revalidation_attempt.route_revalidation_attempt_id IS NULL
    OR revalidation_session.revalidation_session_id IS NULL
    OR revalidation_snapshot.evidence_ref IS NULL
    OR binding_record.route_binding_id IS NULL
    OR community_record.community_id IS NULL
    OR community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR revalidation_attempt.state <> 'consumed'
    OR revalidation_attempt.consumption_kind <> 'verified'
    OR revalidation_session.status <> 'completed'
    OR revalidation_attempt.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR revalidation_snapshot.route_revalidation_id IS DISTINCT FROM revalidation_session.route_revalidation_id
    OR revalidation_snapshot.revalidation_session_id IS DISTINCT FROM revalidation_session.revalidation_session_id
    OR revalidation_snapshot.community_id IS DISTINCT FROM revalidation_session.community_id
    OR revalidation_snapshot.route_binding_id IS DISTINCT FROM revalidation_session.route_binding_id
    OR revalidation_snapshot.principal_kind IS DISTINCT FROM revalidation_session.principal_kind
    OR revalidation_snapshot.principal_id IS DISTINCT FROM revalidation_session.principal_id
    OR revalidation_snapshot.requirement_hash IS DISTINCT FROM revalidation_session.requirement_hash
    OR revalidation_snapshot.expected_binding_generation IS DISTINCT FROM revalidation_session.expected_binding_generation
    OR revalidation_snapshot.expected_verified_evidence_ref IS DISTINCT FROM revalidation_session.expected_verified_evidence_ref
    OR revalidation_snapshot.start_request_hash IS DISTINCT FROM revalidation_session.start_request_hash
    OR revalidation_snapshot.provider_id IS DISTINCT FROM revalidation_session.provider_id
    OR revalidation_snapshot.provider_binding_hash IS DISTINCT FROM revalidation_session.provider_binding_hash
    OR revalidation_snapshot.provider_configuration_kind IS DISTINCT FROM revalidation_session.provider_configuration_kind
    OR revalidation_snapshot.provider_configuration_reference IS DISTINCT FROM revalidation_session.provider_configuration_reference
    OR revalidation_snapshot.provider_configuration_version IS DISTINCT FROM revalidation_session.provider_configuration_version
    OR revalidation_snapshot.protocol_version IS DISTINCT FROM revalidation_session.protocol_version
    OR revalidation_snapshot.environment IS DISTINCT FROM revalidation_session.environment
    OR revalidation_snapshot.family IS DISTINCT FROM revalidation_session.family
    OR revalidation_snapshot.root_label IS DISTINCT FROM revalidation_session.root_label
    OR revalidation_snapshot.root_label_display IS DISTINCT FROM revalidation_session.root_label_display
    OR revalidation_snapshot.path_segment IS DISTINCT FROM revalidation_session.path_segment
    OR revalidation_snapshot.upstream_session_ref IS DISTINCT FROM revalidation_session.upstream_session_ref
    OR revalidation_snapshot.fence_token IS DISTINCT FROM revalidation_attempt.fence_token
    OR revalidation_snapshot.binding_generation IS DISTINCT FROM revalidation_session.expected_binding_generation + 1
    OR NEW.family IS DISTINCT FROM revalidation_snapshot.family
    OR NEW.root_label IS DISTINCT FROM revalidation_snapshot.root_label
    OR NEW.root_label_display IS DISTINCT FROM revalidation_snapshot.root_label_display
    OR NEW.path_segment IS DISTINCT FROM revalidation_snapshot.path_segment
    OR NEW.requirement_hash IS DISTINCT FROM revalidation_snapshot.requirement_hash
    OR NEW.provider_id IS DISTINCT FROM revalidation_snapshot.provider_id
    OR NEW.provider_binding_hash IS DISTINCT FROM revalidation_snapshot.provider_binding_hash
    OR NEW.provider_configuration_version IS DISTINCT FROM revalidation_snapshot.provider_configuration_version
    OR NEW.provider_identity_digest IS DISTINCT FROM revalidation_snapshot.provider_identity_digest
    OR NEW.evidence_digest IS DISTINCT FROM revalidation_snapshot.evidence_digest
    OR NEW.evidence_receipt_id IS NOT NULL
    OR NEW.binding_generation IS DISTINCT FROM revalidation_snapshot.binding_generation
    OR NEW.verified_at IS DISTINCT FROM revalidation_snapshot.observed_at
    OR NEW.expires_at IS DISTINCT FROM revalidation_snapshot.expires_at
    OR binding_record.community_id IS DISTINCT FROM revalidation_snapshot.community_id
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
  THEN
    RAISE EXCEPTION 'route ownership evidence does not match its revalidation authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_community_route_revalidation_attempt_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_record community_route_revalidation_sessions%ROWTYPE;
  consumed_count INTEGER;
  leased_exists BOOLEAN;
  invalid_pending_consumption BOOLEAN;
  mismatched_terminal BOOLEAN;
BEGIN
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.revalidation_session_id IS NULL THEN
    RAISE EXCEPTION 'route revalidation attempt has no session';
  END IF;
  SELECT count(*) FILTER (WHERE state = 'consumed' AND NOT (
           consumption_kind = 'challenge_mismatch'
           AND result_hash IS NULL
           AND terminal_result_document IS NULL
           AND terminal_observed_expires_at IS NULL
         ))::integer,
         COALESCE(bool_or(state = 'leased'), false),
         COALESCE(bool_or(state = 'consumed' AND NOT (
           consumption_kind = 'challenge_mismatch'
           AND result_hash IS NULL
           AND terminal_result_document IS NULL
           AND terminal_observed_expires_at IS NULL
         ) AND (
           consumption_kind <> 'challenge_mismatch'
           OR result_hash IS NOT NULL OR terminal_result_document IS NOT NULL
           OR terminal_observed_expires_at IS NOT NULL
         )), false),
         COALESCE(bool_or(state = 'consumed' AND (
           (session_record.status = 'completed' AND consumption_kind <> 'verified')
           OR (session_record.status = 'expired' AND consumption_kind <> 'session_expired')
           OR (session_record.status = 'failed' AND consumption_kind NOT IN (
             'missing_root', 'control_failed', 'challenge_mismatch',
             'insufficient_expiry', 'disputed', 'revoked',
             'database_time_expired', 'stale_cas'
           ))
         )), false)
    INTO consumed_count, leased_exists, invalid_pending_consumption, mismatched_terminal
    FROM community_route_revalidation_completion_attempts
   WHERE revalidation_session_id = NEW.revalidation_session_id;
  IF session_record.status <> 'pending' AND leased_exists THEN
    RAISE EXCEPTION 'terminal route revalidation session cannot retain a lease';
  END IF;
  IF session_record.status = 'pending' AND invalid_pending_consumption THEN
    RAISE EXCEPTION 'pending route revalidation session has a terminal consumed attempt';
  END IF;
  IF session_record.status IN ('completed', 'failed', 'expired') AND consumed_count <> 1 THEN
    RAISE EXCEPTION 'terminal route revalidation session requires exactly one consumed attempt';
  END IF;
  IF mismatched_terminal THEN
    RAISE EXCEPTION 'route revalidation session status contradicts its consumed outcome';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_community_route_revalidation_session_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  db_now TIMESTAMPTZ;
  reservation_record community_route_revalidation_start_reservations%ROWTYPE;
  presentation_payload JSONB;
  presentation_member_count INTEGER;
  payload_member_count INTEGER;
BEGIN
  db_now := clock_timestamp();
  NEW.created_at := db_now;
  NEW.updated_at := db_now;
  SELECT * INTO reservation_record
    FROM community_route_revalidation_start_reservations
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND fence_token = NEW.start_fence_token
   FOR UPDATE;
  presentation_payload := NEW.start_presentation -> 'payload';
  SELECT count(*)::integer INTO presentation_member_count
    FROM jsonb_object_keys(NEW.start_presentation);
  SELECT count(*)::integer INTO payload_member_count
    FROM jsonb_object_keys(presentation_payload);
  IF reservation_record.route_revalidation_id IS NULL
    OR reservation_record.revalidation_session_id IS DISTINCT FROM NEW.revalidation_session_id
    OR reservation_record.community_id IS DISTINCT FROM NEW.community_id
    OR reservation_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR reservation_record.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR reservation_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR reservation_record.expected_binding_generation IS DISTINCT FROM NEW.expected_binding_generation
    OR reservation_record.expected_verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
    OR reservation_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR reservation_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR reservation_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR reservation_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR reservation_record.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
    OR reservation_record.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
    OR reservation_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR reservation_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR reservation_record.environment IS DISTINCT FROM NEW.environment
    OR reservation_record.family IS DISTINCT FROM NEW.family
    OR reservation_record.root_label IS DISTINCT FROM NEW.root_label
    OR reservation_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR reservation_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR reservation_record.state NOT IN ('acquired', 'finalized')
    OR reservation_record.lease_expires_at <= db_now
    OR NEW.status <> 'pending'
    OR NEW.started_at > db_now
    OR NEW.expires_at <= db_now
    OR presentation_member_count <> 5
    OR (NEW.start_presentation ->> 'kind') IS DISTINCT FROM 'embedded_sdk'
    OR (NEW.start_presentation ->> 'session_id') IS DISTINCT FROM NEW.upstream_session_ref
    OR (NEW.start_presentation ->> 'protocol') IS DISTINCT FROM 'hns-txt-challenge'
    OR (NEW.start_presentation ->> 'version') IS DISTINCT FROM '1'
    OR jsonb_typeof(presentation_payload) IS DISTINCT FROM 'object'
    OR payload_member_count <> 4
    OR (presentation_payload ->> 'ownership_source') NOT IN (
      'hns_parent_chain_txt', 'owner_authoritative_dns_txt'
    )
    OR (presentation_payload ->> 'challenge_name') IS DISTINCT FROM (CASE
      WHEN (presentation_payload ->> 'ownership_source') = 'hns_parent_chain_txt'
        THEN NEW.root_label
      ELSE '_pirate.' || NEW.root_label
    END)
    OR (presentation_payload ->> 'challenge_value')
      IS DISTINCT FROM 'pirate-verification=' || NEW.upstream_session_ref
    OR (presentation_payload ->> 'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
  THEN
    RAISE EXCEPTION 'route revalidation session does not match its live start reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_community_route_revalidation_snapshot_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  db_now TIMESTAMPTZ;
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  session_record community_route_revalidation_sessions%ROWTYPE;
  attempt_record community_route_revalidation_completion_attempts%ROWTYPE;
  observation_record JSONB;
  outer_member_count INTEGER;
  observation_member_count INTEGER;
BEGIN
  db_now := clock_timestamp();
  NEW.created_at := db_now;
  -- Preserve the common lock order even when a caller inserts the child first.
  SELECT * INTO community_record FROM communities
   WHERE community_id = NEW.community_id FOR UPDATE;
  SELECT * INTO binding_record FROM community_canonical_route_bindings
   WHERE route_binding_id = NEW.route_binding_id
     AND community_id = NEW.community_id FOR UPDATE;
  SELECT * INTO session_record FROM community_route_revalidation_sessions
   WHERE route_revalidation_id = NEW.route_revalidation_id
     AND revalidation_session_id = NEW.revalidation_session_id FOR SHARE;
  SELECT * INTO attempt_record FROM community_route_revalidation_completion_attempts
   WHERE route_revalidation_attempt_id = NEW.route_revalidation_attempt_id FOR UPDATE;

  IF community_record.community_id IS NULL
    OR binding_record.route_binding_id IS NULL
    OR session_record.revalidation_session_id IS NULL
    OR attempt_record.route_revalidation_attempt_id IS NULL
    OR community_record.canonical_route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind <> 'verified'
    OR attempt_record.route_revalidation_id IS DISTINCT FROM NEW.route_revalidation_id
    OR attempt_record.revalidation_session_id IS DISTINCT FROM NEW.revalidation_session_id
    OR attempt_record.route_binding_id IS DISTINCT FROM NEW.route_binding_id
    OR attempt_record.expected_binding_generation IS DISTINCT FROM NEW.expected_binding_generation
    OR attempt_record.expected_verified_evidence_ref IS DISTINCT FROM NEW.expected_verified_evidence_ref
    OR attempt_record.evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR attempt_record.fence_token IS DISTINCT FROM NEW.fence_token
    OR session_record.community_id IS DISTINCT FROM NEW.community_id
    OR session_record.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR session_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR session_record.requirement_hash IS DISTINCT FROM NEW.requirement_hash
    OR session_record.start_request_hash IS DISTINCT FROM NEW.start_request_hash
    OR session_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR session_record.provider_binding_hash IS DISTINCT FROM NEW.provider_binding_hash
    OR session_record.provider_configuration_kind IS DISTINCT FROM NEW.provider_configuration_kind
    OR session_record.provider_configuration_reference IS DISTINCT FROM NEW.provider_configuration_reference
    OR session_record.provider_configuration_version IS DISTINCT FROM NEW.provider_configuration_version
    OR session_record.protocol_version IS DISTINCT FROM NEW.protocol_version
    OR session_record.environment IS DISTINCT FROM NEW.environment
    OR session_record.family IS DISTINCT FROM NEW.family
    OR session_record.root_label IS DISTINCT FROM NEW.root_label
    OR session_record.root_label_display IS DISTINCT FROM NEW.root_label_display
    OR session_record.path_segment IS DISTINCT FROM NEW.path_segment
    OR session_record.upstream_session_ref IS DISTINCT FROM NEW.upstream_session_ref
    OR session_record.status <> 'completed'
    OR binding_record.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR binding_record.verified_evidence_ref IS DISTINCT FROM NEW.evidence_ref
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR NEW.observed_at > db_now
    OR NEW.expires_at <= db_now
  THEN
    RAISE EXCEPTION 'route revalidation snapshot does not match its consumed verified authority';
  END IF;

  observation_record := NEW.observation -> 'observation';
  SELECT count(*)::integer INTO outer_member_count
    FROM jsonb_object_keys(NEW.observation);
  SELECT count(*)::integer INTO observation_member_count
    FROM jsonb_object_keys(observation_record);
  IF outer_member_count <> 2
    OR NEW.observation ->> 'status' IS DISTINCT FROM 'verified'
    OR jsonb_typeof(observation_record) IS DISTINCT FROM 'object'
    OR observation_member_count <> 14
    OR observation_record ->> 'ownership_source' IS DISTINCT FROM NEW.ownership_source
    OR observation_record ->> 'challenge_name' IS DISTINCT FROM NEW.challenge_name
    OR (observation_record ->> 'ownership_source')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,ownership_source}')
    OR (observation_record ->> 'challenge_name')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,challenge_name}')
    OR (observation_record ->> 'challenge_value')
      IS DISTINCT FROM (session_record.start_presentation #>> '{payload,challenge_value}')
    OR (observation_record ->> 'challenge_value')
      IS DISTINCT FROM 'pirate-verification=' || NEW.upstream_session_ref
    OR jsonb_typeof(observation_record -> 'challenge_value') IS DISTINCT FROM 'string'
    OR octet_length(observation_record ->> 'challenge_value') NOT BETWEEN 1 AND 4096
    OR (observation_record ->> 'challenge_value') ~ '[[:cntrl:]]'
    OR encode(
      sha256(convert_to(observation_record ->> 'challenge_value', 'UTF8')),
      'hex'
    ) IS DISTINCT FROM NEW.challenge_value_sha256
    OR jsonb_typeof(observation_record -> 'root_exists') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'root_exists')::boolean IS DISTINCT FROM NEW.root_exists
    OR jsonb_typeof(observation_record -> 'root_control_verified') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'root_control_verified')::boolean
      IS DISTINCT FROM NEW.root_control_verified
    OR jsonb_typeof(observation_record -> 'expiry_horizon_sufficient') IS DISTINCT FROM 'boolean'
    OR (observation_record ->> 'expiry_horizon_sufficient')::boolean
      IS DISTINCT FROM NEW.expiry_horizon_sufficient
    OR observation_record ->> 'chain_network' IS DISTINCT FROM NEW.chain_network
    OR jsonb_typeof(observation_record -> 'chain_anchor_height') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'chain_anchor_height')::bigint
      IS DISTINCT FROM NEW.chain_anchor_height
    OR observation_record ->> 'chain_anchor_block_hash'
      IS DISTINCT FROM NEW.chain_anchor_block_hash
    OR jsonb_typeof(observation_record -> 'chain_anchor_median_time') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'chain_anchor_median_time')::bigint
      IS DISTINCT FROM NEW.chain_anchor_median_time
    OR jsonb_typeof(observation_record -> 'expiry_height') IS DISTINCT FROM 'number'
    OR (observation_record ->> 'expiry_height')::bigint IS DISTINCT FROM NEW.expiry_height
    OR (observation_record ->> 'observed_at')::timestamptz IS DISTINCT FROM NEW.observed_at
    OR (observation_record ->> 'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
    OR observation_record ->> 'provider_evidence_ref'
      IS DISTINCT FROM NEW.provider_evidence_ref
    OR encode(sha256(NEW.raw_response_bytes), 'hex') IS DISTINCT FROM NEW.observation_sha256
  THEN
    RAISE EXCEPTION 'route revalidation snapshot observation is incomplete or inconsistent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_community_route_revalidation_start_coherence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  reservation_record community_route_revalidation_start_reservations%ROWTYPE;
  session_record community_route_revalidation_sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'community_route_revalidation_start_reservations' THEN
    SELECT * INTO reservation_record FROM community_route_revalidation_start_reservations
     WHERE route_revalidation_id = NEW.route_revalidation_id;
    SELECT * INTO session_record FROM community_route_revalidation_sessions
     WHERE route_revalidation_id = NEW.route_revalidation_id;
  ELSE
    SELECT * INTO session_record FROM community_route_revalidation_sessions
     WHERE revalidation_session_id = NEW.revalidation_session_id;
    SELECT * INTO reservation_record FROM community_route_revalidation_start_reservations
     WHERE route_revalidation_id = session_record.route_revalidation_id;
  END IF;
  IF session_record.revalidation_session_id IS NULL THEN
    IF reservation_record.state IN ('acquired', 'released') THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'finalized route revalidation start requires its session';
  END IF;
  IF reservation_record.state <> 'finalized'
    OR reservation_record.revalidation_session_id IS DISTINCT FROM session_record.revalidation_session_id
    OR reservation_record.fence_token IS DISTINCT FROM session_record.start_fence_token
  THEN
    RAISE EXCEPTION 'route revalidation start/session coherence is incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_community_route_revalidation_terminal_document(document_text text, expected_result_hash text, expected_status text, expected_route_revalidation_id text, expected_session_id text, expected_attempt_id text, expected_binding_id text, expected_generation bigint, expected_idempotency_key text, expected_completion_request_hash text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  document JSONB;
  canonical_document TEXT;
  ownership TEXT;
  lifecycle TEXT;
BEGIN
  IF document_text IS NULL OR expected_result_hash IS NULL THEN RETURN FALSE; END IF;
  IF octet_length(document_text) NOT BETWEEN 1 AND 8192 THEN RETURN FALSE; END IF;
  document := document_text::jsonb;
  IF jsonb_typeof(document) <> 'array' OR jsonb_array_length(document) <> 14 THEN
    RETURN FALSE;
  END IF;
  SELECT '[' || string_agg(value::TEXT, ',' ORDER BY ordinal) || ']'
    INTO canonical_document
    FROM jsonb_array_elements(document) WITH ORDINALITY AS item(value, ordinal);
  IF document_text IS DISTINCT FROM canonical_document THEN RETURN FALSE; END IF;
  IF jsonb_typeof(document -> 0) <> 'string'
     OR document ->> 0 <> 'pirate-hns-route-revalidation-result-v1'
     OR jsonb_typeof(document -> 1) <> 'string'
     OR document ->> 1 IS DISTINCT FROM expected_route_revalidation_id
     OR jsonb_typeof(document -> 2) <> 'string'
     OR document ->> 2 IS DISTINCT FROM expected_session_id
     OR jsonb_typeof(document -> 3) <> 'string'
     OR document ->> 3 IS DISTINCT FROM expected_attempt_id
     OR jsonb_typeof(document -> 4) <> 'string'
     OR document ->> 4 IS DISTINCT FROM expected_binding_id
     OR jsonb_typeof(document -> 5) <> 'number'
     OR (document -> 5)::text !~ '^(0|[1-9][0-9]*)$'
     OR (document ->> 5)::bigint IS DISTINCT FROM expected_generation
     OR jsonb_typeof(document -> 6) <> 'string'
     OR document ->> 6 IS DISTINCT FROM expected_idempotency_key
     OR jsonb_typeof(document -> 7) <> 'string'
     OR document ->> 7 IS DISTINCT FROM expected_completion_request_hash
     OR jsonb_typeof(document -> 8) <> 'string'
     OR document ->> 8 IS DISTINCT FROM expected_status
  THEN RETURN FALSE; END IF;

  IF jsonb_typeof(document -> 9) = 'null'
     AND jsonb_typeof(document -> 10) = 'null'
     AND jsonb_typeof(document -> 11) = 'null'
  THEN
    NULL;
  ELSIF jsonb_typeof(document -> 9) = 'string'
     AND jsonb_typeof(document -> 10) = 'string'
     AND jsonb_typeof(document -> 11) = 'string'
     AND document ->> 9 ~ '^[^[:cntrl:]]+$'
     AND document ->> 10 ~ '^[0-9a-f]{64}$'
     AND document ->> 11 ~ '^[0-9a-f]{64}$'
  THEN
    NULL;
  ELSE
    RETURN FALSE;
  END IF;

  IF jsonb_typeof(document -> 12) = 'null'
     AND jsonb_typeof(document -> 13) = 'null'
  THEN
    ownership := NULL;
    lifecycle := NULL;
  ELSIF jsonb_typeof(document -> 12) = 'string'
     AND jsonb_typeof(document -> 13) = 'string'
  THEN
    ownership := document ->> 12;
    lifecycle := document ->> 13;
  ELSE
    RETURN FALSE;
  END IF;

  IF expected_status = 'verified' THEN
    IF jsonb_typeof(document -> 9) <> 'string'
       OR jsonb_typeof(document -> 10) <> 'string'
       OR jsonb_typeof(document -> 11) <> 'string'
       OR ownership <> 'verified' OR lifecycle <> 'active'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('missing_root', 'revoked') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'revoked' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('control_failed', 'challenge_mismatch', 'disputed') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'disputed' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('insufficient_expiry', 'database_time_expired') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership <> 'expired' OR lifecycle <> 'suspended'
    THEN RETURN FALSE; END IF;
  ELSIF expected_status IN ('session_expired', 'stale_cas') THEN
    IF jsonb_typeof(document -> 9) <> 'null'
       OR jsonb_typeof(document -> 10) <> 'null'
       OR jsonb_typeof(document -> 11) <> 'null'
       OR ownership IS NOT NULL OR lifecycle IS NOT NULL
    THEN RETURN FALSE; END IF;
  ELSE
    RETURN FALSE;
  END IF;
  RETURN encode(sha256(convert_to(document_text, 'UTF8')), 'hex') = expected_result_hash;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END;
$_$;

CREATE FUNCTION validate_hns_control_observer_snapshot_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  actual_entry_count BIGINT;
  actual_transcript_bytes BIGINT;
  minimum_ordinal INTEGER;
  maximum_ordinal INTEGER;
  actual_logical_bytes BIGINT;
  reservation_record hns_control_observer_reservations%ROWTYPE;
BEGIN
  SELECT count(*),
         COALESCE(sum(octet_length(request_bytes) + COALESCE(octet_length(response_bytes), 0)), 0),
         min(entry_ordinal),
         max(entry_ordinal)
    INTO actual_entry_count, actual_transcript_bytes, minimum_ordinal, maximum_ordinal
    FROM hns_control_observer_snapshot_transcript_entries
   WHERE snapshot_reference = NEW.snapshot_reference;

  IF actual_entry_count <> NEW.transcript_entry_count
    OR actual_transcript_bytes <> NEW.transcript_byte_length
    OR (actual_entry_count > 0
      AND (minimum_ordinal <> 0 OR maximum_ordinal <> actual_entry_count - 1)) THEN
    RAISE EXCEPTION 'HNS observer snapshot transcript is incomplete';
  END IF;

  actual_logical_bytes :=
    octet_length(NEW.request_bytes)
    + octet_length(NEW.configuration_bytes)
    + COALESCE(octet_length(NEW.authority_inventory_bytes), 0)
    + octet_length(NEW.semantic_facts_bytes)
    + octet_length(NEW.result_bytes)
    + actual_transcript_bytes
    + octet_length(NEW.accounting_envelope_bytes);
  IF actual_logical_bytes <> NEW.logical_snapshot_byte_length
    OR actual_logical_bytes > 10485760 THEN
    RAISE EXCEPTION 'HNS observer logical snapshot byte authority mismatch';
  END IF;

  SELECT * INTO reservation_record
    FROM hns_control_observer_reservations
   WHERE observation_id = NEW.observation_id;
  IF NOT FOUND
    OR reservation_record.state <> 'terminal'
    OR reservation_record.observer_fence <> NEW.observer_fence
    OR reservation_record.terminal_snapshot_reference <> NEW.snapshot_reference
    OR reservation_record.terminal_status <> NEW.result_status THEN
    RAISE EXCEPTION 'HNS observer snapshot lacks its terminal reservation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_hns_control_observer_snapshot_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  operation_record hns_control_observer_operations%ROWTYPE;
  reservation_record hns_control_observer_reservations%ROWTYPE;
  configuration_version TEXT;
  request_source TEXT;
  result_document JSONB;
  result_version TEXT;
  inventory_member_count INTEGER;
BEGIN
  SELECT * INTO operation_record
    FROM hns_control_observer_operations
   WHERE observation_id = NEW.observation_id;
  SELECT * INTO reservation_record
    FROM hns_control_observer_reservations
   WHERE observation_id = NEW.observation_id;

  IF operation_record.observation_id IS NULL
    OR reservation_record.observation_id IS NULL
    OR reservation_record.state <> 'reserved'
    OR reservation_record.observer_fence <> NEW.observer_fence
    OR reservation_record.lease_expires_at <= clock_timestamp()
    OR operation_record.snapshot_reference <> NEW.snapshot_reference
    OR operation_record.request_bytes IS DISTINCT FROM NEW.request_bytes
    OR operation_record.request_sha256 <> NEW.request_sha256
    OR operation_record.configuration_bytes IS DISTINCT FROM NEW.configuration_bytes
    OR operation_record.provider_configuration_digest <> NEW.provider_configuration_digest
    OR reservation_record.reservation_database_time <> NEW.reservation_database_time
    OR reservation_record.lease_expires_at <> NEW.lease_expires_at THEN
    RAISE EXCEPTION 'HNS observer snapshot authority mismatch';
  END IF;

  configuration_version := convert_from(NEW.configuration_bytes, 'UTF8')::JSONB ->> 'version';
  request_source := convert_from(NEW.request_bytes, 'UTF8')::JSONB ->> 'ownership_source';
  result_document := convert_from(NEW.result_bytes, 'UTF8')::JSONB;
  result_version := result_document ->> 'version';
  inventory_member_count :=
      (NEW.authority_inventory_bytes IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_reference IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_version IS NOT NULL)::INTEGER
    + (NEW.authority_inventory_digest IS NOT NULL)::INTEGER;

  IF configuration_version = 'pirate-hns-control-observer-configuration-v1' THEN
    IF result_version <> 'pirate-hns-control-observation-result-v1'
      OR inventory_member_count <> 0
      OR NEW.semantic_facts_sha256 IS NOT NULL
      OR NEW.transcript_manifest_sha256 IS NOT NULL
      OR NEW.observer_snapshot_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'HNS observer v1 snapshot contains successor authority';
    END IF;
  ELSIF configuration_version = 'pirate-hns-control-observer-configuration-v2' THEN
    IF result_version <> 'pirate-hns-control-observation-result-v2'
      OR inventory_member_count NOT IN (0, 4)
      OR NEW.semantic_facts_sha256 IS NULL
      OR NEW.transcript_manifest_sha256 IS NULL
      OR NEW.observer_snapshot_sha256 IS NULL
      OR result_document ->> 'observer_snapshot_sha256' <> NEW.observer_snapshot_sha256 THEN
      RAISE EXCEPTION 'HNS observer v2 snapshot authority is incomplete';
    END IF;
    IF request_source = 'owner_authoritative_dns_txt'
      AND NEW.result_status IN ('verified', 'rejected', 'ineligible')
      AND inventory_member_count <> 4 THEN
      RAISE EXCEPTION 'HNS observer owner-authoritative terminal lacks inventory';
    END IF;
    IF NEW.result_status = 'ineligible'
      AND (result_document ->> 'reason_code' <> 'owner_authoritative_source_ineligible'
        OR inventory_member_count <> 4) THEN
      RAISE EXCEPTION 'HNS observer source-ineligible snapshot is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'HNS observer snapshot configuration version is unsupported';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_hns_control_observer_transcript_entry_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  reservation_record hns_control_observer_reservations%ROWTYPE;
  configuration_bytes BYTEA;
  request_bytes BYTEA;
  configuration_document JSONB;
  request_document JSONB;
  is_hsd_entry BOOLEAN;
  is_dns_entry BOOLEAN;
BEGIN
  SELECT reservation.* INTO reservation_record
    FROM hns_control_observer_snapshots AS snapshot
    JOIN hns_control_observer_reservations AS reservation
      ON reservation.observation_id = snapshot.observation_id
     AND reservation.observer_fence = snapshot.observer_fence
   WHERE snapshot.snapshot_reference = NEW.snapshot_reference
   FOR UPDATE OF reservation;

  IF NOT FOUND
    OR reservation_record.state <> 'reserved'
    OR reservation_record.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'HNS observer transcript is not open for insertion';
  END IF;

  SELECT operation.configuration_bytes, operation.request_bytes
    INTO configuration_bytes, request_bytes
    FROM hns_control_observer_snapshots AS snapshot
    JOIN hns_control_observer_operations AS operation
      ON operation.observation_id = snapshot.observation_id
   WHERE snapshot.snapshot_reference = NEW.snapshot_reference;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HNS observer transcript operation authority is absent';
  END IF;

  configuration_document := convert_from(configuration_bytes, 'UTF8')::JSONB;
  request_document := convert_from(request_bytes, 'UTF8')::JSONB;
  is_hsd_entry :=
    NEW.driver_reference = configuration_document #>> '{chain,driver_reference}'
    AND NEW.method_or_view_id IN (
      'getblockchaininfo',
      'getblockheader',
      'getnameinfo',
      'getnameresource'
    );
  is_dns_entry :=
    request_document ->> 'ownership_source' = 'owner_authoritative_dns_txt'
    AND NEW.driver_reference = configuration_document #>> '{authoritative_dns,driver_reference}'
    AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(
              configuration_document #> '{authoritative_dns,required_view_ids}'
            ) = 'array'
              THEN configuration_document #> '{authoritative_dns,required_view_ids}'
            ELSE '[]'::JSONB
          END
        ) AS required_view(view_id)
       WHERE required_view.view_id = NEW.method_or_view_id
    );
  IF NEW.ownership_source <> request_document ->> 'ownership_source'
    OR is_hsd_entry = is_dns_entry
    OR (NEW.transport_outcome = 'response' AND is_hsd_entry
      AND NEW.transport_status IS NULL)
    OR (NEW.transport_outcome = 'response' AND is_dns_entry
      AND NEW.transport_status IS NOT NULL) THEN
    RAISE EXCEPTION 'HNS observer transcript driver authority mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_alignment_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; publication_record media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  SELECT * INTO publication_record FROM media_publication_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
  IF submission_record.status IS DISTINCT FROM 'published'
     OR submission_record.post_id IS DISTINCT FROM NEW.post_id
     OR submission_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR submission_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR submission_record.current_immutable_ref IS NULL
     OR publication_record.submission_id IS NULL
     OR publication_record.alignment IS DISTINCT FROM 'pending'
     OR publication_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR publication_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR publication_record.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256
     OR NEW.alignment_revision <> 0
     OR NEW.status <> 'pending'
     OR NEW.current_artifact_ref IS NOT NULL
     OR NEW.current_artifact_revision IS NOT NULL
     OR NEW.failure_code IS NOT NULL THEN
    RAISE EXCEPTION 'alignment projection must begin as the current published pending projection';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_alignment_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.post_id, NEW.audio_revision, NEW.analysis_revision, NEW.canonical_audio_sha256) IS DISTINCT FROM ROW(OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.post_id, OLD.audio_revision, OLD.analysis_revision, OLD.canonical_audio_sha256) THEN RAISE EXCEPTION 'alignment ownership is immutable'; END IF;
  IF NEW.status NOT IN ('ready', 'unavailable') OR NEW.updated_at <= OLD.updated_at OR NEW.alignment_revision <> OLD.alignment_revision + 1 THEN RAISE EXCEPTION 'alignment transition is not allowed'; END IF;
  IF NEW.status = 'ready' AND (NEW.current_artifact_ref IS NULL OR NEW.current_artifact_revision IS NULL OR NEW.current_artifact_revision <= COALESCE(OLD.current_artifact_revision, 0)) THEN RAISE EXCEPTION 'ready alignment requires a new immutable artifact revision'; END IF;
  IF NEW.status = 'unavailable' AND NEW.current_artifact_ref IS NOT NULL THEN RAISE EXCEPTION 'unavailable alignment cannot point to an artifact'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_immutable_object_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.reservation_id FOR UPDATE;
  IF reservation_record.reservation_id IS NULL OR reservation_record.submission_id <> NEW.submission_id OR reservation_record.operation_id <> NEW.operation_id OR reservation_record.state <> 'claimed' OR reservation_record.expires_at <= clock_timestamp() OR reservation_record.expected_content_type <> NEW.content_type OR reservation_record.expected_size_bytes <> NEW.size_bytes OR (reservation_record.expected_sha256 IS NOT NULL AND reservation_record.expected_sha256 <> NEW.canonical_sha256) THEN RAISE EXCEPTION 'sealed media facts do not match reservation expectations'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_lineage_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL OR NEW.operation_id <> submission_record.operation_id THEN RAISE EXCEPTION 'media lineage does not match its submission'; END IF;
  IF TG_TABLE_NAME = 'media_submission_terms' THEN
    IF NEW.creation_revision <> submission_record.creation_revision + 1 THEN RAISE EXCEPTION 'terms revision is not current'; END IF;
  ELSIF TG_TABLE_NAME = 'media_audio_revisions' THEN
    IF NEW.audio_revision <> submission_record.audio_revision + 1 THEN RAISE EXCEPTION 'audio revision is not current'; END IF;
  ELSIF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF NEW.audio_revision <> submission_record.audio_revision OR NEW.analysis_revision <> submission_record.analysis_revision + 1 THEN RAISE EXCEPTION 'analysis revision is not current'; END IF;
    IF ROW(NEW.bound_reference_asset_id,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(submission_record.bound_reference_asset_id,submission_record.bound_reference_audio_revision,submission_record.bound_reference_analysis_revision,submission_record.bound_reference_audio_sha256,submission_record.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'analysis bound reference does not match submission'; END IF;
    IF NEW.bound_reference_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_reference_evidence r WHERE r.community_id = NEW.community_id AND r.actor_user_id = NEW.actor_user_id AND r.submission_id = NEW.submission_id AND r.operation_id = NEW.operation_id AND r.asset_id = NEW.bound_reference_asset_id AND r.evidence_audio_revision = NEW.bound_reference_audio_revision AND r.evidence_analysis_revision = NEW.bound_reference_analysis_revision AND r.evidence_audio_sha256 = NEW.bound_reference_audio_sha256 AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps) THEN RAISE EXCEPTION 'analysis bound reference evidence does not match'; END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF NEW.creation_revision <> submission_record.creation_revision OR NEW.audio_revision <> submission_record.audio_revision OR NEW.analysis_revision <> submission_record.analysis_revision OR NEW.decision_revision <> submission_record.decision_revision + 1 THEN RAISE EXCEPTION 'decision evidence is not current'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_moderation_action_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE allowed BOOLEAN; submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT (c.status = 'active' AND m.status = 'member') INTO allowed
    FROM communities c
    JOIN community_memberships m ON m.community_id = c.community_id AND m.user_id = NEW.authority_actor_user_id
    WHERE c.community_id = NEW.community_id
    FOR SHARE;
  IF allowed IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'moderation action requires active community membership'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
      AND submission_id = NEW.submission_id AND operation_id = NEW.operation_id
    FOR UPDATE;
  IF submission_record.submission_id IS NULL OR submission_record.status <> 'manual_review'
     OR submission_record.held_revision IS DISTINCT FROM NEW.held_revision
     OR submission_record.review_ref IS NULL THEN
    RAISE EXCEPTION 'moderation action is not bound to a held review';
  END IF;
  IF NEW.held_revision IS DISTINCT FROM submission_record.held_revision THEN RAISE EXCEPTION 'moderation held revision does not match'; END IF;
  IF NEW.action_kind = 'approve' AND (NEW.decision_revision IS NULL OR NEW.decision_revision <> submission_record.decision_revision + 1 OR NEW.decision_snapshot IS DISTINCT FROM (SELECT decision_snapshot FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision)) THEN
    RAISE EXCEPTION 'moderation approval decision revision is not current';
  END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'inconclusive' AND (NEW.approval_kind IS DISTINCT FROM 'acr_override' OR NEW.reason_code IS DISTINCT FROM CASE WHEN submission_record.review_exhaustion_code = 'acr_exhausted' THEN 'acr_exhausted' ELSE 'acr_inconclusive' END) THEN RAISE EXCEPTION 'inconclusive ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'skipped' AND (NEW.approval_kind IS DISTINCT FROM 'acr_override' OR NEW.reason_code IS DISTINCT FROM 'acr_skipped') THEN RAISE EXCEPTION 'skipped ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND (SELECT acr_decision FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=submission_record.analysis_revision) = 'allow' AND (NEW.approval_kind IS DISTINCT FROM 'standard' OR NEW.reason_code IS NOT NULL) THEN RAISE EXCEPTION 'allow ACR moderation mapping is not exact'; END IF;
  IF NEW.action_kind = 'approve' AND NEW.reason_code = 'acr_exhausted' AND submission_record.review_exhaustion_code IS DISTINCT FROM 'acr_exhausted' THEN
    RAISE EXCEPTION 'ACR exhaustion override lacks its private exhaustion hold';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_moderation_projection_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL
     OR NEW.status IS DISTINCT FROM 'none'
     OR NEW.decision_revision IS NOT NULL
     OR NEW.review_ref IS NOT NULL
     OR NEW.held_revision IS NOT NULL
     OR NEW.review_exhaustion_code IS NOT NULL
     OR NEW.review_exhaustion_attempt_id IS NOT NULL
     OR NEW.action_kind IS NOT NULL
     OR NEW.moderator_action_id IS NOT NULL
     OR NEW.moderator_actor_id IS NOT NULL
     OR NEW.action_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION 'initial moderation projection is not empty';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_outbox_payload() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE keys TEXT[]; expected TEXT[]; submission_record media_post_submissions%ROWTYPE;
BEGIN
  keys := ARRAY(SELECT jsonb_object_keys(NEW.payload) ORDER BY 1);
  IF NEW.event_type = 'analysis_launch' THEN expected := ARRAY['analysis_revision','audio_revision','kind','operation_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSIF NEW.event_type = 'publication' THEN expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision'];
  ELSE expected := ARRAY['kind','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision']; END IF;
  IF keys IS DISTINCT FROM expected THEN RAISE EXCEPTION 'media outbox payload is not a closed identifier union'; END IF;
  IF jsonb_typeof(NEW.payload->'kind') IS DISTINCT FROM 'string' OR NEW.payload->>'kind' IS DISTINCT FROM NEW.event_type THEN RAISE EXCEPTION 'media outbox payload kind does not match event type'; END IF;
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL OR NEW.operation_id IS DISTINCT FROM submission_record.operation_id OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision OR NEW.workflow_revision IS DISTINCT FROM submission_record.workflow_revision OR NEW.workflow_instance_id IS DISTINCT FROM 'media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text THEN RAISE EXCEPTION 'media outbox row lineage does not match submission'; END IF;
  IF NEW.event_type = 'analysis_launch' THEN
    IF jsonb_typeof(NEW.payload->'submission_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'operation_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'workflow_instance_id') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'submission_id') = '' OR btrim(NEW.payload->>'operation_id') = '' OR btrim(NEW.payload->>'workflow_instance_id') = '' OR jsonb_typeof(NEW.payload->'audio_revision') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.payload->'analysis_revision') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.payload->'workflow_revision') IS DISTINCT FROM 'number' OR NEW.payload->>'audio_revision' !~ '^[0-9]+$' OR NEW.payload->>'analysis_revision' !~ '^[0-9]+$' OR NEW.payload->>'workflow_revision' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'media analysis outbox payload types are not exact'; END IF;
    IF NEW.payload->>'submission_id' IS DISTINCT FROM NEW.submission_id OR NEW.payload->>'operation_id' IS DISTINCT FROM NEW.operation_id OR (NEW.payload->>'audio_revision')::BIGINT IS DISTINCT FROM NEW.audio_revision OR (NEW.payload->>'analysis_revision')::BIGINT IS DISTINCT FROM NEW.analysis_revision OR (NEW.payload->>'workflow_revision')::BIGINT IS DISTINCT FROM NEW.workflow_revision OR NEW.payload->>'workflow_instance_id' IS DISTINCT FROM NEW.workflow_instance_id OR NOT EXISTS (SELECT 1 FROM media_audio_revisions a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.audio_revision=NEW.audio_revision AND a.immutable_ref=submission_record.current_immutable_ref) THEN RAISE EXCEPTION 'media analysis outbox payload values do not match row'; END IF;
  ELSE
    IF jsonb_typeof(NEW.payload->'submission_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'operation_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'post_id') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.payload->'workflow_instance_id') IS DISTINCT FROM 'string' OR btrim(NEW.payload->>'submission_id') = '' OR btrim(NEW.payload->>'operation_id') = '' OR btrim(NEW.payload->>'post_id') = '' OR btrim(NEW.payload->>'workflow_instance_id') = '' OR jsonb_typeof(NEW.payload->'workflow_revision') IS DISTINCT FROM 'number' OR NEW.payload->>'workflow_revision' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'media publication outbox payload types are not exact'; END IF;
    IF NEW.payload->>'submission_id' IS DISTINCT FROM NEW.submission_id OR NEW.payload->>'operation_id' IS DISTINCT FROM NEW.operation_id OR NEW.payload->>'post_id' IS DISTINCT FROM submission_record.post_id OR (NEW.payload->>'workflow_revision')::BIGINT IS DISTINCT FROM NEW.workflow_revision OR NEW.payload->>'workflow_instance_id' IS DISTINCT FROM NEW.workflow_instance_id THEN RAISE EXCEPTION 'media publication outbox payload values do not match row'; END IF;
  END IF;
  RETURN NEW;
END;
$_$;

CREATE FUNCTION validate_media_publication_projection_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; post_record posts%ROWTYPE; audio_record media_audio_revisions%ROWTYPE; analysis_record media_analysis_evidence%ROWTYPE; decision_record media_publication_decisions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND submission_id = NEW.submission_id FOR SHARE;
  SELECT * INTO post_record FROM posts WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
  SELECT * INTO audio_record FROM media_audio_revisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND audio_revision=NEW.audio_revision FOR SHARE;
  SELECT * INTO analysis_record FROM media_analysis_evidence WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
  SELECT * INTO decision_record FROM media_publication_decisions WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND decision_revision=NEW.decision_revision FOR SHARE;
  IF analysis_record.submission_id IS NULL
     OR analysis_record.audio_revision IS DISTINCT FROM submission_record.audio_revision
     OR analysis_record.canonical_audio_sha256 IS DISTINCT FROM audio_record.canonical_sha256 THEN
    RAISE EXCEPTION 'publication analysis bound reference lineage is not exact';
  END IF;
  IF submission_record.status <> 'published' OR submission_record.operation_id <> NEW.operation_id OR submission_record.post_id <> NEW.post_id OR post_record.author_user_id <> NEW.actor_user_id OR post_record.post_type <> 'song' OR post_record.status <> 'published' OR post_record.visibility <> 'public' OR post_record.title IS DISTINCT FROM submission_record.title OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision OR NEW.alignment <> 'pending' OR audio_record.submission_id IS NULL OR analysis_record.submission_id IS NULL OR decision_record.submission_id IS NULL OR decision_record.outcome <> 'allow' OR NEW.canonical_audio_sha256 IS DISTINCT FROM audio_record.canonical_sha256 OR NEW.title IS DISTINCT FROM submission_record.title OR NEW.audio_asset_ref IS DISTINCT FROM audio_record.immutable_ref OR NEW.cover_artifact_ref IS DISTINCT FROM (CASE WHEN analysis_record.cover_status='ready' THEN analysis_record.cover_artifact_ref ELSE NULL END) OR NEW.language_status IS DISTINCT FROM analysis_record.speech_status OR NEW.primary_language_bcp47 IS DISTINCT FROM analysis_record.primary_language_bcp47 OR NEW.secondary_language_bcp47 IS DISTINCT FROM analysis_record.secondary_language_bcp47 OR NEW.lyrics_explicitness IS DISTINCT FROM analysis_record.explicitness OR NEW.analysis_badges IS DISTINCT FROM (CASE WHEN submission_record.bound_reference_asset_id IS NULL THEN '[]'::jsonb ELSE '["reference_bound"]'::jsonb END) THEN RAISE EXCEPTION 'media publication projection is not owned by its operation'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_reference_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.bound_reference_asset_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM media_reference_evidence r
       WHERE r.community_id=NEW.community_id
         AND r.actor_user_id=NEW.actor_user_id
         AND r.submission_id=NEW.submission_id
         AND r.operation_id=NEW.operation_id
         AND r.asset_id=NEW.bound_reference_asset_id
         AND r.evidence_ref=NEW.bound_reference_evidence_ref
         AND r.evidence_audio_revision=NEW.bound_reference_audio_revision
         AND r.evidence_analysis_revision=NEW.bound_reference_analysis_revision
         AND r.evidence_audio_sha256=NEW.bound_reference_audio_sha256
         AND r.upstream_commercial_rev_share_bps IS NOT DISTINCT FROM NEW.bound_reference_upstream_share_bps
     ) THEN
    RAISE EXCEPTION 'current reference binding lacks its immutable evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_reservation_claim_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; event_record media_submission_events%ROWTYPE; issued_event_record media_submission_events%ROWTYPE;
BEGIN
  IF NEW.state IN ('claimed', 'sealed', 'rejected', 'expired') AND NEW.submission_id IS NOT NULL THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND audio_reservation_id=NEW.reservation_id FOR SHARE;
    SELECT * INTO event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=1 FOR SHARE;
    SELECT * INTO issued_event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=2 FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR event_record.submission_id IS NULL
       OR NEW.claim_fence <> 1
       OR event_record.event_kind IS DISTINCT FROM 'submission_reserved'
       OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'submission_reserved'
       OR issued_event_record.submission_id IS NULL
       OR issued_event_record.event_kind IS DISTINCT FROM 'media_reservation_issued'
       OR issued_event_record.evidence->>'event_kind' IS DISTINCT FROM 'media_reservation_issued' THEN
      RAISE EXCEPTION 'media reservation claim is not paired with its exact submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_snapshot_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE allocation JSONB; allocation_recipient TEXT; allocation_share NUMERIC; allocation_total NUMERIC := 0; allocation_count INTEGER := 0; distinct_recipient_count INTEGER := 0;
BEGIN
  IF TG_TABLE_NAME = 'media_submission_terms' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.terms_snapshot) AS key) IS DISTINCT FROM ARRAY['accessMode','commercialRemixShareBps','licensePreset','royaltyAllocations']::TEXT[] THEN
      RAISE EXCEPTION 'terms snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.terms_snapshot->'licensePreset') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.terms_snapshot->'accessMode') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.terms_snapshot->'royaltyAllocations') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'terms snapshot scalar types are not exact';
    END IF;
    IF jsonb_typeof(NEW.terms_snapshot->'commercialRemixShareBps') IS DISTINCT FROM 'number'
       OR NEW.terms_snapshot->>'commercialRemixShareBps' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'terms commercial share type is not exact';
    END IF;
    IF NEW.terms_snapshot->>'licensePreset' IS DISTINCT FROM NEW.license_preset
       OR NEW.terms_snapshot->>'accessMode' IS DISTINCT FROM NEW.access_mode
       OR (NEW.terms_snapshot->>'commercialRemixShareBps')::numeric IS DISTINCT FROM NEW.commercial_remix_share_bps
       OR NEW.terms_snapshot->'royaltyAllocations' IS DISTINCT FROM NEW.royalty_allocations THEN
      RAISE EXCEPTION 'terms snapshot scalars do not match columns';
    END IF;
    IF jsonb_typeof(NEW.royalty_allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.royalty_allocations) < 1 THEN
      RAISE EXCEPTION 'royalty allocations must be a non-empty array';
    END IF;
    FOR allocation IN SELECT value FROM jsonb_array_elements(NEW.royalty_allocations) LOOP
      IF jsonb_typeof(allocation) IS DISTINCT FROM 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(allocation)) <> 2
         OR NOT (allocation ? 'recipientId')
         OR NOT (allocation ? 'shareBps')
         OR jsonb_typeof(allocation->'recipientId') IS DISTINCT FROM 'string'
         OR jsonb_typeof(allocation->'shareBps') IS DISTINCT FROM 'number'
         OR allocation->>'recipientId' IS NULL
         OR btrim(allocation->>'recipientId') = ''
         OR allocation->>'shareBps' IS NULL
         OR allocation->>'shareBps' !~ '^[0-9]+$'
         OR (allocation->>'shareBps')::numeric <= 0
         OR (allocation->>'shareBps')::numeric > 10000 THEN
        RAISE EXCEPTION 'royalty allocation shape is not exact';
      END IF;
      allocation_recipient := allocation->>'recipientId';
      allocation_share := (allocation->>'shareBps')::numeric;
      allocation_total := allocation_total + allocation_share;
      allocation_count := allocation_count + 1;
    END LOOP;
    SELECT count(DISTINCT value->>'recipientId') INTO distinct_recipient_count
      FROM jsonb_array_elements(NEW.royalty_allocations);
    IF distinct_recipient_count <> allocation_count OR allocation_total <> 10000
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.royalty_allocations) value WHERE value->>'recipientId' = NEW.actor_user_id) THEN
      RAISE EXCEPTION 'royalty allocations do not form an exact author-inclusive 10000 bps split';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.decision_snapshot) AS key) IS DISTINCT FROM ARRAY['analysisRevision','audioRevision','canonicalAudioSha256','creationRevision','decisionRevision','evidenceRef','outcome','policyRevision']::TEXT[] THEN
      RAISE EXCEPTION 'decision snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'canonicalAudioSha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'outcome') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'policyRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.decision_snapshot->'evidenceRef') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'decision snapshot scalar types are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'decisionRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'decisionRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'creationRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'creationRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'audioRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'audioRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.decision_snapshot->'analysisRevision') IS DISTINCT FROM 'number'
       OR NEW.decision_snapshot->>'analysisRevision' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'decision snapshot revision types are not exact';
    END IF;
    IF jsonb_typeof(NEW.decision_snapshot->'decisionRevision') IS DISTINCT FROM 'number'
       OR (NEW.decision_snapshot->>'decisionRevision')::numeric IS DISTINCT FROM NEW.decision_revision
       OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM NEW.outcome
       OR (NEW.decision_snapshot->>'creationRevision')::numeric IS DISTINCT FROM NEW.creation_revision
       OR (NEW.decision_snapshot->>'audioRevision')::numeric IS DISTINCT FROM NEW.audio_revision
       OR (NEW.decision_snapshot->>'analysisRevision')::numeric IS DISTINCT FROM NEW.analysis_revision
       OR NEW.decision_snapshot->>'canonicalAudioSha256' IS DISTINCT FROM NEW.canonical_audio_sha256
       OR NEW.decision_snapshot->>'policyRevision' IS DISTINCT FROM NEW.policy_revision
       OR NEW.decision_snapshot->>'evidenceRef' IS DISTINCT FROM NEW.evidence_ref THEN
      RAISE EXCEPTION 'decision snapshot scalars do not match columns';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot) AS key) IS DISTINCT FROM ARRAY['acr','analysisRevision','audioRevision','boundReference','canonicalAudioSha256','embeddedMetadata','finalizedAudioRef','lyricsSafety','mediaSafety','operationId','probeEvidenceRef','speechLyrics','version']::TEXT[] THEN
      RAISE EXCEPTION 'analysis snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'version') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'operationId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'canonicalAudioSha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'finalizedAudioRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'probeEvidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'lyricsSafety') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'mediaSafety') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'analysis snapshot scalar types are not exact';
    END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata') AS key) IS DISTINCT FROM ARRAY['adapterRevision','cover','evidenceRef','trackTitle']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'adapterRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover') IS DISTINCT FROM 'object'
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'trackTitle') IS DISTINCT FROM 'string' AND NEW.analysis_snapshot->'embeddedMetadata'->'trackTitle' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'embedded metadata snapshot shape is not exact';
    END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'acr') AS key) IS DISTINCT FROM ARRAY['adapterRevision','decision','evidenceRef','policyRevision']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'adapterRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'decision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'acr'->'policyRevision') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'ACR snapshot shape is not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' = 'ready' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'speechLyrics') AS key) IS DISTINCT FROM ARRAY['adapterRevision','evidenceRef','explicitness','policyRevision','primaryLanguageBcp47','secondaryLanguageBcp47','status','transcriptArtifactRef','transcriptSha256']::TEXT[] THEN
      RAISE EXCEPTION 'ready speech snapshot keys are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' IN ('no_speech','unavailable') AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'speechLyrics') AS key) IS DISTINCT FROM ARRAY['adapterRevision','evidenceRef','explicitness','policyRevision','primaryLanguageBcp47','secondaryLanguageBcp47','status','transcriptArtifactRef','transcriptSha256']::TEXT[] THEN
      RAISE EXCEPTION 'non-ready speech snapshot keys are not exact';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'status') IS DISTINCT FROM 'string'
       OR NEW.analysis_snapshot->'speechLyrics'->>'status' NOT IN ('ready','no_speech','unavailable')
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'explicitness') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'evidenceRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'policyRevision') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'adapterRevision') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'speech snapshot discriminator types are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' = 'ready'
       AND (jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'transcriptArtifactRef') IS DISTINCT FROM 'string'
         OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'transcriptSha256') IS DISTINCT FROM 'string'
         OR jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'primaryLanguageBcp47') IS DISTINCT FROM 'string'
         OR (jsonb_typeof(NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47') IS DISTINCT FROM 'string' AND NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb)) THEN
      RAISE EXCEPTION 'ready speech snapshot scalar types are not exact';
    END IF;
    IF NEW.analysis_snapshot->'speechLyrics'->>'status' IN ('no_speech','unavailable')
       AND (NEW.analysis_snapshot->'speechLyrics'->'transcriptArtifactRef' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'transcriptSha256' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'primaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb
         OR NEW.analysis_snapshot->'speechLyrics'->'secondaryLanguageBcp47' IS DISTINCT FROM 'null'::jsonb) THEN
      RAISE EXCEPTION 'non-ready speech nullable fields must be explicit JSON null';
    END IF;
    IF jsonb_typeof(NEW.analysis_snapshot->'analysisRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->>'analysisRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'audioRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->>'audioRevision' !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'analysis snapshot revision types are not exact';
    END IF;
    IF NEW.cover_status = 'ready' AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata'->'cover') AS key) IS DISTINCT FROM ARRAY['artifactRef','artifactSha256','height','mediaType','normalizationRevision','safetyPolicyRevision','status','width']::TEXT[] THEN
      RAISE EXCEPTION 'ready cover facts keys are not exact';
    END IF;
    IF NEW.cover_status IN ('absent','rejected') AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'embeddedMetadata'->'cover') AS key) IS DISTINCT FROM ARRAY['reasonCode','status']::TEXT[] THEN
      RAISE EXCEPTION 'non-ready cover facts keys are not exact';
    END IF;
    IF NEW.cover_status = 'ready' AND (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'artifactRef') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'artifactSha256') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'mediaType') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') IS DISTINCT FROM 'number' OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'width' !~ '^[0-9]+$' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') IS DISTINCT FROM 'number' OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'height' !~ '^[0-9]+$' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'normalizationRevision') IS DISTINCT FROM 'string' OR jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'safetyPolicyRevision') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'ready cover facts types are not exact';
    END IF;
    IF NEW.analysis_snapshot->>'version' IS DISTINCT FROM NEW.analysis_version
       OR NEW.analysis_snapshot->>'operationId' IS DISTINCT FROM NEW.operation_id
       OR (NEW.analysis_snapshot->>'analysisRevision')::numeric IS DISTINCT FROM NEW.analysis_revision
       OR (NEW.analysis_snapshot->>'audioRevision')::numeric IS DISTINCT FROM NEW.audio_revision
       OR NEW.analysis_snapshot->>'canonicalAudioSha256' IS DISTINCT FROM NEW.canonical_audio_sha256
       OR NEW.analysis_snapshot->>'finalizedAudioRef' IS DISTINCT FROM NEW.finalized_audio_ref
       OR NEW.analysis_snapshot->>'probeEvidenceRef' IS DISTINCT FROM NEW.probe_evidence_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'evidenceRef' IS DISTINCT FROM NEW.embedded_metadata_evidence_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'adapterRevision' IS DISTINCT FROM NEW.embedded_metadata_adapter_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->>'trackTitle' IS DISTINCT FROM NEW.embedded_title
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'status' IS DISTINCT FROM NEW.cover_status
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'artifactRef' IS DISTINCT FROM NEW.cover_artifact_ref
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'artifactSha256' IS DISTINCT FROM NEW.cover_artifact_sha256
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'mediaType' IS DISTINCT FROM NEW.cover_media_type
       OR NEW.cover_facts IS DISTINCT FROM NEW.analysis_snapshot->'embeddedMetadata'->'cover'
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') = 'number' AND (NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'width')::numeric IS DISTINCT FROM NEW.cover_width)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'width') <> 'number' AND NEW.cover_width IS NOT NULL)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') = 'number' AND (NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'height')::numeric IS DISTINCT FROM NEW.cover_height)
       OR (jsonb_typeof(NEW.analysis_snapshot->'embeddedMetadata'->'cover'->'height') <> 'number' AND NEW.cover_height IS NOT NULL)
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'normalizationRevision' IS DISTINCT FROM NEW.cover_normalization_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover'->>'safetyPolicyRevision' IS DISTINCT FROM NEW.cover_safety_policy_revision
       OR NEW.analysis_snapshot->'embeddedMetadata'->'cover' IS DISTINCT FROM NEW.cover_facts
       OR NEW.analysis_snapshot->'speechLyrics'->>'status' IS DISTINCT FROM NEW.speech_status
       OR NEW.analysis_snapshot->'speechLyrics'->>'transcriptArtifactRef' IS DISTINCT FROM NEW.transcript_artifact_ref
       OR NEW.analysis_snapshot->'speechLyrics'->>'transcriptSha256' IS DISTINCT FROM NEW.transcript_sha256
       OR NEW.analysis_snapshot->'speechLyrics'->>'explicitness' IS DISTINCT FROM NEW.explicitness
       OR NEW.analysis_snapshot->'speechLyrics'->>'primaryLanguageBcp47' IS DISTINCT FROM NEW.primary_language_bcp47
       OR NEW.analysis_snapshot->'speechLyrics'->>'secondaryLanguageBcp47' IS DISTINCT FROM NEW.secondary_language_bcp47
       OR NEW.analysis_snapshot->'speechLyrics'->>'evidenceRef' IS DISTINCT FROM NEW.speech_evidence_ref
       OR NEW.analysis_snapshot->'speechLyrics'->>'policyRevision' IS DISTINCT FROM NEW.speech_policy_revision
       OR NEW.analysis_snapshot->'speechLyrics'->>'adapterRevision' IS DISTINCT FROM NEW.speech_adapter_revision
       OR NEW.analysis_snapshot->'acr'->>'decision' IS DISTINCT FROM NEW.acr_decision
       OR NEW.analysis_snapshot->'acr'->>'evidenceRef' IS DISTINCT FROM NEW.acr_evidence_ref
       OR NEW.analysis_snapshot->'acr'->>'policyRevision' IS DISTINCT FROM NEW.acr_policy_revision
       OR NEW.analysis_snapshot->'acr'->>'adapterRevision' IS DISTINCT FROM NEW.acr_adapter_revision
       OR NEW.analysis_snapshot->>'lyricsSafety' IS DISTINCT FROM NEW.lyrics_safety
       OR NEW.analysis_snapshot->>'mediaSafety' IS DISTINCT FROM NEW.media_safety THEN
      RAISE EXCEPTION 'analysis snapshot scalars do not match columns';
    END IF;
    IF NEW.bound_reference_asset_id IS NULL THEN
      IF NOT (NEW.analysis_snapshot ? 'boundReference') OR NEW.analysis_snapshot->'boundReference' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'analysis snapshot bound reference does not match columns'; END IF;
    ELSIF NOT (NEW.analysis_snapshot ? 'boundReference')
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference') IS DISTINCT FROM 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot->'boundReference') AS key) IS DISTINCT FROM ARRAY['assetId','evidenceAnalysisRevision','evidenceAudioRevision','evidenceAudioSha256','upstreamCommercialRevShareBps']::TEXT[]
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'assetId') IS DISTINCT FROM 'string'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAudioRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAnalysisRevision') IS DISTINCT FROM 'number'
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAnalysisRevision' !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'evidenceAudioSha256') IS DISTINCT FROM 'string'
       OR NOT (NEW.analysis_snapshot->'boundReference' ? 'upstreamCommercialRevShareBps')
       OR (jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps') IS DISTINCT FROM 'number' AND NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps' IS DISTINCT FROM 'null'::jsonb)
       OR (jsonb_typeof(NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps') = 'number' AND NEW.analysis_snapshot->'boundReference'->>'upstreamCommercialRevShareBps' !~ '^[0-9]+$')
       OR NEW.analysis_snapshot->'boundReference'->>'assetId' IS DISTINCT FROM NEW.bound_reference_asset_id
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioRevision' IS DISTINCT FROM NEW.bound_reference_audio_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAnalysisRevision' IS DISTINCT FROM NEW.bound_reference_analysis_revision::text
       OR NEW.analysis_snapshot->'boundReference'->>'evidenceAudioSha256' IS DISTINCT FROM NEW.bound_reference_audio_sha256
       OR NEW.analysis_snapshot->'boundReference'->'upstreamCommercialRevShareBps' IS DISTINCT FROM to_jsonb(NEW.bound_reference_upstream_share_bps) THEN
      RAISE EXCEPTION 'analysis snapshot bound reference does not match columns';
    END IF;
  END IF;
  RETURN NEW;
END;
$_$;

CREATE FUNCTION validate_media_submission_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE community_active BOOLEAN; membership_active BOOLEAN; reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  SELECT status = 'active' INTO community_active FROM communities WHERE community_id = NEW.community_id FOR SHARE;
  SELECT status = 'member' INTO membership_active FROM community_memberships WHERE community_id = NEW.community_id AND user_id = NEW.actor_user_id FOR SHARE;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.audio_reservation_id FOR UPDATE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE OR reservation_record.reservation_id IS NULL OR reservation_record.state <> 'issued' OR reservation_record.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'media submission requires active community membership and a live reservation'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_submission_event_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE expected_event TEXT; event_record media_submission_events%ROWTYPE; reservation_record media_upload_reservations%ROWTYPE;
BEGIN
  IF OLD.status = 'processing' AND OLD.phase = 'reserve' AND NEW.status = 'processing' AND NEW.phase = 'awaiting_upload' THEN expected_event := 'media_reservation_issued';
  ELSIF (((OLD.status = 'processing' AND OLD.phase IN ('awaiting_upload', 'finalize', 'analysis', 'decision')) OR (OLD.status IN ('action_required', 'manual_review') AND OLD.phase IS NULL)) AND NEW.status = 'processing' AND NEW.creation_revision = OLD.creation_revision + 1 AND NEW.current_terms_revision = NEW.creation_revision) THEN expected_event := 'song_terms_bound';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'awaiting_upload' AND NEW.audio_revision = OLD.audio_revision + 1 THEN expected_event := 'upload_finalized';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.analysis_revision = OLD.analysis_revision + 1 THEN expected_event := 'blocking_analysis_completed';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.decision_revision = OLD.decision_revision + 1 THEN expected_event := CASE NEW.status WHEN 'processing' THEN 'publication_allowed' WHEN 'manual_review' THEN 'review_required' WHEN 'blocked' THEN 'policy_blocked' ELSE NULL END;
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.status = 'manual_review' AND NEW.decision_revision = OLD.decision_revision + 1 THEN expected_event := 'review_required';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'analysis' AND NEW.review_exhaustion_code = 'acr_exhausted' THEN expected_event := 'review_exhaustion_recorded';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'decision' AND NEW.status = 'action_required' THEN expected_event := 'reference_required';
  ELSIF OLD.status = 'action_required' AND NEW.status = 'processing' AND NEW.bound_reference_asset_id IS NOT NULL THEN expected_event := 'reference_bound';
  ELSIF OLD.status = 'manual_review' AND NEW.status = 'processing' THEN expected_event := 'moderator_approved';
  ELSIF OLD.status = 'manual_review' AND NEW.status = 'blocked' THEN expected_event := 'moderator_blocked';
  ELSIF OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published' THEN expected_event := 'publication_committed';
  ELSIF OLD.status = 'processing_failed' AND NEW.status = 'processing' THEN expected_event := 'retry_authorized';
  ELSIF OLD.status = 'action_required' AND NEW.status = 'abandoned' THEN expected_event := 'action_deadline_elapsed';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'author_cancelled' THEN expected_event := 'author_cancelled';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' THEN expected_event := 'reservation_expired';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'upload_expectation_mismatch' THEN expected_event := 'upload_expectation_mismatch_recorded';
  ELSIF OLD.status = 'processing' AND NEW.status = 'abandoned' AND NEW.abandonment_reason = 'upload_source_changed_before_finalize' THEN expected_event := 'upload_source_precondition_failed';
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing_failed' THEN expected_event := 'failure';
  ELSE RAISE EXCEPTION 'media submission event transition is not recognized';
  END IF;
  SELECT * INTO event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=NEW.event_sequence;
  IF event_record.submission_id IS NULL THEN RAISE EXCEPTION 'media submission transition requires its exact event'; END IF;
  IF event_record.community_id IS DISTINCT FROM NEW.community_id OR event_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR event_record.operation_id IS DISTINCT FROM NEW.operation_id OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision THEN RAISE EXCEPTION 'media submission event lineage does not match'; END IF;
  IF expected_event <> 'failure' AND event_record.event_kind IS DISTINCT FROM expected_event THEN RAISE EXCEPTION 'media submission transition requires its exact event'; END IF;
  IF event_record.evidence->>'event_kind' IS DISTINCT FROM event_record.event_kind OR (event_record.event_kind = 'review_exhaustion_recorded' AND event_record.evidence->>'exhaustion_attempt_id' IS DISTINCT FROM NEW.review_exhaustion_attempt_id) THEN RAISE EXCEPTION 'media submission event evidence does not match'; END IF;
  IF event_record.event_kind = 'moderator_blocked' AND event_record.evidence->>'reason_code' IS DISTINCT FROM 'policy_violation' THEN RAISE EXCEPTION 'moderator block event evidence is not exact'; END IF;
  IF expected_event = 'failure' AND event_record.event_kind NOT IN ('media_failure_recorded','technical_exhaustion_recorded','seal_conflict_recorded') THEN RAISE EXCEPTION 'media failure transition event is not exact'; END IF;
  IF NEW.failure_code IS NOT DISTINCT FROM 'upload_seal_conflict' AND (OLD.phase IS DISTINCT FROM 'finalize' OR event_record.event_kind IS DISTINCT FROM 'seal_conflict_recorded') THEN RAISE EXCEPTION 'seal conflict event evidence is not exact'; END IF;
  IF event_record.event_kind = 'seal_conflict_recorded' AND (OLD.phase IS DISTINCT FROM 'finalize' OR NEW.failure_code IS DISTINCT FROM 'upload_seal_conflict' OR NEW.retryable IS DISTINCT FROM FALSE) THEN RAISE EXCEPTION 'seal conflict event evidence is not exact'; END IF;
  IF (NEW.status = 'abandoned' AND NEW.abandonment_reason IN ('upload_expectation_mismatch', 'upload_source_changed_before_finalize')) OR (NEW.status = 'processing_failed' AND NEW.failure_code = 'upload_seal_conflict') THEN
    SELECT * INTO reservation_record FROM media_upload_reservations
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND reservation_id=NEW.audio_reservation_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
    IF reservation_record.reservation_id IS NULL
       OR reservation_record.state IS DISTINCT FROM 'rejected'
       OR reservation_record.terminal_fence IS DISTINCT FROM NEW.event_sequence
       OR reservation_record.terminal_at IS NULL
       OR reservation_record.terminal_evidence_ref IS NULL
       OR reservation_record.terminal_evidence_digest IS DISTINCT FROM encode(sha256(reservation_record.terminal_evidence_ref::bytea), 'hex')
       OR reservation_record.terminal_reason IS DISTINCT FROM (CASE
         WHEN NEW.abandonment_reason = 'upload_expectation_mismatch' THEN 'expectation_mismatch'
         WHEN NEW.abandonment_reason = 'upload_source_changed_before_finalize' THEN 'source_precondition_failed'
         ELSE 'destination_conflict'
       END) THEN
      RAISE EXCEPTION 'terminal upload reservation is not paired with its submission failure';
    END IF;
  END IF;
  IF NEW.status = 'abandoned' AND NEW.abandonment_reason = 'reservation_expired' THEN
    SELECT * INTO reservation_record FROM media_upload_reservations
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND reservation_id=NEW.audio_reservation_id FOR SHARE;
    IF reservation_record.reservation_id IS NULL
       OR reservation_record.state IS DISTINCT FROM 'expired'
       OR reservation_record.submission_id IS DISTINCT FROM NEW.submission_id
       OR reservation_record.operation_id IS DISTINCT FROM NEW.operation_id
       OR reservation_record.claim_fence <= 0
       OR reservation_record.terminal_reason IS NOT NULL
       OR reservation_record.terminal_evidence_ref IS NOT NULL
       OR reservation_record.terminal_evidence_digest IS NOT NULL
       OR reservation_record.terminal_at IS NOT NULL
       OR reservation_record.terminal_fence IS NOT NULL THEN
      RAISE EXCEPTION 'expired upload reservation is not paired with its submission abandonment';
    END IF;
  END IF;
  IF expected_event = 'publication_committed' AND (
    NOT EXISTS (SELECT 1 FROM posts p WHERE p.community_id=NEW.community_id AND p.post_id=NEW.post_id AND p.author_user_id=NEW.actor_user_id AND p.post_type='song' AND p.status='published' AND p.visibility='public' AND p.title=NEW.title)
    OR NOT EXISTS (SELECT 1 FROM media_publication_projections p WHERE p.community_id=NEW.community_id AND p.actor_user_id=NEW.actor_user_id AND p.submission_id=NEW.submission_id AND p.operation_id=NEW.operation_id AND p.post_id=NEW.post_id AND p.creation_revision=NEW.creation_revision AND p.audio_revision=NEW.audio_revision AND p.analysis_revision=NEW.analysis_revision AND p.decision_revision=NEW.decision_revision AND p.canonical_audio_sha256=(SELECT canonical_sha256 FROM media_audio_revisions a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.audio_revision=NEW.audio_revision) AND p.alignment='pending')
    OR NOT EXISTS (SELECT 1 FROM media_alignment_projections a WHERE a.community_id=NEW.community_id AND a.actor_user_id=NEW.actor_user_id AND a.submission_id=NEW.submission_id AND a.operation_id=NEW.operation_id AND a.post_id=NEW.post_id AND a.audio_revision=NEW.audio_revision AND a.analysis_revision=NEW.analysis_revision AND a.canonical_audio_sha256=(SELECT canonical_sha256 FROM media_audio_revisions ar WHERE ar.community_id=NEW.community_id AND ar.actor_user_id=NEW.actor_user_id AND ar.submission_id=NEW.submission_id AND ar.operation_id=NEW.operation_id AND ar.audio_revision=NEW.audio_revision) AND a.status='pending' AND a.alignment_revision=0)
    OR NOT EXISTS (SELECT 1 FROM media_submission_outbox o WHERE o.community_id=NEW.community_id AND o.actor_user_id=NEW.actor_user_id AND o.submission_id=NEW.submission_id AND o.operation_id=NEW.operation_id AND o.event_type='publication' AND o.creation_revision=NEW.creation_revision AND o.audio_revision=NEW.audio_revision AND o.analysis_revision=NEW.analysis_revision AND o.workflow_revision=NEW.workflow_revision AND o.workflow_instance_id='media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text)
  ) THEN RAISE EXCEPTION 'publication commit is missing its owned projection, alignment, or outbox'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_submission_initial_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE event_record media_submission_events%ROWTYPE; issued_event_record media_submission_events%ROWTYPE; reservation_record media_upload_reservations%ROWTYPE; moderation_record media_moderation_projections%ROWTYPE;
BEGIN
  SELECT * INTO event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=1;
  SELECT * INTO issued_event_record FROM media_submission_events WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND event_sequence=2;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND reservation_id=NEW.audio_reservation_id;
  SELECT * INTO moderation_record FROM media_moderation_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id;
  IF event_record.submission_id IS NULL OR event_record.event_kind IS DISTINCT FROM 'submission_reserved' OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'submission_reserved'
     OR issued_event_record.submission_id IS NULL OR issued_event_record.event_kind IS DISTINCT FROM 'media_reservation_issued' OR issued_event_record.creation_revision IS DISTINCT FROM 1 OR issued_event_record.audio_revision IS DISTINCT FROM 0 OR issued_event_record.analysis_revision IS DISTINCT FROM 0 OR issued_event_record.decision_revision IS DISTINCT FROM 0 OR issued_event_record.workflow_revision IS DISTINCT FROM 0 OR issued_event_record.evidence->>'event_kind' IS DISTINCT FROM 'media_reservation_issued'
     OR NEW.status IS DISTINCT FROM 'processing' OR NEW.phase IS DISTINCT FROM 'reserve'
     OR NEW.creation_revision IS DISTINCT FROM 1 OR NEW.audio_revision IS DISTINCT FROM 0 OR NEW.analysis_revision IS DISTINCT FROM 0 OR NEW.decision_revision IS DISTINCT FROM 0 OR NEW.workflow_revision IS DISTINCT FROM 0 OR NEW.event_sequence IS DISTINCT FROM 1
     OR NEW.current_terms_revision IS NOT NULL OR NEW.current_immutable_ref IS NOT NULL OR NEW.current_analysis_revision IS NOT NULL OR NEW.current_decision_revision IS NOT NULL
     OR NEW.bound_reference_asset_id IS NOT NULL OR NEW.bound_reference_evidence_ref IS NOT NULL OR NEW.bound_reference_audio_revision IS NOT NULL OR NEW.bound_reference_analysis_revision IS NOT NULL OR NEW.bound_reference_audio_sha256 IS NOT NULL OR NEW.bound_reference_upstream_share_bps IS NOT NULL
     OR NEW.post_id IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.failure_retry_count IS NOT NULL OR NEW.retryable IS NOT NULL OR NEW.last_safe_phase IS NOT NULL OR NEW.retry_count IS DISTINCT FROM 0
     OR NEW.action_kind IS NOT NULL OR NEW.action_reference_request_ref IS NOT NULL OR NEW.action_expires_at IS NOT NULL OR NEW.held_revision IS NOT NULL OR NEW.review_ref IS NOT NULL OR NEW.review_reason_code IS NOT NULL OR NEW.review_exhaustion_code IS NOT NULL OR NEW.review_exhaustion_attempt_id IS NOT NULL OR NEW.moderator_action_id IS NOT NULL OR NEW.moderator_actor_id IS NOT NULL OR NEW.moderator_evidence_ref IS NOT NULL OR NEW.moderator_approval_kind IS NOT NULL OR NEW.moderator_reason_code IS NOT NULL OR NEW.abandonment_reason IS NOT NULL OR NEW.retention_disposition IS NOT NULL
     OR reservation_record.reservation_id IS NULL OR reservation_record.state IS DISTINCT FROM 'claimed' OR reservation_record.submission_id IS DISTINCT FROM NEW.submission_id OR reservation_record.operation_id IS DISTINCT FROM NEW.operation_id OR reservation_record.claim_fence IS DISTINCT FROM 1
     OR moderation_record.submission_id IS NULL OR moderation_record.community_id IS DISTINCT FROM NEW.community_id OR moderation_record.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR moderation_record.operation_id IS DISTINCT FROM NEW.operation_id OR moderation_record.status IS DISTINCT FROM 'none' OR moderation_record.decision_revision IS NOT NULL OR moderation_record.review_ref IS NOT NULL OR moderation_record.held_revision IS NOT NULL OR moderation_record.review_exhaustion_code IS NOT NULL OR moderation_record.review_exhaustion_attempt_id IS NOT NULL OR moderation_record.action_kind IS NOT NULL OR moderation_record.moderator_action_id IS NOT NULL OR moderation_record.moderator_actor_id IS NOT NULL OR moderation_record.action_evidence_ref IS NOT NULL THEN
    RAISE EXCEPTION 'media submission creation requires its exact submission_reserved event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_timed_lyrics_artifact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE segment JSONB; previous_start NUMERIC := 0; start_value NUMERIC; end_value NUMERIC; start_ms BIGINT; end_ms BIGINT; total_segment_text BIGINT := 0; publication media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO publication FROM media_publication_projections WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id AND post_id=NEW.post_id FOR SHARE;
  IF publication.submission_id IS NULL OR publication.post_id IS DISTINCT FROM NEW.post_id OR publication.audio_revision IS DISTINCT FROM NEW.audio_revision OR publication.analysis_revision IS DISTINCT FROM NEW.analysis_revision OR publication.canonical_audio_sha256 IS DISTINCT FROM NEW.canonical_audio_sha256 THEN RAISE EXCEPTION 'timed lyrics artifact lineage does not match publication'; END IF;
  IF encode(sha256(convert_to(NEW.artifact::text, 'UTF8')), 'hex') <> NEW.artifact_sha256 THEN RAISE EXCEPTION 'timed lyrics artifact hash does not match payload'; END IF;
  IF jsonb_typeof(NEW.artifact->'segments') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.artifact->'segments') > 10000 THEN RAISE EXCEPTION 'timed lyrics segment bounds are invalid'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.artifact->'segments') LOOP
    IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(segment) AS key) IS DISTINCT FROM ARRAY['end_ms','start_ms','text']::TEXT[] OR jsonb_typeof(segment->'start_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'end_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'text') IS DISTINCT FROM 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'timed lyrics segment shape is invalid'; END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN RAISE EXCEPTION 'timed lyrics segment text aggregate exceeds 200000 characters'; END IF;
    start_value := (segment->>'start_ms')::numeric; end_value := (segment->>'end_ms')::numeric;
    IF start_value < 0 OR end_value < start_value OR end_value > 86400000 OR start_value <> trunc(start_value) OR end_value <> trunc(end_value) OR start_value < previous_start THEN RAISE EXCEPTION 'timed lyrics segment timing is invalid'; END IF;
    start_ms := start_value::bigint; end_ms := end_value::bigint;
    previous_start := start_ms;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_media_transcript_artifact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE segment JSONB; previous_start NUMERIC := 0; start_value NUMERIC; end_value NUMERIC; start_ms BIGINT; end_ms BIGINT; total_segment_text BIGINT := 0;
BEGIN
  IF char_length(NEW.transcript_text) > 200000 OR encode(sha256(convert_to(NEW.transcript_text, 'UTF8')), 'hex') IS DISTINCT FROM NEW.transcript_sha256 THEN RAISE EXCEPTION 'transcript payload is not bounded or hashed'; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.segments) LOOP
    IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(segment) AS key) IS DISTINCT FROM ARRAY['end_ms','start_ms','text']::TEXT[] OR jsonb_typeof(segment->'start_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'end_ms') IS DISTINCT FROM 'number' OR jsonb_typeof(segment->'text') IS DISTINCT FROM 'string' OR char_length(segment->>'text') > 4096 THEN RAISE EXCEPTION 'transcript segment shape is invalid'; END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN RAISE EXCEPTION 'transcript segment text aggregate exceeds 200000 characters'; END IF;
    start_value := (segment->>'start_ms')::numeric; end_value := (segment->>'end_ms')::numeric;
    IF start_value < 0 OR end_value < start_value OR end_value > 86400000 OR start_value <> trunc(start_value) OR end_value <> trunc(end_value) OR start_value < previous_start THEN RAISE EXCEPTION 'transcript segment timing is invalid'; END IF;
    start_ms := start_value::bigint; end_ms := end_value::bigint;
    previous_start := start_ms;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_attempt_session_coherence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  leased_attempt_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_completion_attempts' THEN
    SELECT * INTO attempt_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = NEW.completion_attempt_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id;

    IF session_record.namespace_session_id IS NULL
      OR attempt_record.completion_attempt_id IS NULL
    THEN
      RAISE EXCEPTION 'namespace ownership completion attempt has no session';
    END IF;

    IF attempt_record.state = 'leased'
      AND (
        session_record.status <> 'pending'
        OR session_record.expires_at <= clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'leased namespace ownership attempt requires a live pending session';
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id;
  SELECT EXISTS (
    SELECT 1
      FROM namespace_ownership_completion_attempts
     WHERE namespace_session_id = NEW.namespace_session_id
       AND actor_id = NEW.actor_id
       AND state = 'leased'
  ) INTO leased_attempt_exists;

  IF session_record.namespace_session_id IS NULL THEN
    RAISE EXCEPTION 'namespace ownership session has no completion attempt parent';
  END IF;

  IF session_record.status <> 'pending' AND leased_attempt_exists THEN
    RAISE EXCEPTION 'terminal namespace ownership session cannot retain a leased attempt';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_consumed_attempt_coherence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  result_record community_creation_ceremony_results%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
BEGIN
  IF NEW.state <> 'consumed' THEN RETURN NULL; END IF;

  SELECT * INTO result_record
    FROM community_creation_ceremony_results
   WHERE completion_attempt_id = NEW.completion_attempt_id;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE completion_attempt_id = NEW.completion_attempt_id;

  IF NEW.consumption_kind = 'semantic_contradiction' THEN
    IF result_record.ceremony_intent_id IS NOT NULL
      OR snapshot_record.evidence_ref IS NOT NULL
    THEN
      RAISE EXCEPTION 'semantic contradiction cannot carry terminal namespace authority';
    END IF;
    RETURN NULL;
  END IF;

  IF result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id <> NEW.namespace_session_id
    OR result_record.callback_idempotency_key <> NEW.idempotency_key
    OR result_record.callback_request_hash <> NEW.completion_request_hash
    OR (
      NEW.consumption_kind = 'verified'
      AND (
        result_record.outcome_status <> 'satisfied'
        OR snapshot_record.evidence_ref IS NULL
        OR snapshot_record.evidence_ref <> NEW.evidence_ref
        OR snapshot_record.namespace_session_id <> NEW.namespace_session_id
      )
    )
    OR (
      NEW.consumption_kind = 'rejected'
      AND (
        result_record.outcome_status <> 'failed'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
    OR (
      NEW.consumption_kind = 'expired'
      AND (
        result_record.outcome_status <> 'expired'
        OR snapshot_record.evidence_ref IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'consumed namespace attempt lacks its matching terminal authority';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_evidence_snapshot_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  attempt_record namespace_ownership_completion_attempts%ROWTYPE;
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
BEGIN
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR SHARE;
  SELECT * INTO session_record
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
     AND actor_id = NEW.actor_id
   FOR SHARE;
  SELECT * INTO attempt_record
    FROM namespace_ownership_completion_attempts
   WHERE completion_attempt_id = NEW.completion_attempt_id
   FOR UPDATE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR attempt_record.completion_attempt_id IS NULL
    OR session_record.status <> 'pending'
    OR attempt_record.state <> 'consumed'
    OR attempt_record.consumption_kind IS DISTINCT FROM 'verified'
    OR attempt_record.lease_expires_at <= attempt_record.updated_at
    OR session_record.expires_at <= attempt_record.updated_at
    OR attempt_record.namespace_session_id <> NEW.namespace_session_id
    OR attempt_record.actor_id <> NEW.actor_id
    OR attempt_record.evidence_ref <> NEW.evidence_ref
    OR attempt_record.fence_token <> NEW.fence_token
    OR attempt_record.submission_channel <> 'poll_result'
    OR session_record.creation_intent_id <> NEW.creation_intent_id
    OR session_record.ceremony_intent_id <> NEW.ceremony_intent_id
    OR session_record.requirement_kind <> NEW.requirement_kind
    OR session_record.generation <> NEW.generation
    OR session_record.requirement_hash <> NEW.requirement_hash
    OR session_record.request_hash <> NEW.request_hash
    OR session_record.provider_id <> NEW.provider_id
    OR session_record.provider_binding_hash <> NEW.provider_binding_hash
    OR session_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR session_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR session_record.provider_configuration_version <> NEW.provider_configuration_version
    OR session_record.protocol_version <> NEW.protocol_version
    OR session_record.environment <> NEW.environment
    OR session_record.route_family <> NEW.family
    OR session_record.route_root_label <> NEW.root_label
    OR session_record.route_root_label_display <> NEW.root_label_display
    OR session_record.route_path_segment <> NEW.path_segment
    OR session_record.route_href <> NEW.href
    OR session_record.route_app_host IS DISTINCT FROM NEW.app_host
    OR session_record.upstream_session_ref <> NEW.upstream_session_ref
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot does not match its consumed verified fence';
  END IF;

  IF NEW.observed_at > clock_timestamp()
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at <= NEW.observed_at
  THEN
    RAISE EXCEPTION 'namespace ownership evidence snapshot timestamps are not live';
  END IF;

  IF NOT (
    (
      NEW.ownership_source = 'hns_parent_chain_txt'
      AND NEW.challenge_name = NEW.root_label
    )
    OR (
      NEW.ownership_source = 'owner_authoritative_dns_txt'
      AND NEW.challenge_name = '_pirate.' || NEW.root_label
    )
  ) THEN
    RAISE EXCEPTION 'namespace ownership evidence challenge is not bound to its route';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_session_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  intent_record community_creation_intents%ROWTYPE;
  state_record community_creation_requirement_states%ROWTYPE;
  ceremony_record community_creation_ceremony_attempts%ROWTYPE;
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
BEGIN
  -- Lock order: actor -> intent -> requirement state -> start reservation -> session.
  PERFORM 1 FROM users WHERE user_id = NEW.actor_id FOR SHARE;
  SELECT * INTO intent_record
    FROM community_creation_intents
   WHERE actor_id = NEW.actor_id AND intent_id = NEW.creation_intent_id
   FOR SHARE;
  SELECT * INTO state_record
    FROM community_creation_requirement_states
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = 'namespace_ownership'
   FOR UPDATE;
  SELECT * INTO ceremony_record
    FROM community_creation_ceremony_attempts
   WHERE actor_id = NEW.actor_id
     AND intent_id = NEW.creation_intent_id
     AND requirement_kind = NEW.requirement_kind
     AND generation = NEW.generation
     AND ceremony_intent_id = NEW.ceremony_intent_id
   FOR SHARE;
  SELECT * INTO reservation_record
    FROM namespace_ownership_start_reservations
   WHERE reservation_id = NEW.start_reservation_id
     AND fence_token = NEW.start_fence_token
   FOR SHARE;

  IF intent_record.intent_id IS NULL
    OR state_record.intent_id IS NULL
    OR ceremony_record.ceremony_intent_id IS NULL
    OR state_record.status <> 'pending'
    OR intent_record.revision <> NEW.expected_revision
    OR state_record.current_ceremony_intent_id <> NEW.ceremony_intent_id
    OR state_record.generation <> NEW.generation
    OR state_record.requirement_hash <> NEW.requirement_hash
    OR state_record.provider_id <> NEW.provider_id
    OR state_record.provider_binding_hash <> NEW.provider_binding_hash
    OR state_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR state_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR state_record.provider_configuration_version <> NEW.provider_configuration_version
    OR NEW.status <> 'pending'
    OR NEW.expires_at <= clock_timestamp()
    OR ceremony_record.provider_id <> NEW.provider_id
    OR ceremony_record.provider_binding_hash <> NEW.provider_binding_hash
    OR ceremony_record.provider_configuration_kind <> NEW.provider_configuration_kind
    OR ceremony_record.provider_configuration_ref <> NEW.provider_configuration_ref
    OR ceremony_record.provider_configuration_version <> NEW.provider_configuration_version
    OR ceremony_record.route_family IS DISTINCT FROM NEW.route_family
    OR ceremony_record.route_root_label IS DISTINCT FROM NEW.route_root_label
    OR ceremony_record.route_root_label_display IS DISTINCT FROM NEW.route_root_label_display
    OR ceremony_record.route_path_segment IS DISTINCT FROM NEW.route_path_segment
    OR (
      reservation_record.reservation_id IS NOT NULL
      AND (
        reservation_record.namespace_session_id <> NEW.namespace_session_id
        OR reservation_record.actor_id <> NEW.actor_id
        OR reservation_record.creation_intent_id <> NEW.creation_intent_id
        OR reservation_record.ceremony_intent_id <> NEW.ceremony_intent_id
        OR reservation_record.requirement_kind <> NEW.requirement_kind
        OR reservation_record.generation <> NEW.generation
        OR reservation_record.expected_revision <> NEW.expected_revision
        OR reservation_record.requirement_hash <> NEW.requirement_hash
        OR reservation_record.request_hash <> NEW.request_hash
        OR reservation_record.provider_id <> NEW.provider_id
        OR reservation_record.provider_binding_hash <> NEW.provider_binding_hash
        OR reservation_record.provider_configuration_kind <> NEW.provider_configuration_kind
        OR reservation_record.provider_configuration_ref <> NEW.provider_configuration_ref
        OR reservation_record.provider_configuration_version <> NEW.provider_configuration_version
        OR reservation_record.protocol_version <> NEW.protocol_version
        OR reservation_record.environment <> NEW.environment
        OR reservation_record.route_family <> NEW.route_family
        OR reservation_record.route_root_label <> NEW.route_root_label
        OR reservation_record.route_root_label_display <> NEW.route_root_label_display
        OR reservation_record.route_path_segment <> NEW.route_path_segment
        OR reservation_record.route_href <> NEW.route_href
        OR reservation_record.route_app_host IS DISTINCT FROM NEW.route_app_host
        OR reservation_record.state NOT IN ('acquired', 'finalized')
        OR reservation_record.lease_expires_at > NEW.expires_at
      )
    ) THEN
    RAISE EXCEPTION 'namespace ownership session does not match its creation ceremony';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_start_coherence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  reservation_record namespace_ownership_start_reservations%ROWTYPE;
  session_record namespace_ownership_sessions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_start_reservations' THEN
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = NEW.reservation_id;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = reservation_record.namespace_session_id
       AND actor_id = reservation_record.actor_id;
    IF session_record.namespace_session_id IS NULL THEN
      IF reservation_record.state IN ('acquired', 'released') THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'finalized namespace ownership start requires its session';
    END IF;
  ELSE
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO reservation_record
      FROM namespace_ownership_start_reservations
     WHERE reservation_id = session_record.start_reservation_id
       AND fence_token = session_record.start_fence_token;
  END IF;

  IF reservation_record.reservation_id IS NULL
    OR session_record.namespace_session_id IS NULL
    OR reservation_record.state <> 'finalized'
    OR reservation_record.namespace_session_id <> session_record.namespace_session_id
    OR reservation_record.actor_id <> session_record.actor_id
    OR reservation_record.creation_intent_id <> session_record.creation_intent_id
    OR reservation_record.ceremony_intent_id <> session_record.ceremony_intent_id
    OR reservation_record.requirement_kind <> session_record.requirement_kind
    OR reservation_record.generation <> session_record.generation
    OR reservation_record.expected_revision <> session_record.expected_revision
    OR reservation_record.requirement_hash <> session_record.requirement_hash
    OR reservation_record.request_hash <> session_record.request_hash
    OR reservation_record.provider_id <> session_record.provider_id
    OR reservation_record.provider_binding_hash <> session_record.provider_binding_hash
    OR reservation_record.provider_configuration_kind <> session_record.provider_configuration_kind
    OR reservation_record.provider_configuration_ref <> session_record.provider_configuration_ref
    OR reservation_record.provider_configuration_version <> session_record.provider_configuration_version
    OR reservation_record.protocol_version <> session_record.protocol_version
    OR reservation_record.environment <> session_record.environment
    OR reservation_record.route_family <> session_record.route_family
    OR reservation_record.route_root_label <> session_record.route_root_label
    OR reservation_record.route_root_label_display <> session_record.route_root_label_display
    OR reservation_record.route_path_segment <> session_record.route_path_segment
    OR reservation_record.route_href <> session_record.route_href
    OR reservation_record.route_app_host IS DISTINCT FROM session_record.route_app_host
    OR reservation_record.lease_expires_at > session_record.expires_at
  THEN
    RAISE EXCEPTION 'namespace ownership start reservation/session coherence is incomplete';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_namespace_ownership_terminal_coherence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_record namespace_ownership_sessions%ROWTYPE;
  result_record community_creation_ceremony_results%ROWTYPE;
  attempt_record community_creation_ceremony_attempts%ROWTYPE;
  completion_record namespace_ownership_completion_attempts%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  route_record community_route_ownership_evidence%ROWTYPE;
  coherence_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'namespace_ownership_sessions' THEN
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = NEW.namespace_session_id;
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE namespace_session_id = session_record.namespace_session_id;
  ELSE
    SELECT * INTO result_record
      FROM community_creation_ceremony_results
     WHERE ceremony_intent_id = NEW.ceremony_intent_id;
    IF result_record.namespace_session_id IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO session_record
      FROM namespace_ownership_sessions
     WHERE namespace_session_id = result_record.namespace_session_id;
  END IF;

  IF session_record.status = 'pending' THEN
    IF result_record.ceremony_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'pending namespace ownership session cannot have a ceremony result';
    END IF;
    RETURN NULL;
  END IF;

  IF session_record.namespace_session_id IS NULL
    OR result_record.ceremony_intent_id IS NULL
    OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
    OR (
      session_record.status = 'completed'
      AND result_record.outcome_status IS DISTINCT FROM 'satisfied'
    )
    OR (
      session_record.status IN ('failed', 'expired')
      AND result_record.outcome_status IS DISTINCT FROM session_record.status
    )
  THEN
    RAISE EXCEPTION 'terminal namespace ownership session/result correlation is incomplete';
  END IF;

  IF session_record.status = 'completed' THEN
    SELECT * INTO attempt_record
      FROM community_creation_ceremony_attempts
     WHERE ceremony_intent_id = result_record.ceremony_intent_id;
    SELECT * INTO completion_record
      FROM namespace_ownership_completion_attempts
     WHERE completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO snapshot_record
      FROM namespace_ownership_evidence_snapshots
     WHERE evidence_ref = result_record.evidence_ref
       AND namespace_session_id = result_record.namespace_session_id
       AND completion_attempt_id = result_record.completion_attempt_id;
    SELECT * INTO route_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = result_record.evidence_ref;

    IF attempt_record.ceremony_intent_id IS NULL
      OR completion_record.completion_attempt_id IS NULL
      OR snapshot_record.evidence_ref IS NULL
      OR route_record.evidence_ref IS NULL
      OR result_record.completion_attempt_id IS NULL
      OR result_record.evidence_ref IS NULL
      OR result_record.evidence_digest IS NULL
      OR result_record.provider_identity_digest IS NULL
      OR result_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR result_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR result_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR result_record.generation IS DISTINCT FROM session_record.generation
      OR result_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR result_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR result_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR result_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR attempt_record.intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR attempt_record.requirement_kind IS DISTINCT FROM session_record.requirement_kind
      OR attempt_record.generation IS DISTINCT FROM session_record.generation
      OR attempt_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR attempt_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR attempt_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR attempt_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR attempt_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR attempt_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR attempt_record.route_family IS DISTINCT FROM session_record.route_family
      OR attempt_record.route_root_label IS DISTINCT FROM session_record.route_root_label
      OR attempt_record.route_root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR attempt_record.route_path_segment IS DISTINCT FROM session_record.route_path_segment
      OR completion_record.namespace_session_id IS DISTINCT FROM session_record.namespace_session_id
      OR completion_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR completion_record.state IS DISTINCT FROM 'consumed'
      OR completion_record.consumption_kind IS DISTINCT FROM 'verified'
      OR completion_record.evidence_ref IS DISTINCT FROM result_record.evidence_ref
      OR completion_record.fence_token IS DISTINCT FROM snapshot_record.fence_token
      OR snapshot_record.actor_id IS DISTINCT FROM session_record.actor_id
      OR snapshot_record.creation_intent_id IS DISTINCT FROM session_record.creation_intent_id
      OR snapshot_record.ceremony_intent_id IS DISTINCT FROM session_record.ceremony_intent_id
      OR snapshot_record.generation IS DISTINCT FROM session_record.generation
      OR snapshot_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR snapshot_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR snapshot_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR snapshot_record.provider_configuration_kind IS DISTINCT FROM session_record.provider_configuration_kind
      OR snapshot_record.provider_configuration_ref IS DISTINCT FROM session_record.provider_configuration_ref
      OR snapshot_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR snapshot_record.protocol_version IS DISTINCT FROM session_record.protocol_version
      OR snapshot_record.environment IS DISTINCT FROM session_record.environment
      OR snapshot_record.family IS DISTINCT FROM session_record.route_family
      OR snapshot_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR snapshot_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR snapshot_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR snapshot_record.href IS DISTINCT FROM session_record.route_href
      OR snapshot_record.upstream_session_ref IS DISTINCT FROM session_record.upstream_session_ref
      OR snapshot_record.fence_token IS DISTINCT FROM completion_record.fence_token
      OR snapshot_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR snapshot_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR snapshot_record.observed_at > coherence_at
      OR snapshot_record.expires_at <= coherence_at
      OR route_record.creation_ceremony_intent_id IS DISTINCT FROM result_record.ceremony_intent_id
      OR route_record.verified_by_actor_id IS DISTINCT FROM session_record.actor_id
      OR route_record.family IS DISTINCT FROM session_record.route_family
      OR route_record.root_label IS DISTINCT FROM session_record.route_root_label
      OR route_record.root_label_display IS DISTINCT FROM session_record.route_root_label_display
      OR route_record.path_segment IS DISTINCT FROM session_record.route_path_segment
      OR route_record.requirement_hash IS DISTINCT FROM session_record.requirement_hash
      OR route_record.provider_id IS DISTINCT FROM session_record.provider_id
      OR route_record.provider_binding_hash IS DISTINCT FROM session_record.provider_binding_hash
      OR route_record.provider_configuration_version IS DISTINCT FROM session_record.provider_configuration_version
      OR route_record.provider_identity_digest IS DISTINCT FROM result_record.provider_identity_digest
      OR route_record.evidence_digest IS DISTINCT FROM result_record.evidence_digest
      OR route_record.evidence_receipt_id IS DISTINCT FROM result_record.evidence_receipt_id
      OR route_record.binding_generation IS DISTINCT FROM session_record.generation
      OR route_record.verified_at IS DISTINCT FROM result_record.satisfied_at
      OR (
        route_record.expires_at IS NOT NULL
        AND route_record.expires_at IS DISTINCT FROM snapshot_record.expires_at
      )
    THEN
      RAISE EXCEPTION 'namespace ownership terminal evidence chain is incoherent';
    END IF;
  ELSE
    IF result_record.evidence_ref IS NOT NULL
      OR result_record.evidence_digest IS NOT NULL
      OR result_record.provider_identity_digest IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM namespace_ownership_evidence_snapshots
         WHERE namespace_session_id = session_record.namespace_session_id
      )
      OR EXISTS (
        SELECT 1 FROM community_route_ownership_evidence
         WHERE creation_ceremony_intent_id = result_record.ceremony_intent_id
      )
    THEN
      RAISE EXCEPTION 'failed or expired namespace ownership has no evidence snapshot';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_optional_route_v2_committed_community() RETURNS trigger
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

CREATE FUNCTION validate_route_v1_committed_community() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  snapshot_record namespace_ownership_evidence_snapshots%ROWTYPE;
  expected_family TEXT;
  expected_root TEXT;
  guard_at TIMESTAMPTZ;
  human_evidence_valid BOOLEAN;
BEGIN
  IF NEW.creation_contract_version <> 'route_v1'
    OR NEW.status <> 'committed' THEN
    RETURN NULL;
  END IF;

  expected_family := NEW.draft -> 'route_request' ->> 'family';
  expected_root := NEW.draft -> 'route_request' ->> 'root_label';

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.committed_community_id;
  IF NOT FOUND
    OR community_record.status <> 'active'
    OR community_record.canonical_route_binding_id IS NULL THEN
    RAISE EXCEPTION 'route-v1 committed intent requires an active canonical community binding';
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = community_record.canonical_route_binding_id
     AND community_id = community_record.community_id;
  IF NOT FOUND
    OR binding_record.family IS DISTINCT FROM expected_family
    OR binding_record.root_label IS DISTINCT FROM expected_root
    OR binding_record.ownership_status <> 'verified'
    OR binding_record.route_lifecycle_status <> 'active'
    OR binding_record.verified_evidence_ref IS NULL
    OR NEW.committed_resource_href IS DISTINCT FROM binding_record.href THEN
    RAISE EXCEPTION 'route-v1 committed intent does not match its verified canonical route';
  END IF;

  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  SELECT * INTO snapshot_record
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = binding_record.verified_evidence_ref;
  guard_at := clock_timestamp();
  IF evidence_record.evidence_ref IS NULL
    OR snapshot_record.evidence_ref IS NULL
    OR evidence_record.family IS DISTINCT FROM binding_record.family
    OR evidence_record.root_label IS DISTINCT FROM binding_record.root_label
    OR evidence_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR evidence_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.family IS DISTINCT FROM binding_record.family
    OR snapshot_record.root_label IS DISTINCT FROM binding_record.root_label
    OR snapshot_record.root_label_display IS DISTINCT FROM binding_record.root_label_display
    OR snapshot_record.path_segment IS DISTINCT FROM binding_record.path_segment
    OR snapshot_record.href IS DISTINCT FROM binding_record.href
    OR snapshot_record.expires_at <= guard_at
    OR (evidence_record.expires_at IS NOT NULL AND evidence_record.expires_at <= guard_at)
  THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live canonical route evidence';
  END IF;

  SELECT (
    COUNT(DISTINCT claim.claim_id) = 1
    AND COUNT(DISTINCT receipt.evidence_receipt_id) = 1
    AND COUNT(DISTINCT assertion.assertion_id) = 2
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'human.personhood'
        AND assertion.assertion_value = '{"personhood": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND COUNT(DISTINCT assertion.assertion_id) FILTER (
      WHERE assertion.claim_id = 'credential.subject_unique'
        AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
        AND assertion.assurance = 'provider_attested'
    ) = 1
    AND BOOL_AND(
      claim.community_id = NEW.committed_community_id
      AND claim.verification_requirement_hash = NEW.verification_requirement_hash
      AND receipt.proof_session_id = claim.proof_session_id
      AND receipt.evidence_receipt_id = claim.evidence_receipt_id
      AND receipt.user_id = NEW.actor_id
      AND receipt.subject_key_id = claim.subject_key_id
      AND receipt.evidence_kind = 'very.web.server-verified.v1'
      AND (receipt.expires_at IS NULL OR receipt.expires_at > guard_at)
      AND assertion.user_id = NEW.actor_id
      AND assertion.subject_key_id = claim.subject_key_id
      AND assertion.evidence_receipt_id = claim.evidence_receipt_id
      AND (assertion.expires_at IS NULL OR assertion.expires_at > guard_at)
      AND assertion_binding.user_id = NEW.actor_id
      AND assertion_binding.binding_mode = 'same_subject'
      AND assertion_binding.subject_key_id = claim.subject_key_id
      AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
      AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
      AND active_binding.user_id = NEW.actor_id
      AND active_binding.subject_key_id = claim.subject_key_id
      AND active_binding.binding_event_id = receipt.subject_binding_event_id
      AND active_binding.binding_epoch = receipt.subject_binding_epoch
    )
  ) INTO human_evidence_valid
    FROM community_creation_subject_claims AS claim
    JOIN evidence_receipts AS receipt
      ON receipt.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertions AS assertion
      ON assertion.evidence_receipt_id = claim.evidence_receipt_id
    JOIN assertion_bindings AS assertion_binding
      ON assertion_binding.binding_group_id = assertion.binding_group_id
    JOIN active_subject_key_bindings AS active_binding
      ON active_binding.subject_key_id = claim.subject_key_id
   WHERE claim.intent_id = NEW.intent_id
     AND claim.actor_id = NEW.actor_id;
  IF human_evidence_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'route-v1 committed intent requires live human creation evidence';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_route_v1_creation_requirement_cardinality() RETURNS trigger
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

CREATE FUNCTION validate_text_content_submission_relations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_community_id TEXT;
  target_submission_id TEXT;
  submission text_content_submissions%ROWTYPE;
  held_count INTEGER;
  case_count INTEGER;
  persisted_case text_moderation_cases%ROWTYPE;
BEGIN
  target_community_id := COALESCE(NEW.community_id, OLD.community_id);
  target_submission_id := COALESCE(NEW.submission_id, OLD.submission_id);

  SELECT * INTO submission
    FROM text_content_submissions
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO held_count
    FROM text_content_held_revisions
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  SELECT count(*) INTO case_count
    FROM text_moderation_cases
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;
  SELECT * INTO persisted_case
    FROM text_moderation_cases
   WHERE community_id = target_community_id
     AND submission_id = target_submission_id;

  IF submission.status = 'manual_review' THEN
    IF submission.moderation_decision <> 'manual_review'
      OR held_count <> 1 OR case_count <> 1 OR persisted_case.status <> 'open'
      OR persisted_case.case_id <> submission.review_ref
    THEN
      RAISE EXCEPTION 'manual-review submission requires one matching held revision and open case';
    END IF;
  ELSIF held_count <> case_count OR held_count > 1 THEN
    RAISE EXCEPTION 'historical review evidence must remain paired';
  ELSIF held_count = 0 AND (
    (submission.status = 'published' AND submission.moderation_decision <> 'allow')
    OR (submission.status = 'blocked' AND submission.moderation_decision <> 'blocked')
  ) THEN
    RAISE EXCEPTION 'direct submission result does not match its moderation decision';
  ELSIF held_count = 1 AND submission.moderation_decision <> 'manual_review' THEN
    RAISE EXCEPTION 'reviewed submission must retain its manual-review decision';
  ELSIF held_count = 1 AND (
    (submission.status = 'published' AND persisted_case.status <> 'approved')
    OR (
      submission.status = 'blocked'
      AND persisted_case.status NOT IN ('blocked', 'dismissed')
    )
  ) THEN
    RAISE EXCEPTION 'submission result does not match its moderation case';
  END IF;

  IF submission.status = 'published' AND submission.surface = 'text_post' AND NOT EXISTS (
    SELECT 1
      FROM posts
     WHERE community_id = submission.community_id
       AND post_id = submission.published_post_id
       AND status = 'published'
       AND post_type = 'text'
       AND author_user_id = submission.actor_user_id
  ) THEN
    RAISE EXCEPTION 'published text submission requires its matching published text post';
  END IF;

  IF submission.status = 'published' AND submission.surface = 'text_post' AND NOT EXISTS (
    SELECT 1
      FROM home_feed_projection
     WHERE community_id = submission.community_id
       AND post_id = submission.published_post_id
  ) THEN
    RAISE EXCEPTION 'published text submission requires its atomic home feed projection';
  END IF;

  IF submission.status = 'published' AND submission.surface IN ('comment', 'reply') AND NOT EXISTS (
    SELECT 1
      FROM comments
     WHERE community_id = submission.community_id
       AND comment_id = submission.published_comment_id
       AND status = 'published'
       AND author_user_id = submission.actor_user_id
  ) THEN
    RAISE EXCEPTION 'published comment submission requires its matching published comment';
  END IF;

  RETURN NULL;
END;
$$;

CREATE FUNCTION validate_text_review_child_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  submission_status TEXT;
  submission_review_ref TEXT;
BEGIN
  SELECT status, review_ref
    INTO submission_status, submission_review_ref
    FROM text_content_submissions
   WHERE community_id = NEW.community_id
     AND submission_id = NEW.submission_id
   FOR KEY SHARE;

  IF NOT FOUND OR submission_status <> 'manual_review' THEN
    RAISE EXCEPTION 'review children require a manual-review submission';
  END IF;
  IF TG_TABLE_NAME = 'text_moderation_cases'
    AND (to_jsonb(NEW) ->> 'case_id') <> submission_review_ref
  THEN
    RAISE EXCEPTION 'moderation case must match the submission review reference';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE account_aliases (
    source_user_id text NOT NULL,
    canonical_user_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_aliases_canonical_not_blank CHECK ((btrim(canonical_user_id) <> ''::text)),
    CONSTRAINT account_aliases_kind_check CHECK ((kind = ANY (ARRAY['alias'::text, 'merge'::text]))),
    CONSTRAINT account_aliases_source_not_blank CHECK ((btrim(source_user_id) <> ''::text)),
    CONSTRAINT account_aliases_status_check CHECK ((status = ANY (ARRAY['active'::text, 'finalizing'::text, 'completed'::text, 'inactive'::text])))
);

CREATE TABLE action_challenges (
    action_challenge_id text NOT NULL,
    action_intent_id text NOT NULL,
    provider_id text NOT NULL,
    challenge_hash text NOT NULL,
    challenge_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_challenges_challenge_hash_check CHECK ((challenge_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_challenges_provider_not_blank CHECK ((btrim(provider_id) <> ''::text)),
    CONSTRAINT action_challenges_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'verified'::text, 'expired'::text, 'canceled'::text])))
);

CREATE TABLE action_grants (
    action_grant_id text NOT NULL,
    action_intent_id text NOT NULL,
    action_challenge_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    grant_nonce text NOT NULL,
    signed_grant text NOT NULL,
    signer_key_id text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_grants_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_grants_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(grant_nonce) <> ''::text) AND (btrim(signed_grant) <> ''::text) AND (btrim(signer_key_id) <> ''::text)))
);

CREATE TABLE action_intents (
    action_intent_id text NOT NULL,
    user_id text NOT NULL,
    community_id text,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    intent_binding_hash text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_intents_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_intents_identifiers_not_blank CHECK (((btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(idempotency_key) <> ''::text))),
    CONSTRAINT action_intents_intent_binding_hash_check CHECK ((intent_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT action_intents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'fulfilled'::text, 'expired'::text, 'canceled'::text])))
);

CREATE TABLE active_subject_key_bindings (
    subject_key_id text NOT NULL,
    binding_event_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    user_id text NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT active_subject_key_bindings_binding_epoch_check CHECK ((binding_epoch > 0))
);

CREATE TABLE assertion_bindings (
    binding_group_id text NOT NULL,
    user_id text NOT NULL,
    binding_mode text NOT NULL,
    subject_key_id text,
    evidence_receipt_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_binding_event_id text,
    subject_binding_epoch bigint,
    CONSTRAINT assertion_bindings_anchor_shape_check CHECK ((((binding_mode = 'same_subject'::text) AND (subject_key_id IS NOT NULL) AND (subject_binding_event_id IS NOT NULL) AND (subject_binding_epoch IS NOT NULL) AND (evidence_receipt_id IS NULL)) OR ((binding_mode = 'same_receipt'::text) AND (subject_key_id IS NULL) AND (subject_binding_event_id IS NULL) AND (subject_binding_epoch IS NULL) AND (evidence_receipt_id IS NOT NULL)))),
    CONSTRAINT assertion_bindings_binding_mode_check CHECK ((binding_mode = ANY (ARRAY['same_subject'::text, 'same_receipt'::text])))
);

CREATE TABLE assertion_revalidation_events (
    assertion_revalidation_event_id text NOT NULL,
    assertion_id text NOT NULL,
    user_id text NOT NULL,
    evidence_receipt_id text,
    observation_id text,
    outcome text NOT NULL,
    reason text,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assertion_revalidation_events_outcome_check CHECK ((outcome = ANY (ARRAY['accepted'::text, 'stale'::text, 'revoked'::text, 'indeterminate'::text]))),
    CONSTRAINT assertion_revalidation_source_check CHECK (((evidence_receipt_id IS NOT NULL) OR (observation_id IS NOT NULL)))
);

CREATE TABLE assertions (
    assertion_id text NOT NULL,
    binding_group_id text NOT NULL,
    evidence_receipt_id text NOT NULL,
    subject_key_id text,
    user_id text NOT NULL,
    claim_id text NOT NULL,
    assertion_value jsonb NOT NULL,
    assurance text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assertions_identifiers_not_blank CHECK (((btrim(claim_id) <> ''::text) AND (btrim(assurance) <> ''::text)))
);

CREATE TABLE comment_moderation_actions (
    action_id text NOT NULL,
    community_id text NOT NULL,
    case_ref text NOT NULL,
    actor_user_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    action text NOT NULL,
    target_status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT comment_moderation_actions_action_check CHECK ((action = ANY (ARRAY['approve'::text, 'dismiss'::text, 'hide'::text, 'remove'::text, 'restore'::text]))),
    CONSTRAINT comment_moderation_actions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT comment_moderation_actions_target_status_check CHECK ((target_status = ANY (ARRAY['held'::text, 'published'::text, 'hidden'::text, 'removed'::text])))
);

CREATE TABLE comment_moderation_cases (
    case_ref text NOT NULL,
    community_id text NOT NULL,
    submission_id text NOT NULL,
    comment_id text,
    source text NOT NULL,
    text_case_id text,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by_user_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT comment_moderation_cases_resolution_shape CHECK ((((status = 'open'::text) AND (resolved_by_user_id IS NULL)) OR ((status <> 'open'::text) AND (resolved_by_user_id IS NOT NULL)))),
    CONSTRAINT comment_moderation_cases_source_check CHECK ((source = ANY (ARRAY['automated'::text, 'report'::text]))),
    CONSTRAINT comment_moderation_cases_source_shape CHECK ((((source = 'automated'::text) AND (comment_id IS NULL) AND (text_case_id = case_ref)) OR ((source = 'report'::text) AND (comment_id IS NOT NULL) AND (text_case_id IS NULL)))),
    CONSTRAINT comment_moderation_cases_status_check CHECK ((status = ANY (ARRAY['open'::text, 'approved'::text, 'dismissed'::text, 'blocked'::text]))),
    CONSTRAINT comment_moderation_cases_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE comment_publication_projection (
    community_id text NOT NULL,
    comment_id text NOT NULL,
    post_id text NOT NULL,
    parent_comment_id text,
    author_user_id text NOT NULL,
    body text NOT NULL,
    depth integer NOT NULL,
    status text NOT NULL,
    projected_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT comment_publication_projection_depth_check CHECK (((depth >= 0) AND (depth <= 8))),
    CONSTRAINT comment_publication_projection_status_check CHECK ((status = ANY (ARRAY['published'::text, 'hidden'::text, 'removed'::text])))
);

CREATE TABLE comment_reports (
    report_id text NOT NULL,
    community_id text NOT NULL,
    comment_id text NOT NULL,
    case_ref text NOT NULL,
    reporter_user_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT comment_reports_reason_code_check CHECK ((reason_code = ANY (ARRAY['spam'::text, 'harassment'::text, 'hate'::text, 'sexual_content'::text, 'graphic_content'::text, 'misleading'::text, 'other'::text]))),
    CONSTRAINT comment_reports_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT comment_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'coalesced'::text])))
);

CREATE TABLE comments (
    community_id text NOT NULL,
    comment_id text NOT NULL,
    post_id text NOT NULL,
    parent_comment_id text,
    author_user_id text,
    status text DEFAULT 'published'::text NOT NULL,
    body text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    idempotency_key text DEFAULT ''::text NOT NULL,
    idempotency_body_hash text,
    depth integer DEFAULT 0 NOT NULL,
    reply_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT comments_depth_check CHECK ((depth >= 0)),
    CONSTRAINT comments_not_self_parent CHECK (((parent_comment_id IS NULL) OR (parent_comment_id <> comment_id))),
    CONSTRAINT comments_reply_count_nonnegative CHECK ((reply_count >= 0)),
    CONSTRAINT comments_status_check CHECK ((status = ANY (ARRAY['published'::text, 'hidden'::text, 'removed'::text, 'deleted'::text])))
);

CREATE TABLE communities (
    community_id text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_user_id text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    membership_mode text DEFAULT 'open'::text NOT NULL,
    human_verification_lane text,
    route_slug text,
    description text,
    canonical_route_binding_id text,
    route_authority_version text DEFAULT 'legacy_slug_v1'::text NOT NULL,
    CONSTRAINT communities_human_verification_lane_check CHECK (((human_verification_lane IS NULL) OR (human_verification_lane = ANY (ARRAY['very'::text, 'self'::text])))),
    CONSTRAINT communities_id_not_blank CHECK ((btrim(community_id) <> ''::text)),
    CONSTRAINT communities_membership_mode_check CHECK ((membership_mode = ANY (ARRAY['open'::text, 'request'::text, 'gated'::text]))),
    CONSTRAINT communities_optional_route_v2_identity_shape CHECK (((route_authority_version <> 'optional_route_v2'::text) OR ((community_id ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (route_slug IS NULL)))),
    CONSTRAINT communities_route_authority_binding_shape CHECK (((route_authority_version <> 'route_v1'::text) OR (status <> 'active'::text) OR (canonical_route_binding_id IS NOT NULL))),
    CONSTRAINT communities_route_authority_version_check CHECK ((route_authority_version = ANY (ARRAY['legacy_slug_v1'::text, 'route_v1'::text, 'optional_route_v2'::text]))),
    CONSTRAINT communities_route_slug_format_check CHECK (((route_slug IS NULL) OR (route_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text))),
    CONSTRAINT communities_route_slug_length_check CHECK (((route_slug IS NULL) OR (char_length(route_slug) <= 256))),
    CONSTRAINT communities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'hidden'::text, 'archived'::text])))
);

CREATE TABLE community_canonical_route_bindings (
    route_binding_id text NOT NULL,
    community_id text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text GENERATED ALWAYS AS (
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END) STORED,
    href text GENERATED ALWAYS AS (('/c/'::text ||
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END)) STORED,
    ownership_status text NOT NULL,
    route_lifecycle_status text DEFAULT 'suspended'::text NOT NULL,
    binding_generation bigint DEFAULT 1 NOT NULL,
    verified_evidence_ref text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_canonical_route_bindings_active_shape CHECK (((route_lifecycle_status <> 'active'::text) OR ((ownership_status = 'verified'::text) AND (verified_evidence_ref IS NOT NULL)))),
    CONSTRAINT community_canonical_route_bindings_binding_generation_check CHECK ((binding_generation > 0)),
    CONSTRAINT community_canonical_route_bindings_family_check CHECK ((family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_canonical_route_bindings_id_not_blank CHECK (((btrim(route_binding_id) <> ''::text) AND (route_binding_id = btrim(route_binding_id)))),
    CONSTRAINT community_canonical_route_bindings_ownership_status_check CHECK ((ownership_status = ANY (ARRAY['pending'::text, 'verified'::text, 'expired'::text, 'disputed'::text, 'revoked'::text]))),
    CONSTRAINT community_canonical_route_bindings_root_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE))),
    CONSTRAINT community_canonical_route_bindings_route_lifecycle_status_check CHECK ((route_lifecycle_status = ANY (ARRAY['active'::text, 'suspended'::text]))),
    CONSTRAINT community_canonical_route_bindings_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE community_commerce_allocation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    allocation_mode text DEFAULT 'single_unit'::text NOT NULL,
    CONSTRAINT community_commerce_allocation_mode_check CHECK ((allocation_mode = 'single_unit'::text))
);

CREATE TABLE community_commerce_donation_partners (
    partner_id text NOT NULL,
    community_id text NOT NULL,
    name text NOT NULL,
    destination_address text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT community_commerce_donation_partner_check CHECK (((btrim(partner_id) <> ''::text) AND (btrim(name) <> ''::text) AND (destination_address ~ '^0x[0-9a-f]{40}$'::text)))
);

CREATE TABLE community_commerce_donation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    policy_mode text NOT NULL,
    partner_id text,
    share_bps integer DEFAULT 0 NOT NULL,
    CONSTRAINT community_commerce_donation_mode_check CHECK ((policy_mode = ANY (ARRAY['none'::text, 'partner_share'::text]))),
    CONSTRAINT community_commerce_donation_partner_check CHECK ((((policy_mode = 'none'::text) AND (partner_id IS NULL) AND (share_bps = 0)) OR ((policy_mode = 'partner_share'::text) AND (partner_id IS NOT NULL) AND (share_bps > 0)))),
    CONSTRAINT community_commerce_donation_share_check CHECK (((share_bps >= 0) AND (share_bps <= 10000)))
);

CREATE TABLE community_commerce_eligibility_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    verification_required boolean DEFAULT false NOT NULL
);

CREATE TABLE community_commerce_listings (
    listing_id text NOT NULL,
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    active boolean DEFAULT true NOT NULL,
    availability_mode text NOT NULL,
    available_quantity integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_commerce_listing_id_check CHECK ((btrim(listing_id) <> ''::text)),
    CONSTRAINT community_commerce_listing_mode_check CHECK ((availability_mode = ANY (ARRAY['unbounded'::text, 'finite'::text]))),
    CONSTRAINT community_commerce_listing_quantity_check CHECK ((((availability_mode = 'unbounded'::text) AND (available_quantity IS NULL)) OR ((availability_mode = 'finite'::text) AND (available_quantity >= 0))))
);

CREATE TABLE community_commerce_money_route_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    required_confirmations integer NOT NULL,
    CONSTRAINT community_commerce_route_chain_check CHECK ((chain_id > 0)),
    CONSTRAINT community_commerce_route_confirmations_check CHECK ((required_confirmations > 0)),
    CONSTRAINT community_commerce_route_token_check CHECK (((token_contract ~ '^0x[0-9a-f]{40}$'::text) AND (token_decimals = 6))),
    CONSTRAINT community_commerce_route_treasury_check CHECK ((treasury_address ~ '^0x[0-9a-f]{40}$'::text))
);

CREATE TABLE community_commerce_operator_ledger (
    event_id text NOT NULL,
    operator_id text NOT NULL,
    event_kind text NOT NULL,
    target_identity text NOT NULL,
    reason text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT community_commerce_operator_event_check CHECK (((event_kind = ANY (ARRAY['policy_issued'::text, 'correction'::text])) AND (btrim(target_identity) <> ''::text) AND (btrim(reason) <> ''::text)))
);

CREATE TABLE community_commerce_policy_revisions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    source_revision text NOT NULL,
    issued_by text NOT NULL,
    effective_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    superseded_at timestamp with time zone,
    CONSTRAINT community_commerce_policy_revision_check CHECK (((policy_version > 0) AND (btrim(source_revision) <> ''::text)))
);

CREATE TABLE community_commerce_pricing_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    amount_atomic numeric(78,0) NOT NULL,
    CONSTRAINT community_commerce_pricing_amount_check CHECK ((amount_atomic > (0)::numeric))
);

CREATE TABLE community_commerce_settlement_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    settlement_mode text NOT NULL,
    CONSTRAINT community_commerce_settlement_mode_check CHECK ((settlement_mode = ANY (ARRAY['delivery_only_story_settlement'::text, 'royalty_native_story_payment'::text])))
);

CREATE TABLE community_creation_ceremony_attempts (
    ceremony_intent_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    requirement_kind text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    route_family text,
    route_root_label text,
    route_root_label_display text,
    route_path_segment text,
    reservation_request_hash text NOT NULL,
    reservation_request jsonb NOT NULL,
    reserved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_creation_ceremony_a_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_creation_ceremony_atte_reservation_request_hash_check CHECK ((reservation_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_attempt_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_attempts_generation_check CHECK ((generation > 0)),
    CONSTRAINT community_creation_ceremony_attempts_identifiers_not_blank CHECK (((btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT community_creation_ceremony_attempts_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_attempts_requirement_kind_check CHECK ((requirement_kind = ANY (ARRAY['human_identity'::text, 'namespace_ownership'::text]))),
    CONSTRAINT community_creation_ceremony_attempts_reservation_request_check CHECK ((jsonb_typeof(reservation_request) = 'object'::text)),
    CONSTRAINT community_creation_ceremony_attempts_route_family_check CHECK ((route_family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_creation_ceremony_attempts_route_shape CHECK ((((requirement_kind = 'human_identity'::text) AND (route_family IS NULL) AND (route_root_label IS NULL) AND (route_root_label_display IS NULL) AND (route_path_segment IS NULL)) OR ((requirement_kind = 'namespace_ownership'::text) AND (route_family IS NOT NULL) AND (route_root_label IS NOT NULL) AND (route_root_label_display IS NOT NULL) AND (route_path_segment IS NOT NULL) AND (is_community_route_root_label(route_family, route_root_label) IS TRUE) AND (is_community_route_root_label_display(route_root_label_display) IS TRUE) AND (route_path_segment =
CASE route_family
    WHEN 'hns'::text THEN ('app.'::text || route_root_label)
    WHEN 'spaces'::text THEN ('@'::text || route_root_label)
    ELSE NULL::text
END)))),
    CONSTRAINT community_creation_ceremony_attempts_time_order CHECK (((expires_at > reserved_at) AND (created_at >= reserved_at)))
);

CREATE TABLE community_creation_ceremony_results (
    ceremony_intent_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    requirement_kind text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_version text NOT NULL,
    callback_idempotency_key text NOT NULL,
    callback_request_hash text NOT NULL,
    outcome_status text NOT NULL,
    result_hash text NOT NULL,
    proof_session_id text,
    evidence_receipt_id text,
    evidence_ref text,
    evidence_digest text,
    provider_identity_digest text,
    terminal_at timestamp with time zone NOT NULL,
    satisfied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    namespace_session_id text,
    completion_attempt_id text,
    submission_channel text,
    CONSTRAINT community_creation_ceremony_resu_provider_identity_digest_check CHECK (((provider_identity_digest IS NULL) OR (provider_identity_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT community_creation_ceremony_results_callback_request_hash_check CHECK ((callback_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_results_evidence_digest_check CHECK (((evidence_digest IS NULL) OR (evidence_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT community_creation_ceremony_results_generation_check CHECK ((generation > 0)),
    CONSTRAINT community_creation_ceremony_results_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(callback_idempotency_key) <> ''::text) AND (callback_idempotency_key = btrim(callback_idempotency_key)) AND ((evidence_ref IS NULL) OR ((btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)))))),
    CONSTRAINT community_creation_ceremony_results_outcome_shape CHECK ((((outcome_status = 'satisfied'::text) AND (evidence_ref IS NOT NULL) AND (evidence_digest IS NOT NULL) AND (provider_identity_digest IS NOT NULL) AND (satisfied_at IS NOT NULL) AND (((requirement_kind = 'human_identity'::text) AND (proof_session_id IS NOT NULL) AND (namespace_session_id IS NULL) AND (completion_attempt_id IS NULL) AND (submission_channel IS NULL)) OR ((requirement_kind = 'namespace_ownership'::text) AND (proof_session_id IS NULL) AND (namespace_session_id IS NOT NULL) AND (completion_attempt_id IS NOT NULL) AND (submission_channel = 'poll_result'::text) AND (evidence_receipt_id IS NULL)))) OR ((outcome_status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (proof_session_id IS NULL) AND (evidence_receipt_id IS NULL) AND (evidence_ref IS NULL) AND (evidence_digest IS NULL) AND (provider_identity_digest IS NULL) AND (satisfied_at IS NULL) AND (((requirement_kind = 'human_identity'::text) AND (namespace_session_id IS NULL) AND (completion_attempt_id IS NULL) AND (submission_channel IS NULL)) OR ((requirement_kind = 'namespace_ownership'::text) AND (namespace_session_id IS NOT NULL) AND (submission_channel = 'poll_result'::text) AND ((completion_attempt_id IS NOT NULL) OR (outcome_status = 'expired'::text))))))),
    CONSTRAINT community_creation_ceremony_results_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['satisfied'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT community_creation_ceremony_results_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_results_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_results_requirement_kind_check CHECK ((requirement_kind = ANY (ARRAY['human_identity'::text, 'namespace_ownership'::text]))),
    CONSTRAINT community_creation_ceremony_results_result_hash_check CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_ceremony_results_submission_channel_check CHECK (((submission_channel IS NULL) OR (submission_channel = 'poll_result'::text))),
    CONSTRAINT community_creation_ceremony_results_time_order CHECK (((created_at >= terminal_at) AND ((satisfied_at IS NULL) OR (satisfied_at = terminal_at))))
);

CREATE TABLE community_creation_intent_revisions (
    intent_id text NOT NULL,
    revision integer NOT NULL,
    actor_id text NOT NULL,
    operation_kind text NOT NULL,
    idempotency_key text,
    request_hash text NOT NULL,
    status text NOT NULL,
    state_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_creation_intent_revisions_idempotency_shape CHECK ((((operation_kind = ANY (ARRAY['create'::text, 'update'::text, 'commit'::text])) AND (idempotency_key IS NOT NULL) AND (btrim(idempotency_key) <> ''::text) AND (idempotency_key = btrim(idempotency_key))) OR ((operation_kind <> ALL (ARRAY['create'::text, 'update'::text, 'commit'::text])) AND (idempotency_key IS NULL)))),
    CONSTRAINT community_creation_intent_revisions_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['create'::text, 'update'::text, 'preflight'::text, 'verification'::text, 'commit'::text, 'expire'::text, 'cancel'::text]))),
    CONSTRAINT community_creation_intent_revisions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_intent_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT community_creation_intent_revisions_state_snapshot_check CHECK ((jsonb_typeof(state_snapshot) = 'object'::text)),
    CONSTRAINT community_creation_intent_revisions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'verification_required'::text, 'commit_ready'::text, 'committed'::text, 'quota_exceeded'::text, 'gate_unsupported'::text, 'expired'::text, 'cancelled'::text])))
);

CREATE TABLE community_creation_intents (
    intent_id text NOT NULL,
    actor_id text NOT NULL,
    create_idempotency_key text NOT NULL,
    create_request_hash text NOT NULL,
    revision integer NOT NULL,
    status text NOT NULL,
    draft jsonb NOT NULL,
    canonical_policy_revision integer NOT NULL,
    canonical_policy_hash text NOT NULL,
    verification_requirement_hash text NOT NULL,
    verification_provider_id text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    committed_community_id text,
    committed_resource_href text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    creation_contract_version text DEFAULT 'legacy_slug_v1'::text NOT NULL,
    CONSTRAINT community_creation_intents_canonical_policy_hash_check CHECK ((canonical_policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_intents_canonical_policy_revision_check CHECK ((canonical_policy_revision > 0)),
    CONSTRAINT community_creation_intents_committed_shape CHECK ((((status = 'committed'::text) AND (committed_community_id IS NOT NULL) AND (committed_resource_href IS NOT NULL) AND (committed_resource_href ~~ '/%'::text)) OR ((status <> 'committed'::text) AND (committed_community_id IS NULL) AND (committed_resource_href IS NULL)))),
    CONSTRAINT community_creation_intents_create_request_hash_check CHECK ((create_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_intents_creation_contract_version_check CHECK ((creation_contract_version = ANY (ARRAY['legacy_slug_v1'::text, 'route_v1'::text, 'optional_route_v2'::text]))),
    CONSTRAINT community_creation_intents_draft_check CHECK ((jsonb_typeof(draft) = 'object'::text)),
    CONSTRAINT community_creation_intents_identifiers_not_blank CHECK (((btrim(intent_id) <> ''::text) AND (intent_id = btrim(intent_id)) AND (btrim(actor_id) <> ''::text) AND (actor_id = btrim(actor_id)) AND (btrim(create_idempotency_key) <> ''::text) AND (create_idempotency_key = btrim(create_idempotency_key)) AND (btrim(verification_provider_id) <> ''::text) AND (verification_provider_id = btrim(verification_provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT community_creation_intents_optional_route_v2_committed_shape CHECK (((creation_contract_version <> 'optional_route_v2'::text) OR (status <> 'committed'::text) OR ((committed_community_id ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (committed_resource_href = ('/c/'::text || committed_community_id))))),
    CONSTRAINT community_creation_intents_optional_route_v2_draft_shape CHECK (((creation_contract_version <> 'optional_route_v2'::text) OR ((jsonb_typeof(draft) = 'object'::text) AND (draft ? 'name'::text) AND (draft ? 'description'::text) AND (draft ? 'policy'::text) AND ((((draft - 'name'::text) - 'description'::text) - 'policy'::text) = '{}'::jsonb) AND (jsonb_typeof((draft -> 'name'::text)) = 'string'::text) AND (btrim((draft ->> 'name'::text)) <> ''::text) AND (jsonb_typeof((draft -> 'description'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((draft -> 'policy'::text)) = 'object'::text) AND (NOT (draft ? 'slug'::text)) AND (NOT (draft ? 'route_request'::text))))),
    CONSTRAINT community_creation_intents_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_creation_intents_revision_check CHECK ((revision > 0)),
    CONSTRAINT community_creation_intents_route_v1_committed_href CHECK (((creation_contract_version <> 'route_v1'::text) OR (status <> 'committed'::text) OR (committed_resource_href ~~ '/c/%'::text))),
    CONSTRAINT community_creation_intents_route_v1_draft_shape CHECK (((creation_contract_version <> 'route_v1'::text) OR ((NOT (draft ? 'slug'::text)) AND (jsonb_typeof((draft -> 'route_request'::text)) = 'object'::text) AND ((draft -> 'route_request'::text) ? 'family'::text) AND ((draft -> 'route_request'::text) ? 'root_label'::text) AND ((((draft -> 'route_request'::text) - 'family'::text) - 'root_label'::text) = '{}'::jsonb) AND (((draft -> 'route_request'::text) ->> 'family'::text) = ANY (ARRAY['hns'::text, 'spaces'::text])) AND (is_community_route_root_label(((draft -> 'route_request'::text) ->> 'family'::text), ((draft -> 'route_request'::text) ->> 'root_label'::text)) IS TRUE)))),
    CONSTRAINT community_creation_intents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'verification_required'::text, 'commit_ready'::text, 'committed'::text, 'quota_exceeded'::text, 'gate_unsupported'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT community_creation_intents_verification_requirement_hash_check CHECK ((verification_requirement_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE community_creation_quota_approvals (
    approval_id text NOT NULL,
    subject_key_id text NOT NULL,
    actor_id text NOT NULL,
    slot_number integer NOT NULL,
    approved_by_user_id text NOT NULL,
    reason text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_creation_quota_approvals_not_blank CHECK (((btrim(approval_id) <> ''::text) AND (approval_id = btrim(approval_id)) AND (btrim(reason) <> ''::text) AND (reason = btrim(reason)))),
    CONSTRAINT community_creation_quota_approvals_slot_number_check CHECK ((slot_number > 1))
);

CREATE TABLE community_creation_requirement_states (
    intent_id text NOT NULL,
    actor_id text NOT NULL,
    requirement_kind text NOT NULL,
    status text NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    route_family text,
    route_root_label text,
    route_root_label_display text,
    route_path_segment text,
    generation bigint DEFAULT 0 NOT NULL,
    current_ceremony_intent_id text,
    satisfied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_creation_requiremen_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_creation_requirement_stat_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_requirement_states_generation_check CHECK ((generation >= 0)),
    CONSTRAINT community_creation_requirement_states_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT community_creation_requirement_states_progress_shape CHECK ((((status = 'unmet'::text) AND (current_ceremony_intent_id IS NULL) AND (satisfied_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'failed'::text, 'expired'::text])) AND (generation > 0) AND (current_ceremony_intent_id IS NOT NULL) AND (btrim(current_ceremony_intent_id) <> ''::text) AND (current_ceremony_intent_id = btrim(current_ceremony_intent_id)) AND (satisfied_at IS NULL)) OR ((status = 'satisfied'::text) AND (generation > 0) AND (current_ceremony_intent_id IS NOT NULL) AND (btrim(current_ceremony_intent_id) <> ''::text) AND (current_ceremony_intent_id = btrim(current_ceremony_intent_id)) AND (satisfied_at IS NOT NULL)))),
    CONSTRAINT community_creation_requirement_states_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_requirement_states_requirement_kind_check CHECK ((requirement_kind = ANY (ARRAY['human_identity'::text, 'namespace_ownership'::text]))),
    CONSTRAINT community_creation_requirement_states_route_family_check CHECK ((route_family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_creation_requirement_states_route_shape CHECK ((((requirement_kind = 'human_identity'::text) AND (route_family IS NULL) AND (route_root_label IS NULL) AND (route_root_label_display IS NULL) AND (route_path_segment IS NULL)) OR ((requirement_kind = 'namespace_ownership'::text) AND (route_family IS NOT NULL) AND (route_root_label IS NOT NULL) AND (route_root_label_display IS NOT NULL) AND (route_path_segment IS NOT NULL) AND (is_community_route_root_label(route_family, route_root_label) IS TRUE) AND (is_community_route_root_label_display(route_root_label_display) IS TRUE) AND (route_path_segment =
CASE route_family
    WHEN 'hns'::text THEN ('app.'::text || route_root_label)
    WHEN 'spaces'::text THEN ('@'::text || route_root_label)
    ELSE NULL::text
END)))),
    CONSTRAINT community_creation_requirement_states_status_check CHECK ((status = ANY (ARRAY['unmet'::text, 'pending'::text, 'satisfied'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT community_creation_requirement_states_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE community_creation_subject_claims (
    claim_id text NOT NULL,
    subject_key_id text NOT NULL,
    actor_id text NOT NULL,
    slot_number integer NOT NULL,
    approval_id text,
    intent_id text NOT NULL,
    community_id text NOT NULL,
    proof_session_id text NOT NULL,
    evidence_receipt_id text NOT NULL,
    verification_requirement_hash text NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_creation_subject_c_verification_requirement_has_check CHECK ((verification_requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_creation_subject_claims_not_blank CHECK (((btrim(claim_id) <> ''::text) AND (claim_id = btrim(claim_id)))),
    CONSTRAINT community_creation_subject_claims_slot_number_check CHECK ((slot_number > 0)),
    CONSTRAINT community_creation_subject_claims_slot_shape CHECK ((((slot_number = 1) AND (approval_id IS NULL)) OR ((slot_number > 1) AND (approval_id IS NOT NULL))))
);

CREATE TABLE community_feed_projection (
    community_id text NOT NULL,
    post_id text NOT NULL,
    rank_score double precision DEFAULT 0 NOT NULL,
    projected_at timestamp with time zone NOT NULL
);

CREATE TABLE community_follows (
    community_follow_id text NOT NULL,
    community_id text NOT NULL,
    user_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    unfollowed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT community_follows_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT community_follows_status_timestamp_check CHECK ((((status = 'active'::text) AND (unfollowed_at IS NULL)) OR ((status = 'inactive'::text) AND (unfollowed_at IS NOT NULL))))
);

CREATE TABLE community_memberships (
    community_id text NOT NULL,
    membership_id text NOT NULL,
    user_id text NOT NULL,
    status text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone,
    left_at timestamp with time zone,
    banned_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    request_note text,
    CONSTRAINT community_memberships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'member'::text, 'left'::text, 'banned'::text])))
);

CREATE TABLE community_policy_current (
    community_id text NOT NULL,
    policy_key text NOT NULL,
    policy_version_id text NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE community_policy_provider_bindings (
    policy_version_id text NOT NULL,
    community_id text NOT NULL,
    policy_key text NOT NULL,
    verification_requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    method text NOT NULL,
    protocol_version text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    issuer text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    request_mode text NOT NULL,
    evaluator_id text NOT NULL,
    CONSTRAINT community_policy_provider_bi_verification_requirement_has_check CHECK ((verification_requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_policy_provider_bin_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_policy_provider_bindings_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(method) <> ''::text) AND (method = btrim(method)) AND (btrim(protocol_version) <> ''::text) AND (protocol_version = btrim(protocol_version)))),
    CONSTRAINT community_policy_provider_bindings_request_mode_check CHECK ((request_mode = ANY (ARRAY['curated'::text, 'dynamic'::text]))),
    CONSTRAINT community_policy_provider_bindings_request_shape CHECK ((((request_mode = 'curated'::text) AND (provider_configuration_kind = 'managed'::text)) OR ((request_mode = 'dynamic'::text) AND (provider_configuration_kind = 'dynamic'::text)))),
    CONSTRAINT community_policy_provider_bindings_resolution_not_blank CHECK (((btrim(issuer) <> ''::text) AND (issuer = btrim(issuer)) AND (btrim(evaluator_id) <> ''::text) AND (evaluator_id = btrim(evaluator_id)) AND ((issuer_rp_scope IS NULL) OR ((btrim(issuer_rp_scope) <> ''::text) AND (issuer_rp_scope = btrim(issuer_rp_scope)))) AND ((issuer_rp_action_scope IS NULL) OR ((btrim(issuer_rp_action_scope) <> ''::text) AND (issuer_rp_action_scope = btrim(issuer_rp_action_scope)))))),
    CONSTRAINT community_policy_provider_bindings_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['none'::text, 'issuer_rp_scope'::text, 'issuer_rp_action_scope'::text]))),
    CONSTRAINT community_policy_provider_bindings_scope_shape CHECK ((((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL))))
);

CREATE TABLE community_purchase_allocation_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_availability_reservations (
    purchase_id text NOT NULL,
    listing_id text NOT NULL,
    state text DEFAULT 'held'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    transitioned_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_reservation_state_check CHECK ((state = ANY (ARRAY['held'::text, 'consumed'::text, 'released'::text, 'expired'::text])))
);

CREATE TABLE community_purchase_correction_events (
    event_id text NOT NULL,
    target_identity text NOT NULL,
    kind text NOT NULL,
    operator_id text NOT NULL,
    reason text NOT NULL,
    quote_id text,
    purchase_id text,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_correction_kind_check CHECK ((kind = ANY (ARRAY['cancel_unbound_quote'::text, 'release_unbound_reservation'::text, 'supersede_policy'::text]))),
    CONSTRAINT community_purchase_correction_target_check CHECK (((btrim(target_identity) <> ''::text) AND (btrim(reason) <> ''::text)))
);

CREATE TABLE community_purchase_donation_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_eligibility_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_funding_journal (
    operation_id text NOT NULL,
    community_id text NOT NULL,
    actor_id text NOT NULL,
    quote_id text NOT NULL,
    purchase_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    expected_sender text NOT NULL,
    expected_recipient text NOT NULL,
    expected_amount_atomic numeric(78,0) NOT NULL,
    required_confirmations integer NOT NULL,
    state text NOT NULL,
    version bigint NOT NULL,
    snapshot jsonb NOT NULL,
    failure_tag text,
    failure_reason text,
    funding_receipt_status text,
    funding_transaction_hash text,
    funding_log_index integer,
    funding_observation_id text,
    lease_owner text,
    lease_fence_token bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_funding_amount_check CHECK ((expected_amount_atomic > (0)::numeric)),
    CONSTRAINT community_purchase_funding_business_ids_not_blank CHECK (((btrim(quote_id) <> ''::text) AND (btrim(purchase_id) <> ''::text))),
    CONSTRAINT community_purchase_funding_chain_id_check CHECK ((chain_id > 0)),
    CONSTRAINT community_purchase_funding_confirmations_check CHECK ((required_confirmations > 0)),
    CONSTRAINT community_purchase_funding_failure_coherence_check CHECK ((((state = ANY (ARRAY['planned'::text, 'dormant_unobserved'::text, 'confirming'::text, 'confirmed'::text, 'reverted'::text])) AND (failure_tag IS NULL) AND (failure_reason IS NULL)) OR ((state = 'reclaimable_failed'::text) AND (failure_tag = 'reclaimable'::text) AND (btrim(failure_reason) <> ''::text)) OR ((state = 'reconciliation_required'::text) AND (failure_tag = ANY (ARRAY['ambiguous'::text, 'legacy'::text])) AND (btrim(failure_reason) <> ''::text)))),
    CONSTRAINT community_purchase_funding_lease_shape_check CHECK (((lease_fence_token >= 0) AND (((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((btrim(lease_owner) <> ''::text) AND (lease_expires_at IS NOT NULL))))),
    CONSTRAINT community_purchase_funding_operation_not_blank CHECK ((btrim(operation_id) <> ''::text)),
    CONSTRAINT community_purchase_funding_parties_check CHECK (((expected_sender ~ '^0x[0-9a-f]{40}$'::text) AND (expected_recipient ~ '^0x[0-9a-f]{40}$'::text))),
    CONSTRAINT community_purchase_funding_policy_version_check CHECK ((policy_version > 0)),
    CONSTRAINT community_purchase_funding_receipt_shape_check CHECK ((((funding_receipt_status IS NULL) AND (funding_transaction_hash IS NULL) AND (funding_log_index IS NULL) AND (funding_observation_id IS NULL)) OR ((funding_receipt_status = 'success'::text) AND (funding_transaction_hash ~ '^0x[0-9a-f]{64}$'::text) AND (funding_log_index >= 0) AND (funding_observation_id ~ '^0x[0-9a-f]{64}$'::text)) OR ((funding_receipt_status = 'reverted'::text) AND (funding_transaction_hash ~ '^0x[0-9a-f]{64}$'::text) AND (funding_log_index IS NULL) AND (funding_observation_id ~ '^0x[0-9a-f]{64}$'::text)))),
    CONSTRAINT community_purchase_funding_snapshot_object_check CHECK ((jsonb_typeof(snapshot) = 'object'::text)),
    CONSTRAINT community_purchase_funding_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'dormant_unobserved'::text, 'confirming'::text, 'confirmed'::text, 'reverted'::text, 'reclaimable_failed'::text, 'reconciliation_required'::text]))),
    CONSTRAINT community_purchase_funding_token_check CHECK (((token_contract ~ '^0x[0-9a-f]{40}$'::text) AND (token_decimals = 6))),
    CONSTRAINT community_purchase_funding_version_check CHECK ((version > 0))
);

CREATE TABLE community_purchase_funding_plans (
    quote_id text NOT NULL,
    community_id text NOT NULL,
    actor_id text NOT NULL,
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    purchase_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78,0) NOT NULL,
    required_confirmations integer NOT NULL,
    quoted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    operation_id text,
    CONSTRAINT community_purchase_funding_plans_amount_check CHECK ((amount_atomic > (0)::numeric)),
    CONSTRAINT community_purchase_funding_plans_buyer_chain_check CHECK (((buyer_chain_id > 0) AND (buyer_chain_id = chain_id))),
    CONSTRAINT community_purchase_funding_plans_buyer_wallet_check CHECK ((buyer_wallet_address ~ '^0x[0-9a-f]{40}$'::text)),
    CONSTRAINT community_purchase_funding_plans_chain_id_check CHECK ((chain_id > 0)),
    CONSTRAINT community_purchase_funding_plans_confirmations_check CHECK ((required_confirmations > 0)),
    CONSTRAINT community_purchase_funding_plans_expiry_check CHECK ((expires_at > quoted_at)),
    CONSTRAINT community_purchase_funding_plans_operation_coherence_check CHECK ((((status = 'bound'::text) AND (operation_id IS NOT NULL)) OR ((status = ANY (ARRAY['active'::text, 'cancelled'::text])) AND (operation_id IS NULL)))),
    CONSTRAINT community_purchase_funding_plans_policy_version_check CHECK ((policy_version > 0)),
    CONSTRAINT community_purchase_funding_plans_purchase_not_blank CHECK ((btrim(purchase_id) <> ''::text)),
    CONSTRAINT community_purchase_funding_plans_quote_not_blank CHECK ((btrim(quote_id) <> ''::text)),
    CONSTRAINT community_purchase_funding_plans_status_check CHECK ((status = ANY (ARRAY['active'::text, 'bound'::text, 'cancelled'::text]))),
    CONSTRAINT community_purchase_funding_plans_token_check CHECK (((token_contract ~ '^0x[0-9a-f]{40}$'::text) AND (token_decimals = 6))),
    CONSTRAINT community_purchase_funding_plans_treasury_check CHECK ((treasury_address ~ '^0x[0-9a-f]{40}$'::text))
);

CREATE TABLE community_purchase_funding_receipts (
    receipt_id text NOT NULL,
    operation_id text NOT NULL,
    community_id text NOT NULL,
    purchase_id text NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    sender text NOT NULL,
    recipient text NOT NULL,
    amount_atomic numeric(78,0) NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    confirmed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_funding_receipts_amount_check CHECK ((amount_atomic > (0)::numeric)),
    CONSTRAINT community_purchase_funding_receipts_id_not_blank CHECK ((btrim(receipt_id) <> ''::text)),
    CONSTRAINT community_purchase_funding_receipts_log_check CHECK ((log_index >= 0))
);

CREATE TABLE community_purchase_funding_reconciliation_attempts (
    operation_id text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    last_failure_class text,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    escalated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    finalized_generation bigint,
    CONSTRAINT cpf_attempts_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT cpf_attempts_escalation_check CHECK (((escalated_at IS NULL) OR (last_failure_class IS NOT NULL))),
    CONSTRAINT cpf_attempts_failure_class_check CHECK (((last_failure_class IS NULL) OR (last_failure_class = ANY (ARRAY['lease_contention'::text, 'chain_unavailable'::text, 'chain_timeout'::text, 'transaction_not_found'::text, 'invalid_evidence'::text, 'reorg'::text, 'identity_conflict'::text])))),
    CONSTRAINT cpf_attempts_finalized_generation_check CHECK (((finalized_generation IS NULL) OR ((finalized_generation >= 0) AND (finalized_generation <= generation)))),
    CONSTRAINT cpf_attempts_generation_check CHECK ((generation >= 0)),
    CONSTRAINT cpf_attempts_shape_check CHECK ((((last_attempt_at IS NULL) AND (next_attempt_at IS NULL) AND (last_failure_class IS NULL) AND (consecutive_failures = 0) AND (escalated_at IS NULL)) OR (last_attempt_at IS NOT NULL)))
);

CREATE TABLE community_purchase_funding_reconciliation_operator_actions (
    action_id bigint NOT NULL,
    operation_id text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    generation bigint NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT cpf_attempt_operator_action_check CHECK ((action = 'unpark_escalated'::text)),
    CONSTRAINT cpf_attempt_operator_actor_check CHECK ((length(TRIM(BOTH FROM actor_id)) > 0)),
    CONSTRAINT cpf_attempt_operator_generation_check CHECK ((generation >= 0)),
    CONSTRAINT cpf_attempt_operator_reason_check CHECK ((length(TRIM(BOTH FROM reason)) > 0))
);

ALTER TABLE community_purchase_funding_reconciliation_operator_actions ALTER COLUMN action_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME community_purchase_funding_reconciliation_operato_action_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE community_purchase_funding_requests (
    actor_id text NOT NULL,
    endpoint text NOT NULL,
    client_nonce text NOT NULL,
    request_hash text NOT NULL,
    canonical_request jsonb NOT NULL,
    operation_id text NOT NULL,
    status text NOT NULL,
    result jsonb NOT NULL,
    result_version bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_funding_requests_endpoint_check CHECK ((endpoint = 'community-purchase-funding'::text)),
    CONSTRAINT community_purchase_funding_requests_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_purchase_funding_requests_nonce_not_blank CHECK ((btrim(client_nonce) <> ''::text)),
    CONSTRAINT community_purchase_funding_requests_request_object_check CHECK ((jsonb_typeof(canonical_request) = 'object'::text)),
    CONSTRAINT community_purchase_funding_requests_result_object_check CHECK ((jsonb_typeof(result) = 'object'::text)),
    CONSTRAINT community_purchase_funding_requests_result_version_check CHECK ((result_version > 0)),
    CONSTRAINT community_purchase_funding_requests_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'dormant_unobserved'::text, 'confirming'::text, 'confirmed'::text, 'reverted'::text, 'reclaimable_failed'::text, 'reconciliation_required'::text])))
);

CREATE TABLE community_purchase_funding_transaction_claims (
    operation_id text NOT NULL,
    chain_id bigint NOT NULL,
    transaction_hash text NOT NULL,
    successful_log_index integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_funding_transaction_claims_chain_check CHECK ((chain_id > 0)),
    CONSTRAINT community_purchase_funding_transaction_claims_hash_check CHECK ((transaction_hash ~ '^0x[0-9a-f]{64}$'::text)),
    CONSTRAINT community_purchase_funding_transaction_claims_log_check CHECK (((successful_log_index IS NULL) OR (successful_log_index >= 0)))
);

CREATE TABLE community_purchase_funding_transitions (
    operation_id text NOT NULL,
    target_version bigint NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    event jsonb NOT NULL,
    observation_id text,
    transaction_hash text,
    log_index integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_purchase_funding_transitions_event_object_check CHECK ((jsonb_typeof(event) = 'object'::text)),
    CONSTRAINT community_purchase_funding_transitions_event_type_not_blank CHECK ((btrim(event_type) <> ''::text)),
    CONSTRAINT community_purchase_funding_transitions_evidence_shape_check CHECK ((((observation_id IS NULL) AND (transaction_hash IS NULL) AND (log_index IS NULL)) OR ((observation_id ~ '^0x[0-9a-f]{64}$'::text) AND (transaction_hash ~ '^0x[0-9a-f]{64}$'::text) AND ((log_index IS NULL) OR (log_index >= 0))))),
    CONSTRAINT community_purchase_funding_transitions_source_check CHECK ((source = ANY (ARRAY['request'::text, 'reconciler'::text]))),
    CONSTRAINT community_purchase_funding_transitions_version_check CHECK ((target_version > 1))
);

CREATE TABLE community_purchase_intents (
    purchase_id text NOT NULL,
    actor_id text NOT NULL,
    community_id text NOT NULL,
    listing_id text NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT community_purchase_intent_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT community_purchase_intent_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'consumed'::text, 'released'::text, 'expired'::text])))
);

CREATE TABLE community_purchase_pricing_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_quotes (
    quote_id text NOT NULL,
    purchase_id text NOT NULL,
    community_id text NOT NULL,
    actor_id text NOT NULL,
    listing_id text NOT NULL,
    policy_version bigint NOT NULL,
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78,0) NOT NULL,
    required_confirmations integer NOT NULL,
    eligibility_snapshot_id text,
    pricing_snapshot_id text,
    verification_snapshot_id text,
    route_snapshot_id text,
    allocation_snapshot_id text,
    settlement_snapshot_id text,
    donation_snapshot_id text,
    quoted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT community_purchase_quote_amount_check CHECK ((amount_atomic > (0)::numeric)),
    CONSTRAINT community_purchase_quote_chain_check CHECK (((buyer_chain_id = chain_id) AND (chain_id > 0))),
    CONSTRAINT community_purchase_quote_confirmations_check CHECK ((required_confirmations > 0)),
    CONSTRAINT community_purchase_quote_expiry_check CHECK ((expires_at > quoted_at)),
    CONSTRAINT community_purchase_quote_status_check CHECK ((status = ANY (ARRAY['active'::text, 'bound'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT community_purchase_quote_token_check CHECK (((token_contract ~ '^0x[0-9a-f]{40}$'::text) AND (token_decimals = 6))),
    CONSTRAINT community_purchase_quote_treasury_check CHECK ((treasury_address ~ '^0x[0-9a-f]{40}$'::text)),
    CONSTRAINT community_purchase_quote_wallet_check CHECK ((buyer_wallet_address ~ '^0x[0-9a-f]{40}$'::text))
);

CREATE TABLE community_purchase_route_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_settlement_snapshots (
    snapshot_id text NOT NULL,
    quote_id text NOT NULL,
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_verification_snapshots (
    snapshot_id text NOT NULL,
    quote_id text,
    actor_id text NOT NULL,
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    provider text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_route_app_host_health (
    route_binding_id text NOT NULL,
    family text DEFAULT 'hns'::text NOT NULL,
    health_status text NOT NULL,
    health_generation bigint DEFAULT 0 NOT NULL,
    observed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_app_host_health_family_check CHECK ((family = 'hns'::text)),
    CONSTRAINT community_route_app_host_health_health_generation_check CHECK ((health_generation >= 0)),
    CONSTRAINT community_route_app_host_health_health_status_check CHECK ((health_status = ANY (ARRAY['unconfigured'::text, 'pending'::text, 'healthy'::text, 'unhealthy'::text, 'stale'::text])))
);

CREATE TABLE community_route_attachment_ceremony_attempts (
    ceremony_intent_id text NOT NULL,
    attachment_intent_id text NOT NULL,
    actor_id text NOT NULL,
    requirement_kind text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    reservation_request_hash text NOT NULL,
    reservation_request jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_attachment_ce_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_attachment_cerem_reservation_request_hash_check CHECK ((reservation_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_ceremony_atte_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_ceremony_atte_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT community_route_attachment_ceremony_attempts_family_check CHECK ((family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_route_attachment_ceremony_attempts_generation_check CHECK ((generation > 0)),
    CONSTRAINT community_route_attachment_ceremony_attempts_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment =
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END))),
    CONSTRAINT community_route_attachment_ceremony_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE community_route_attachment_ceremony_results (
    ceremony_intent_id text NOT NULL,
    actor_id text NOT NULL,
    attachment_intent_id text NOT NULL,
    requirement_kind text NOT NULL,
    generation bigint NOT NULL,
    callback_idempotency_key text NOT NULL,
    callback_request_hash text NOT NULL,
    outcome_status text NOT NULL,
    result_hash text NOT NULL,
    evidence_ref text,
    evidence_digest text,
    provider_identity_digest text,
    terminal_at timestamp with time zone NOT NULL,
    satisfied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_attachment_cerem_provider_identity_digest_check CHECK (((provider_identity_digest IS NULL) OR (provider_identity_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT community_route_attachment_ceremony_callback_request_hash_check CHECK ((callback_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_ceremony_resu_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT community_route_attachment_ceremony_resul_evidence_digest_check CHECK (((evidence_digest IS NULL) OR (evidence_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT community_route_attachment_ceremony_result_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['satisfied'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT community_route_attachment_ceremony_results_generation_check CHECK ((generation > 0)),
    CONSTRAINT community_route_attachment_ceremony_results_outcome_shape CHECK ((((outcome_status = 'satisfied'::text) AND (evidence_ref IS NOT NULL) AND (evidence_digest IS NOT NULL) AND (provider_identity_digest IS NOT NULL) AND (satisfied_at = terminal_at)) OR ((outcome_status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (evidence_ref IS NULL) AND (evidence_digest IS NULL) AND (provider_identity_digest IS NULL) AND (satisfied_at IS NULL)))),
    CONSTRAINT community_route_attachment_ceremony_results_result_hash_check CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE community_route_attachment_intent_revisions (
    attachment_intent_id text NOT NULL,
    revision bigint NOT NULL,
    actor_id text NOT NULL,
    operation_kind text NOT NULL,
    idempotency_key text,
    request_hash text NOT NULL,
    status text NOT NULL,
    state_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_attachment_intent_revision_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['create'::text, 'verification'::text, 'commit'::text, 'expire'::text, 'cancel'::text]))),
    CONSTRAINT community_route_attachment_intent_revisions_operation_shape CHECK ((((operation_kind = ANY (ARRAY['create'::text, 'commit'::text])) AND (idempotency_key IS NOT NULL)) OR ((operation_kind <> ALL (ARRAY['create'::text, 'commit'::text])) AND (idempotency_key IS NULL)))),
    CONSTRAINT community_route_attachment_intent_revisions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_intent_revisions_revision_check CHECK ((revision > 0))
);

CREATE TABLE community_route_attachment_intents (
    attachment_intent_id text NOT NULL,
    community_id text NOT NULL,
    actor_id text NOT NULL,
    authority_grant_id text NOT NULL,
    create_idempotency_key text NOT NULL,
    create_request_hash text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    status text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text GENERATED ALWAYS AS (
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END) STORED,
    href text GENERATED ALWAYS AS (('/c/'::text ||
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END)) STORED,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    committed_route_binding_id text,
    committed_resource jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_attachment_in_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_attachment_intents_commit_shape CHECK ((((status = 'committed'::text) AND (committed_route_binding_id IS NOT NULL) AND (jsonb_typeof(committed_resource) = 'object'::text)) OR ((status <> 'committed'::text) AND (committed_route_binding_id IS NULL) AND (committed_resource IS NULL)))),
    CONSTRAINT community_route_attachment_intents_create_request_hash_check CHECK ((create_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_intents_family_check CHECK ((family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_route_attachment_intents_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_intents_provider_shape CHECK (((btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(protocol_version) <> ''::text) AND (protocol_version = btrim(protocol_version)))),
    CONSTRAINT community_route_attachment_intents_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_intents_revision_check CHECK ((revision > 0)),
    CONSTRAINT community_route_attachment_intents_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE))),
    CONSTRAINT community_route_attachment_intents_status_check CHECK ((status = ANY (ARRAY['verification_required'::text, 'commit_ready'::text, 'committed'::text, 'failed'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT community_route_attachment_intents_time_order CHECK (((updated_at >= created_at) AND (expires_at > created_at)))
);

CREATE TABLE community_route_attachment_requirement_states (
    attachment_intent_id text NOT NULL,
    actor_id text NOT NULL,
    requirement_kind text NOT NULL,
    status text NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    current_ceremony_intent_id text,
    satisfied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_attachment_re_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_attachment_requirem_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_requirement_s_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_attachment_requirement_s_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT community_route_attachment_requirement_states_family_check CHECK ((family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_route_attachment_requirement_states_generation_check CHECK ((generation >= 0)),
    CONSTRAINT community_route_attachment_requirement_states_progress_shape CHECK ((((status = 'unmet'::text) AND (generation = 0) AND (current_ceremony_intent_id IS NULL) AND (satisfied_at IS NULL)) OR ((status = 'pending'::text) AND (generation > 0) AND (current_ceremony_intent_id IS NOT NULL) AND (satisfied_at IS NULL)) OR ((status = 'satisfied'::text) AND (generation > 0) AND (current_ceremony_intent_id IS NOT NULL) AND (satisfied_at IS NOT NULL)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (generation > 0) AND (current_ceremony_intent_id IS NOT NULL) AND (satisfied_at IS NULL)))),
    CONSTRAINT community_route_attachment_requirement_states_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment =
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END))),
    CONSTRAINT community_route_attachment_requirement_states_status_check CHECK ((status = ANY (ARRAY['unmet'::text, 'pending'::text, 'satisfied'::text, 'failed'::text, 'expired'::text])))
);

CREATE TABLE community_route_authority_grants (
    grant_id text NOT NULL,
    community_id text NOT NULL,
    principal_user_id text NOT NULL,
    authority text NOT NULL,
    source_kind text NOT NULL,
    source_policy_ref text,
    status text NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    granted_by_user_id text NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_user_id text,
    CONSTRAINT community_route_authority_grants_authority_check CHECK ((authority = 'manage_routes'::text)),
    CONSTRAINT community_route_authority_grants_id_shape CHECK (((btrim(grant_id) <> ''::text) AND (grant_id = btrim(grant_id)) AND (octet_length(grant_id) <= 512))),
    CONSTRAINT community_route_authority_grants_source_kind_check CHECK ((source_kind = ANY (ARRAY['creator_owner'::text, 'community_policy'::text]))),
    CONSTRAINT community_route_authority_grants_source_shape CHECK ((((source_kind = 'creator_owner'::text) AND (source_policy_ref IS NULL)) OR ((source_kind = 'community_policy'::text) AND (btrim(source_policy_ref) <> ''::text)))),
    CONSTRAINT community_route_authority_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT community_route_authority_grants_status_shape CHECK ((((status = 'active'::text) AND (revoked_at IS NULL) AND (revoked_by_user_id IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL) AND (revoked_by_user_id IS NOT NULL))))
);

CREATE TABLE community_route_lifecycle_transitions (
    route_lifecycle_transition_id text NOT NULL,
    version text NOT NULL,
    transition_kind text NOT NULL,
    community_id text NOT NULL,
    route_binding_id text NOT NULL,
    principal_kind text NOT NULL,
    principal_id text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    expected_binding_generation bigint NOT NULL,
    resulting_binding_generation bigint NOT NULL,
    expected_verified_evidence_ref text NOT NULL,
    observed_evidence_expires_at timestamp with time zone NOT NULL,
    ownership_status text NOT NULL,
    route_lifecycle_status text NOT NULL,
    transitioned_at timestamp with time zone NOT NULL,
    CONSTRAINT community_route_lifecycle_transition_generation_check CHECK (((expected_binding_generation > 0) AND (resulting_binding_generation = (expected_binding_generation + 1)))),
    CONSTRAINT community_route_lifecycle_transition_identity_check CHECK (((btrim(route_lifecycle_transition_id) <> ''::text) AND (route_lifecycle_transition_id = btrim(route_lifecycle_transition_id)) AND (octet_length(route_lifecycle_transition_id) <= 512) AND (btrim(principal_id) <> ''::text) AND (principal_id = btrim(principal_id)) AND (octet_length(principal_id) <= 256))),
    CONSTRAINT community_route_lifecycle_transition_kind_check CHECK (((version = 'pirate-community-route-lifecycle-transition-v1'::text) AND (transition_kind = 'database_time_expired'::text) AND (principal_kind = 'system'::text) AND (ownership_status = 'expired'::text) AND (route_lifecycle_status = 'suspended'::text))),
    CONSTRAINT community_route_lifecycle_transition_route_check CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment =
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END))),
    CONSTRAINT community_route_lifecycle_transition_time_check CHECK ((observed_evidence_expires_at <= transitioned_at))
);

CREATE TABLE community_route_operator_override_audit (
    override_audit_id text NOT NULL,
    community_id text NOT NULL,
    operator_principal_id text NOT NULL,
    action_kind text NOT NULL,
    reason text NOT NULL,
    request_hash text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT community_route_operator_override_audit_action_kind_check CHECK ((action_kind = ANY (ARRAY['attachment_intent_created'::text, 'attachment_committed'::text]))),
    CONSTRAINT community_route_operator_override_audit_identity_shape CHECK (((btrim(override_audit_id) <> ''::text) AND (override_audit_id = btrim(override_audit_id)) AND (btrim(operator_principal_id) <> ''::text) AND (operator_principal_id = btrim(operator_principal_id)) AND (btrim(reason) <> ''::text))),
    CONSTRAINT community_route_operator_override_audit_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE community_route_ownership_evidence (
    evidence_ref text NOT NULL,
    creation_ceremony_intent_id text,
    verified_by_actor_id text,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_version text NOT NULL,
    provider_identity_digest text NOT NULL,
    evidence_digest text NOT NULL,
    evidence_receipt_id text,
    binding_generation bigint NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    origin text DEFAULT 'creation_ceremony'::text NOT NULL,
    route_revalidation_attempt_id text,
    route_attachment_ceremony_intent_id text,
    CONSTRAINT community_route_ownership_eviden_provider_identity_digest_check CHECK ((provider_identity_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_ownership_evidence_binding_generation_check CHECK ((binding_generation > 0)),
    CONSTRAINT community_route_ownership_evidence_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_ownership_evidence_family_check CHECK ((family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT community_route_ownership_evidence_identifiers_not_blank CHECK (((btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT community_route_ownership_evidence_origin_shape CHECK ((((origin = 'creation_ceremony'::text) AND (creation_ceremony_intent_id IS NOT NULL) AND (route_revalidation_attempt_id IS NULL) AND (route_attachment_ceremony_intent_id IS NULL) AND (verified_by_actor_id IS NOT NULL)) OR ((origin = 'route_revalidation'::text) AND (creation_ceremony_intent_id IS NULL) AND (route_revalidation_attempt_id IS NOT NULL) AND (route_attachment_ceremony_intent_id IS NULL) AND (verified_by_actor_id IS NULL)) OR ((origin = 'route_attachment'::text) AND (creation_ceremony_intent_id IS NULL) AND (route_revalidation_attempt_id IS NULL) AND (route_attachment_ceremony_intent_id IS NOT NULL) AND (verified_by_actor_id IS NOT NULL)))),
    CONSTRAINT community_route_ownership_evidence_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_ownership_evidence_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_ownership_evidence_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment =
CASE family
    WHEN 'hns'::text THEN ('app.'::text || root_label)
    WHEN 'spaces'::text THEN ('@'::text || root_label)
    ELSE NULL::text
END))),
    CONSTRAINT community_route_ownership_evidence_time_order CHECK (((created_at >= verified_at) AND ((expires_at IS NULL) OR (expires_at > verified_at))))
);

CREATE TABLE community_route_revalidation_completion_attempts (
    route_revalidation_attempt_id text NOT NULL,
    route_revalidation_id text NOT NULL,
    revalidation_session_id text NOT NULL,
    route_binding_id text NOT NULL,
    expected_binding_generation bigint NOT NULL,
    expected_verified_evidence_ref text,
    attempt_number integer NOT NULL,
    idempotency_key text NOT NULL,
    completion_request_hash text NOT NULL,
    evidence_ref text NOT NULL,
    state text DEFAULT 'leased'::text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    consumption_kind text,
    result_hash text,
    terminal_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    terminal_result_document text,
    terminal_observed_expires_at timestamp with time zone,
    CONSTRAINT community_route_revalidation_attempts_identifiers_not_blank CHECK (((btrim(route_revalidation_attempt_id) <> ''::text) AND (route_revalidation_attempt_id = btrim(route_revalidation_attempt_id)) AND (octet_length(route_revalidation_attempt_id) <= 256) AND (btrim(idempotency_key) <> ''::text) AND (idempotency_key = btrim(idempotency_key)) AND (octet_length(idempotency_key) <= 256) AND (btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (octet_length(evidence_ref) <= 512))),
    CONSTRAINT community_route_revalidation_attempts_result_shape CHECK ((((state = 'consumed'::text) AND (consumption_kind IS NOT NULL) AND (terminal_at IS NOT NULL) AND (((consumption_kind = 'challenge_mismatch'::text) AND (result_hash IS NULL) AND (terminal_result_document IS NULL)) OR ((result_hash IS NOT NULL) AND (terminal_result_document IS NOT NULL) AND (((consumption_kind = 'database_time_expired'::text) AND (terminal_observed_expires_at IS NOT NULL)) OR ((consumption_kind <> 'database_time_expired'::text) AND (terminal_observed_expires_at IS NULL)))))) OR ((state = ANY (ARRAY['leased'::text, 'released'::text])) AND (consumption_kind IS NULL) AND (result_hash IS NULL) AND (terminal_result_document IS NULL) AND (terminal_observed_expires_at IS NULL) AND (terminal_at IS NULL)))),
    CONSTRAINT community_route_revalidation_attempts_time_order CHECK (((updated_at >= created_at) AND ((terminal_at IS NULL) OR (terminal_at >= created_at)))),
    CONSTRAINT community_route_revalidation_comp_completion_request_hash_check CHECK ((completion_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_completion__consumption_kind_check CHECK ((consumption_kind = ANY (ARRAY['verified'::text, 'missing_root'::text, 'control_failed'::text, 'challenge_mismatch'::text, 'insufficient_expiry'::text, 'disputed'::text, 'revoked'::text, 'database_time_expired'::text, 'session_expired'::text, 'stale_cas'::text]))),
    CONSTRAINT community_route_revalidation_completion_at_attempt_number_check CHECK (((attempt_number >= 1) AND (attempt_number <= 3))),
    CONSTRAINT community_route_revalidation_completion_attem_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT community_route_revalidation_completion_attem_result_hash_check CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_completion_attempts_state_check CHECK ((state = ANY (ARRAY['leased'::text, 'released'::text, 'consumed'::text]))),
    CONSTRAINT community_route_revalidation_expected_binding_generation_check2 CHECK ((expected_binding_generation > 0))
);

CREATE TABLE community_route_revalidation_evidence_snapshots (
    evidence_ref text NOT NULL,
    route_revalidation_attempt_id text NOT NULL,
    route_revalidation_id text NOT NULL,
    revalidation_session_id text NOT NULL,
    community_id text NOT NULL,
    route_binding_id text NOT NULL,
    principal_kind text DEFAULT 'system'::text NOT NULL,
    principal_id text NOT NULL,
    requirement_hash text NOT NULL,
    expected_binding_generation bigint NOT NULL,
    binding_generation bigint NOT NULL,
    expected_verified_evidence_ref text,
    start_request_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_reference text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text DEFAULT 'hns-txt-v1'::text NOT NULL,
    environment text NOT NULL,
    family text DEFAULT 'hns'::text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    upstream_session_ref text NOT NULL,
    fence_token bigint NOT NULL,
    abi_version text DEFAULT 'pirate-hns-route-revalidation-evidence-v1'::text NOT NULL,
    ownership_source text NOT NULL,
    challenge_name text NOT NULL,
    challenge_value_sha256 text NOT NULL,
    root_exists boolean NOT NULL,
    root_control_verified boolean NOT NULL,
    expiry_horizon_sufficient boolean NOT NULL,
    chain_network text NOT NULL,
    chain_anchor_height bigint NOT NULL,
    chain_anchor_block_hash text NOT NULL,
    chain_anchor_median_time bigint NOT NULL,
    expiry_height bigint NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    provider_evidence_ref text NOT NULL,
    observation_sha256 text NOT NULL,
    provider_identity_digest text NOT NULL,
    evidence_digest text NOT NULL,
    observation jsonb NOT NULL,
    raw_response_bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_revalidation_ev_expiry_horizon_sufficient_check CHECK ((expiry_horizon_sufficient IS TRUE)),
    CONSTRAINT community_route_revalidation_evi_chain_anchor_median_time_check CHECK ((chain_anchor_median_time > 0)),
    CONSTRAINT community_route_revalidation_evi_provider_identity_digest_check CHECK ((provider_identity_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evid_chain_anchor_block_hash_check CHECK ((chain_anchor_block_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evide_challenge_value_sha256_check CHECK ((challenge_value_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_eviden_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_eviden_root_control_verified_check CHECK ((root_control_verified IS TRUE)),
    CONSTRAINT community_route_revalidation_evidence__binding_generation_check CHECK ((binding_generation > 1)),
    CONSTRAINT community_route_revalidation_evidence__observation_sha256_check CHECK ((observation_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evidence__raw_response_bytes_check CHECK (((octet_length(raw_response_bytes) >= 1) AND (octet_length(raw_response_bytes) <= 1048576))),
    CONSTRAINT community_route_revalidation_evidence__start_request_hash_check CHECK ((start_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evidence_chain_anchor_height_check CHECK ((chain_anchor_height > 0)),
    CONSTRAINT community_route_revalidation_evidence_sn_ownership_source_check CHECK ((ownership_source = ANY (ARRAY['hns_parent_chain_txt'::text, 'owner_authoritative_dns_txt'::text]))),
    CONSTRAINT community_route_revalidation_evidence_sn_protocol_version_check CHECK ((protocol_version = 'hns-txt-v1'::text)),
    CONSTRAINT community_route_revalidation_evidence_sn_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evidence_sna_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_evidence_snap_principal_kind_check CHECK ((principal_kind = 'system'::text)),
    CONSTRAINT community_route_revalidation_evidence_snaps_expiry_height_check CHECK ((expiry_height > 0)),
    CONSTRAINT community_route_revalidation_evidence_snapsho_abi_version_check CHECK ((abi_version = 'pirate-hns-route-revalidation-evidence-v1'::text)),
    CONSTRAINT community_route_revalidation_evidence_snapsho_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT community_route_revalidation_evidence_snapsho_observation_check CHECK (((jsonb_typeof(observation) = 'object'::text) AND ((observation ->> 'status'::text) = 'verified'::text))),
    CONSTRAINT community_route_revalidation_evidence_snapsho_root_exists_check CHECK ((root_exists IS TRUE)),
    CONSTRAINT community_route_revalidation_evidence_snapshots_family_check CHECK ((family = 'hns'::text)),
    CONSTRAINT community_route_revalidation_expected_binding_generation_check3 CHECK ((expected_binding_generation > 0)),
    CONSTRAINT community_route_revalidation_provider_configuration_kind_check2 CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_revalidation_snapshots_challenge_shape CHECK (((btrim(challenge_name) <> ''::text) AND (challenge_name = btrim(challenge_name)) AND (octet_length(challenge_name) <= 255) AND (challenge_name !~ '[[:cntrl:]]'::text) AND (((ownership_source = 'hns_parent_chain_txt'::text) AND (challenge_name = root_label)) OR ((ownership_source = 'owner_authoritative_dns_txt'::text) AND (challenge_name = ('_pirate.'::text || root_label)))))),
    CONSTRAINT community_route_revalidation_snapshots_generation_shape CHECK ((binding_generation = (expected_binding_generation + 1))),
    CONSTRAINT community_route_revalidation_snapshots_identifiers_not_blank CHECK (((btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (octet_length(evidence_ref) <= 512) AND (btrim(principal_id) <> ''::text) AND (principal_id = btrim(principal_id)) AND (octet_length(principal_id) <= 256) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (octet_length(provider_id) <= 256) AND (btrim(provider_configuration_reference) <> ''::text) AND (provider_configuration_reference = btrim(provider_configuration_reference)) AND (octet_length(provider_configuration_reference) <= 512) AND (btrim(chain_network) <> ''::text) AND (chain_network = btrim(chain_network)) AND (btrim(provider_evidence_ref) <> ''::text) AND (provider_evidence_ref = btrim(provider_evidence_ref)) AND (octet_length(provider_evidence_ref) <= 512) AND (octet_length(provider_configuration_version) <= 128) AND (octet_length(environment) <= 128))),
    CONSTRAINT community_route_revalidation_snapshots_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment = ('app.'::text || root_label)))),
    CONSTRAINT community_route_revalidation_snapshots_time_order CHECK (((expires_at > observed_at) AND (created_at >= observed_at)))
);

CREATE TABLE community_route_revalidation_sessions (
    revalidation_session_id text NOT NULL,
    route_revalidation_id text NOT NULL,
    start_fence_token bigint NOT NULL,
    community_id text NOT NULL,
    route_binding_id text NOT NULL,
    principal_kind text DEFAULT 'system'::text NOT NULL,
    principal_id text NOT NULL,
    expected_binding_generation bigint NOT NULL,
    expected_verified_evidence_ref text,
    requirement_hash text NOT NULL,
    start_request_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_reference text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text DEFAULT 'hns-txt-v1'::text NOT NULL,
    environment text NOT NULL,
    family text DEFAULT 'hns'::text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    upstream_session_ref text NOT NULL,
    start_presentation jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    terminal_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_revalidation_expected_binding_generation_check1 CHECK ((expected_binding_generation > 0)),
    CONSTRAINT community_route_revalidation_provider_configuration_kind_check1 CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_revalidation_sessio_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_sessions_family_check CHECK ((family = 'hns'::text)),
    CONSTRAINT community_route_revalidation_sessions_identifiers_not_blank CHECK (((btrim(revalidation_session_id) <> ''::text) AND (revalidation_session_id = btrim(revalidation_session_id)) AND (octet_length(revalidation_session_id) <= 256) AND (btrim(route_revalidation_id) <> ''::text) AND (route_revalidation_id = btrim(route_revalidation_id)) AND (octet_length(route_revalidation_id) <= 256) AND (btrim(principal_id) <> ''::text) AND (principal_id = btrim(principal_id)) AND (octet_length(principal_id) <= 256) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (octet_length(provider_id) <= 256) AND (btrim(provider_configuration_reference) <> ''::text) AND (provider_configuration_reference = btrim(provider_configuration_reference)) AND (octet_length(provider_configuration_reference) <= 512) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (octet_length(provider_configuration_version) <= 128) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)) AND (octet_length(environment) <= 128))),
    CONSTRAINT community_route_revalidation_sessions_lifecycle_shape CHECK ((((status = 'pending'::text) AND (terminal_at IS NULL)) OR ((status = ANY (ARRAY['completed'::text, 'failed'::text, 'expired'::text])) AND (terminal_at IS NOT NULL)))),
    CONSTRAINT community_route_revalidation_sessions_presentation_shape CHECK ((jsonb_typeof(start_presentation) = 'object'::text)),
    CONSTRAINT community_route_revalidation_sessions_principal_kind_check CHECK ((principal_kind = 'system'::text)),
    CONSTRAINT community_route_revalidation_sessions_protocol_version_check CHECK ((protocol_version = 'hns-txt-v1'::text)),
    CONSTRAINT community_route_revalidation_sessions_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_sessions_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment = ('app.'::text || root_label)))),
    CONSTRAINT community_route_revalidation_sessions_start_fence_token_check CHECK ((start_fence_token > 0)),
    CONSTRAINT community_route_revalidation_sessions_start_request_hash_check CHECK ((start_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT community_route_revalidation_sessions_time_order CHECK (((expires_at > started_at) AND (created_at >= started_at) AND (updated_at >= created_at) AND ((terminal_at IS NULL) OR (terminal_at >= started_at)))),
    CONSTRAINT community_route_revalidation_sessions_upstream_ref_shape CHECK (((octet_length(upstream_session_ref) BETWEEN 1 AND 16384) AND (btrim(upstream_session_ref) = upstream_session_ref) AND (upstream_session_ref !~ '[[:cntrl:]]'::text)))
);

CREATE TABLE community_route_revalidation_start_reservations (
    route_revalidation_id text NOT NULL,
    revalidation_session_id text NOT NULL,
    community_id text NOT NULL,
    route_binding_id text NOT NULL,
    principal_kind text DEFAULT 'system'::text NOT NULL,
    principal_id text NOT NULL,
    expected_binding_generation bigint NOT NULL,
    expected_verified_evidence_ref text,
    requirement_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_reference text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text DEFAULT 'hns-txt-v1'::text NOT NULL,
    environment text NOT NULL,
    family text DEFAULT 'hns'::text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    start_request_hash text NOT NULL,
    state text DEFAULT 'acquired'::text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT community_route_revalidation__expected_binding_generation_check CHECK ((expected_binding_generation > 0)),
    CONSTRAINT community_route_revalidation__provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT community_route_revalidation_start__provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_start_identifiers_not_blank CHECK (((btrim(route_revalidation_id) <> ''::text) AND (route_revalidation_id = btrim(route_revalidation_id)) AND (octet_length(route_revalidation_id) <= 256) AND (btrim(revalidation_session_id) <> ''::text) AND (revalidation_session_id = btrim(revalidation_session_id)) AND (octet_length(revalidation_session_id) <= 256) AND (btrim(principal_id) <> ''::text) AND (principal_id = btrim(principal_id)) AND (octet_length(principal_id) <= 256) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (octet_length(provider_id) <= 256) AND (btrim(provider_configuration_reference) <> ''::text) AND (provider_configuration_reference = btrim(provider_configuration_reference)) AND (octet_length(provider_configuration_reference) <= 512) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (octet_length(provider_configuration_version) <= 128) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)) AND (octet_length(environment) <= 128))),
    CONSTRAINT community_route_revalidation_start_res_start_request_hash_check CHECK ((start_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_start_reser_protocol_version_check CHECK ((protocol_version = 'hns-txt-v1'::text)),
    CONSTRAINT community_route_revalidation_start_reser_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT community_route_revalidation_start_reserva_principal_kind_check CHECK ((principal_kind = 'system'::text)),
    CONSTRAINT community_route_revalidation_start_reservatio_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT community_route_revalidation_start_reservations_family_check CHECK ((family = 'hns'::text)),
    CONSTRAINT community_route_revalidation_start_reservations_state_check CHECK ((state = ANY (ARRAY['acquired'::text, 'released'::text, 'finalized'::text]))),
    CONSTRAINT community_route_revalidation_start_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment = ('app.'::text || root_label)))),
    CONSTRAINT community_route_revalidation_start_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE content_publication_outbox (
    outbox_event_id text NOT NULL,
    community_id text NOT NULL,
    submission_id text NOT NULL,
    comment_id text NOT NULL,
    event_type text NOT NULL,
    effect_key text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT content_publication_outbox_event_type_check CHECK ((event_type = ANY (ARRAY['comment_published'::text, 'comment_notification'::text, 'comment_cache_invalidation'::text]))),
    CONSTRAINT content_publication_outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT content_publication_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'published'::text, 'failed'::text]))),
    CONSTRAINT content_publication_outbox_time_shape CHECK ((((state = 'published'::text) AND (published_at IS NOT NULL)) OR ((state = ANY (ARRAY['pending'::text, 'failed'::text])) AND (published_at IS NULL))))
);

CREATE TABLE decision_records (
    decision_record_id text NOT NULL,
    community_id text NOT NULL,
    user_id text NOT NULL,
    policy_version_id text NOT NULL,
    policy_hash text NOT NULL,
    evaluation_mode text NOT NULL,
    outcome text NOT NULL,
    winning_witness jsonb DEFAULT '[]'::jsonb NOT NULL,
    trace jsonb DEFAULT '[]'::jsonb NOT NULL,
    indeterminate_reason text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT decision_records_evaluation_mode_check CHECK ((evaluation_mode = ANY (ARRAY['preview'::text, 'enforce'::text, 'diagnose'::text]))),
    CONSTRAINT decision_records_outcome_check CHECK ((outcome = ANY (ARRAY['pass'::text, 'fail'::text, 'needs_evidence'::text, 'indeterminate'::text]))),
    CONSTRAINT decision_records_pass_witness_check CHECK (((outcome <> 'pass'::text) OR (jsonb_array_length(winning_witness) > 0))),
    CONSTRAINT decision_records_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT decision_records_request_not_blank CHECK (((request_id IS NULL) OR (btrim(request_id) <> ''::text))),
    CONSTRAINT decision_records_witness_shape_check CHECK (((jsonb_typeof(winning_witness) = 'array'::text) AND (jsonb_typeof(trace) = 'array'::text)))
);

CREATE TABLE evidence_receipts (
    evidence_receipt_id text NOT NULL,
    proof_session_id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    evidence_kind text NOT NULL,
    evidence_hash text NOT NULL,
    receipt_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    provenance_kind text DEFAULT 'proof_session'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_key_id text,
    subject_binding_event_id text,
    subject_binding_epoch bigint,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    CONSTRAINT evidence_receipts_evidence_hash_check CHECK ((evidence_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_receipts_identifiers_not_blank CHECK (((btrim(provider_id) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text) AND (btrim(evidence_kind) <> ''::text))),
    CONSTRAINT evidence_receipts_payload_object_check CHECK ((jsonb_typeof(receipt_metadata) = 'object'::text)),
    CONSTRAINT evidence_receipts_provenance_kind_check CHECK ((provenance_kind = 'proof_session'::text)),
    CONSTRAINT evidence_receipts_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT evidence_receipts_provider_configuration_values_not_blank CHECK (((btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT evidence_receipts_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT evidence_receipts_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT evidence_receipts_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT evidence_receipts_subject_binding_shape_check CHECK ((((subject_key_id IS NULL) AND (subject_binding_event_id IS NULL) AND (subject_binding_epoch IS NULL)) OR ((subject_key_id IS NOT NULL) AND (subject_binding_event_id IS NOT NULL) AND (subject_binding_epoch IS NOT NULL))))
);

CREATE TABLE hns_authority_inventories (
    registry_reference text NOT NULL,
    authority_inventory_reference text NOT NULL,
    authority_inventory_version text NOT NULL,
    authority_inventory_digest text NOT NULL,
    environment text NOT NULL,
    runtime_capability_set_digest text NOT NULL,
    inventory_bytes bytea NOT NULL,
    published_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT hns_authority_inventories_bytes_check CHECK (((octet_length(inventory_bytes) >= 1) AND (octet_length(inventory_bytes) <= 65536))),
    CONSTRAINT hns_authority_inventories_digest_check CHECK (((authority_inventory_digest ~ '^[0-9a-f]{64}$'::text) AND (runtime_capability_set_digest ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(inventory_bytes), 'hex'::text) = authority_inventory_digest))),
    CONSTRAINT hns_authority_inventories_identity_check CHECK (((registry_reference ~ '^[a-z][a-z0-9-]{0,63}:[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'::text) AND (authority_inventory_reference ~ '^[a-z][a-z0-9-]{0,63}:[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'::text) AND (btrim(authority_inventory_version) <> ''::text) AND (authority_inventory_version = btrim(authority_inventory_version)) AND (octet_length(authority_inventory_version) <= 256) AND (authority_inventory_version !~ '[[:cntrl:]]'::text) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)) AND (octet_length(environment) <= 256) AND (environment !~ '[[:cntrl:]]'::text))),
    CONSTRAINT hns_authority_inventories_time_check CHECK ((expires_at > published_at))
);

CREATE TABLE hns_control_observer_configurations (
    provider_configuration_reference text NOT NULL,
    provider_configuration_version text NOT NULL,
    provider_configuration_digest text NOT NULL,
    configuration_bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT hns_control_observer_configurations_bytes_check CHECK (((octet_length(configuration_bytes) >= 1) AND (octet_length(configuration_bytes) <= 8192))),
    CONSTRAINT hns_control_observer_configurations_digest_check CHECK (((provider_configuration_digest ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(configuration_bytes), 'hex'::text) = provider_configuration_digest))),
    CONSTRAINT hns_control_observer_configurations_identity_check CHECK (((btrim(provider_configuration_reference) <> ''::text) AND (provider_configuration_reference = btrim(provider_configuration_reference)) AND (octet_length(provider_configuration_reference) <= 512) AND (provider_configuration_reference !~ '[[:cntrl:]]'::text) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (octet_length(provider_configuration_version) <= 256) AND (provider_configuration_version !~ '[[:cntrl:]]'::text)))
);

CREATE TABLE hns_control_observer_operations (
    observation_id text NOT NULL,
    provider_configuration_reference text NOT NULL,
    provider_configuration_version text NOT NULL,
    provider_configuration_digest text NOT NULL,
    request_bytes bytea NOT NULL,
    request_sha256 text NOT NULL,
    configuration_bytes bytea NOT NULL,
    snapshot_reference text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT hns_control_observer_operations_configuration_check CHECK (((octet_length(configuration_bytes) >= 1) AND (octet_length(configuration_bytes) <= 8192) AND (provider_configuration_digest ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(configuration_bytes), 'hex'::text) = provider_configuration_digest))),
    CONSTRAINT hns_control_observer_operations_observation_check CHECK (((btrim(observation_id) <> ''::text) AND (observation_id = btrim(observation_id)) AND (octet_length(observation_id) <= 256) AND (observation_id !~ '[[:cntrl:]]'::text))),
    CONSTRAINT hns_control_observer_operations_request_check CHECK (((octet_length(request_bytes) >= 1) AND (octet_length(request_bytes) <= 32768) AND (request_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT hns_control_observer_operations_snapshot_reference_check CHECK (((octet_length(snapshot_reference) <= 424) AND (snapshot_reference ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,127}){1,3}$'::text)))
);

CREATE TABLE hns_control_observer_reservations (
    observation_id text NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    reservation_lease_seconds integer NOT NULL,
    observer_fence bigint NOT NULL,
    reservation_database_time timestamp with time zone NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    terminal_snapshot_reference text,
    terminal_status text,
    terminal_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT hns_control_observer_reservations_lease_check CHECK (((reservation_lease_seconds >= 4) AND (reservation_lease_seconds <= 60) AND ((observer_fence >= 1) AND (observer_fence <= '9007199254740991'::bigint)) AND (lease_expires_at = (reservation_database_time + ((reservation_lease_seconds)::double precision * '00:00:01'::interval))) AND (updated_at >= created_at))),
    CONSTRAINT hns_control_observer_reservations_state_check CHECK ((((state = 'reserved'::text) AND (terminal_snapshot_reference IS NULL) AND (terminal_status IS NULL) AND (terminal_at IS NULL)) OR ((state = 'terminal'::text) AND (terminal_snapshot_reference IS NOT NULL) AND (terminal_status = ANY (ARRAY['verified'::text, 'rejected'::text, 'unavailable'::text, 'ineligible'::text])) AND (terminal_at IS NOT NULL) AND (terminal_at = updated_at) AND (terminal_at >= reservation_database_time) AND (terminal_at < lease_expires_at))))
);

CREATE TABLE hns_control_observer_snapshot_transcript_entries (
    snapshot_reference text NOT NULL,
    entry_ordinal smallint NOT NULL,
    driver_reference text NOT NULL,
    ownership_source text NOT NULL,
    method_or_view_id text NOT NULL,
    request_bytes bytea NOT NULL,
    request_sha256 text NOT NULL,
    transport_outcome text NOT NULL,
    transport_status integer,
    response_bytes bytea,
    response_sha256 text,
    CONSTRAINT hns_control_observer_snapshot_transcript_entries_identity_check CHECK (((btrim(driver_reference) <> ''::text) AND (driver_reference = btrim(driver_reference)) AND (octet_length(driver_reference) <= 256) AND (driver_reference !~ '[[:cntrl:]]'::text) AND (btrim(method_or_view_id) <> ''::text) AND (method_or_view_id = btrim(method_or_view_id)) AND (octet_length(method_or_view_id) <= 256) AND (method_or_view_id !~ '[[:cntrl:]]'::text) AND (ownership_source = ANY (ARRAY['hns_parent_chain_txt'::text, 'owner_authoritative_dns_txt'::text])))),
    CONSTRAINT hns_control_observer_snapshot_transcript_entries_ordinal_check CHECK (((entry_ordinal >= 0) AND (entry_ordinal <= 15))),
    CONSTRAINT hns_control_observer_snapshot_transcript_entries_request_check CHECK (((octet_length(request_bytes) >= 1) AND (octet_length(request_bytes) <= 4096) AND (request_sha256 ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(request_bytes), 'hex'::text) = request_sha256))),
    CONSTRAINT hns_control_observer_snapshot_transcript_entries_response_check CHECK ((((transport_outcome = 'response'::text) AND (response_bytes IS NOT NULL) AND ((octet_length(response_bytes) >= 1) AND (octet_length(response_bytes) <= 1048576)) AND (response_sha256 IS NOT NULL) AND (response_sha256 ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(response_bytes), 'hex'::text) = response_sha256) AND ((transport_status IS NULL) OR ((transport_status >= 100) AND (transport_status <= 599)))) OR ((transport_outcome = ANY (ARRAY['timeout'::text, 'transport_error'::text, 'aborted'::text])) AND (transport_status IS NULL) AND (response_bytes IS NULL) AND (response_sha256 IS NULL))))
);

CREATE TABLE hns_control_observer_snapshots (
    snapshot_reference text NOT NULL,
    observation_id text NOT NULL,
    observer_fence bigint NOT NULL,
    request_bytes bytea NOT NULL,
    request_sha256 text NOT NULL,
    configuration_bytes bytea NOT NULL,
    provider_configuration_digest text NOT NULL,
    reservation_database_time timestamp with time zone NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    semantic_facts_bytes bytea NOT NULL,
    result_status text NOT NULL,
    result_reference_kind text NOT NULL,
    result_reference text NOT NULL,
    result_bytes bytea NOT NULL,
    result_sha256 text NOT NULL,
    transcript_entry_count smallint NOT NULL,
    transcript_byte_length bigint NOT NULL,
    accounting_envelope_bytes bytea NOT NULL,
    logical_snapshot_byte_length bigint NOT NULL,
    retained_at timestamp with time zone NOT NULL,
    authority_inventory_bytes bytea,
    authority_inventory_reference text,
    authority_inventory_version text,
    authority_inventory_digest text,
    semantic_facts_sha256 text,
    transcript_manifest_sha256 text,
    observer_snapshot_sha256 text,
    CONSTRAINT hns_control_observer_snapshots_bytes_check CHECK (((octet_length(request_bytes) >= 1) AND (octet_length(request_bytes) <= 32768) AND ((octet_length(configuration_bytes) >= 1) AND (octet_length(configuration_bytes) <= 8192)) AND ((authority_inventory_bytes IS NULL) OR ((octet_length(authority_inventory_bytes) >= 1) AND (octet_length(authority_inventory_bytes) <= 65536))) AND ((octet_length(semantic_facts_bytes) >= 1) AND (octet_length(semantic_facts_bytes) <= 10485760)) AND ((octet_length(result_bytes) >= 1) AND (octet_length(result_bytes) <= 1048576)) AND (octet_length(accounting_envelope_bytes) > 0) AND ((transcript_entry_count >= 0) AND (transcript_entry_count <= 16)) AND ((transcript_byte_length >= 0) AND (transcript_byte_length <= 7929848)) AND ((logical_snapshot_byte_length >= 1) AND (logical_snapshot_byte_length <= 10485760)))),
    CONSTRAINT hns_control_observer_snapshots_hash_check CHECK (((request_sha256 ~ '^[0-9a-f]{64}$'::text) AND (provider_configuration_digest ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(configuration_bytes), 'hex'::text) = provider_configuration_digest) AND (result_sha256 ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(result_bytes), 'hex'::text) = result_sha256) AND ((authority_inventory_digest IS NULL) OR ((authority_inventory_digest ~ '^[0-9a-f]{64}$'::text) AND (authority_inventory_bytes IS NOT NULL) AND (encode(sha256(authority_inventory_bytes), 'hex'::text) = authority_inventory_digest))) AND ((semantic_facts_sha256 IS NULL) OR ((semantic_facts_sha256 ~ '^[0-9a-f]{64}$'::text) AND (encode(sha256(semantic_facts_bytes), 'hex'::text) = semantic_facts_sha256))) AND ((transcript_manifest_sha256 IS NULL) OR (transcript_manifest_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((observer_snapshot_sha256 IS NULL) OR (observer_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT hns_control_observer_snapshots_reference_check CHECK (((result_reference = snapshot_reference) AND (octet_length(result_reference) <= 424) AND (result_reference ~ '^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,127}){1,3}$'::text) AND (((result_status = ANY (ARRAY['verified'::text, 'rejected'::text])) AND (result_reference_kind = 'provider_evidence_ref'::text)) OR ((result_status = ANY (ARRAY['unavailable'::text, 'ineligible'::text])) AND (result_reference_kind = 'diagnostic_ref'::text))))),
    CONSTRAINT hns_control_observer_snapshots_time_check CHECK (((retained_at >= reservation_database_time) AND (retained_at < lease_expires_at)))
);

CREATE TABLE home_feed_projection (
    community_id text NOT NULL,
    feed_item_id text NOT NULL,
    post_id text NOT NULL,
    rank_score double precision DEFAULT 0 NOT NULL,
    projected_at timestamp with time zone NOT NULL
);

CREATE TABLE identity_credentials (
    credential_id text NOT NULL,
    provider text NOT NULL,
    provider_app_id text NOT NULL,
    provider_subject text NOT NULL,
    canonical_user_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tombstoned_at timestamp with time zone,
    CONSTRAINT identity_credentials_app_not_blank CHECK ((btrim(provider_app_id) <> ''::text)),
    CONSTRAINT identity_credentials_canonical_values CHECK (((provider_app_id = btrim(provider_app_id)) AND (provider_subject = btrim(provider_subject)))),
    CONSTRAINT identity_credentials_id_not_blank CHECK ((btrim(credential_id) <> ''::text)),
    CONSTRAINT identity_credentials_provider_check CHECK ((provider = 'privy'::text)),
    CONSTRAINT identity_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'tombstoned'::text]))),
    CONSTRAINT identity_credentials_subject_not_blank CHECK ((btrim(provider_subject) <> ''::text)),
    CONSTRAINT identity_credentials_tombstone_time_check CHECK ((((status = 'active'::text) AND (tombstoned_at IS NULL)) OR ((status = 'tombstoned'::text) AND (tombstoned_at IS NOT NULL)))),
    CONSTRAINT identity_credentials_user_not_blank CHECK ((btrim(canonical_user_id) <> ''::text))
);

CREATE TABLE media_alignment_projections (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    post_id text NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    alignment_revision bigint DEFAULT 0 NOT NULL,
    status text NOT NULL,
    current_artifact_ref text,
    current_artifact_revision bigint,
    failure_code text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_alignment_artifact_pointer_shape CHECK ((((current_artifact_ref IS NULL) AND (current_artifact_revision IS NULL)) OR ((current_artifact_ref IS NOT NULL) AND (current_artifact_revision > 0)))),
    CONSTRAINT media_alignment_outcome_shape CHECK ((((status = 'unavailable'::text) AND (failure_code IS NOT NULL) AND (current_artifact_ref IS NULL) AND (current_artifact_revision IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'ready'::text])) AND (failure_code IS NULL)))),
    CONSTRAINT media_alignment_projections_alignment_revision_check CHECK ((alignment_revision >= 0)),
    CONSTRAINT media_alignment_projections_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_alignment_projections_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_alignment_projections_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_alignment_projections_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['elevenlabs_key_missing'::text, 'key_invalid'::text, 'rate_limited'::text, 'provider_unavailable'::text, 'timeout'::text, 'invalid_response'::text, 'alignment_failed'::text, 'lyrics_missing'::text, 'audio_missing'::text])))),
    CONSTRAINT media_alignment_projections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'unavailable'::text])))
);

CREATE TABLE media_analysis_evidence (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    analysis_version text NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    finalized_audio_ref text NOT NULL,
    probe_evidence_ref text NOT NULL,
    embedded_metadata_evidence_ref text NOT NULL,
    embedded_metadata_adapter_revision text NOT NULL,
    embedded_title text,
    embedded_title_provenance text NOT NULL,
    cover_status text NOT NULL,
    cover_artifact_ref text,
    cover_artifact_sha256 text,
    cover_media_type text,
    cover_width integer,
    cover_height integer,
    cover_normalization_revision text,
    cover_safety_policy_revision text,
    cover_facts jsonb NOT NULL,
    speech_status text NOT NULL,
    transcript_artifact_ref text,
    transcript_sha256 text,
    explicitness text NOT NULL,
    primary_language_bcp47 text,
    secondary_language_bcp47 text,
    speech_evidence_ref text NOT NULL,
    speech_policy_revision text NOT NULL,
    speech_adapter_revision text NOT NULL,
    acr_decision text NOT NULL,
    acr_evidence_ref text NOT NULL,
    acr_policy_revision text NOT NULL,
    acr_adapter_revision text NOT NULL,
    media_safety text NOT NULL,
    lyrics_safety text NOT NULL,
    bound_reference_asset_id text,
    bound_reference_audio_revision bigint,
    bound_reference_analysis_revision bigint,
    bound_reference_audio_sha256 text,
    bound_reference_upstream_share_bps integer,
    analysis_snapshot jsonb NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_analysis_cover_shape CHECK ((((cover_status = 'ready'::text) AND (cover_artifact_ref IS NOT NULL) AND (cover_artifact_sha256 IS NOT NULL) AND (cover_media_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])) AND (cover_width IS NOT NULL) AND (cover_height IS NOT NULL) AND (cover_width > 0) AND (cover_height > 0) AND (btrim(cover_normalization_revision) <> ''::text) AND (btrim(cover_safety_policy_revision) <> ''::text) AND (NOT (cover_facts ? 'reasonCode'::text))) OR ((cover_status = 'absent'::text) AND ((cover_facts ->> 'reasonCode'::text) IS NOT NULL) AND ((cover_facts ->> 'reasonCode'::text) = 'not_embedded'::text) AND (cover_artifact_ref IS NULL) AND (cover_artifact_sha256 IS NULL) AND (cover_media_type IS NULL) AND (cover_width IS NULL) AND (cover_height IS NULL) AND (cover_normalization_revision IS NULL) AND (cover_safety_policy_revision IS NULL)) OR ((cover_status = 'rejected'::text) AND ((cover_facts ->> 'reasonCode'::text) IS NOT NULL) AND ((cover_facts ->> 'reasonCode'::text) = ANY (ARRAY['invalid'::text, 'unsafe'::text, 'limits_exceeded'::text])) AND (cover_artifact_ref IS NULL) AND (cover_artifact_sha256 IS NULL) AND (cover_media_type IS NULL) AND (cover_width IS NULL) AND (cover_height IS NULL) AND (cover_normalization_revision IS NULL) AND (cover_safety_policy_revision IS NULL)))),
    CONSTRAINT media_analysis_evidence_acr_adapter_revision_check CHECK ((btrim(acr_adapter_revision) <> ''::text)),
    CONSTRAINT media_analysis_evidence_acr_decision_check CHECK ((acr_decision = ANY (ARRAY['allow'::text, 'requires_reference'::text, 'inconclusive'::text, 'skipped'::text]))),
    CONSTRAINT media_analysis_evidence_acr_evidence_ref_check CHECK ((btrim(acr_evidence_ref) <> ''::text)),
    CONSTRAINT media_analysis_evidence_acr_policy_revision_check CHECK ((btrim(acr_policy_revision) <> ''::text)),
    CONSTRAINT media_analysis_evidence_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_analysis_evidence_analysis_snapshot_check CHECK ((jsonb_typeof(analysis_snapshot) = 'object'::text)),
    CONSTRAINT media_analysis_evidence_analysis_version_check CHECK ((analysis_version = 'song-trusted-analysis-v1'::text)),
    CONSTRAINT media_analysis_evidence_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_analysis_evidence_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_analysis_evidence_cover_artifact_sha256_check CHECK (((cover_artifact_sha256 IS NULL) OR (cover_artifact_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT media_analysis_evidence_cover_facts_check CHECK ((jsonb_typeof(cover_facts) = 'object'::text)),
    CONSTRAINT media_analysis_evidence_cover_status_check CHECK ((cover_status = ANY (ARRAY['ready'::text, 'absent'::text, 'rejected'::text]))),
    CONSTRAINT media_analysis_evidence_embedded_metadata_adapter_revisio_check CHECK ((btrim(embedded_metadata_adapter_revision) <> ''::text)),
    CONSTRAINT media_analysis_evidence_embedded_metadata_evidence_ref_check CHECK ((btrim(embedded_metadata_evidence_ref) <> ''::text)),
    CONSTRAINT media_analysis_evidence_embedded_title_provenance_check CHECK ((embedded_title_provenance = ANY (ARRAY['embedded'::text, 'absent'::text]))),
    CONSTRAINT media_analysis_evidence_explicitness_check CHECK ((explicitness = ANY (ARRAY['not_explicit'::text, 'explicit'::text, 'uncertain'::text, 'no_lyrics'::text]))),
    CONSTRAINT media_analysis_evidence_lyrics_safety_check CHECK ((lyrics_safety = ANY (ARRAY['skipped'::text, 'allow'::text, 'review_required'::text, 'blocked'::text]))),
    CONSTRAINT media_analysis_evidence_media_safety_check CHECK ((media_safety = ANY (ARRAY['allow'::text, 'draft'::text, 'review_required'::text, 'blocked'::text]))),
    CONSTRAINT media_analysis_evidence_probe_evidence_ref_check CHECK ((btrim(probe_evidence_ref) <> ''::text)),
    CONSTRAINT media_analysis_evidence_speech_adapter_revision_check CHECK ((btrim(speech_adapter_revision) <> ''::text)),
    CONSTRAINT media_analysis_evidence_speech_evidence_ref_check CHECK ((btrim(speech_evidence_ref) <> ''::text)),
    CONSTRAINT media_analysis_evidence_speech_policy_revision_check CHECK ((btrim(speech_policy_revision) <> ''::text)),
    CONSTRAINT media_analysis_evidence_speech_status_check CHECK ((speech_status = ANY (ARRAY['ready'::text, 'no_speech'::text, 'unavailable'::text]))),
    CONSTRAINT media_analysis_evidence_transcript_sha256_check CHECK (((transcript_sha256 IS NULL) OR (transcript_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT media_analysis_reference_shape CHECK ((((bound_reference_asset_id IS NULL) AND (bound_reference_audio_revision IS NULL) AND (bound_reference_analysis_revision IS NULL) AND (bound_reference_audio_sha256 IS NULL) AND (bound_reference_upstream_share_bps IS NULL)) OR ((bound_reference_asset_id IS NOT NULL) AND (bound_reference_audio_revision = audio_revision) AND (bound_reference_analysis_revision > 0) AND (bound_reference_analysis_revision <= analysis_revision) AND (bound_reference_audio_sha256 = canonical_audio_sha256) AND ((bound_reference_upstream_share_bps IS NULL) OR ((bound_reference_upstream_share_bps >= 0) AND (bound_reference_upstream_share_bps <= 10000)))))),
    CONSTRAINT media_analysis_speech_shape CHECK ((((speech_status = 'ready'::text) AND (transcript_artifact_ref IS NOT NULL) AND (transcript_sha256 IS NOT NULL) AND (explicitness = ANY (ARRAY['not_explicit'::text, 'explicit'::text, 'uncertain'::text])) AND (primary_language_bcp47 IS NOT NULL) AND (char_length(primary_language_bcp47) <= 35) AND (primary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'::text) AND ((secondary_language_bcp47 IS NULL) OR ((char_length(secondary_language_bcp47) <= 35) AND (secondary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'::text) AND (secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47))) AND (lyrics_safety = ANY (ARRAY['skipped'::text, 'allow'::text]))) OR ((speech_status = 'no_speech'::text) AND (transcript_artifact_ref IS NULL) AND (transcript_sha256 IS NULL) AND (explicitness = 'no_lyrics'::text) AND (primary_language_bcp47 IS NULL) AND (secondary_language_bcp47 IS NULL) AND (lyrics_safety = 'skipped'::text)) OR ((speech_status = 'unavailable'::text) AND (transcript_artifact_ref IS NULL) AND (transcript_sha256 IS NULL) AND (explicitness = 'uncertain'::text) AND (primary_language_bcp47 IS NULL) AND (secondary_language_bcp47 IS NULL) AND (lyrics_safety = 'review_required'::text)))),
    CONSTRAINT media_analysis_title_shape CHECK ((((embedded_title_provenance = 'embedded'::text) AND (embedded_title IS NOT NULL) AND (btrim(embedded_title) <> ''::text) AND (char_length(embedded_title) <= 200)) OR ((embedded_title_provenance = 'absent'::text) AND (embedded_title IS NULL))))
);

CREATE TABLE media_audio_revisions (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    audio_revision bigint NOT NULL,
    immutable_ref text NOT NULL,
    canonical_sha256 text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    finalized_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_audio_revisions_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_audio_revisions_canonical_sha256_check CHECK ((canonical_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_audio_revisions_content_type_check CHECK ((content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'::text)),
    CONSTRAINT media_audio_revisions_size_bytes_check CHECK ((size_bytes > 0))
);

CREATE TABLE media_immutable_objects (
    immutable_ref text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    reservation_id text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    destination_ref text NOT NULL,
    etag text NOT NULL,
    object_version text NOT NULL,
    size_bytes bigint NOT NULL,
    content_type text NOT NULL,
    canonical_sha256 text NOT NULL,
    sealed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_immutable_objects_canonical_sha256_check CHECK ((canonical_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_immutable_objects_content_type_check CHECK ((content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'::text)),
    CONSTRAINT media_immutable_objects_destination_ref_check CHECK ((btrim(destination_ref) <> ''::text)),
    CONSTRAINT media_immutable_objects_etag_check CHECK ((btrim(etag) <> ''::text)),
    CONSTRAINT media_immutable_objects_immutable_ref_check CHECK ((btrim(immutable_ref) <> ''::text)),
    CONSTRAINT media_immutable_objects_object_version_check CHECK ((btrim(object_version) <> ''::text)),
    CONSTRAINT media_immutable_objects_size_bytes_check CHECK ((size_bytes > 0))
);

CREATE TABLE media_moderation_actions (
    action_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    authority_actor_user_id text NOT NULL,
    action_kind text NOT NULL,
    approval_kind text,
    reason_code text,
    held_revision bigint NOT NULL,
    decision_revision bigint,
    evidence_ref text NOT NULL,
    decision_snapshot jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_moderation_action_shape CHECK ((((action_kind IS NOT NULL) AND (action_kind = 'approve'::text) AND (approval_kind IS NOT NULL) AND (decision_revision IS NOT NULL) AND (decision_snapshot IS NOT NULL) AND (jsonb_typeof(decision_snapshot) = 'object'::text) AND (((approval_kind = 'acr_override'::text) AND (reason_code IS NOT NULL) AND (reason_code = ANY (ARRAY['acr_inconclusive'::text, 'acr_exhausted'::text, 'acr_skipped'::text]))) OR ((approval_kind = 'standard'::text) AND (reason_code IS NULL)))) OR ((action_kind IS NOT NULL) AND (action_kind = 'block'::text) AND (approval_kind IS NULL) AND (reason_code IS NOT NULL) AND (reason_code = 'policy_violation'::text) AND (decision_revision IS NULL) AND (decision_snapshot IS NOT NULL) AND (decision_snapshot = '{"reasonCode": "policy_violation"}'::jsonb)))),
    CONSTRAINT media_moderation_actions_action_id_check CHECK ((btrim(action_id) <> ''::text)),
    CONSTRAINT media_moderation_actions_action_kind_check CHECK ((action_kind = ANY (ARRAY['approve'::text, 'block'::text]))),
    CONSTRAINT media_moderation_actions_approval_kind_check CHECK (((approval_kind IS NULL) OR (approval_kind = ANY (ARRAY['standard'::text, 'acr_override'::text])))),
    CONSTRAINT media_moderation_actions_evidence_ref_check CHECK ((btrim(evidence_ref) <> ''::text)),
    CONSTRAINT media_moderation_actions_reason_code_check CHECK (((reason_code IS NULL) OR (reason_code = ANY (ARRAY['acr_inconclusive'::text, 'acr_exhausted'::text, 'acr_skipped'::text, 'policy_violation'::text]))))
);

CREATE TABLE media_moderation_projections (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    status text NOT NULL,
    decision_revision bigint,
    review_ref text,
    held_revision bigint,
    review_exhaustion_code text,
    review_exhaustion_attempt_id text,
    action_kind text,
    moderator_action_id text,
    moderator_actor_id text,
    action_evidence_ref text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_moderation_projection_exhaustion_shape CHECK ((((review_exhaustion_code IS NULL) AND (review_exhaustion_attempt_id IS NULL)) OR ((review_exhaustion_code = 'acr_exhausted'::text) AND (review_exhaustion_attempt_id IS NOT NULL) AND (status = 'open'::text) AND (held_revision IS NOT NULL)))),
    CONSTRAINT media_moderation_projections_action_kind_check CHECK (((action_kind IS NULL) OR (action_kind = ANY (ARRAY['approve'::text, 'block'::text])))),
    CONSTRAINT media_moderation_projections_review_exhaustion_code_check CHECK (((review_exhaustion_code IS NULL) OR (review_exhaustion_code = 'acr_exhausted'::text))),
    CONSTRAINT media_moderation_projections_status_check CHECK ((status = ANY (ARRAY['none'::text, 'open'::text, 'approved'::text, 'blocked'::text, 'closed'::text])))
);

CREATE TABLE media_post_submissions (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    endpoint_template text DEFAULT '/communities/:communityId/media-post-submissions'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    title text NOT NULL,
    song_type text NOT NULL,
    start_input jsonb NOT NULL,
    audio_reservation_id text NOT NULL,
    creation_revision bigint DEFAULT 1 NOT NULL,
    audio_revision bigint DEFAULT 0 NOT NULL,
    analysis_revision bigint DEFAULT 0 NOT NULL,
    decision_revision bigint DEFAULT 0 NOT NULL,
    workflow_revision bigint DEFAULT 0 NOT NULL,
    event_sequence bigint DEFAULT 1 NOT NULL,
    current_terms_revision bigint,
    current_immutable_ref text,
    current_analysis_revision bigint,
    current_decision_revision bigint,
    bound_reference_asset_id text,
    bound_reference_evidence_ref text,
    bound_reference_audio_revision bigint,
    bound_reference_analysis_revision bigint,
    bound_reference_audio_sha256 text,
    bound_reference_upstream_share_bps integer,
    status text DEFAULT 'processing'::text NOT NULL,
    phase text DEFAULT 'reserve'::text,
    post_id text,
    failure_code text,
    retry_count integer DEFAULT 0 NOT NULL,
    failure_retry_count integer,
    retryable boolean,
    last_safe_phase text,
    action_kind text,
    action_reference_request_ref text,
    action_expires_at timestamp with time zone,
    held_revision bigint,
    review_ref text,
    review_reason_code text,
    review_exhaustion_code text,
    review_exhaustion_attempt_id text,
    moderator_action_id text,
    moderator_actor_id text,
    moderator_evidence_ref text,
    moderator_approval_kind text,
    moderator_reason_code text,
    abandonment_reason text,
    retention_disposition text,
    response_snapshot_bytes bytea NOT NULL,
    response_snapshot_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_post_submissions_abandonment_reason_check CHECK (((abandonment_reason IS NULL) OR (abandonment_reason = ANY (ARRAY['author_cancelled'::text, 'reservation_expired'::text, 'action_deadline_elapsed'::text, 'upload_expectation_mismatch'::text, 'upload_source_changed_before_finalize'::text])))),
    CONSTRAINT media_post_submissions_action_kind_check CHECK (((action_kind IS NULL) OR (action_kind = 'reference_required'::text))),
    CONSTRAINT media_post_submissions_analysis_revision_check CHECK ((analysis_revision >= 0)),
    CONSTRAINT media_post_submissions_audio_revision_check CHECK ((audio_revision >= 0)),
    CONSTRAINT media_post_submissions_creation_revision_check CHECK ((creation_revision > 0)),
    CONSTRAINT media_post_submissions_decision_revision_check CHECK ((decision_revision >= 0)),
    CONSTRAINT media_post_submissions_endpoint_template_check CHECK ((endpoint_template = '/communities/:communityId/media-post-submissions'::text)),
    CONSTRAINT media_post_submissions_event_sequence_check CHECK ((event_sequence > 0)),
    CONSTRAINT media_post_submissions_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['invalid_media'::text, 'unsupported_media'::text, 'probe_failed'::text, 'hash_failed'::text, 'transform_failed'::text, 'publication_failed'::text, 'upload_seal_conflict'::text])))),
    CONSTRAINT media_post_submissions_failure_retry_count_check CHECK (((failure_retry_count IS NULL) OR ((failure_retry_count >= 0) AND (failure_retry_count <= 3)))),
    CONSTRAINT media_post_submissions_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT media_post_submissions_last_safe_phase_check CHECK (((last_safe_phase IS NULL) OR (last_safe_phase = ANY (ARRAY['reserve'::text, 'awaiting_upload'::text, 'finalize'::text, 'analysis'::text, 'decision'::text, 'publish'::text])))),
    CONSTRAINT media_post_submissions_moderator_approval_kind_check CHECK (((moderator_approval_kind IS NULL) OR (moderator_approval_kind = ANY (ARRAY['standard'::text, 'acr_override'::text])))),
    CONSTRAINT media_post_submissions_moderator_reason_code_check CHECK (((moderator_reason_code IS NULL) OR (moderator_reason_code = ANY (ARRAY['acr_inconclusive'::text, 'acr_exhausted'::text, 'acr_skipped'::text, 'policy_violation'::text])))),
    CONSTRAINT media_post_submissions_operation_id_check CHECK ((btrim(operation_id) <> ''::text)),
    CONSTRAINT media_post_submissions_phase_check CHECK (((phase IS NULL) OR (phase = ANY (ARRAY['reserve'::text, 'awaiting_upload'::text, 'finalize'::text, 'analysis'::text, 'decision'::text, 'publish'::text])))),
    CONSTRAINT media_post_submissions_reference_shape CHECK ((((bound_reference_asset_id IS NULL) AND (bound_reference_evidence_ref IS NULL) AND (bound_reference_audio_revision IS NULL) AND (bound_reference_analysis_revision IS NULL) AND (bound_reference_audio_sha256 IS NULL) AND (bound_reference_upstream_share_bps IS NULL)) OR ((bound_reference_asset_id IS NOT NULL) AND (bound_reference_evidence_ref IS NOT NULL) AND (btrim(bound_reference_evidence_ref) <> ''::text) AND (bound_reference_audio_revision = audio_revision) AND (bound_reference_analysis_revision > 0) AND (bound_reference_analysis_revision <= analysis_revision) AND (bound_reference_audio_sha256 ~ '^[0-9a-f]{64}$'::text) AND ((bound_reference_upstream_share_bps IS NULL) OR ((bound_reference_upstream_share_bps >= 0) AND (bound_reference_upstream_share_bps <= 10000)))))),
    CONSTRAINT media_post_submissions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_post_submissions_response_hash CHECK (((octet_length(response_snapshot_bytes) > 0) AND (encode(sha256(response_snapshot_bytes), 'hex'::text) = response_snapshot_sha256))),
    CONSTRAINT media_post_submissions_response_snapshot_sha256_check CHECK ((response_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_post_submissions_retention_disposition_check CHECK (((retention_disposition IS NULL) OR (retention_disposition = ANY (ARRAY['no_object'::text, 'retain_for_reconciliation'::text, 'retain_until_expiry'::text])))),
    CONSTRAINT media_post_submissions_retry_count_check CHECK (((retry_count >= 0) AND (retry_count <= 3))),
    CONSTRAINT media_post_submissions_review_exhaustion_code_check CHECK (((review_exhaustion_code IS NULL) OR (review_exhaustion_code = 'acr_exhausted'::text))),
    CONSTRAINT media_post_submissions_review_exhaustion_shape CHECK ((((review_exhaustion_code IS NULL) AND (review_exhaustion_attempt_id IS NULL)) OR ((review_exhaustion_code = 'acr_exhausted'::text) AND (review_exhaustion_attempt_id IS NOT NULL) AND (status = 'manual_review'::text)))),
    CONSTRAINT media_post_submissions_review_reason_code_check CHECK (((review_reason_code IS NULL) OR (review_reason_code = ANY (ARRAY['review_required'::text, 'moderation_unavailable'::text])))),
    CONSTRAINT media_post_submissions_revision_shape CHECK ((((audio_revision = 0) AND (current_immutable_ref IS NULL)) OR ((audio_revision > 0) AND (current_immutable_ref IS NOT NULL)))),
    CONSTRAINT media_post_submissions_shape CHECK ((((status = 'processing'::text) AND (phase IS NOT NULL) AND (post_id IS NULL)) OR ((status = 'action_required'::text) AND (phase IS NULL) AND (action_kind = 'reference_required'::text) AND (action_reference_request_ref IS NOT NULL) AND (action_expires_at IS NOT NULL) AND (held_revision = creation_revision) AND (post_id IS NULL)) OR ((status = 'manual_review'::text) AND (phase IS NULL) AND (review_ref IS NOT NULL) AND (held_revision = creation_revision) AND (post_id IS NULL) AND ((review_exhaustion_code IS NULL) OR (review_exhaustion_code = 'acr_exhausted'::text))) OR ((status = 'published'::text) AND (phase IS NULL) AND (post_id IS NOT NULL) AND (failure_code IS NULL)) OR ((status = 'blocked'::text) AND (phase IS NULL) AND (post_id IS NULL)) OR ((status = 'processing_failed'::text) AND (phase IS NULL) AND (failure_code IS NOT NULL) AND (failure_retry_count IS NOT NULL) AND (retryable IS NOT NULL) AND (last_safe_phase IS NOT NULL) AND (post_id IS NULL)) OR ((status = 'abandoned'::text) AND (phase IS NULL) AND (post_id IS NULL) AND (abandonment_reason IS NOT NULL) AND (retention_disposition IS NOT NULL) AND (action_kind IS NULL) AND (action_reference_request_ref IS NULL) AND (action_expires_at IS NULL) AND (review_ref IS NULL) AND (review_reason_code IS NULL) AND (review_exhaustion_code IS NULL) AND (held_revision IS NULL) AND (moderator_action_id IS NULL) AND (moderator_actor_id IS NULL) AND (moderator_evidence_ref IS NULL) AND (moderator_approval_kind IS NULL) AND (moderator_reason_code IS NULL)))),
    CONSTRAINT media_post_submissions_song_type_check CHECK ((song_type = ANY (ARRAY['original'::text, 'remix'::text]))),
    CONSTRAINT media_post_submissions_start_input_check CHECK ((jsonb_typeof(start_input) = 'object'::text)),
    CONSTRAINT media_post_submissions_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'action_required'::text, 'manual_review'::text, 'published'::text, 'blocked'::text, 'processing_failed'::text, 'abandoned'::text]))),
    CONSTRAINT media_post_submissions_submission_id_check CHECK ((btrim(submission_id) <> ''::text)),
    CONSTRAINT media_post_submissions_title_check CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200))),
    CONSTRAINT media_post_submissions_workflow_revision_check CHECK ((workflow_revision >= 0))
);

CREATE TABLE media_processing_attempts (
    attempt_id text NOT NULL,
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    stage text NOT NULL,
    attempt_number integer NOT NULL,
    input_hash text NOT NULL,
    provider_idempotency_key text NOT NULL,
    input_kind text NOT NULL,
    input_revision bigint NOT NULL,
    policy_revision text NOT NULL,
    adapter_revision text NOT NULL,
    state text NOT NULL,
    claim_owner text,
    claim_fence bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    next_eligible_at timestamp with time zone,
    retryable boolean,
    failure_code text,
    evidence_ref text,
    result jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_processing_attempt_state_shape CHECK ((((state = 'pending'::text) AND (claim_owner IS NULL) AND (claim_fence = 0) AND (lease_expires_at IS NULL) AND (next_eligible_at IS NULL) AND (retryable IS NULL) AND (failure_code IS NULL) AND (evidence_ref IS NULL) AND (result IS NULL)) OR ((state = 'running'::text) AND (claim_owner IS NOT NULL) AND (claim_fence > 0) AND (lease_expires_at IS NOT NULL) AND (next_eligible_at IS NULL) AND (retryable IS NULL) AND (failure_code IS NULL) AND (evidence_ref IS NULL) AND (result IS NULL)) OR ((state = 'retry_wait'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND (lease_expires_at IS NULL) AND (retryable = true) AND (next_eligible_at IS NOT NULL) AND (failure_code IS NOT NULL) AND (evidence_ref IS NULL) AND (result IS NULL)) OR ((state = 'succeeded'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND (lease_expires_at IS NULL) AND (next_eligible_at IS NULL) AND (retryable IS NULL) AND (failure_code IS NULL) AND (evidence_ref IS NOT NULL) AND (result IS NOT NULL)) OR ((state = 'exhausted'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND (lease_expires_at IS NULL) AND (next_eligible_at IS NULL) AND (retryable = false) AND (failure_code IS NOT NULL) AND (result IS NULL)))),
    CONSTRAINT media_processing_attempts_adapter_revision_check CHECK ((btrim(adapter_revision) <> ''::text)),
    CONSTRAINT media_processing_attempts_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_processing_attempts_attempt_id_check CHECK ((btrim(attempt_id) <> ''::text)),
    CONSTRAINT media_processing_attempts_attempt_number_check CHECK (((attempt_number >= 1) AND (attempt_number <= 3))),
    CONSTRAINT media_processing_attempts_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_processing_attempts_claim_fence_check CHECK ((claim_fence >= 0)),
    CONSTRAINT media_processing_attempts_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['invalid_media'::text, 'unsupported_media'::text, 'probe_failed'::text, 'hash_failed'::text, 'transform_failed'::text, 'publication_failed'::text, 'upload_seal_conflict'::text, 'elevenlabs_key_missing'::text, 'key_invalid'::text, 'rate_limited'::text, 'provider_unavailable'::text, 'timeout'::text, 'invalid_response'::text, 'alignment_failed'::text, 'lyrics_missing'::text, 'audio_missing'::text, 'provider_timeout'::text, 'provider_invalid'::text])))),
    CONSTRAINT media_processing_attempts_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_processing_attempts_input_kind_check CHECK ((input_kind = ANY (ARRAY['audio'::text, 'analysis'::text, 'transcript'::text, 'reference'::text, 'publication'::text]))),
    CONSTRAINT media_processing_attempts_input_revision_check CHECK ((input_revision > 0)),
    CONSTRAINT media_processing_attempts_policy_revision_check CHECK ((btrim(policy_revision) <> ''::text)),
    CONSTRAINT media_processing_attempts_provider_idempotency_key_check CHECK ((btrim(provider_idempotency_key) <> ''::text)),
    CONSTRAINT media_processing_attempts_stage_check CHECK ((stage = ANY (ARRAY['probe'::text, 'embedded_metadata'::text, 'cover'::text, 'transcript'::text, 'acr'::text, 'lyrics_safety'::text, 'media_safety'::text, 'publication'::text]))),
    CONSTRAINT media_processing_attempts_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text, 'succeeded'::text, 'exhausted'::text])))
);

CREATE TABLE media_publication_decisions (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    decision_revision bigint NOT NULL,
    creation_revision bigint NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    outcome text NOT NULL,
    policy_revision text NOT NULL,
    evidence_ref text NOT NULL,
    decision_snapshot jsonb NOT NULL,
    decided_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_publication_decisions_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_publication_decisions_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_publication_decisions_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_publication_decisions_creation_revision_check CHECK ((creation_revision > 1)),
    CONSTRAINT media_publication_decisions_decision_revision_check CHECK ((decision_revision > 0)),
    CONSTRAINT media_publication_decisions_decision_snapshot_check CHECK ((jsonb_typeof(decision_snapshot) = 'object'::text)),
    CONSTRAINT media_publication_decisions_evidence_ref_check CHECK ((btrim(evidence_ref) <> ''::text)),
    CONSTRAINT media_publication_decisions_outcome_check CHECK ((outcome = ANY (ARRAY['allow'::text, 'manual_review'::text, 'block'::text]))),
    CONSTRAINT media_publication_decisions_policy_revision_check CHECK ((btrim(policy_revision) <> ''::text))
);

CREATE TABLE media_publication_projections (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    post_id text NOT NULL,
    creation_revision bigint NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    decision_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    title text NOT NULL,
    audio_asset_ref text NOT NULL,
    cover_artifact_ref text,
    language_status text NOT NULL,
    primary_language_bcp47 text,
    secondary_language_bcp47 text,
    lyrics_explicitness text NOT NULL,
    analysis_badges jsonb DEFAULT '[]'::jsonb NOT NULL,
    alignment text DEFAULT 'pending'::text NOT NULL,
    data_registration text DEFAULT 'pending'::text NOT NULL,
    locked_delivery text DEFAULT 'not_required'::text NOT NULL,
    projected_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_publication_projections_alignment_check CHECK ((alignment = ANY (ARRAY['pending'::text, 'ready'::text, 'unavailable'::text]))),
    CONSTRAINT media_publication_projections_analysis_badges_check CHECK ((analysis_badges = ANY (ARRAY['[]'::jsonb, '["reference_bound"]'::jsonb]))),
    CONSTRAINT media_publication_projections_audio_asset_ref_check CHECK ((btrim(audio_asset_ref) <> ''::text)),
    CONSTRAINT media_publication_projections_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_publication_projections_data_registration_check CHECK ((data_registration = ANY (ARRAY['pending'::text, 'registered'::text, 'failed'::text]))),
    CONSTRAINT media_publication_projections_language_status_check CHECK ((language_status = ANY (ARRAY['ready'::text, 'no_speech'::text, 'unavailable'::text]))),
    CONSTRAINT media_publication_projections_locked_delivery_check CHECK ((locked_delivery = ANY (ARRAY['not_required'::text, 'preparing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT media_publication_projections_lyrics_explicitness_check CHECK ((lyrics_explicitness = ANY (ARRAY['not_explicit'::text, 'explicit'::text, 'no_lyrics'::text, 'uncertain'::text, 'unavailable'::text]))),
    CONSTRAINT media_publication_projections_title_check CHECK ((btrim(title) <> ''::text))
);

CREATE TABLE media_reference_evidence (
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    asset_id text NOT NULL,
    evidence_audio_revision bigint NOT NULL,
    evidence_analysis_revision bigint NOT NULL,
    evidence_audio_sha256 text NOT NULL,
    evidence_ref text NOT NULL,
    upstream_commercial_rev_share_bps integer,
    inherited_license_preset text,
    inherited_commercial_rev_share_bps integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_reference_evidence_asset_id_check CHECK ((btrim(asset_id) <> ''::text)),
    CONSTRAINT media_reference_evidence_evidence_analysis_revision_check CHECK ((evidence_analysis_revision > 0)),
    CONSTRAINT media_reference_evidence_evidence_audio_revision_check CHECK ((evidence_audio_revision > 0)),
    CONSTRAINT media_reference_evidence_evidence_audio_sha256_check CHECK ((evidence_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_reference_evidence_evidence_ref_check CHECK ((btrim(evidence_ref) <> ''::text)),
    CONSTRAINT media_reference_evidence_inherited_commercial_rev_share_b_check CHECK (((inherited_commercial_rev_share_bps IS NULL) OR ((inherited_commercial_rev_share_bps >= 0) AND (inherited_commercial_rev_share_bps <= 10000)))),
    CONSTRAINT media_reference_evidence_inherited_license_preset_check CHECK (((inherited_license_preset IS NULL) OR (inherited_license_preset = ANY (ARRAY['non-commercial'::text, 'commercial-use'::text, 'commercial-remix'::text])))),
    CONSTRAINT media_reference_evidence_upstream_commercial_rev_share_bp_check CHECK (((upstream_commercial_rev_share_bps IS NULL) OR ((upstream_commercial_rev_share_bps >= 0) AND (upstream_commercial_rev_share_bps <= 10000))))
);

CREATE TABLE media_submission_command_replays (
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    submission_actor_user_id text NOT NULL,
    endpoint_template text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    response_snapshot_bytes bytea NOT NULL,
    response_snapshot_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_submission_command_replays_endpoint_template_check CHECK ((btrim(endpoint_template) <> ''::text)),
    CONSTRAINT media_submission_command_replays_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT media_submission_command_replays_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_submission_command_replays_response_hash CHECK (((octet_length(response_snapshot_bytes) > 0) AND (encode(sha256(response_snapshot_bytes), 'hex'::text) = response_snapshot_sha256))),
    CONSTRAINT media_submission_command_replays_response_snapshot_sha256_check CHECK ((response_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE media_submission_events (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    event_sequence bigint NOT NULL,
    event_id text NOT NULL,
    event_kind text NOT NULL,
    creation_revision bigint NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    decision_revision bigint NOT NULL,
    workflow_revision bigint NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_submission_events_analysis_revision_check CHECK ((analysis_revision >= 0)),
    CONSTRAINT media_submission_events_audio_revision_check CHECK ((audio_revision >= 0)),
    CONSTRAINT media_submission_events_creation_revision_check CHECK ((creation_revision > 0)),
    CONSTRAINT media_submission_events_decision_revision_check CHECK ((decision_revision >= 0)),
    CONSTRAINT media_submission_events_event_id_check CHECK ((btrim(event_id) <> ''::text)),
    CONSTRAINT media_submission_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['submission_reserved'::text, 'text_input_bound'::text, 'media_reservation_issued'::text, 'finalize_requested'::text, 'author_cancelled'::text, 'reservation_expired'::text, 'upload_finalized'::text, 'upload_expectation_mismatch_recorded'::text, 'upload_source_precondition_failed'::text, 'seal_conflict_recorded'::text, 'song_terms_bound'::text, 'blocking_analysis_completed'::text, 'review_exhaustion_recorded'::text, 'media_failure_recorded'::text, 'publication_allowed'::text, 'reference_required'::text, 'review_required'::text, 'policy_blocked'::text, 'reference_bound'::text, 'action_deadline_elapsed'::text, 'moderator_approved'::text, 'moderator_blocked'::text, 'publication_committed'::text, 'technical_exhaustion_recorded'::text, 'retry_authorized'::text]))),
    CONSTRAINT media_submission_events_event_sequence_check CHECK ((event_sequence > 0)),
    CONSTRAINT media_submission_events_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT media_submission_events_workflow_revision_check CHECK ((workflow_revision >= 0))
);

CREATE TABLE media_submission_outbox (
    outbox_event_id text NOT NULL,
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    creation_revision bigint NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    workflow_revision bigint NOT NULL,
    workflow_instance_id text NOT NULL,
    event_type text NOT NULL,
    effect_identity text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    delivery_attempts integer DEFAULT 0 NOT NULL,
    claim_owner text,
    claim_fence bigint DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    next_eligible_at timestamp with time zone,
    delivered_at timestamp with time zone,
    failure_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_submission_outbox_analysis_revision_check CHECK ((analysis_revision >= 0)),
    CONSTRAINT media_submission_outbox_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_submission_outbox_check CHECK ((workflow_instance_id = ((('media-'::text || operation_id) || '-r'::text) || (workflow_revision)::text))),
    CONSTRAINT media_submission_outbox_claim_fence_check CHECK ((claim_fence >= 0)),
    CONSTRAINT media_submission_outbox_creation_revision_check CHECK ((creation_revision > 0)),
    CONSTRAINT media_submission_outbox_delivery_attempts_check CHECK (((delivery_attempts >= 0) AND (delivery_attempts <= 3))),
    CONSTRAINT media_submission_outbox_effect_identity_check CHECK ((btrim(effect_identity) <> ''::text)),
    CONSTRAINT media_submission_outbox_event_type_check CHECK ((event_type = ANY (ARRAY['analysis_launch'::text, 'publication'::text, 'alignment'::text]))),
    CONSTRAINT media_submission_outbox_failure_code_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['provider_unavailable'::text, 'provider_timeout'::text, 'provider_invalid'::text])))),
    CONSTRAINT media_submission_outbox_outbox_event_id_check CHECK ((btrim(outbox_event_id) <> ''::text)),
    CONSTRAINT media_submission_outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT media_submission_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'delivered'::text, 'failed'::text, 'exhausted'::text]))),
    CONSTRAINT media_submission_outbox_state_shape CHECK ((((state = 'pending'::text) AND (claim_owner IS NULL) AND (claim_fence = 0) AND (delivery_attempts = 0) AND (lease_expires_at IS NULL) AND (next_eligible_at IS NULL) AND (delivered_at IS NULL) AND (failure_code IS NULL)) OR ((state = 'running'::text) AND (claim_owner IS NOT NULL) AND (claim_fence > 0) AND ((delivery_attempts >= 1) AND (delivery_attempts <= 3)) AND (lease_expires_at IS NOT NULL) AND (next_eligible_at IS NULL) AND (delivered_at IS NULL) AND (failure_code IS NULL)) OR ((state = 'failed'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND ((delivery_attempts >= 1) AND (delivery_attempts <= 2)) AND (lease_expires_at IS NULL) AND (delivered_at IS NULL) AND (failure_code IS NOT NULL) AND (next_eligible_at IS NOT NULL)) OR ((state = 'delivered'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND ((delivery_attempts >= 1) AND (delivery_attempts <= 3)) AND (lease_expires_at IS NULL) AND (next_eligible_at IS NULL) AND (delivered_at IS NOT NULL) AND (failure_code IS NULL)) OR ((state = 'exhausted'::text) AND (claim_owner IS NULL) AND (claim_fence > 0) AND (delivery_attempts = 3) AND (lease_expires_at IS NULL) AND (delivered_at IS NULL) AND (failure_code IS NOT NULL) AND (next_eligible_at IS NULL)))),
    CONSTRAINT media_submission_outbox_workflow_revision_check CHECK ((workflow_revision > 0))
);

CREATE TABLE media_submission_terms (
    submission_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    creation_revision bigint NOT NULL,
    license_preset text NOT NULL,
    commercial_remix_share_bps integer NOT NULL,
    royalty_allocations jsonb NOT NULL,
    access_mode text NOT NULL,
    terms_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_submission_terms_access_mode_check CHECK ((access_mode = 'public'::text)),
    CONSTRAINT media_submission_terms_commercial_remix_share_bps_check CHECK (((commercial_remix_share_bps >= 0) AND (commercial_remix_share_bps <= 10000))),
    CONSTRAINT media_submission_terms_creation_revision_check CHECK ((creation_revision > 1)),
    CONSTRAINT media_submission_terms_license_preset_check CHECK ((license_preset = ANY (ARRAY['non-commercial'::text, 'commercial-use'::text, 'commercial-remix'::text]))),
    CONSTRAINT media_submission_terms_royalty_allocations_check CHECK (((jsonb_typeof(royalty_allocations) = 'array'::text) AND (jsonb_array_length(royalty_allocations) > 0))),
    CONSTRAINT media_submission_terms_share_shape CHECK (((license_preset = 'commercial-remix'::text) OR (commercial_remix_share_bps = 0))),
    CONSTRAINT media_submission_terms_terms_snapshot_check CHECK ((jsonb_typeof(terms_snapshot) = 'object'::text))
);

CREATE TABLE media_timed_lyrics_artifacts (
    artifact_ref text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    post_id text NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    artifact_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    artifact_sha256 text NOT NULL,
    artifact jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_timed_lyrics_artifacts_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_timed_lyrics_artifacts_artifact_check CHECK ((jsonb_typeof(artifact) = 'object'::text)),
    CONSTRAINT media_timed_lyrics_artifacts_artifact_ref_check CHECK ((btrim(artifact_ref) <> ''::text)),
    CONSTRAINT media_timed_lyrics_artifacts_artifact_revision_check CHECK ((artifact_revision > 0)),
    CONSTRAINT media_timed_lyrics_artifacts_artifact_sha256_check CHECK ((artifact_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_timed_lyrics_artifacts_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_timed_lyrics_artifacts_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE media_transcript_artifacts (
    transcript_artifact_ref text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    submission_id text NOT NULL,
    operation_id text NOT NULL,
    audio_revision bigint NOT NULL,
    analysis_revision bigint NOT NULL,
    canonical_audio_sha256 text NOT NULL,
    transcript_sha256 text NOT NULL,
    transcript_text text NOT NULL,
    segments jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_transcript_artifacts_analysis_revision_check CHECK ((analysis_revision > 0)),
    CONSTRAINT media_transcript_artifacts_audio_revision_check CHECK ((audio_revision > 0)),
    CONSTRAINT media_transcript_artifacts_canonical_audio_sha256_check CHECK ((canonical_audio_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_transcript_artifacts_segments_check CHECK (((jsonb_typeof(segments) = 'array'::text) AND (jsonb_array_length(segments) <= 10000))),
    CONSTRAINT media_transcript_artifacts_transcript_artifact_ref_check CHECK ((btrim(transcript_artifact_ref) <> ''::text)),
    CONSTRAINT media_transcript_artifacts_transcript_sha256_check CHECK ((transcript_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_transcript_artifacts_transcript_text_check CHECK ((char_length(transcript_text) <= 200000))
);

CREATE TABLE media_upload_reservations (
    reservation_id text NOT NULL,
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    endpoint_template text DEFAULT '/communities/:communityId/media-upload-reservations'::text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    expected_content_type text NOT NULL,
    expected_size_bytes bigint NOT NULL,
    expected_sha256 text,
    upload_url text NOT NULL,
    upload_headers jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'issued'::text NOT NULL,
    submission_id text,
    operation_id text,
    claim_fence bigint DEFAULT 0 NOT NULL,
    terminal_reason text,
    terminal_evidence_ref text,
    terminal_evidence_digest text,
    terminal_at timestamp with time zone,
    terminal_fence bigint,
    response_snapshot_bytes bytea NOT NULL,
    response_snapshot_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT media_upload_reservations_claim_fence_check CHECK ((claim_fence >= 0)),
    CONSTRAINT media_upload_reservations_claim_shape CHECK ((((state = 'issued'::text) AND (claim_fence = 0)) OR ((state = 'expired'::text) AND (((submission_id IS NULL) AND (claim_fence = 0)) OR ((submission_id IS NOT NULL) AND (claim_fence > 0)))) OR ((state = ANY (ARRAY['claimed'::text, 'sealed'::text, 'rejected'::text])) AND (claim_fence > 0)))),
    CONSTRAINT media_upload_reservations_endpoint_template_check CHECK ((endpoint_template = '/communities/:communityId/media-upload-reservations'::text)),
    CONSTRAINT media_upload_reservations_expected_content_type_check CHECK ((expected_content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'::text)),
    CONSTRAINT media_upload_reservations_expected_sha256_check CHECK (((expected_sha256 IS NULL) OR (expected_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT media_upload_reservations_expected_size_bytes_check CHECK ((expected_size_bytes > 0)),
    CONSTRAINT media_upload_reservations_expiry_shape CHECK (((state <> 'expired'::text) OR (expires_at <= updated_at))),
    CONSTRAINT media_upload_reservations_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT media_upload_reservations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_upload_reservations_reservation_id_check CHECK ((btrim(reservation_id) <> ''::text)),
    CONSTRAINT media_upload_reservations_response_hash CHECK (((octet_length(response_snapshot_bytes) > 0) AND (encode(sha256(response_snapshot_bytes), 'hex'::text) = response_snapshot_sha256))),
    CONSTRAINT media_upload_reservations_response_snapshot_sha256_check CHECK ((response_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_upload_reservations_state_check CHECK ((state = ANY (ARRAY['issued'::text, 'claimed'::text, 'sealed'::text, 'rejected'::text, 'expired'::text]))),
    CONSTRAINT media_upload_reservations_state_shape CHECK ((((state = 'issued'::text) AND (submission_id IS NULL) AND (operation_id IS NULL)) OR ((state = 'expired'::text) AND (((submission_id IS NULL) AND (operation_id IS NULL)) OR ((submission_id IS NOT NULL) AND (operation_id IS NOT NULL)))) OR ((state = ANY (ARRAY['claimed'::text, 'sealed'::text, 'rejected'::text])) AND (submission_id IS NOT NULL) AND (operation_id IS NOT NULL)))),
    CONSTRAINT media_upload_reservations_terminal_evidence_digest_check CHECK (((terminal_evidence_digest IS NULL) OR (terminal_evidence_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT media_upload_reservations_terminal_evidence_ref_check CHECK (((terminal_evidence_ref IS NULL) OR (btrim(terminal_evidence_ref) <> ''::text))),
    CONSTRAINT media_upload_reservations_terminal_fence_check CHECK (((terminal_fence IS NULL) OR (terminal_fence > 0))),
    CONSTRAINT media_upload_reservations_terminal_reason_check CHECK (((terminal_reason IS NULL) OR (terminal_reason = ANY (ARRAY['expectation_mismatch'::text, 'source_precondition_failed'::text, 'destination_conflict'::text])))),
    CONSTRAINT media_upload_reservations_terminal_shape CHECK ((((state = 'rejected'::text) AND (terminal_reason IS NOT NULL) AND (terminal_evidence_ref IS NOT NULL) AND (terminal_evidence_digest IS NOT NULL) AND (terminal_at IS NOT NULL) AND (terminal_fence IS NOT NULL)) OR ((state <> 'rejected'::text) AND (terminal_reason IS NULL) AND (terminal_evidence_ref IS NULL) AND (terminal_evidence_digest IS NULL) AND (terminal_at IS NULL) AND (terminal_fence IS NULL)))),
    CONSTRAINT media_upload_reservations_upload_headers_check CHECK ((jsonb_typeof(upload_headers) = 'array'::text)),
    CONSTRAINT media_upload_reservations_upload_url_check CHECK ((btrim(upload_url) <> ''::text))
);

CREATE TABLE moderation_actions (
    community_id text NOT NULL,
    action_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    actor_user_id text NOT NULL,
    action text NOT NULL,
    reason text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT moderation_actions_action_check CHECK ((action = ANY (ARRAY['hide'::text, 'restore'::text, 'ban'::text, 'unban'::text]))),
    CONSTRAINT moderation_actions_target_kind_check CHECK ((target_kind = ANY (ARRAY['post'::text, 'comment'::text, 'member'::text])))
);

CREATE TABLE moderation_reports (
    community_id text NOT NULL,
    report_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    reporter_user_id text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT moderation_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triaged'::text, 'resolved'::text, 'dismissed'::text]))),
    CONSTRAINT moderation_reports_target_kind_check CHECK ((target_kind = ANY (ARRAY['post'::text, 'comment'::text])))
);

CREATE TABLE namespace_ownership_completion_attempts (
    completion_attempt_id text NOT NULL,
    namespace_session_id text NOT NULL,
    actor_id text NOT NULL,
    idempotency_key text NOT NULL,
    completion_request_hash text NOT NULL,
    evidence_ref text NOT NULL,
    submission_channel text DEFAULT 'poll_result'::text NOT NULL,
    state text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    consumption_kind text,
    CONSTRAINT namespace_ownership_completion_at_completion_request_hash_check CHECK ((completion_request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_completion_attempt_submission_channel_check CHECK ((submission_channel = 'poll_result'::text)),
    CONSTRAINT namespace_ownership_completion_attempts_consumption_shape CHECK ((((state = 'consumed'::text) AND (consumption_kind IS NOT NULL) AND (consumption_kind = ANY (ARRAY['semantic_contradiction'::text, 'verified'::text, 'rejected'::text, 'expired'::text]))) OR ((state = ANY (ARRAY['leased'::text, 'released'::text])) AND (consumption_kind IS NULL)))),
    CONSTRAINT namespace_ownership_completion_attempts_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT namespace_ownership_completion_attempts_identifiers_not_blank CHECK (((btrim(completion_attempt_id) <> ''::text) AND (completion_attempt_id = btrim(completion_attempt_id)) AND (btrim(idempotency_key) <> ''::text) AND (idempotency_key = btrim(idempotency_key)) AND (btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (octet_length(evidence_ref) <= 512))),
    CONSTRAINT namespace_ownership_completion_attempts_state_check CHECK ((state = ANY (ARRAY['leased'::text, 'released'::text, 'consumed'::text]))),
    CONSTRAINT namespace_ownership_completion_attempts_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE namespace_ownership_evidence_snapshots (
    evidence_ref text NOT NULL,
    completion_attempt_id text NOT NULL,
    namespace_session_id text NOT NULL,
    actor_id text NOT NULL,
    creation_intent_id text NOT NULL,
    ceremony_intent_id text NOT NULL,
    requirement_kind text DEFAULT 'namespace_ownership'::text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    request_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    family text NOT NULL,
    root_label text NOT NULL,
    root_label_display text NOT NULL,
    path_segment text NOT NULL,
    href text NOT NULL,
    app_host text,
    upstream_session_ref text NOT NULL,
    fence_token bigint NOT NULL,
    abi_version text DEFAULT 'pirate-hns-ownership-evidence-v1'::text NOT NULL,
    ownership_source text NOT NULL,
    challenge_name text NOT NULL,
    challenge_value_sha256 text NOT NULL,
    root_exists boolean NOT NULL,
    root_control_verified boolean NOT NULL,
    expiry_horizon_sufficient boolean NOT NULL,
    chain_network text NOT NULL,
    chain_anchor_height bigint NOT NULL,
    chain_anchor_block_hash text NOT NULL,
    chain_anchor_median_time bigint NOT NULL,
    expiry_height bigint NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    provider_evidence_ref text NOT NULL,
    observation_sha256 text NOT NULL,
    provider_identity_digest text NOT NULL,
    evidence_digest text NOT NULL,
    observation jsonb NOT NULL,
    raw_response_bytes bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT namespace_ownership_evidence__provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT namespace_ownership_evidence_sn_expiry_horizon_sufficient_check CHECK ((expiry_horizon_sufficient IS TRUE)),
    CONSTRAINT namespace_ownership_evidence_sna_chain_anchor_median_time_check CHECK ((chain_anchor_median_time > 0)),
    CONSTRAINT namespace_ownership_evidence_sna_provider_identity_digest_check CHECK ((provider_identity_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snap_chain_anchor_block_hash_check CHECK ((chain_anchor_block_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snaps_challenge_value_sha256_check CHECK ((challenge_value_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapsh_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapsh_root_control_verified_check CHECK ((root_control_verified IS TRUE)),
    CONSTRAINT namespace_ownership_evidence_snapshot_chain_anchor_height_check CHECK ((chain_anchor_height > 0)),
    CONSTRAINT namespace_ownership_evidence_snapshots_abi_version_check CHECK ((abi_version = 'pirate-hns-ownership-evidence-v1'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_challenge_shape CHECK (((btrim(challenge_name) <> ''::text) AND (challenge_name = btrim(challenge_name)) AND (octet_length(challenge_name) <= 255) AND (challenge_name !~ '[[:cntrl:]]'::text))),
    CONSTRAINT namespace_ownership_evidence_snapshots_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_expiry_height_check CHECK ((expiry_height > 0)),
    CONSTRAINT namespace_ownership_evidence_snapshots_family_check CHECK ((family = 'hns'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT namespace_ownership_evidence_snapshots_generation_check CHECK ((generation > 0)),
    CONSTRAINT namespace_ownership_evidence_snapshots_identifiers_not_blank CHECK (((btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (octet_length(evidence_ref) <= 512) AND (btrim(creation_intent_id) <> ''::text) AND (creation_intent_id = btrim(creation_intent_id)) AND (btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (octet_length(provider_configuration_ref) <= 512) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(protocol_version) <> ''::text) AND (protocol_version = btrim(protocol_version)) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)) AND (btrim(chain_network) <> ''::text) AND (chain_network = btrim(chain_network)) AND (btrim(provider_evidence_ref) <> ''::text) AND (provider_evidence_ref = btrim(provider_evidence_ref)) AND (octet_length(provider_evidence_ref) <= 512))),
    CONSTRAINT namespace_ownership_evidence_snapshots_observation_sha256_check CHECK ((observation_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_observation_shape CHECK (((jsonb_typeof(observation) = 'object'::text) AND ((observation ->> 'status'::text) = 'verified'::text))),
    CONSTRAINT namespace_ownership_evidence_snapshots_ownership_source_check CHECK ((ownership_source = ANY (ARRAY['hns_parent_chain_txt'::text, 'owner_authoritative_dns_txt'::text]))),
    CONSTRAINT namespace_ownership_evidence_snapshots_raw_bytes_shape CHECK (((octet_length(raw_response_bytes) >= 1) AND (octet_length(raw_response_bytes) <= 1048576))),
    CONSTRAINT namespace_ownership_evidence_snapshots_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT namespace_ownership_evidence_snapshots_root_exists_check CHECK ((root_exists IS TRUE)),
    CONSTRAINT namespace_ownership_evidence_snapshots_route_shape CHECK (((is_community_route_root_label(family, root_label) IS TRUE) AND (is_community_route_root_label_display(root_label_display) IS TRUE) AND (path_segment = ('app.'::text || root_label)) AND (href = ('/c/'::text || path_segment)) AND (app_host IS NULL))),
    CONSTRAINT namespace_ownership_evidence_snapshots_time_order CHECK (((expires_at > observed_at) AND (created_at >= observed_at))),
    CONSTRAINT namespace_ownership_evidence_snapshots_upstream_ref_shape CHECK (((octet_length(upstream_session_ref) BETWEEN 1 AND 16384) AND (btrim(upstream_session_ref) = upstream_session_ref) AND (upstream_session_ref !~ '[[:cntrl:]]'::text)))
);

CREATE TABLE namespace_ownership_sessions (
    namespace_session_id text NOT NULL,
    actor_id text NOT NULL,
    creation_intent_id text NOT NULL,
    ceremony_intent_id text NOT NULL,
    start_reservation_id text NOT NULL,
    start_fence_token bigint NOT NULL,
    expected_revision integer NOT NULL,
    requirement_kind text DEFAULT 'namespace_ownership'::text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    request_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    route_family text NOT NULL,
    route_root_label text NOT NULL,
    route_root_label_display text NOT NULL,
    route_path_segment text NOT NULL,
    route_href text NOT NULL,
    route_app_host text,
    upstream_session_ref text NOT NULL,
    presentation_kind text NOT NULL,
    presentation_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    terminal_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT namespace_ownership_sessions_expected_revision_check CHECK ((expected_revision > 0)),
    CONSTRAINT namespace_ownership_sessions_generation_check CHECK ((generation > 0)),
    CONSTRAINT namespace_ownership_sessions_identifiers_not_blank CHECK (((btrim(namespace_session_id) <> ''::text) AND (namespace_session_id = btrim(namespace_session_id)) AND (btrim(start_reservation_id) <> ''::text) AND (start_reservation_id = btrim(start_reservation_id)) AND (btrim(creation_intent_id) <> ''::text) AND (creation_intent_id = btrim(creation_intent_id)) AND (btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(protocol_version) <> ''::text) AND (protocol_version = btrim(protocol_version)) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)))),
    CONSTRAINT namespace_ownership_sessions_presentation_kind_check CHECK ((presentation_kind = ANY (ARRAY['redirect'::text, 'deeplink'::text, 'embedded_sdk'::text, 'poll'::text, 'none'::text]))),
    CONSTRAINT namespace_ownership_sessions_presentation_payload_check CHECK ((jsonb_typeof(presentation_payload) = 'object'::text)),
    CONSTRAINT namespace_ownership_sessions_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_sessions_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT namespace_ownership_sessions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_sessions_request_lifecycle_shape CHECK ((((status = 'pending'::text) AND (completed_at IS NULL) AND (terminal_at IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL) AND (terminal_at IS NOT NULL) AND (completed_at = terminal_at)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (completed_at IS NULL) AND (terminal_at IS NOT NULL) AND ((status <> 'expired'::text) OR (terminal_at >= expires_at))))),
    CONSTRAINT namespace_ownership_sessions_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_sessions_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT namespace_ownership_sessions_route_family_check CHECK ((route_family = ANY (ARRAY['hns'::text, 'spaces'::text]))),
    CONSTRAINT namespace_ownership_sessions_route_shape CHECK (((is_community_route_root_label(route_family, route_root_label) IS TRUE) AND (is_community_route_root_label_display(route_root_label_display) IS TRUE) AND (route_path_segment =
CASE route_family
    WHEN 'hns'::text THEN ('app.'::text || route_root_label)
    WHEN 'spaces'::text THEN ('@'::text || route_root_label)
    ELSE NULL::text
END) AND (route_href = ('/c/'::text || route_path_segment)) AND (route_app_host IS NULL))),
    CONSTRAINT namespace_ownership_sessions_start_fence_token_check CHECK ((start_fence_token > 0)),
    CONSTRAINT namespace_ownership_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT namespace_ownership_sessions_time_order CHECK (((expires_at > started_at) AND (created_at >= started_at) AND (updated_at >= created_at) AND ((terminal_at IS NULL) OR (terminal_at >= started_at)))),
    CONSTRAINT namespace_ownership_sessions_upstream_ref_shape CHECK (((octet_length(upstream_session_ref) BETWEEN 1 AND 16384) AND (btrim(upstream_session_ref) = upstream_session_ref) AND (upstream_session_ref !~ '[[:cntrl:]]'::text)))
);

CREATE TABLE namespace_ownership_start_reservations (
    reservation_id text NOT NULL,
    namespace_session_id text NOT NULL,
    actor_id text NOT NULL,
    creation_intent_id text NOT NULL,
    ceremony_intent_id text NOT NULL,
    requirement_kind text DEFAULT 'namespace_ownership'::text NOT NULL,
    generation bigint NOT NULL,
    requirement_hash text NOT NULL,
    expected_revision integer NOT NULL,
    client_idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    route_family text NOT NULL,
    route_root_label text NOT NULL,
    route_root_label_display text NOT NULL,
    route_path_segment text NOT NULL,
    route_href text NOT NULL,
    route_app_host text,
    state text DEFAULT 'acquired'::text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT namespace_ownership_start_res_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT namespace_ownership_start_reservati_provider_binding_hash_check CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_start_reservations_expected_revision_check CHECK ((expected_revision > 0)),
    CONSTRAINT namespace_ownership_start_reservations_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT namespace_ownership_start_reservations_generation_check CHECK ((generation > 0)),
    CONSTRAINT namespace_ownership_start_reservations_identifiers_not_blank CHECK (((btrim(reservation_id) <> ''::text) AND (reservation_id = btrim(reservation_id)) AND (btrim(namespace_session_id) <> ''::text) AND (namespace_session_id = btrim(namespace_session_id)) AND (btrim(creation_intent_id) <> ''::text) AND (creation_intent_id = btrim(creation_intent_id)) AND (btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(client_idempotency_key) <> ''::text) AND (client_idempotency_key = btrim(client_idempotency_key)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)) AND (btrim(protocol_version) <> ''::text) AND (protocol_version = btrim(protocol_version)) AND (btrim(environment) <> ''::text) AND (environment = btrim(environment)))),
    CONSTRAINT namespace_ownership_start_reservations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_start_reservations_requirement_hash_check CHECK ((requirement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT namespace_ownership_start_reservations_requirement_kind_check CHECK ((requirement_kind = 'namespace_ownership'::text)),
    CONSTRAINT namespace_ownership_start_reservations_route_family_check CHECK ((route_family = 'hns'::text)),
    CONSTRAINT namespace_ownership_start_reservations_route_shape CHECK (((is_community_route_root_label(route_family, route_root_label) IS TRUE) AND (is_community_route_root_label_display(route_root_label_display) IS TRUE) AND (route_path_segment = ('app.'::text || route_root_label)) AND (route_href = ('/c/'::text || route_path_segment)) AND (route_app_host IS NULL))),
    CONSTRAINT namespace_ownership_start_reservations_state_check CHECK ((state = ANY (ARRAY['acquired'::text, 'released'::text, 'finalized'::text]))),
    CONSTRAINT namespace_ownership_start_reservations_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE observations (
    observation_id text NOT NULL,
    user_id text NOT NULL,
    resolver_id text NOT NULL,
    source_id text NOT NULL,
    claim_id text NOT NULL,
    observation_kind text NOT NULL,
    subject_ref text NOT NULL,
    observation_value jsonb NOT NULL,
    chain_id text,
    account_caip10 text,
    asset_caip19 text,
    aggregation_mode text NOT NULL,
    trust_mode text NOT NULL,
    completeness text NOT NULL,
    snapshot_ref jsonb NOT NULL,
    source_response_hash text NOT NULL,
    descriptor_version text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observations_aggregation_mode_check CHECK ((aggregation_mode = ANY (ARRAY['single_wallet'::text, 'any_wallet'::text, 'sum_across_wallets'::text]))),
    CONSTRAINT observations_completeness_check CHECK ((completeness = ANY (ARRAY['complete'::text, 'partial'::text, 'unknown'::text]))),
    CONSTRAINT observations_identifiers_not_blank CHECK (((btrim(resolver_id) <> ''::text) AND (btrim(source_id) <> ''::text) AND (btrim(claim_id) <> ''::text) AND (btrim(observation_kind) <> ''::text) AND (btrim(subject_ref) <> ''::text) AND (btrim(aggregation_mode) <> ''::text) AND (btrim(descriptor_version) <> ''::text))),
    CONSTRAINT observations_observation_kind_check CHECK ((observation_kind = ANY (ARRAY['asset_inventory'::text, 'asset_balance'::text, 'disclosed_predicate'::text]))),
    CONSTRAINT observations_snapshot_shape_check CHECK (((jsonb_typeof(snapshot_ref) = 'object'::text) AND (jsonb_typeof((snapshot_ref -> 'kind'::text)) = 'string'::text) AND (jsonb_typeof((snapshot_ref -> 'reference'::text)) = 'string'::text) AND (btrim((snapshot_ref ->> 'kind'::text)) <> ''::text) AND (btrim((snapshot_ref ->> 'reference'::text)) <> ''::text) AND ((snapshot_ref ->> 'kind'::text) = ANY (ARRAY['block'::text, 'provider_snapshot'::text, 'receipt'::text])))),
    CONSTRAINT observations_source_response_hash_check CHECK ((source_response_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT observations_trust_mode_check CHECK ((trust_mode = ANY (ARRAY['onchain_pinned'::text, 'provider_asserted'::text]))),
    CONSTRAINT observations_value_object_check CHECK ((jsonb_typeof(observation_value) = 'object'::text)),
    CONSTRAINT observations_variant_shape_check CHECK ((((observation_value ->> 'kind'::text) = observation_kind) AND (((observation_kind = ANY (ARRAY['asset_inventory'::text, 'asset_balance'::text])) AND (chain_id IS NOT NULL) AND (account_caip10 IS NOT NULL) AND (asset_caip19 IS NOT NULL) AND (chain_id = (observation_value ->> 'chain_id'::text)) AND (account_caip10 = (observation_value ->> 'account_id'::text)) AND (asset_caip19 = (observation_value ->> 'asset_id'::text))) OR ((observation_kind = 'disclosed_predicate'::text) AND (chain_id IS NULL) AND (account_caip10 IS NULL) AND (asset_caip19 IS NULL)))))
);

CREATE TABLE policy_versions (
    policy_version_id text NOT NULL,
    community_id text NOT NULL,
    policy_key text NOT NULL,
    revision integer NOT NULL,
    policy_hash text NOT NULL,
    policy jsonb NOT NULL,
    compiled_plan jsonb NOT NULL,
    compiler_version text NOT NULL,
    uniqueness_model jsonb NOT NULL,
    created_by_user_id text,
    published_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_purpose text NOT NULL,
    uniqueness_authority_id text,
    CONSTRAINT policy_versions_identifiers_not_blank CHECK (((btrim(policy_key) <> ''::text) AND (btrim(compiler_version) <> ''::text))),
    CONSTRAINT policy_versions_json_shape_check CHECK (((jsonb_typeof(policy) = 'object'::text) AND (jsonb_typeof(compiled_plan) = 'object'::text) AND (jsonb_typeof(uniqueness_model) = 'object'::text))),
    CONSTRAINT policy_versions_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT policy_versions_policy_purpose_check CHECK ((policy_purpose = ANY (ARRAY['access'::text, 'reward'::text]))),
    CONSTRAINT policy_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT policy_versions_reward_authority_check CHECK ((((policy_purpose = 'access'::text) AND (uniqueness_authority_id IS NULL)) OR ((policy_purpose = 'reward'::text) AND (uniqueness_authority_id IS NOT NULL) AND ((uniqueness_model ->> 'kind'::text) = 'single_authority'::text) AND ((uniqueness_model ->> 'authority_id'::text) = uniqueness_authority_id))))
);

CREATE TABLE post_vote_actions (
    action_id text NOT NULL,
    community_id text NOT NULL,
    post_id text NOT NULL,
    actor_user_id text NOT NULL,
    endpoint_template text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    result_value integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT post_vote_actions_endpoint_result_shape CHECK ((((endpoint_template = '/posts/:postId/vote'::text) AND (result_value = ANY (ARRAY['-1'::integer, 1]))) OR ((endpoint_template = '/posts/:postId/clear_vote'::text) AND (result_value = 0)))),
    CONSTRAINT post_vote_actions_endpoint_template_check CHECK ((endpoint_template = ANY (ARRAY['/posts/:postId/vote'::text, '/posts/:postId/clear_vote'::text]))),
    CONSTRAINT post_vote_actions_idempotency_key_check CHECK ((idempotency_key <> ''::text)),
    CONSTRAINT post_vote_actions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT post_vote_actions_result_value_check CHECK ((result_value = ANY (ARRAY['-1'::integer, 0, 1])))
);

CREATE TABLE post_votes (
    community_id text NOT NULL,
    post_vote_id text NOT NULL,
    post_id text NOT NULL,
    user_id text NOT NULL,
    vote_value smallint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT post_votes_vote_value_check CHECK ((vote_value = ANY (ARRAY['-1'::integer, 1])))
);

CREATE TABLE posts (
    community_id text NOT NULL,
    post_id text NOT NULL,
    author_user_id text,
    post_type text DEFAULT 'text'::text NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    visibility text DEFAULT 'public'::text NOT NULL,
    title text,
    body text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    idempotency_key text DEFAULT ''::text NOT NULL,
    idempotency_body_hash text,
    comments_locked boolean DEFAULT false NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    upvote_count integer DEFAULT 0 NOT NULL,
    downvote_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT posts_comment_count_nonnegative CHECK ((comment_count >= 0)),
    CONSTRAINT posts_downvote_count_nonnegative CHECK ((downvote_count >= 0)),
    CONSTRAINT posts_post_type_check CHECK ((post_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'link'::text, 'song'::text, 'crosspost'::text, 'file'::text]))),
    CONSTRAINT posts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'processing'::text, 'published'::text, 'failed'::text, 'hidden'::text, 'removed'::text, 'deleted'::text]))),
    CONSTRAINT posts_upvote_count_nonnegative CHECK ((upvote_count >= 0)),
    CONSTRAINT posts_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'members_only'::text])))
);

CREATE TABLE proof_session_completion_events (
    completion_event_id text NOT NULL,
    proof_session_id text NOT NULL,
    actor_id text NOT NULL,
    idempotency_key text NOT NULL,
    terminal_status text NOT NULL,
    result_hash text NOT NULL,
    terminal_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proof_session_completion_events_not_blank CHECK (((btrim(completion_event_id) <> ''::text) AND (btrim(idempotency_key) <> ''::text))),
    CONSTRAINT proof_session_completion_events_result_hash_check CHECK ((result_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT proof_session_completion_events_terminal_status_check CHECK ((terminal_status = ANY (ARRAY['completed'::text, 'failed'::text, 'expired'::text])))
);

CREATE TABLE proof_session_presentations (
    proof_session_id text NOT NULL,
    presentation_kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proof_session_presentations_kind_check CHECK ((presentation_kind = ANY (ARRAY['redirect'::text, 'deeplink'::text, 'embedded_sdk'::text, 'poll'::text, 'none'::text]))),
    CONSTRAINT proof_session_presentations_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);

CREATE TABLE proof_sessions (
    proof_session_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    request_hash text NOT NULL,
    provider_id text NOT NULL,
    method text NOT NULL,
    issuer text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    request_mode text NOT NULL,
    protocol_version text NOT NULL,
    environment text NOT NULL,
    status text NOT NULL,
    upstream_session_ref text,
    requested_requirements jsonb NOT NULL,
    requested_claim_ids jsonb NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_binding_intent text NOT NULL,
    completion_idempotency_key text,
    completion_result_hash text,
    terminal_at timestamp with time zone,
    provider_configuration_kind text NOT NULL,
    provider_configuration_ref text NOT NULL,
    provider_configuration_version text NOT NULL,
    creation_ceremony_intent_id text,
    CONSTRAINT proof_sessions_creation_ceremony_identity CHECK (((creation_ceremony_intent_id IS NULL) OR (creation_ceremony_intent_id = intent_id))),
    CONSTRAINT proof_sessions_identifiers_not_blank CHECK (((btrim(intent_id) <> ''::text) AND (btrim(request_hash) <> ''::text) AND (btrim(provider_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(protocol_version) <> ''::text) AND (btrim(environment) <> ''::text))),
    CONSTRAINT proof_sessions_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
    CONSTRAINT proof_sessions_provider_configuration_mode_check CHECK ((((request_mode = 'curated'::text) AND (provider_configuration_kind = 'managed'::text)) OR ((request_mode = 'dynamic'::text) AND (provider_configuration_kind = 'dynamic'::text)))),
    CONSTRAINT proof_sessions_provider_configuration_values_not_blank CHECK (((btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version)))),
    CONSTRAINT proof_sessions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT proof_sessions_request_mode_check CHECK ((request_mode = ANY (ARRAY['curated'::text, 'dynamic'::text]))),
    CONSTRAINT proof_sessions_requested_claims_check CHECK (((jsonb_typeof(requested_claim_ids) = 'array'::text) AND (jsonb_array_length(requested_claim_ids) > 0))),
    CONSTRAINT proof_sessions_requested_requirements_check CHECK (((jsonb_typeof(requested_requirements) = 'array'::text) AND (jsonb_array_length(requested_requirements) > 0))),
    CONSTRAINT proof_sessions_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)) OR ((scope_kind = 'none'::text) AND (issuer_rp_scope IS NULL) AND (issuer_rp_action_scope IS NULL)))),
    CONSTRAINT proof_sessions_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT proof_sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT proof_sessions_subject_binding_intent_check CHECK ((subject_binding_intent = ANY (ARRAY['establish'::text, 'recover'::text, 'none'::text]))),
    CONSTRAINT proof_sessions_terminal_shape_check CHECK ((((status = 'pending'::text) AND (completion_idempotency_key IS NULL) AND (completion_result_hash IS NULL) AND (terminal_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at = terminal_at)) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text])) AND (completion_idempotency_key IS NOT NULL) AND (btrim(completion_idempotency_key) <> ''::text) AND (completion_result_hash ~ '^[0-9a-f]{64}$'::text) AND (terminal_at IS NOT NULL) AND (completed_at IS NULL))))
);

CREATE TABLE public_handle_index (
    handle_id text NOT NULL,
    label_normalized text NOT NULL,
    label_display text NOT NULL,
    status text NOT NULL,
    owner_user_id text NOT NULL,
    redirect_target_handle_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_handle_index_display_not_blank CHECK ((btrim(label_display) <> ''::text)),
    CONSTRAINT public_handle_index_label_format_check CHECK (((label_normalized ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text) AND (label_display = (label_normalized || '.pirate'::text)))),
    CONSTRAINT public_handle_index_label_not_blank CHECK ((btrim(label_normalized) <> ''::text)),
    CONSTRAINT public_handle_index_not_self_redirect CHECK (((redirect_target_handle_id IS NULL) OR (redirect_target_handle_id <> handle_id))),
    CONSTRAINT public_handle_index_status_check CHECK ((status = ANY (ARRAY['active'::text, 'redirect'::text, 'retired'::text]))),
    CONSTRAINT public_handle_index_status_target_check CHECK ((((status = 'active'::text) AND (redirect_target_handle_id IS NULL)) OR ((status = 'redirect'::text) AND (redirect_target_handle_id IS NOT NULL)) OR ((status = 'retired'::text) AND (redirect_target_handle_id IS NULL))))
);

CREATE TABLE reward_subject_consumptions (
    reward_subject_consumption_id text NOT NULL,
    campaign_id text NOT NULL,
    subject_key_id text NOT NULL,
    user_id text NOT NULL,
    binding_event_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    evidence_receipt_id text,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_subject_consumptions_binding_epoch_check CHECK ((binding_epoch > 0))
);

CREATE TABLE reward_uniqueness_authorities (
    campaign_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text NOT NULL,
    issuer_rp_action_scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reward_uniqueness_authorities_not_blank CHECK (((btrim(campaign_id) <> ''::text) AND (btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(issuer_rp_scope) <> ''::text) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT reward_uniqueness_authorities_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text]))),
    CONSTRAINT reward_uniqueness_authorities_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_action_scope IS NOT NULL))))
);

CREATE TABLE schema_migrations (
    version text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE subject_key_binding_events (
    binding_event_id text NOT NULL,
    subject_key_id text NOT NULL,
    binding_epoch bigint NOT NULL,
    user_id text NOT NULL,
    proof_session_id text NOT NULL,
    binding_kind text NOT NULL,
    previous_binding_event_id text,
    idempotency_key text NOT NULL,
    bound_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_key_binding_events_binding_epoch_check CHECK ((binding_epoch > 0)),
    CONSTRAINT subject_key_binding_events_binding_kind_check CHECK ((binding_kind = ANY (ARRAY['initial'::text, 'recovery'::text]))),
    CONSTRAINT subject_key_binding_events_not_blank CHECK (((btrim(binding_event_id) <> ''::text) AND (btrim(idempotency_key) <> ''::text)))
);

CREATE TABLE subject_keys (
    subject_key_id text NOT NULL,
    issuer text NOT NULL,
    method text NOT NULL,
    scope_kind text NOT NULL,
    issuer_rp_scope text,
    issuer_rp_action_scope text,
    subject_digest text NOT NULL,
    digest_algorithm text DEFAULT 'sha256'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_keys_identifiers_not_blank CHECK (((btrim(issuer) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(subject_digest) <> ''::text) AND (btrim(digest_algorithm) <> ''::text))),
    CONSTRAINT subject_keys_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['issuer_rp_scope'::text, 'issuer_rp_action_scope'::text]))),
    CONSTRAINT subject_keys_scope_shape_check CHECK ((((scope_kind = 'issuer_rp_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NULL)) OR ((scope_kind = 'issuer_rp_action_scope'::text) AND (issuer_rp_scope IS NOT NULL) AND (issuer_rp_action_scope IS NOT NULL)))),
    CONSTRAINT subject_keys_scope_values_not_blank CHECK ((((issuer_rp_scope IS NULL) OR (btrim(issuer_rp_scope) <> ''::text)) AND ((issuer_rp_action_scope IS NULL) OR (btrim(issuer_rp_action_scope) <> ''::text)))),
    CONSTRAINT subject_keys_sha256_digest_check CHECK (((digest_algorithm = 'sha256'::text) AND (subject_digest ~ '^[0-9a-f]{64}$'::text)))
);

CREATE TABLE text_content_held_revisions (
    community_id text NOT NULL,
    held_revision_id text NOT NULL,
    submission_id text NOT NULL,
    title text,
    body text,
    content_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_content_held_revisions_content_present CHECK ((((title IS NOT NULL) AND (btrim(title) <> ''::text)) OR ((body IS NOT NULL) AND (btrim(body) <> ''::text)))),
    CONSTRAINT text_content_held_revisions_content_sha256_check CHECK ((content_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_content_held_revisions_identifiers_not_blank CHECK (((btrim(held_revision_id) <> ''::text) AND (held_revision_id = btrim(held_revision_id))))
);

CREATE TABLE text_content_submissions (
    community_id text NOT NULL,
    submission_id text NOT NULL,
    actor_user_id text NOT NULL,
    surface text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL,
    moderation_decision text NOT NULL,
    public_reason_code text,
    policy_revision_id text NOT NULL,
    policy_hash text NOT NULL,
    input_sha256 text NOT NULL,
    internal_reason_codes jsonb NOT NULL,
    evidence_ref text,
    published_post_id text,
    published_comment_id text,
    review_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    operation_id text NOT NULL,
    response_snapshot_bytes bytea NOT NULL,
    response_snapshot_sha256 text NOT NULL,
    target_post_id text,
    target_parent_comment_id text,
    CONSTRAINT text_content_submissions_identifiers_not_blank CHECK (((btrim(submission_id) <> ''::text) AND (submission_id = btrim(submission_id)) AND (btrim(actor_user_id) <> ''::text) AND (actor_user_id = btrim(actor_user_id)) AND (btrim(idempotency_key) <> ''::text) AND (idempotency_key = btrim(idempotency_key)) AND ((review_ref IS NULL) OR ((btrim(review_ref) <> ''::text) AND (review_ref = btrim(review_ref)))))),
    CONSTRAINT text_content_submissions_input_sha256_check CHECK ((input_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_content_submissions_moderation_decision_check CHECK ((moderation_decision = ANY (ARRAY['allow'::text, 'manual_review'::text, 'blocked'::text]))),
    CONSTRAINT text_content_submissions_operation_id_not_blank CHECK (((btrim(operation_id) <> ''::text) AND (operation_id = btrim(operation_id)))),
    CONSTRAINT text_content_submissions_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_content_submissions_public_reason_code_check CHECK (((public_reason_code IS NULL) OR (public_reason_code = ANY (ARRAY['review_required'::text, 'moderation_unavailable'::text, 'policy_violation'::text])))),
    CONSTRAINT text_content_submissions_reasons_array CHECK ((valid_text_moderation_reason_codes(internal_reason_codes) AND (((moderation_decision = 'allow'::text) AND (jsonb_array_length(internal_reason_codes) = 0)) OR ((moderation_decision = 'manual_review'::text) AND (jsonb_array_length(internal_reason_codes) > 0) AND (NOT (internal_reason_codes ? 'sexual_minors'::text))) OR ((moderation_decision = 'blocked'::text) AND (jsonb_array_length(internal_reason_codes) > 0) AND (NOT (internal_reason_codes ?| ARRAY['age_gate_required'::text, 'provider_unavailable'::text, 'provider_timeout'::text, 'provider_invalid'::text])))))),
    CONSTRAINT text_content_submissions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_content_submissions_response_snapshot_hash CHECK ((encode(sha256(response_snapshot_bytes), 'hex'::text) = response_snapshot_sha256)),
    CONSTRAINT text_content_submissions_response_snapshot_nonempty CHECK ((octet_length(response_snapshot_bytes) > 0)),
    CONSTRAINT text_content_submissions_response_snapshot_sha256_check CHECK ((response_snapshot_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_content_submissions_status_check CHECK ((status = ANY (ARRAY['published'::text, 'manual_review'::text, 'blocked'::text]))),
    CONSTRAINT text_content_submissions_status_shape CHECK ((((status = 'published'::text) AND (public_reason_code IS NULL) AND (review_ref IS NULL) AND (((surface = 'text_post'::text) AND (published_post_id IS NOT NULL) AND (published_comment_id IS NULL)) OR ((surface = ANY (ARRAY['comment'::text, 'reply'::text])) AND (published_post_id IS NULL) AND (published_comment_id IS NOT NULL)))) OR ((status = 'manual_review'::text) AND (public_reason_code IS NOT NULL) AND (public_reason_code = ANY (ARRAY['review_required'::text, 'moderation_unavailable'::text])) AND (review_ref IS NOT NULL) AND (published_post_id IS NULL) AND (published_comment_id IS NULL)) OR ((status = 'blocked'::text) AND (public_reason_code IS NOT NULL) AND (public_reason_code = 'policy_violation'::text) AND (review_ref IS NULL) AND (published_post_id IS NULL) AND (published_comment_id IS NULL)))),
    CONSTRAINT text_content_submissions_surface_check CHECK ((surface = ANY (ARRAY['text_post'::text, 'comment'::text, 'reply'::text]))),
    CONSTRAINT text_content_submissions_target_shape CHECK ((((surface = 'text_post'::text) AND (target_post_id IS NULL) AND (target_parent_comment_id IS NULL)) OR ((surface = 'comment'::text) AND (target_post_id IS NOT NULL) AND (target_parent_comment_id IS NULL)) OR ((surface = 'reply'::text) AND (target_post_id IS NOT NULL) AND (target_parent_comment_id IS NOT NULL)))),
    CONSTRAINT text_content_submissions_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE text_moderation_cases (
    community_id text NOT NULL,
    case_id text NOT NULL,
    submission_id text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by_user_id text,
    resolution_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_moderation_cases_identifiers_not_blank CHECK (((btrim(case_id) <> ''::text) AND (case_id = btrim(case_id)) AND ((resolved_by_user_id IS NULL) OR ((btrim(resolved_by_user_id) <> ''::text) AND (resolved_by_user_id = btrim(resolved_by_user_id)))))),
    CONSTRAINT text_moderation_cases_status_check CHECK ((status = ANY (ARRAY['open'::text, 'approved'::text, 'dismissed'::text, 'blocked'::text]))),
    CONSTRAINT text_moderation_cases_status_shape CHECK ((((status = 'open'::text) AND (resolved_by_user_id IS NULL)) OR ((status <> 'open'::text) AND (resolved_by_user_id IS NOT NULL)))),
    CONSTRAINT text_moderation_cases_time_order CHECK ((updated_at >= created_at))
);

CREATE TABLE text_moderation_evidence (
    evidence_ref text NOT NULL,
    provider_id text NOT NULL,
    requested_model_identifier text NOT NULL,
    response_model_identifier text,
    outcome text NOT NULL,
    normalized_categories jsonb DEFAULT '{}'::jsonb NOT NULL,
    normalized_scores jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_moderation_evidence_categories_object CHECK ((jsonb_typeof(normalized_categories) = 'object'::text)),
    CONSTRAINT text_moderation_evidence_identifiers_not_blank CHECK (((btrim(evidence_ref) <> ''::text) AND (evidence_ref = btrim(evidence_ref)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(requested_model_identifier) <> ''::text) AND (requested_model_identifier = btrim(requested_model_identifier)) AND ((response_model_identifier IS NULL) OR ((btrim(response_model_identifier) <> ''::text) AND (response_model_identifier = btrim(response_model_identifier)))))),
    CONSTRAINT text_moderation_evidence_outcome_check CHECK ((outcome = ANY (ARRAY['evaluated'::text, 'provider_unavailable'::text, 'provider_timeout'::text, 'provider_invalid'::text]))),
    CONSTRAINT text_moderation_evidence_response_sha256_check CHECK (((response_sha256 IS NULL) OR (response_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT text_moderation_evidence_scores_object CHECK ((jsonb_typeof(normalized_scores) = 'object'::text))
);

CREATE TABLE text_moderation_policy_current (
    singleton boolean DEFAULT true NOT NULL,
    policy_revision_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_moderation_policy_current_singleton_check CHECK (singleton)
);

CREATE TABLE text_moderation_policy_revisions (
    policy_revision_id text NOT NULL,
    policy_hash text NOT NULL,
    policy_preimage text NOT NULL,
    policy_document jsonb NOT NULL,
    provider_id text NOT NULL,
    model_identifier text NOT NULL,
    base_url_origin text NOT NULL,
    timeout_ms integer NOT NULL,
    sexual_minors_block_threshold numeric NOT NULL,
    normalization_revision text NOT NULL,
    decision_mapper_revision text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_moderation_policy_document_object CHECK ((jsonb_typeof(policy_document) = 'object'::text)),
    CONSTRAINT text_moderation_policy_identifiers_not_blank CHECK (((btrim(policy_revision_id) <> ''::text) AND (policy_revision_id = btrim(policy_revision_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(model_identifier) <> ''::text) AND (model_identifier = btrim(model_identifier)) AND (btrim(base_url_origin) <> ''::text) AND (base_url_origin = btrim(base_url_origin)) AND (btrim(normalization_revision) <> ''::text) AND (normalization_revision = btrim(normalization_revision)) AND (btrim(decision_mapper_revision) <> ''::text) AND (decision_mapper_revision = btrim(decision_mapper_revision)))),
    CONSTRAINT text_moderation_policy_preimage_matches_document CHECK (((policy_preimage)::jsonb = policy_document)),
    CONSTRAINT text_moderation_policy_revis_sexual_minors_block_threshol_check CHECK (((sexual_minors_block_threshold >= (0)::numeric) AND (sexual_minors_block_threshold <= (1)::numeric))),
    CONSTRAINT text_moderation_policy_revisions_policy_hash_check CHECK ((policy_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT text_moderation_policy_revisions_timeout_ms_check CHECK ((timeout_ms > 0))
);

CREATE TABLE used_action_grants (
    grant_nonce text NOT NULL,
    action_grant_id text NOT NULL,
    action_intent_id text NOT NULL,
    action_kind text NOT NULL,
    action_scope text NOT NULL,
    action_payload_hash text NOT NULL,
    action_result_ref text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT used_action_grants_action_payload_hash_check CHECK ((action_payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT used_action_grants_identifiers_not_blank CHECK (((btrim(grant_nonce) <> ''::text) AND (btrim(action_kind) <> ''::text) AND (btrim(action_scope) <> ''::text) AND (btrim(action_result_ref) <> ''::text)))
);

CREATE TABLE users (
    user_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    account jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_id_not_blank CHECK ((btrim(user_id) <> ''::text)),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'deleted'::text])))
);

CREATE TABLE verification_completion_attempts (
    attempt_id text NOT NULL,
    proof_session_id text NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verification_completion_attempts_fence_check CHECK ((fence_token > 0)),
    CONSTRAINT verification_completion_attempts_idempotency_not_blank CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT verification_completion_attempts_state_check CHECK ((state = ANY (ARRAY['leased'::text, 'released'::text, 'consumed'::text])))
);

CREATE TABLE verification_start_reservations (
    reservation_id text NOT NULL,
    actor_id text NOT NULL,
    intent_id text NOT NULL,
    request_hash text NOT NULL,
    request jsonb NOT NULL,
    state text NOT NULL,
    fence_token bigint DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    creation_intent_id text,
    creation_requirement_kind text,
    creation_generation bigint,
    client_idempotency_key text,
    CONSTRAINT verification_start_reservations_creation_shape CHECK ((((creation_intent_id IS NULL) AND (creation_requirement_kind IS NULL) AND (creation_generation IS NULL) AND (client_idempotency_key IS NULL)) OR ((creation_intent_id IS NOT NULL) AND (creation_requirement_kind = ANY (ARRAY['human_identity'::text, 'namespace_ownership'::text])) AND (creation_generation > 0) AND (client_idempotency_key IS NOT NULL) AND (btrim(client_idempotency_key) <> ''::text) AND (client_idempotency_key = btrim(client_idempotency_key))))),
    CONSTRAINT verification_start_reservations_fence_check CHECK ((fence_token > 0)),
    CONSTRAINT verification_start_reservations_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT verification_start_reservations_request_object_check CHECK ((jsonb_typeof(request) = 'object'::text)),
    CONSTRAINT verification_start_reservations_state_check CHECK ((state = ANY (ARRAY['acquired'::text, 'released'::text, 'finalized'::text])))
);

ALTER TABLE ONLY account_aliases
    ADD CONSTRAINT account_aliases_pkey PRIMARY KEY (source_user_id);

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_id_intent_provider_unique UNIQUE (action_challenge_id, action_intent_id, provider_id);

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_intent_hash_unique UNIQUE (action_intent_id, challenge_hash);

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_pkey PRIMARY KEY (action_challenge_id);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_consumption_identity_unique UNIQUE (action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_unique UNIQUE (action_intent_id);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_nonce_unique UNIQUE (grant_nonce);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_pkey PRIMARY KEY (action_grant_id);

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_identity_unique UNIQUE (action_intent_id, user_id, action_kind, action_scope, action_payload_hash);

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_pkey PRIMARY KEY (action_intent_id);

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_user_action_idempotency_unique UNIQUE (user_id, action_kind, idempotency_key);

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_pkey PRIMARY KEY (subject_key_id);

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_subject_user_unique UNIQUE (subject_key_id, user_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_id_user_unique UNIQUE (binding_group_id, user_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_pkey PRIMARY KEY (binding_group_id);

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_events_pkey PRIMARY KEY (assertion_revalidation_event_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_id_binding_unique UNIQUE (assertion_id, binding_group_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_id_user_unique UNIQUE (assertion_id, user_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_pkey PRIMARY KEY (assertion_id);

ALTER TABLE ONLY comment_moderation_actions
    ADD CONSTRAINT comment_moderation_actions_actor_key_unique UNIQUE (case_ref, actor_user_id, idempotency_key);

ALTER TABLE ONLY comment_moderation_actions
    ADD CONSTRAINT comment_moderation_actions_pkey PRIMARY KEY (action_id);

ALTER TABLE ONLY comment_moderation_cases
    ADD CONSTRAINT comment_moderation_cases_community_ref_unique UNIQUE (community_id, case_ref);

ALTER TABLE ONLY comment_moderation_cases
    ADD CONSTRAINT comment_moderation_cases_pkey PRIMARY KEY (case_ref);

ALTER TABLE ONLY comment_publication_projection
    ADD CONSTRAINT comment_publication_projection_pkey PRIMARY KEY (community_id, comment_id);

ALTER TABLE ONLY comment_reports
    ADD CONSTRAINT comment_reports_pkey PRIMARY KEY (report_id);

ALTER TABLE ONLY comment_reports
    ADD CONSTRAINT comment_reports_reporter_key_unique UNIQUE (reporter_user_id, comment_id, idempotency_key);

ALTER TABLE ONLY comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (community_id, comment_id);

ALTER TABLE ONLY communities
    ADD CONSTRAINT communities_pkey PRIMARY KEY (community_id);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_community_id_key UNIQUE (community_id);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_community_id_unique UNIQUE (community_id, route_binding_id);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_id_family_unique UNIQUE (route_binding_id, family);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_path_unique UNIQUE (path_segment);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_pkey PRIMARY KEY (route_binding_id);

ALTER TABLE ONLY community_commerce_allocation_policy_versions
    ADD CONSTRAINT community_commerce_allocation_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_donation_partners
    ADD CONSTRAINT community_commerce_donation_partners_pkey PRIMARY KEY (partner_id);

ALTER TABLE ONLY community_commerce_donation_policy_versions
    ADD CONSTRAINT community_commerce_donation_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_eligibility_policy_versions
    ADD CONSTRAINT community_commerce_eligibility_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_listings
    ADD CONSTRAINT community_commerce_listings_pkey PRIMARY KEY (listing_id);

ALTER TABLE ONLY community_commerce_money_route_policy_versions
    ADD CONSTRAINT community_commerce_money_route_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_operator_ledger
    ADD CONSTRAINT community_commerce_operator_ledger_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY community_commerce_policy_revisions
    ADD CONSTRAINT community_commerce_policy_revisions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_pricing_policy_versions
    ADD CONSTRAINT community_commerce_pricing_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_commerce_settlement_policy_versions
    ADD CONSTRAINT community_commerce_settlement_policy_versions_pkey PRIMARY KEY (community_id, policy_version);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_actor_ceremony_unique UNIQUE (actor_id, ceremony_intent_id);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_generation_unique UNIQUE (intent_id, requirement_kind, generation);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_identity_unique UNIQUE (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_pkey PRIMARY KEY (ceremony_intent_id);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_unique UNIQUE (completion_attempt_id);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_pkey PRIMARY KEY (ceremony_intent_id);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_proof_session_id_key UNIQUE (proof_session_id);

ALTER TABLE ONLY community_creation_intent_revisions
    ADD CONSTRAINT community_creation_intent_revisions_pkey PRIMARY KEY (intent_id, revision);

ALTER TABLE ONLY community_creation_intents
    ADD CONSTRAINT community_creation_intents_actor_create_key_unique UNIQUE (actor_id, create_idempotency_key);

ALTER TABLE ONLY community_creation_intents
    ADD CONSTRAINT community_creation_intents_actor_intent_unique UNIQUE (actor_id, intent_id);

ALTER TABLE ONLY community_creation_intents
    ADD CONSTRAINT community_creation_intents_pkey PRIMARY KEY (intent_id);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_binding_unique UNIQUE (approval_id, subject_key_id, actor_id, slot_number);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_pkey PRIMARY KEY (approval_id);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_subject_slot_unique UNIQUE (subject_key_id, slot_number);

ALTER TABLE ONLY community_creation_requirement_states
    ADD CONSTRAINT community_creation_requirement_states_actor_generation_unique UNIQUE (actor_id, intent_id, requirement_kind, generation);

ALTER TABLE ONLY community_creation_requirement_states
    ADD CONSTRAINT community_creation_requirement_states_pkey PRIMARY KEY (intent_id, requirement_kind);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_approval_id_key UNIQUE (approval_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_community_id_key UNIQUE (community_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_intent_id_key UNIQUE (intent_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_pkey PRIMARY KEY (claim_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_subject_slot_unique UNIQUE (subject_key_id, slot_number);

ALTER TABLE ONLY community_feed_projection
    ADD CONSTRAINT community_feed_projection_pkey PRIMARY KEY (community_id, post_id);

ALTER TABLE ONLY community_follows
    ADD CONSTRAINT community_follows_pkey PRIMARY KEY (community_follow_id);

ALTER TABLE ONLY community_follows
    ADD CONSTRAINT community_follows_user_unique UNIQUE (community_id, user_id);

ALTER TABLE ONLY community_memberships
    ADD CONSTRAINT community_memberships_pkey PRIMARY KEY (community_id, membership_id);

ALTER TABLE ONLY community_memberships
    ADD CONSTRAINT community_memberships_user_unique UNIQUE (community_id, user_id);

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_pk PRIMARY KEY (community_id, policy_key);

ALTER TABLE ONLY community_policy_provider_bindings
    ADD CONSTRAINT community_policy_provider_bindings_pkey PRIMARY KEY (community_id, policy_key, policy_version_id);

ALTER TABLE ONLY community_purchase_allocation_snapshots
    ADD CONSTRAINT community_purchase_allocation_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_allocation_snapshots
    ADD CONSTRAINT community_purchase_allocation_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_availability_reservations
    ADD CONSTRAINT community_purchase_availability_reservations_pkey PRIMARY KEY (purchase_id);

ALTER TABLE ONLY community_purchase_correction_events
    ADD CONSTRAINT community_purchase_correction_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY community_purchase_donation_snapshots
    ADD CONSTRAINT community_purchase_donation_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_donation_snapshots
    ADD CONSTRAINT community_purchase_donation_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_eligibility_snapshots
    ADD CONSTRAINT community_purchase_eligibility_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_eligibility_snapshots
    ADD CONSTRAINT community_purchase_eligibility_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_funding_journal
    ADD CONSTRAINT community_purchase_funding_journal_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_operation_id_key UNIQUE (operation_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_pkey PRIMARY KEY (quote_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_purchase_id_key UNIQUE (purchase_id);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_log_unique UNIQUE (chain_id, transaction_hash, log_index);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_operation_id_key UNIQUE (operation_id);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_pkey PRIMARY KEY (receipt_id);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_transaction_unique UNIQUE (chain_id, transaction_hash);

ALTER TABLE ONLY community_purchase_funding_reconciliation_attempts
    ADD CONSTRAINT community_purchase_funding_reconciliation_attempts_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY community_purchase_funding_reconciliation_operator_actions
    ADD CONSTRAINT community_purchase_funding_reconciliation_operator_actions_pkey PRIMARY KEY (action_id);

ALTER TABLE ONLY community_purchase_funding_requests
    ADD CONSTRAINT community_purchase_funding_requests_pkey PRIMARY KEY (actor_id, endpoint, client_nonce);

ALTER TABLE ONLY community_purchase_funding_transaction_claims
    ADD CONSTRAINT community_purchase_funding_transaction_claims_hash_unique UNIQUE (chain_id, transaction_hash);

ALTER TABLE ONLY community_purchase_funding_transaction_claims
    ADD CONSTRAINT community_purchase_funding_transaction_claims_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY community_purchase_funding_transitions
    ADD CONSTRAINT community_purchase_funding_transitions_observation_unique UNIQUE (operation_id, observation_id);

ALTER TABLE ONLY community_purchase_funding_transitions
    ADD CONSTRAINT community_purchase_funding_transitions_pkey PRIMARY KEY (operation_id, target_version);

ALTER TABLE ONLY community_purchase_intents
    ADD CONSTRAINT community_purchase_intents_pkey PRIMARY KEY (purchase_id);

ALTER TABLE ONLY community_purchase_pricing_snapshots
    ADD CONSTRAINT community_purchase_pricing_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_pricing_snapshots
    ADD CONSTRAINT community_purchase_pricing_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_pkey PRIMARY KEY (quote_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_purchase_id_key UNIQUE (purchase_id);

ALTER TABLE ONLY community_purchase_route_snapshots
    ADD CONSTRAINT community_purchase_route_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_route_snapshots
    ADD CONSTRAINT community_purchase_route_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_settlement_snapshots
    ADD CONSTRAINT community_purchase_settlement_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_settlement_snapshots
    ADD CONSTRAINT community_purchase_settlement_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_purchase_verification_snapshots
    ADD CONSTRAINT community_purchase_verification_snapshots_pkey PRIMARY KEY (snapshot_id);

ALTER TABLE ONLY community_purchase_verification_snapshots
    ADD CONSTRAINT community_purchase_verification_snapshots_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY community_route_app_host_health
    ADD CONSTRAINT community_route_app_host_health_pkey PRIMARY KEY (route_binding_id);

ALTER TABLE ONLY community_route_attachment_ceremony_attempts
    ADD CONSTRAINT community_route_attachment_ceremony_attempts_identity_unique UNIQUE (actor_id, attachment_intent_id, requirement_kind, generation, ceremony_intent_id);

ALTER TABLE ONLY community_route_attachment_ceremony_attempts
    ADD CONSTRAINT community_route_attachment_ceremony_attempts_pkey PRIMARY KEY (ceremony_intent_id);

ALTER TABLE ONLY community_route_attachment_ceremony_results
    ADD CONSTRAINT community_route_attachment_ceremony_results_callback_unique UNIQUE (actor_id, ceremony_intent_id, callback_idempotency_key);

ALTER TABLE ONLY community_route_attachment_ceremony_results
    ADD CONSTRAINT community_route_attachment_ceremony_results_pkey PRIMARY KEY (ceremony_intent_id);

ALTER TABLE ONLY community_route_attachment_intent_revisions
    ADD CONSTRAINT community_route_attachment_intent_revisions_pkey PRIMARY KEY (attachment_intent_id, revision);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_actor_identity_unique UNIQUE (actor_id, attachment_intent_id);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_create_idempotency_unique UNIQUE (actor_id, create_idempotency_key);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_pkey PRIMARY KEY (attachment_intent_id);

ALTER TABLE ONLY community_route_attachment_requirement_states
    ADD CONSTRAINT community_route_attachment_requirement_states_pkey PRIMARY KEY (attachment_intent_id, requirement_kind);

ALTER TABLE ONLY community_route_authority_grants
    ADD CONSTRAINT community_route_authority_grants_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY community_route_lifecycle_transitions
    ADD CONSTRAINT community_route_lifecycle_transition_generation_unique UNIQUE (route_binding_id, expected_binding_generation);

ALTER TABLE ONLY community_route_lifecycle_transitions
    ADD CONSTRAINT community_route_lifecycle_transitions_pkey PRIMARY KEY (route_lifecycle_transition_id);

ALTER TABLE ONLY community_route_operator_override_audit
    ADD CONSTRAINT community_route_operator_override_audit_pkey PRIMARY KEY (override_audit_id);

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_pkey PRIMARY KEY (evidence_ref);

ALTER TABLE ONLY community_route_revalidation_evidence_snapshots
    ADD CONSTRAINT community_route_revalidation__route_revalidation_attempt_id_key UNIQUE (route_revalidation_attempt_id);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_attempts_fence_unique UNIQUE (route_revalidation_attempt_id, fence_token);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_attempts_idempotency_unique UNIQUE (route_revalidation_id, idempotency_key);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_attempts_number_unique UNIQUE (route_revalidation_id, attempt_number);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_completion_attemp_evidence_ref_key UNIQUE (evidence_ref);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_completion_attempts_pkey PRIMARY KEY (route_revalidation_attempt_id);

ALTER TABLE ONLY community_route_revalidation_evidence_snapshots
    ADD CONSTRAINT community_route_revalidation_evidence_snapshots_pkey PRIMARY KEY (evidence_ref);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_authority_unique UNIQUE (route_revalidation_id, revalidation_session_id, route_binding_id, expected_binding_generation);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_pkey PRIMARY KEY (revalidation_session_id);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_route_revalidation_id_key UNIQUE (route_revalidation_id);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_upstream_unique UNIQUE (provider_id, provider_binding_hash, environment, upstream_session_ref);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start__revalidation_session_id_key UNIQUE (revalidation_session_id);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start_fence_unique UNIQUE (route_revalidation_id, fence_token);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start_generation_unique UNIQUE (route_binding_id, expected_binding_generation);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start_reservations_pkey PRIMARY KEY (route_revalidation_id);

ALTER TABLE ONLY content_publication_outbox
    ADD CONSTRAINT content_publication_outbox_effect_key_unique UNIQUE (effect_key);

ALTER TABLE ONLY content_publication_outbox
    ADD CONSTRAINT content_publication_outbox_pkey PRIMARY KEY (outbox_event_id);

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_pkey PRIMARY KEY (decision_record_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_binding_identity_unique UNIQUE (evidence_receipt_id, subject_key_id, subject_binding_event_id, subject_binding_epoch, user_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_id_user_unique UNIQUE (evidence_receipt_id, user_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_pkey PRIMARY KEY (evidence_receipt_id);

ALTER TABLE ONLY hns_authority_inventories
    ADD CONSTRAINT hns_authority_inventories_identity_unique UNIQUE (authority_inventory_reference, authority_inventory_version, authority_inventory_digest);

ALTER TABLE ONLY hns_authority_inventories
    ADD CONSTRAINT hns_authority_inventories_pk PRIMARY KEY (registry_reference, authority_inventory_version);

ALTER TABLE ONLY hns_control_observer_configurations
    ADD CONSTRAINT hns_control_observer_configurations_digest_unique UNIQUE (provider_configuration_reference, provider_configuration_version, provider_configuration_digest);

ALTER TABLE ONLY hns_control_observer_configurations
    ADD CONSTRAINT hns_control_observer_configurations_pk PRIMARY KEY (provider_configuration_reference, provider_configuration_version);

ALTER TABLE ONLY hns_control_observer_operations
    ADD CONSTRAINT hns_control_observer_operations_identity_snapshot_unique UNIQUE (observation_id, snapshot_reference);

ALTER TABLE ONLY hns_control_observer_operations
    ADD CONSTRAINT hns_control_observer_operations_pkey PRIMARY KEY (observation_id);

ALTER TABLE ONLY hns_control_observer_operations
    ADD CONSTRAINT hns_control_observer_operations_snapshot_unique UNIQUE (snapshot_reference);

ALTER TABLE ONLY hns_control_observer_reservations
    ADD CONSTRAINT hns_control_observer_reservations_fence_unique UNIQUE (observation_id, observer_fence);

ALTER TABLE ONLY hns_control_observer_reservations
    ADD CONSTRAINT hns_control_observer_reservations_pkey PRIMARY KEY (observation_id);

ALTER TABLE ONLY hns_control_observer_snapshot_transcript_entries
    ADD CONSTRAINT hns_control_observer_snapshot_transcript_entries_pk PRIMARY KEY (snapshot_reference, entry_ordinal);

ALTER TABLE ONLY hns_control_observer_snapshots
    ADD CONSTRAINT hns_control_observer_snapshots_observation_unique UNIQUE (observation_id);

ALTER TABLE ONLY hns_control_observer_snapshots
    ADD CONSTRAINT hns_control_observer_snapshots_pkey PRIMARY KEY (snapshot_reference);

ALTER TABLE ONLY home_feed_projection
    ADD CONSTRAINT home_feed_projection_pkey PRIMARY KEY (community_id, feed_item_id);

ALTER TABLE ONLY identity_credentials
    ADD CONSTRAINT identity_credentials_pkey PRIMARY KEY (credential_id);

ALTER TABLE ONLY identity_credentials
    ADD CONSTRAINT identity_credentials_provider_subject_unique UNIQUE (provider, provider_app_id, provider_subject);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_community_id_actor_user_id_post_key UNIQUE (community_id, actor_user_id, post_id);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_evidence_pkey PRIMARY KEY (submission_id, analysis_revision);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_evidence_submission_id_audio_revision_analys_key UNIQUE (submission_id, audio_revision, analysis_revision, canonical_audio_sha256);

ALTER TABLE ONLY media_audio_revisions
    ADD CONSTRAINT media_audio_revisions_pkey PRIMARY KEY (submission_id, audio_revision);

ALTER TABLE ONLY media_audio_revisions
    ADD CONSTRAINT media_audio_revisions_submission_id_audio_revision_canonic_key1 UNIQUE (submission_id, audio_revision, canonical_sha256);

ALTER TABLE ONLY media_audio_revisions
    ADD CONSTRAINT media_audio_revisions_submission_id_audio_revision_canonica_key UNIQUE (submission_id, audio_revision, canonical_sha256, immutable_ref);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_community_id_actor_user_id_operatio_key UNIQUE (community_id, actor_user_id, operation_id);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_community_id_immutable_ref_canonica_key UNIQUE (community_id, immutable_ref, canonical_sha256, content_type, size_bytes);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_community_id_immutable_ref_key UNIQUE (community_id, immutable_ref);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_destination_ref_key UNIQUE (destination_ref);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_pkey PRIMARY KEY (immutable_ref);

ALTER TABLE ONLY media_moderation_actions
    ADD CONSTRAINT media_moderation_actions_community_id_authority_actor_user__key UNIQUE (community_id, authority_actor_user_id, action_id);

ALTER TABLE ONLY media_moderation_actions
    ADD CONSTRAINT media_moderation_actions_pkey PRIMARY KEY (action_id);

ALTER TABLE ONLY media_moderation_projections
    ADD CONSTRAINT media_moderation_projections_community_id_actor_user_id_sub_key UNIQUE (community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_moderation_projections
    ADD CONSTRAINT media_moderation_projections_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_actor_lineage_unique UNIQUE (community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_actor_operation_unique UNIQUE (community_id, actor_user_id, operation_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_actor_submission_unique UNIQUE (community_id, actor_user_id, submission_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_identity_unique UNIQUE (community_id, submission_id, operation_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_replay_unique UNIQUE (community_id, actor_user_id, endpoint_template, idempotency_key);

ALTER TABLE ONLY media_processing_attempts
    ADD CONSTRAINT media_processing_attempts_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY media_processing_attempts
    ADD CONSTRAINT media_processing_attempts_provider_idempotency_key_key UNIQUE (provider_idempotency_key);

ALTER TABLE ONLY media_processing_attempts
    ADD CONSTRAINT media_processing_attempts_submission_id_audio_revision_anal_key UNIQUE (submission_id, audio_revision, analysis_revision, stage, attempt_number);

ALTER TABLE ONLY media_publication_decisions
    ADD CONSTRAINT media_publication_decisions_pkey PRIMARY KEY (submission_id, decision_revision);

ALTER TABLE ONLY media_publication_projections
    ADD CONSTRAINT media_publication_projections_community_id_actor_user_id_po_key UNIQUE (community_id, actor_user_id, post_id);

ALTER TABLE ONLY media_publication_projections
    ADD CONSTRAINT media_publication_projections_community_id_actor_user_id_su_key UNIQUE (community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_publication_projections
    ADD CONSTRAINT media_publication_projections_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY media_reference_evidence
    ADD CONSTRAINT media_reference_evidence_pkey PRIMARY KEY (community_id, actor_user_id, submission_id, operation_id, asset_id, evidence_audio_revision, evidence_analysis_revision, evidence_audio_sha256);

ALTER TABLE ONLY media_submission_command_replays
    ADD CONSTRAINT media_submission_command_replays_pkey PRIMARY KEY (community_id, actor_user_id, endpoint_template, idempotency_key);

ALTER TABLE ONLY media_submission_events
    ADD CONSTRAINT media_submission_events_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY media_submission_events
    ADD CONSTRAINT media_submission_events_pkey PRIMARY KEY (community_id, actor_user_id, submission_id, event_sequence);

ALTER TABLE ONLY media_submission_outbox
    ADD CONSTRAINT media_submission_outbox_community_id_actor_user_id_effect_i_key UNIQUE (community_id, actor_user_id, effect_identity);

ALTER TABLE ONLY media_submission_outbox
    ADD CONSTRAINT media_submission_outbox_community_id_actor_user_id_submissi_key UNIQUE (community_id, actor_user_id, submission_id, workflow_revision, event_type);

ALTER TABLE ONLY media_submission_outbox
    ADD CONSTRAINT media_submission_outbox_pkey PRIMARY KEY (outbox_event_id);

ALTER TABLE ONLY media_submission_terms
    ADD CONSTRAINT media_submission_terms_pkey PRIMARY KEY (submission_id, creation_revision);

ALTER TABLE ONLY media_timed_lyrics_artifacts
    ADD CONSTRAINT media_timed_lyrics_artifacts_artifact_ref_artifact_revision_key UNIQUE (artifact_ref, artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256);

ALTER TABLE ONLY media_timed_lyrics_artifacts
    ADD CONSTRAINT media_timed_lyrics_artifacts_pkey PRIMARY KEY (artifact_ref);

ALTER TABLE ONLY media_transcript_artifacts
    ADD CONSTRAINT media_transcript_artifacts_pkey PRIMARY KEY (transcript_artifact_ref);

ALTER TABLE ONLY media_transcript_artifacts
    ADD CONSTRAINT media_transcript_artifacts_transcript_artifact_ref_communit_key UNIQUE (transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_claim_unique UNIQUE (community_id, actor_user_id, reservation_id, submission_id, operation_id);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_identity_unique UNIQUE (community_id, actor_user_id, reservation_id);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_pkey PRIMARY KEY (reservation_id);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_replay_unique UNIQUE (community_id, actor_user_id, endpoint_template, idempotency_key);

ALTER TABLE ONLY moderation_actions
    ADD CONSTRAINT moderation_actions_pkey PRIMARY KEY (community_id, action_id);

ALTER TABLE ONLY moderation_reports
    ADD CONSTRAINT moderation_reports_pkey PRIMARY KEY (community_id, report_id);

ALTER TABLE ONLY namespace_ownership_completion_attempts
    ADD CONSTRAINT namespace_ownership_completion_attempts_evidence_ref_unique UNIQUE (evidence_ref);

ALTER TABLE ONLY namespace_ownership_completion_attempts
    ADD CONSTRAINT namespace_ownership_completion_attempts_idempotency_unique UNIQUE (namespace_session_id, idempotency_key);

ALTER TABLE ONLY namespace_ownership_completion_attempts
    ADD CONSTRAINT namespace_ownership_completion_attempts_pkey PRIMARY KEY (completion_attempt_id);

ALTER TABLE ONLY namespace_ownership_evidence_snapshots
    ADD CONSTRAINT namespace_ownership_evidence_snapshot_completion_attempt_id_key UNIQUE (completion_attempt_id);

ALTER TABLE ONLY namespace_ownership_evidence_snapshots
    ADD CONSTRAINT namespace_ownership_evidence_snapshots_pkey PRIMARY KEY (evidence_ref);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_actor_ceremony_unique UNIQUE (actor_id, ceremony_intent_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_generation_unique UNIQUE (creation_intent_id, requirement_kind, generation);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_id_actor_unique UNIQUE (namespace_session_id, actor_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_pkey PRIMARY KEY (namespace_session_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_actor_ceremony_unique UNIQUE (actor_id, ceremony_intent_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_client_key_unique UNIQUE (actor_id, creation_intent_id, client_idempotency_key);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_fence_unique UNIQUE (reservation_id, fence_token);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_generation_unique UNIQUE (creation_intent_id, requirement_kind, generation);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_pkey PRIMARY KEY (reservation_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_session_unique UNIQUE (namespace_session_id, actor_id);

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_id_user_unique UNIQUE (observation_id, user_id);

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (observation_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_id_hash_unique UNIQUE (community_id, policy_version_id, policy_hash);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_key_version_unique UNIQUE (community_id, policy_key, policy_version_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_hash_unique UNIQUE (community_id, policy_key, policy_hash);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (community_id, policy_version_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_revision_unique UNIQUE (community_id, policy_key, revision);

ALTER TABLE ONLY post_vote_actions
    ADD CONSTRAINT post_vote_actions_actor_post_endpoint_key_unique UNIQUE (actor_user_id, post_id, endpoint_template, idempotency_key);

ALTER TABLE ONLY post_vote_actions
    ADD CONSTRAINT post_vote_actions_pkey PRIMARY KEY (action_id);

ALTER TABLE ONLY post_votes
    ADD CONSTRAINT post_votes_pkey PRIMARY KEY (community_id, post_vote_id);

ALTER TABLE ONLY post_votes
    ADD CONSTRAINT post_votes_user_post_unique UNIQUE (community_id, post_id, user_id);

ALTER TABLE ONLY posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (community_id, post_id);

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_idempotency_unique UNIQUE (proof_session_id, idempotency_key);

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_pkey PRIMARY KEY (completion_event_id);

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_session_unique UNIQUE (proof_session_id);

ALTER TABLE ONLY proof_session_presentations
    ADD CONSTRAINT proof_session_presentations_pkey PRIMARY KEY (proof_session_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_actor_intent_unique UNIQUE (actor_id, intent_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_creation_ceremony_intent_id_key UNIQUE (creation_ceremony_intent_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_id_actor_unique UNIQUE (proof_session_id, actor_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_pkey PRIMARY KEY (proof_session_id);

ALTER TABLE ONLY public_handle_index
    ADD CONSTRAINT public_handle_index_pkey PRIMARY KEY (handle_id);

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_campaign_subject_unique UNIQUE (campaign_id, subject_key_id);

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_pkey PRIMARY KEY (reward_subject_consumption_id);

ALTER TABLE ONLY reward_uniqueness_authorities
    ADD CONSTRAINT reward_uniqueness_authorities_pkey PRIMARY KEY (campaign_id);

ALTER TABLE ONLY schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_event_subject_unique UNIQUE (binding_event_id, subject_key_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_pkey PRIMARY KEY (binding_event_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_receipt_identity_unique UNIQUE (binding_event_id, subject_key_id, binding_epoch, user_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_epoch_unique UNIQUE (subject_key_id, binding_epoch);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_idempotency_unique UNIQUE (subject_key_id, idempotency_key);

ALTER TABLE ONLY subject_keys
    ADD CONSTRAINT subject_keys_pkey PRIMARY KEY (subject_key_id);

ALTER TABLE ONLY text_content_held_revisions
    ADD CONSTRAINT text_content_held_revisions_pkey PRIMARY KEY (held_revision_id);

ALTER TABLE ONLY text_content_held_revisions
    ADD CONSTRAINT text_content_held_revisions_submission_id_key UNIQUE (submission_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_community_id_unique UNIQUE (community_id, submission_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_operation_id_unique UNIQUE (operation_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_pkey PRIMARY KEY (submission_id);

ALTER TABLE ONLY text_moderation_cases
    ADD CONSTRAINT text_moderation_cases_community_case_unique UNIQUE (community_id, case_id);

ALTER TABLE ONLY text_moderation_cases
    ADD CONSTRAINT text_moderation_cases_pkey PRIMARY KEY (case_id);

ALTER TABLE ONLY text_moderation_cases
    ADD CONSTRAINT text_moderation_cases_submission_id_key UNIQUE (submission_id);

ALTER TABLE ONLY text_moderation_evidence
    ADD CONSTRAINT text_moderation_evidence_pkey PRIMARY KEY (evidence_ref);

ALTER TABLE ONLY text_moderation_policy_current
    ADD CONSTRAINT text_moderation_policy_current_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY text_moderation_policy_revisions
    ADD CONSTRAINT text_moderation_policy_revision_hash_unique UNIQUE (policy_revision_id, policy_hash);

ALTER TABLE ONLY text_moderation_policy_revisions
    ADD CONSTRAINT text_moderation_policy_revisions_pkey PRIMARY KEY (policy_revision_id);

ALTER TABLE ONLY text_moderation_policy_revisions
    ADD CONSTRAINT text_moderation_policy_revisions_policy_hash_key UNIQUE (policy_hash);

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_grant_unique UNIQUE (action_grant_id);

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_pkey PRIMARY KEY (grant_nonce);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_idempotency_unique UNIQUE (proof_session_id, idempotency_key);

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY verification_start_reservations
    ADD CONSTRAINT verification_start_reservations_actor_intent_unique UNIQUE (actor_id, intent_id);

ALTER TABLE ONLY verification_start_reservations
    ADD CONSTRAINT verification_start_reservations_pkey PRIMARY KEY (reservation_id);

CREATE INDEX account_aliases_canonical_idx ON account_aliases USING btree (canonical_user_id);

CREATE INDEX action_challenges_intent_status_idx ON action_challenges USING btree (action_intent_id, status, expires_at DESC);

CREATE INDEX action_grants_user_expiry_idx ON action_grants USING btree (user_id, expires_at DESC, action_grant_id);

CREATE INDEX action_intents_expiry_idx ON action_intents USING btree (status, expires_at, action_intent_id);

CREATE INDEX active_subject_key_bindings_user_idx ON active_subject_key_bindings USING btree (user_id, activated_at DESC, subject_key_id);

CREATE INDEX assertion_bindings_user_idx ON assertion_bindings USING btree (user_id, created_at DESC);

CREATE INDEX assertion_revalidation_assertion_idx ON assertion_revalidation_events USING btree (assertion_id, observed_at DESC);

CREATE INDEX assertion_revalidation_receipt_idx ON assertion_revalidation_events USING btree (evidence_receipt_id, observed_at DESC) WHERE (evidence_receipt_id IS NOT NULL);

CREATE INDEX assertions_binding_claim_idx ON assertions USING btree (binding_group_id, claim_id);

CREATE INDEX assertions_user_claim_observed_idx ON assertions USING btree (user_id, claim_id, observed_at DESC);

CREATE UNIQUE INDEX comment_moderation_cases_open_source_submission_unique ON comment_moderation_cases USING btree (source, submission_id) WHERE (status = 'open'::text);

CREATE INDEX comment_moderation_cases_open_target_idx ON comment_moderation_cases USING btree (community_id, comment_id, created_at, case_ref) WHERE (status = 'open'::text);

CREATE INDEX comment_publication_projection_thread_idx ON comment_publication_projection USING btree (community_id, post_id, parent_comment_id, projected_at, comment_id);

CREATE INDEX comment_reports_open_target_idx ON comment_reports USING btree (community_id, comment_id, created_at, report_id) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX comments_author_endpoint_idempotency_unique ON comments USING btree (author_user_id, (
CASE
    WHEN (parent_comment_id IS NULL) THEN 'comment'::text
    ELSE 'reply'::text
END), idempotency_key) WHERE ((author_user_id IS NOT NULL) AND (idempotency_key <> ''::text));

CREATE UNIQUE INDEX comments_comment_id_global_unique ON comments USING btree (comment_id);

CREATE INDEX comments_parent_created_idx ON comments USING btree (community_id, parent_comment_id, created_at, comment_id);

CREATE INDEX comments_post_created_idx ON comments USING btree (community_id, post_id, created_at, comment_id);

CREATE INDEX communities_creator_status_created_idx ON communities USING btree (created_by_user_id, status, created_at DESC, community_id);

CREATE UNIQUE INDEX communities_route_slug_uidx ON communities USING btree (route_slug) WHERE (route_slug IS NOT NULL);

CREATE INDEX community_commerce_listing_active_idx ON community_commerce_listings USING btree (community_id, active, listing_id);

CREATE UNIQUE INDEX community_creation_ceremony_results_callback_uidx ON community_creation_ceremony_results USING btree (actor_id, ceremony_intent_id, callback_idempotency_key);

CREATE UNIQUE INDEX community_creation_intent_revisions_idempotency_uidx ON community_creation_intent_revisions USING btree (actor_id, operation_kind, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX community_creation_intents_actor_status_idx ON community_creation_intents USING btree (actor_id, status, updated_at DESC, intent_id);

CREATE INDEX community_creation_intents_expiry_idx ON community_creation_intents USING btree (expires_at, intent_id) WHERE (status = ANY (ARRAY['draft'::text, 'verification_required'::text, 'commit_ready'::text]));

CREATE INDEX community_feed_rank_idx ON community_feed_projection USING btree (community_id, rank_score DESC, post_id);

CREATE INDEX community_follows_user_status_idx ON community_follows USING btree (user_id, status);

CREATE INDEX community_memberships_status_idx ON community_memberships USING btree (community_id, status, updated_at DESC);

CREATE INDEX community_policy_current_version_idx ON community_policy_current USING btree (policy_version_id);

CREATE UNIQUE INDEX community_purchase_correction_idempotency ON community_purchase_correction_events USING btree (target_identity, kind);

CREATE INDEX community_purchase_funding_lease_idx ON community_purchase_funding_journal USING btree (lease_expires_at, operation_id) WHERE (lease_owner IS NOT NULL);

CREATE INDEX community_purchase_funding_planned_dormancy_idx ON community_purchase_funding_journal USING btree (created_at, operation_id) WHERE ((state = 'planned'::text) AND (funding_transaction_hash IS NULL));

CREATE INDEX community_purchase_funding_plans_actor_status_idx ON community_purchase_funding_plans USING btree (actor_id, status, expires_at, quote_id);

CREATE INDEX community_purchase_funding_plans_community_status_idx ON community_purchase_funding_plans USING btree (community_id, status, expires_at, quote_id);

CREATE INDEX community_purchase_funding_requests_operation_idx ON community_purchase_funding_requests USING btree (operation_id);

CREATE INDEX community_purchase_funding_state_idx ON community_purchase_funding_journal USING btree (state, updated_at, operation_id);

CREATE UNIQUE INDEX community_purchase_funding_transaction_claims_log_unique ON community_purchase_funding_transaction_claims USING btree (chain_id, transaction_hash, successful_log_index) WHERE (successful_log_index IS NOT NULL);

CREATE UNIQUE INDEX community_purchase_intents_open_unique ON community_purchase_intents USING btree (actor_id, community_id, listing_id) WHERE (status = 'reserved'::text);

CREATE INDEX community_purchase_quote_actor_status_idx ON community_purchase_quotes USING btree (actor_id, status, expires_at, quote_id);

CREATE UNIQUE INDEX community_route_attachment_intent_replay_uidx ON community_route_attachment_intent_revisions USING btree (actor_id, operation_kind, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE UNIQUE INDEX community_route_attachment_intents_one_open_per_community_uidx ON community_route_attachment_intents USING btree (community_id) WHERE (status = ANY (ARRAY['verification_required'::text, 'commit_ready'::text]));

CREATE UNIQUE INDEX community_route_authority_grants_active_uidx ON community_route_authority_grants USING btree (community_id, principal_user_id, authority) WHERE (status = 'active'::text);

CREATE INDEX community_route_authority_grants_principal_idx ON community_route_authority_grants USING btree (principal_user_id, community_id, status);

CREATE INDEX community_route_lifecycle_transitions_time_idx ON community_route_lifecycle_transitions USING btree (transitioned_at, route_binding_id, expected_binding_generation);

CREATE UNIQUE INDEX community_route_ownership_evidence_attachment_ceremony_uidx ON community_route_ownership_evidence USING btree (route_attachment_ceremony_intent_id) WHERE (origin = 'route_attachment'::text);

CREATE INDEX community_route_ownership_evidence_expiry_idx ON community_route_ownership_evidence USING btree (expires_at, evidence_ref) WHERE (expires_at IS NOT NULL);

CREATE UNIQUE INDEX community_route_ownership_evidence_revalidation_attempt_uidx ON community_route_ownership_evidence USING btree (route_revalidation_attempt_id) WHERE (origin = 'route_revalidation'::text);

CREATE INDEX community_route_revalidation_attempts_lease_idx ON community_route_revalidation_completion_attempts USING btree (state, lease_expires_at);

CREATE UNIQUE INDEX community_route_revalidation_one_leased_attempt_uidx ON community_route_revalidation_completion_attempts USING btree (revalidation_session_id) WHERE (state = 'leased'::text);

CREATE INDEX community_route_revalidation_start_lease_idx ON community_route_revalidation_start_reservations USING btree (state, lease_expires_at);

CREATE INDEX content_publication_outbox_pending_idx ON content_publication_outbox USING btree (state, created_at, outbox_event_id) WHERE (state = ANY (ARRAY['pending'::text, 'failed'::text]));

CREATE UNIQUE INDEX content_publication_outbox_publish_effect_unique ON content_publication_outbox USING btree (submission_id, event_type) WHERE (event_type = ANY (ARRAY['comment_published'::text, 'comment_notification'::text]));

CREATE INDEX cpf_attempt_operator_actions_operation_idx ON community_purchase_funding_reconciliation_operator_actions USING btree (operation_id, action_id);

CREATE INDEX cpf_attempts_selection_idx ON community_purchase_funding_reconciliation_attempts USING btree (next_attempt_at, operation_id) WHERE (escalated_at IS NULL);

CREATE INDEX decision_records_policy_created_idx ON decision_records USING btree (policy_version_id, created_at DESC, decision_record_id);

CREATE UNIQUE INDEX decision_records_request_uidx ON decision_records USING btree (community_id, user_id, request_id) WHERE (request_id IS NOT NULL);

CREATE INDEX decision_records_user_created_idx ON decision_records USING btree (user_id, created_at DESC, decision_record_id);

CREATE UNIQUE INDEX evidence_receipts_provider_evidence_uidx ON evidence_receipts USING btree (provider_id, environment, evidence_hash);

CREATE UNIQUE INDEX evidence_receipts_session_hash_uidx ON evidence_receipts USING btree (proof_session_id, evidence_hash) WHERE (proof_session_id IS NOT NULL);

CREATE INDEX evidence_receipts_session_observed_idx ON evidence_receipts USING btree (proof_session_id, observed_at DESC, evidence_receipt_id);

CREATE INDEX evidence_receipts_user_observed_idx ON evidence_receipts USING btree (user_id, observed_at DESC, evidence_receipt_id);

CREATE INDEX hns_authority_inventories_current_idx ON hns_authority_inventories USING btree (registry_reference, published_at DESC, expires_at);

CREATE INDEX hns_control_observer_reservations_live_lease_idx ON hns_control_observer_reservations USING btree (lease_expires_at, observation_id) WHERE (state = 'reserved'::text);

CREATE UNIQUE INDEX home_feed_projection_post_unique ON home_feed_projection USING btree (community_id, post_id);

CREATE INDEX home_feed_rank_idx ON home_feed_projection USING btree (community_id, rank_score DESC, feed_item_id);

CREATE INDEX identity_credentials_user_status_idx ON identity_credentials USING btree (canonical_user_id, status, created_at DESC);

CREATE INDEX media_post_submissions_author_idx ON media_post_submissions USING btree (community_id, actor_user_id, updated_at DESC, submission_id);

CREATE INDEX media_processing_attempts_claim_idx ON media_processing_attempts USING btree (state, next_eligible_at, lease_expires_at, attempt_id) WHERE (state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text]));

CREATE INDEX media_submission_outbox_claim_idx ON media_submission_outbox USING btree (state, next_eligible_at, lease_expires_at, created_at, outbox_event_id) WHERE (state = ANY (ARRAY['pending'::text, 'running'::text, 'failed'::text]));

CREATE INDEX media_transcript_lineage_idx ON media_transcript_artifacts USING btree (submission_id, audio_revision, analysis_revision, canonical_audio_sha256);

CREATE INDEX media_upload_reservations_expiry_idx ON media_upload_reservations USING btree (state, expires_at, reservation_id) WHERE (state = ANY (ARRAY['issued'::text, 'claimed'::text]));

CREATE INDEX moderation_actions_target_idx ON moderation_actions USING btree (community_id, target_kind, target_id, created_at DESC);

CREATE INDEX moderation_reports_status_idx ON moderation_reports USING btree (community_id, status, created_at, report_id);

CREATE INDEX namespace_ownership_completion_attempts_lease_idx ON namespace_ownership_completion_attempts USING btree (state, lease_expires_at);

CREATE INDEX namespace_ownership_start_reservations_lease_idx ON namespace_ownership_start_reservations USING btree (state, lease_expires_at);

CREATE INDEX observations_chain_asset_observed_idx ON observations USING btree (user_id, chain_id, asset_caip19, observed_at DESC);

CREATE INDEX observations_snapshot_idx ON observations USING gin (snapshot_ref);

CREATE INDEX observations_snapshot_response_idx ON observations USING btree (resolver_id, source_response_hash);

CREATE INDEX observations_user_kind_observed_idx ON observations USING btree (user_id, observation_kind, observed_at DESC, observation_id);

CREATE INDEX post_vote_actions_target_time_idx ON post_vote_actions USING btree (community_id, post_id, created_at, action_id);

CREATE INDEX post_votes_post_idx ON post_votes USING btree (community_id, post_id, updated_at DESC, post_vote_id);

CREATE INDEX posts_author_created_idx ON posts USING btree (community_id, author_user_id, created_at DESC, post_id);

CREATE UNIQUE INDEX posts_author_idempotency_unique ON posts USING btree (community_id, author_user_id, idempotency_key) WHERE ((author_user_id IS NOT NULL) AND (idempotency_key <> ''::text));

CREATE UNIQUE INDEX posts_post_id_global_unique ON posts USING btree (post_id);

CREATE INDEX posts_status_created_idx ON posts USING btree (community_id, status, created_at DESC, post_id);

CREATE INDEX proof_sessions_actor_status_idx ON proof_sessions USING btree (actor_id, status, created_at DESC);

CREATE UNIQUE INDEX proof_sessions_provider_ref_uidx ON proof_sessions USING btree (provider_id, upstream_session_ref) WHERE (upstream_session_ref IS NOT NULL);

CREATE UNIQUE INDEX public_handle_index_label_normalized_uidx ON public_handle_index USING btree (label_normalized);

CREATE UNIQUE INDEX public_handle_index_one_active_owner_uidx ON public_handle_index USING btree (owner_user_id) WHERE (status = 'active'::text);

CREATE INDEX public_handle_index_owner_status_idx ON public_handle_index USING btree (owner_user_id, status, updated_at DESC);

CREATE INDEX public_handle_index_redirect_target_idx ON public_handle_index USING btree (redirect_target_handle_id) WHERE (status = 'redirect'::text);

CREATE INDEX subject_key_binding_events_user_bound_idx ON subject_key_binding_events USING btree (user_id, bound_at DESC, binding_event_id);

CREATE UNIQUE INDEX subject_keys_action_scope_uidx ON subject_keys USING btree (issuer, method, issuer_rp_scope, issuer_rp_action_scope, subject_digest) WHERE (scope_kind = 'issuer_rp_action_scope'::text);

CREATE UNIQUE INDEX subject_keys_rp_scope_uidx ON subject_keys USING btree (issuer, method, issuer_rp_scope, subject_digest) WHERE (scope_kind = 'issuer_rp_scope'::text);

CREATE INDEX subject_keys_scope_created_idx ON subject_keys USING btree (issuer, method, scope_kind, created_at DESC, subject_key_id);

CREATE INDEX text_content_submissions_actor_created_idx ON text_content_submissions USING btree (actor_user_id, created_at DESC, submission_id);

CREATE UNIQUE INDEX text_content_submissions_comment_reply_actor_key_unique ON text_content_submissions USING btree (actor_user_id, surface, idempotency_key) WHERE (surface = ANY (ARRAY['comment'::text, 'reply'::text]));

CREATE INDEX text_content_submissions_review_idx ON text_content_submissions USING btree (community_id, status, created_at, submission_id) WHERE (status = 'manual_review'::text);

CREATE UNIQUE INDEX text_content_submissions_text_post_actor_key_unique ON text_content_submissions USING btree (actor_user_id, idempotency_key) WHERE (surface = 'text_post'::text);

CREATE INDEX text_moderation_cases_open_idx ON text_moderation_cases USING btree (community_id, created_at, case_id) WHERE (status = 'open'::text);

CREATE INDEX used_action_grants_intent_idx ON used_action_grants USING btree (action_intent_id, consumed_at DESC);

CREATE INDEX verification_completion_attempts_lease_idx ON verification_completion_attempts USING btree (state, lease_expires_at);

CREATE INDEX verification_completion_attempts_session_state_idx ON verification_completion_attempts USING btree (proof_session_id, state);

CREATE UNIQUE INDEX verification_start_reservations_creation_idempotency_uidx ON verification_start_reservations USING btree (actor_id, creation_intent_id, creation_requirement_kind, client_idempotency_key) WHERE (creation_intent_id IS NOT NULL);

CREATE INDEX verification_start_reservations_lease_idx ON verification_start_reservations USING btree (state, lease_expires_at);

CREATE TRIGGER action_grants_append_only BEFORE DELETE OR UPDATE ON action_grants FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER active_subject_key_bindings_projection_only BEFORE INSERT OR DELETE OR UPDATE ON active_subject_key_bindings FOR EACH ROW EXECUTE FUNCTION gates_v2_active_binding_projection_guard();

CREATE TRIGGER assertion_bindings_append_only BEFORE DELETE OR UPDATE ON assertion_bindings FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertion_revalidation_events_append_only BEFORE DELETE OR UPDATE ON assertion_revalidation_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertions_append_only BEFORE DELETE OR UPDATE ON assertions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER assertions_validate_binding BEFORE INSERT OR UPDATE ON assertions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_assertion_binding();

CREATE CONSTRAINT TRIGGER communities_canonical_route_binding_guard AFTER INSERT OR UPDATE OF status, canonical_route_binding_id, route_authority_version ON communities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

CREATE TRIGGER communities_canonical_route_reference_guard BEFORE UPDATE OF canonical_route_binding_id ON communities FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_reference();

CREATE TRIGGER communities_route_authority_version_guard BEFORE UPDATE OF route_authority_version ON communities FOR EACH ROW EXECUTE FUNCTION guard_community_route_authority_version();

CREATE TRIGGER community_canonical_route_binding_delete_guard BEFORE DELETE ON community_canonical_route_bindings FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE TRIGGER community_canonical_route_binding_update_guard BEFORE UPDATE ON community_canonical_route_bindings FOR EACH ROW EXECUTE FUNCTION guard_community_canonical_route_binding_change();

CREATE CONSTRAINT TRIGGER community_canonical_route_reference_guard AFTER INSERT OR UPDATE ON community_canonical_route_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

CREATE TRIGGER community_commerce_allocation_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_allocation_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_donation_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_donation_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_eligibility_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_eligibility_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_operator_ledger_append_only BEFORE DELETE OR UPDATE ON community_commerce_operator_ledger FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_policy_revision_delete_guard BEFORE DELETE ON community_commerce_policy_revisions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_policy_revision_update_guard BEFORE UPDATE ON community_commerce_policy_revisions FOR EACH ROW EXECUTE FUNCTION guard_community_commerce_policy_revision_update();

CREATE TRIGGER community_commerce_pricing_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_pricing_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_route_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_money_route_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_settlement_policy_append_only BEFORE DELETE OR UPDATE ON community_commerce_settlement_policy_versions FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_creation_ceremony_attempt_append_only BEFORE DELETE OR UPDATE ON community_creation_ceremony_attempts FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_ceremony_attempt_insert_guard BEFORE INSERT ON community_creation_ceremony_attempts FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_attempt_insert();

CREATE TRIGGER community_creation_ceremony_result_append_only BEFORE DELETE OR UPDATE ON community_creation_ceremony_results FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_ceremony_result_insert_guard BEFORE INSERT ON community_creation_ceremony_results FOR EACH ROW EXECUTE FUNCTION validate_community_creation_ceremony_result_insert();

CREATE CONSTRAINT TRIGGER community_creation_ceremony_result_state_guard AFTER INSERT ON community_creation_ceremony_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

CREATE TRIGGER community_creation_contract_version_guard BEFORE UPDATE OF creation_contract_version ON community_creation_intents FOR EACH ROW EXECUTE FUNCTION guard_community_creation_contract_version();

CREATE TRIGGER community_creation_intent_delete_guard BEFORE DELETE ON community_creation_intents FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_intent_revision_append_only BEFORE DELETE OR UPDATE ON community_creation_intent_revisions FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_intent_update_guard BEFORE UPDATE ON community_creation_intents FOR EACH ROW EXECUTE FUNCTION guard_community_creation_intent_update();

CREATE CONSTRAINT TRIGGER community_creation_optional_route_v2_commit_guard AFTER INSERT OR UPDATE ON community_creation_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_optional_route_v2_committed_community();

CREATE TRIGGER community_creation_quota_approval_append_only BEFORE DELETE OR UPDATE ON community_creation_quota_approvals FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE CONSTRAINT TRIGGER community_creation_requirement_result_state_guard AFTER INSERT OR UPDATE ON community_creation_requirement_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_creation_requirement_result();

CREATE TRIGGER community_creation_requirement_state_delete_guard BEFORE DELETE ON community_creation_requirement_states FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_creation_requirement_state_update_guard BEFORE UPDATE ON community_creation_requirement_states FOR EACH ROW EXECUTE FUNCTION guard_community_creation_requirement_state_update();

CREATE CONSTRAINT TRIGGER community_creation_route_v1_commit_guard AFTER INSERT OR UPDATE ON community_creation_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_route_v1_committed_community();

CREATE TRIGGER community_creation_subject_claim_append_only BEFORE DELETE OR UPDATE ON community_creation_subject_claims FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_policy_provider_binding_append_only BEFORE DELETE OR UPDATE ON community_policy_provider_bindings FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_purchase_allocation_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_allocation_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_correction_event_append_only BEFORE DELETE OR UPDATE ON community_purchase_correction_events FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_donation_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_donation_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_eligibility_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_eligibility_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_funding_claims_append_only BEFORE DELETE OR UPDATE ON community_purchase_funding_transaction_claims FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_journal_delete_guard BEFORE DELETE ON community_purchase_funding_journal FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_journal_update_guard BEFORE UPDATE ON community_purchase_funding_journal FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_journal_update();

CREATE TRIGGER community_purchase_funding_plans_delete_guard BEFORE DELETE ON community_purchase_funding_plans FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_plans_update_guard BEFORE UPDATE ON community_purchase_funding_plans FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_plan_update();

CREATE TRIGGER community_purchase_funding_receipts_append_only BEFORE DELETE OR UPDATE ON community_purchase_funding_receipts FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_requests_delete_guard BEFORE DELETE ON community_purchase_funding_requests FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_transitions_append_only BEFORE DELETE OR UPDATE ON community_purchase_funding_transitions FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_pricing_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_pricing_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_quote_update_guard BEFORE UPDATE ON community_purchase_quotes FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_quote_update();

CREATE TRIGGER community_purchase_route_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_route_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_settlement_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_settlement_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_purchase_verification_snapshot_append_only BEFORE DELETE OR UPDATE ON community_purchase_verification_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_route_attachment_attempt_append_only BEFORE DELETE OR UPDATE ON community_route_attachment_ceremony_attempts FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

CREATE TRIGGER community_route_attachment_attempt_insert_guard BEFORE INSERT ON community_route_attachment_ceremony_attempts FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_attempt_insert();

CREATE TRIGGER community_route_attachment_binding_insert_guard BEFORE INSERT ON community_canonical_route_bindings FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_binding_insert();

CREATE TRIGGER community_route_attachment_evidence_insert_guard BEFORE INSERT ON community_route_ownership_evidence FOR EACH ROW WHEN ((new.origin = 'route_attachment'::text)) EXECUTE FUNCTION validate_community_route_attachment_evidence_insert();

CREATE TRIGGER community_route_attachment_intent_guard BEFORE INSERT OR UPDATE ON community_route_attachment_intents FOR EACH ROW EXECUTE FUNCTION guard_community_route_attachment_intent();

CREATE CONSTRAINT TRIGGER community_route_attachment_intent_requirement_cardinality AFTER INSERT OR UPDATE ON community_route_attachment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_cardinality();

CREATE CONSTRAINT TRIGGER community_route_attachment_requirement_cardinality AFTER INSERT OR DELETE OR UPDATE ON community_route_attachment_requirement_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_cardinality();

CREATE CONSTRAINT TRIGGER community_route_attachment_requirement_result_state_guard AFTER INSERT OR UPDATE ON community_route_attachment_requirement_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_result();

CREATE TRIGGER community_route_attachment_requirement_state_guard BEFORE DELETE OR UPDATE ON community_route_attachment_requirement_states FOR EACH ROW EXECUTE FUNCTION guard_community_route_attachment_requirement_state();

CREATE TRIGGER community_route_attachment_result_append_only BEFORE DELETE OR UPDATE ON community_route_attachment_ceremony_results FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

CREATE TRIGGER community_route_attachment_result_insert_guard BEFORE INSERT ON community_route_attachment_ceremony_results FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_result_insert();

CREATE CONSTRAINT TRIGGER community_route_attachment_result_state_guard AFTER INSERT ON community_route_attachment_ceremony_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_attachment_requirement_result();

CREATE TRIGGER community_route_attachment_revision_append_only BEFORE DELETE OR UPDATE ON community_route_attachment_intent_revisions FOR EACH ROW EXECUTE FUNCTION reject_community_route_attachment_immutable_change();

CREATE TRIGGER community_route_authority_grants_change_guard BEFORE UPDATE ON community_route_authority_grants FOR EACH ROW EXECUTE FUNCTION guard_community_route_authority_grant_change();

CREATE TRIGGER community_route_lifecycle_transition_append_only BEFORE DELETE OR UPDATE ON community_route_lifecycle_transitions FOR EACH ROW EXECUTE FUNCTION reject_community_route_lifecycle_transition_change();

CREATE TRIGGER community_route_lifecycle_transition_insert_guard BEFORE INSERT ON community_route_lifecycle_transitions FOR EACH ROW EXECUTE FUNCTION validate_community_route_lifecycle_transition_insert();

CREATE TRIGGER community_route_operator_override_audit_change_guard BEFORE DELETE OR UPDATE ON community_route_operator_override_audit FOR EACH ROW EXECUTE FUNCTION reject_community_route_operator_override_audit_change();

CREATE TRIGGER community_route_ownership_evidence_append_only BEFORE DELETE OR UPDATE ON community_route_ownership_evidence FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_route_ownership_evidence_insert_guard BEFORE INSERT ON community_route_ownership_evidence FOR EACH ROW WHEN ((new.origin = ANY (ARRAY['creation_ceremony'::text, 'route_revalidation'::text]))) EXECUTE FUNCTION validate_community_route_ownership_evidence_insert();

CREATE TRIGGER community_route_revalidation_attempt_guard BEFORE INSERT OR DELETE OR UPDATE ON community_route_revalidation_completion_attempts FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_attempt();

CREATE CONSTRAINT TRIGGER community_route_revalidation_attempt_session_guard AFTER INSERT OR UPDATE ON community_route_revalidation_completion_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();

CREATE CONSTRAINT TRIGGER community_route_revalidation_session_attempt_guard AFTER UPDATE ON community_route_revalidation_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_attempt_session();

CREATE TRIGGER community_route_revalidation_session_change_guard BEFORE DELETE OR UPDATE ON community_route_revalidation_sessions FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_session_change();

CREATE CONSTRAINT TRIGGER community_route_revalidation_session_coherence AFTER INSERT OR UPDATE ON community_route_revalidation_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_start_coherence();

CREATE TRIGGER community_route_revalidation_session_insert_guard BEFORE INSERT ON community_route_revalidation_sessions FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_session_insert();

CREATE TRIGGER community_route_revalidation_snapshot_append_only BEFORE DELETE OR UPDATE ON community_route_revalidation_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION reject_community_creation_immutable_change();

CREATE TRIGGER community_route_revalidation_snapshot_insert_guard BEFORE INSERT ON community_route_revalidation_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_snapshot_insert();

CREATE CONSTRAINT TRIGGER community_route_revalidation_start_coherence AFTER INSERT OR UPDATE ON community_route_revalidation_start_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_community_route_revalidation_start_coherence();

CREATE TRIGGER community_route_revalidation_start_guard BEFORE INSERT OR DELETE OR UPDATE ON community_route_revalidation_start_reservations FOR EACH ROW EXECUTE FUNCTION guard_community_route_revalidation_start();

CREATE TRIGGER decision_records_append_only BEFORE DELETE OR UPDATE ON decision_records FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER evidence_receipts_append_only BEFORE DELETE OR UPDATE ON evidence_receipts FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER evidence_receipts_validate_metadata BEFORE INSERT OR UPDATE ON evidence_receipts FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_evidence_receipt();

CREATE TRIGGER hns_authority_inventories_append_only BEFORE DELETE OR UPDATE ON hns_authority_inventories FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_configurations_append_only BEFORE DELETE OR UPDATE ON hns_control_observer_configurations FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_operation_prepare BEFORE INSERT ON hns_control_observer_operations FOR EACH ROW EXECUTE FUNCTION prepare_hns_control_observer_operation_insert();

CREATE TRIGGER hns_control_observer_operations_append_only BEFORE DELETE OR UPDATE ON hns_control_observer_operations FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_reservation_guard BEFORE DELETE OR UPDATE ON hns_control_observer_reservations FOR EACH ROW EXECUTE FUNCTION guard_hns_control_observer_reservation_change();

CREATE CONSTRAINT TRIGGER hns_control_observer_snapshot_complete_guard AFTER INSERT ON hns_control_observer_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_snapshot_complete();

CREATE TRIGGER hns_control_observer_snapshot_insert_guard BEFORE INSERT ON hns_control_observer_snapshots FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_snapshot_insert();

CREATE TRIGGER hns_control_observer_snapshots_append_only BEFORE DELETE OR UPDATE ON hns_control_observer_snapshots FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_transcript_entries_append_only BEFORE DELETE OR UPDATE ON hns_control_observer_snapshot_transcript_entries FOR EACH ROW EXECUTE FUNCTION reject_hns_control_observer_append_only_change();

CREATE TRIGGER hns_control_observer_transcript_entry_insert_guard BEFORE INSERT ON hns_control_observer_snapshot_transcript_entries FOR EACH ROW EXECUTE FUNCTION validate_hns_control_observer_transcript_entry_insert();

CREATE TRIGGER identity_credentials_enforce_lifecycle BEFORE INSERT OR DELETE OR UPDATE ON identity_credentials FOR EACH ROW EXECUTE FUNCTION identity_credentials_enforce_lifecycle();

CREATE TRIGGER media_alignment_insert_guard BEFORE INSERT ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_insert();

CREATE TRIGGER media_alignment_update_guard BEFORE UPDATE ON media_alignment_projections FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_update();

CREATE TRIGGER media_analysis_evidence_append_only BEFORE DELETE OR UPDATE ON media_analysis_evidence FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_analysis_lineage_guard BEFORE INSERT ON media_analysis_evidence FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();

CREATE TRIGGER media_analysis_snapshot_guard BEFORE INSERT ON media_analysis_evidence FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();

CREATE TRIGGER media_audio_lineage_guard BEFORE INSERT ON media_audio_revisions FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();

CREATE TRIGGER media_audio_revisions_append_only BEFORE DELETE OR UPDATE ON media_audio_revisions FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_decision_lineage_guard BEFORE INSERT ON media_publication_decisions FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();

CREATE TRIGGER media_decision_snapshot_guard BEFORE INSERT ON media_publication_decisions FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();

CREATE TRIGGER media_immutable_object_insert_guard BEFORE INSERT ON media_immutable_objects FOR EACH ROW EXECUTE FUNCTION validate_media_immutable_object_insert();

CREATE TRIGGER media_immutable_objects_append_only BEFORE DELETE OR UPDATE ON media_immutable_objects FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_moderation_action_authority_guard BEFORE INSERT ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION validate_media_moderation_action_insert();

CREATE TRIGGER media_moderation_actions_append_only BEFORE DELETE OR UPDATE ON media_moderation_actions FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_moderation_projection_insert_guard BEFORE INSERT ON media_moderation_projections FOR EACH ROW EXECUTE FUNCTION validate_media_moderation_projection_insert();

CREATE TRIGGER media_moderation_projection_update_guard BEFORE UPDATE ON media_moderation_projections FOR EACH ROW EXECUTE FUNCTION guard_media_moderation_projection_update();

CREATE TRIGGER media_outbox_payload_guard BEFORE INSERT ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION validate_media_outbox_payload();

CREATE TRIGGER media_outbox_update_guard BEFORE UPDATE ON media_submission_outbox FOR EACH ROW EXECUTE FUNCTION guard_media_outbox_update();

CREATE TRIGGER media_processing_attempt_update_guard BEFORE UPDATE ON media_processing_attempts FOR EACH ROW EXECUTE FUNCTION guard_media_processing_attempt_update();

CREATE TRIGGER media_publication_decisions_append_only BEFORE DELETE OR UPDATE ON media_publication_decisions FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_publication_projection_insert_guard BEFORE INSERT ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION validate_media_publication_projection_insert();

CREATE TRIGGER media_publication_projection_update_guard BEFORE UPDATE ON media_publication_projections FOR EACH ROW EXECUTE FUNCTION guard_media_publication_projection_update();

CREATE CONSTRAINT TRIGGER media_reference_binding_pair AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_reference_binding();

CREATE TRIGGER media_reference_evidence_append_only BEFORE DELETE OR UPDATE ON media_reference_evidence FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE CONSTRAINT TRIGGER media_reservation_claim_pair AFTER INSERT OR UPDATE ON media_upload_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_reservation_claim_pair();

CREATE TRIGGER media_reservation_update_guard BEFORE UPDATE ON media_upload_reservations FOR EACH ROW EXECUTE FUNCTION guard_media_reservation_update();

CREATE TRIGGER media_submission_command_replays_append_only BEFORE DELETE OR UPDATE ON media_submission_command_replays FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE CONSTRAINT TRIGGER media_submission_event_pair AFTER UPDATE ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_submission_event_pair();

CREATE TRIGGER media_submission_events_append_only BEFORE DELETE OR UPDATE ON media_submission_events FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE CONSTRAINT TRIGGER media_submission_initial_event AFTER INSERT ON media_post_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_media_submission_initial_event();

CREATE TRIGGER media_submission_insert_authority_guard BEFORE INSERT ON media_post_submissions FOR EACH ROW EXECUTE FUNCTION validate_media_submission_authority();

CREATE TRIGGER media_submission_terms_append_only BEFORE DELETE OR UPDATE ON media_submission_terms FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_submission_update_guard BEFORE UPDATE ON media_post_submissions FOR EACH ROW EXECUTE FUNCTION guard_media_submission_update();

CREATE TRIGGER media_terms_lineage_guard BEFORE INSERT ON media_submission_terms FOR EACH ROW EXECUTE FUNCTION validate_media_lineage_insert();

CREATE TRIGGER media_terms_snapshot_guard BEFORE INSERT ON media_submission_terms FOR EACH ROW EXECUTE FUNCTION validate_media_snapshot_insert();

CREATE TRIGGER media_timed_lyrics_artifact_shape_guard BEFORE INSERT ON media_timed_lyrics_artifacts FOR EACH ROW EXECUTE FUNCTION validate_media_timed_lyrics_artifact();

CREATE TRIGGER media_timed_lyrics_artifacts_append_only BEFORE DELETE OR UPDATE ON media_timed_lyrics_artifacts FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE TRIGGER media_transcript_artifact_shape_guard BEFORE INSERT ON media_transcript_artifacts FOR EACH ROW EXECUTE FUNCTION validate_media_transcript_artifact();

CREATE TRIGGER media_transcript_artifacts_append_only BEFORE DELETE OR UPDATE ON media_transcript_artifacts FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();

CREATE CONSTRAINT TRIGGER namespace_ownership_attempt_session_coherence AFTER INSERT OR UPDATE ON namespace_ownership_completion_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE TRIGGER namespace_ownership_completion_attempt_change_guard BEFORE INSERT OR DELETE OR UPDATE ON namespace_ownership_completion_attempts FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_completion_attempt_change();

CREATE CONSTRAINT TRIGGER namespace_ownership_consumed_attempt_coherence AFTER UPDATE OF state, consumption_kind ON namespace_ownership_completion_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_consumed_attempt_coherence();

CREATE TRIGGER namespace_ownership_evidence_snapshot_append_only BEFORE DELETE OR UPDATE ON namespace_ownership_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION reject_namespace_ownership_evidence_snapshot_change();

CREATE TRIGGER namespace_ownership_evidence_snapshot_insert_guard BEFORE INSERT ON namespace_ownership_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_evidence_snapshot_insert();

CREATE CONSTRAINT TRIGGER namespace_ownership_result_terminal_coherence AFTER INSERT ON community_creation_ceremony_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_attempt_coherence AFTER INSERT OR UPDATE ON namespace_ownership_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_attempt_session_coherence();

CREATE TRIGGER namespace_ownership_session_delete_guard BEFORE DELETE ON namespace_ownership_sessions FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE TRIGGER namespace_ownership_session_insert_guard BEFORE INSERT ON namespace_ownership_sessions FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_session_insert();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_start_coherence AFTER INSERT OR UPDATE ON namespace_ownership_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE CONSTRAINT TRIGGER namespace_ownership_session_terminal_coherence AFTER INSERT OR UPDATE ON namespace_ownership_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_terminal_coherence();

CREATE TRIGGER namespace_ownership_session_update_guard BEFORE UPDATE ON namespace_ownership_sessions FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_session_update();

CREATE TRIGGER namespace_ownership_start_reservation_change_guard BEFORE INSERT OR DELETE OR UPDATE ON namespace_ownership_start_reservations FOR EACH ROW EXECUTE FUNCTION guard_namespace_ownership_start_reservation_change();

CREATE CONSTRAINT TRIGGER namespace_ownership_start_reservation_coherence AFTER INSERT OR UPDATE ON namespace_ownership_start_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_namespace_ownership_start_coherence();

CREATE TRIGGER observations_append_only BEFORE DELETE OR UPDATE ON observations FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER policy_versions_append_only BEFORE DELETE OR UPDATE ON policy_versions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER proof_session_completion_events_append_only BEFORE DELETE OR UPDATE ON proof_session_completion_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER proof_session_completion_events_validate BEFORE INSERT ON proof_session_completion_events FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_completion_event();

CREATE TRIGGER proof_session_presentations_append_only BEFORE DELETE OR UPDATE ON proof_session_presentations FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER proof_sessions_lifecycle BEFORE INSERT OR DELETE OR UPDATE ON proof_sessions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_proof_session_lifecycle();

CREATE CONSTRAINT TRIGGER proof_sessions_terminal_completion_event AFTER INSERT OR UPDATE ON proof_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gates_v2_require_terminal_completion_event();

CREATE CONSTRAINT TRIGGER public_handle_index_redirect_integrity AFTER INSERT OR UPDATE OF status, owner_user_id, redirect_target_handle_id ON public_handle_index DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public_handle_index_validate_redirects();

CREATE TRIGGER reward_subject_consumptions_append_only BEFORE DELETE OR UPDATE ON reward_subject_consumptions FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER reward_subject_consumptions_validate BEFORE INSERT ON reward_subject_consumptions FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_reward_subject_consumption();

CREATE TRIGGER reward_uniqueness_authorities_append_only BEFORE DELETE OR UPDATE ON reward_uniqueness_authorities FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE CONSTRAINT TRIGGER route_v1_creation_intent_requirement_cardinality AFTER INSERT OR UPDATE ON community_creation_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();

CREATE CONSTRAINT TRIGGER route_v1_creation_requirement_cardinality AFTER INSERT OR DELETE OR UPDATE ON community_creation_requirement_states DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_route_v1_creation_requirement_cardinality();

CREATE TRIGGER subject_key_binding_events_append_only BEFORE DELETE OR UPDATE ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER subject_key_binding_events_project AFTER INSERT ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_project_subject_key_binding();

CREATE TRIGGER subject_key_binding_events_validate BEFORE INSERT ON subject_key_binding_events FOR EACH ROW EXECUTE FUNCTION gates_v2_validate_subject_key_binding_event();

CREATE TRIGGER subject_keys_append_only BEFORE DELETE OR UPDATE ON subject_keys FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

CREATE TRIGGER text_content_held_revision_insert_guard BEFORE INSERT ON text_content_held_revisions FOR EACH ROW EXECUTE FUNCTION validate_text_review_child_insert();

CREATE CONSTRAINT TRIGGER text_content_held_revision_relations_guard AFTER INSERT ON text_content_held_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE TRIGGER text_content_held_revisions_append_only BEFORE DELETE OR UPDATE ON text_content_held_revisions FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER text_content_submission_delete_guard BEFORE DELETE ON text_content_submissions FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE CONSTRAINT TRIGGER text_content_submission_relations_guard AFTER INSERT OR UPDATE ON text_content_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE TRIGGER text_content_submission_response_snapshot_guard BEFORE UPDATE ON text_content_submissions FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_response_snapshot();

CREATE TRIGGER text_content_submission_update_guard BEFORE UPDATE ON text_content_submissions FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_update();

CREATE TRIGGER text_moderation_case_delete_guard BEFORE DELETE ON text_moderation_cases FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER text_moderation_case_insert_guard BEFORE INSERT ON text_moderation_cases FOR EACH ROW EXECUTE FUNCTION validate_text_review_child_insert();

CREATE CONSTRAINT TRIGGER text_moderation_case_relations_guard AFTER INSERT OR UPDATE ON text_moderation_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE TRIGGER text_moderation_case_update_guard BEFORE UPDATE ON text_moderation_cases FOR EACH ROW EXECUTE FUNCTION guard_text_moderation_case_update();

CREATE TRIGGER text_moderation_evidence_append_only BEFORE DELETE OR UPDATE ON text_moderation_evidence FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER text_moderation_policy_revisions_append_only BEFORE DELETE OR UPDATE ON text_moderation_policy_revisions FOR EACH ROW EXECUTE FUNCTION reject_text_moderation_append_only_change();

CREATE TRIGGER used_action_grants_append_only BEFORE DELETE OR UPDATE ON used_action_grants FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

ALTER TABLE ONLY action_challenges
    ADD CONSTRAINT action_challenges_intent_fk FOREIGN KEY (action_intent_id) REFERENCES action_intents(action_intent_id);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_challenge_intent_fk FOREIGN KEY (action_challenge_id, action_intent_id, provider_id) REFERENCES action_challenges(action_challenge_id, action_intent_id, provider_id);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_fk FOREIGN KEY (action_intent_id) REFERENCES action_intents(action_intent_id);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_intent_identity_fk FOREIGN KEY (action_intent_id, user_id, action_kind, action_scope, action_payload_hash) REFERENCES action_intents(action_intent_id, user_id, action_kind, action_scope, action_payload_hash);

ALTER TABLE ONLY action_grants
    ADD CONSTRAINT action_grants_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY action_intents
    ADD CONSTRAINT action_intents_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY active_subject_key_bindings
    ADD CONSTRAINT active_subject_key_bindings_event_fk FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_receipt_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_subject_binding_fk FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY assertion_bindings
    ADD CONSTRAINT assertion_bindings_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_assertion_fk FOREIGN KEY (assertion_id, user_id) REFERENCES assertions(assertion_id, user_id);

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_observation_fk FOREIGN KEY (observation_id, user_id) REFERENCES observations(observation_id, user_id);

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_receipt_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);

ALTER TABLE ONLY assertion_revalidation_events
    ADD CONSTRAINT assertion_revalidation_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_binding_user_fk FOREIGN KEY (binding_group_id, user_id) REFERENCES assertion_bindings(binding_group_id, user_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_receipt_user_fk FOREIGN KEY (evidence_receipt_id, user_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY assertions
    ADD CONSTRAINT assertions_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY comment_moderation_actions
    ADD CONSTRAINT comment_moderation_actions_case_fk FOREIGN KEY (community_id, case_ref) REFERENCES comment_moderation_cases(community_id, case_ref);

ALTER TABLE ONLY comment_moderation_cases
    ADD CONSTRAINT comment_moderation_cases_comment_fk FOREIGN KEY (community_id, comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY comment_moderation_cases
    ADD CONSTRAINT comment_moderation_cases_submission_fk FOREIGN KEY (community_id, submission_id) REFERENCES text_content_submissions(community_id, submission_id);

ALTER TABLE ONLY comment_moderation_cases
    ADD CONSTRAINT comment_moderation_cases_text_case_fk FOREIGN KEY (community_id, text_case_id) REFERENCES text_moderation_cases(community_id, case_id);

ALTER TABLE ONLY comment_publication_projection
    ADD CONSTRAINT comment_publication_projection_comment_fk FOREIGN KEY (community_id, comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY comment_publication_projection
    ADD CONSTRAINT comment_publication_projection_parent_fk FOREIGN KEY (community_id, parent_comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY comment_publication_projection
    ADD CONSTRAINT comment_publication_projection_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY comment_reports
    ADD CONSTRAINT comment_reports_case_fk FOREIGN KEY (community_id, case_ref) REFERENCES comment_moderation_cases(community_id, case_ref);

ALTER TABLE ONLY comment_reports
    ADD CONSTRAINT comment_reports_comment_fk FOREIGN KEY (community_id, comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY comments
    ADD CONSTRAINT comments_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY comments
    ADD CONSTRAINT comments_parent_fk FOREIGN KEY (community_id, parent_comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY comments
    ADD CONSTRAINT comments_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY communities
    ADD CONSTRAINT communities_canonical_route_binding_fk FOREIGN KEY (community_id, canonical_route_binding_id) REFERENCES community_canonical_route_bindings(community_id, route_binding_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_canonical_route_bindings
    ADD CONSTRAINT community_canonical_route_bindings_verified_evidence_fk FOREIGN KEY (verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_commerce_allocation_policy_versions
    ADD CONSTRAINT community_commerce_allocation__community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_donation_partners
    ADD CONSTRAINT community_commerce_donation_partners_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_commerce_donation_policy_versions
    ADD CONSTRAINT community_commerce_donation_po_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_donation_policy_versions
    ADD CONSTRAINT community_commerce_donation_policy_versions_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES community_commerce_donation_partners(partner_id);

ALTER TABLE ONLY community_commerce_eligibility_policy_versions
    ADD CONSTRAINT community_commerce_eligibility_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_listings
    ADD CONSTRAINT community_commerce_listing_identity_fk FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_money_route_policy_versions
    ADD CONSTRAINT community_commerce_money_route_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_operator_ledger
    ADD CONSTRAINT community_commerce_operator_ledger_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_commerce_policy_revisions
    ADD CONSTRAINT community_commerce_policy_revisions_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_commerce_policy_revisions
    ADD CONSTRAINT community_commerce_policy_revisions_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES users(user_id);

ALTER TABLE ONLY community_commerce_pricing_policy_versions
    ADD CONSTRAINT community_commerce_pricing_pol_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_commerce_settlement_policy_versions
    ADD CONSTRAINT community_commerce_settlement__community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_actor_intent_fk FOREIGN KEY (actor_id, intent_id) REFERENCES community_creation_intents(actor_id, intent_id);

ALTER TABLE ONLY community_creation_ceremony_attempts
    ADD CONSTRAINT community_creation_ceremony_attempts_state_fk FOREIGN KEY (intent_id, requirement_kind) REFERENCES community_creation_requirement_states(intent_id, requirement_kind);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_attempt_fk FOREIGN KEY (actor_id, intent_id, requirement_kind, generation, ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, intent_id, requirement_kind, generation, ceremony_intent_id);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_completion_attempt_fk FOREIGN KEY (completion_attempt_id) REFERENCES namespace_ownership_completion_attempts(completion_attempt_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_namespace_session_fk FOREIGN KEY (namespace_session_id) REFERENCES namespace_ownership_sessions(namespace_session_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_proof_session_id_fkey FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);

ALTER TABLE ONLY community_creation_ceremony_results
    ADD CONSTRAINT community_creation_ceremony_results_receipt_actor_fk FOREIGN KEY (evidence_receipt_id, actor_id) REFERENCES evidence_receipts(evidence_receipt_id, user_id);

ALTER TABLE ONLY community_creation_intent_revisions
    ADD CONSTRAINT community_creation_intent_revisions_actor_fk FOREIGN KEY (actor_id, intent_id) REFERENCES community_creation_intents(actor_id, intent_id);

ALTER TABLE ONLY community_creation_intent_revisions
    ADD CONSTRAINT community_creation_intent_revisions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_intent_revisions
    ADD CONSTRAINT community_creation_intent_revisions_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES community_creation_intents(intent_id);

ALTER TABLE ONLY community_creation_intents
    ADD CONSTRAINT community_creation_intents_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_intents
    ADD CONSTRAINT community_creation_intents_committed_community_id_fkey FOREIGN KEY (committed_community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_approved_by_user_id_fkey FOREIGN KEY (approved_by_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_quota_approvals
    ADD CONSTRAINT community_creation_quota_approvals_subject_key_id_fkey FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY community_creation_requirement_states
    ADD CONSTRAINT community_creation_requirement_states_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_requirement_states
    ADD CONSTRAINT community_creation_requirement_states_actor_intent_fk FOREIGN KEY (actor_id, intent_id) REFERENCES community_creation_intents(actor_id, intent_id);

ALTER TABLE ONLY community_creation_requirement_states
    ADD CONSTRAINT community_creation_requirement_states_current_ceremony_fk FOREIGN KEY (actor_id, intent_id, requirement_kind, generation, current_ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, intent_id, requirement_kind, generation, ceremony_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_approval_fk FOREIGN KEY (approval_id, subject_key_id, actor_id, slot_number) REFERENCES community_creation_quota_approvals(approval_id, subject_key_id, actor_id, slot_number);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_evidence_receipt_id_fkey FOREIGN KEY (evidence_receipt_id) REFERENCES evidence_receipts(evidence_receipt_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_intent_id_fkey FOREIGN KEY (intent_id) REFERENCES community_creation_intents(intent_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_proof_session_id_fkey FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);

ALTER TABLE ONLY community_creation_subject_claims
    ADD CONSTRAINT community_creation_subject_claims_subject_key_id_fkey FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY community_feed_projection
    ADD CONSTRAINT community_feed_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY community_follows
    ADD CONSTRAINT community_follows_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_memberships
    ADD CONSTRAINT community_memberships_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_policy_current
    ADD CONSTRAINT community_policy_current_policy_fk FOREIGN KEY (community_id, policy_key, policy_version_id) REFERENCES policy_versions(community_id, policy_key, policy_version_id);

ALTER TABLE ONLY community_policy_provider_bindings
    ADD CONSTRAINT community_policy_provider_bindings_policy_fk FOREIGN KEY (community_id, policy_key, policy_version_id) REFERENCES policy_versions(community_id, policy_key, policy_version_id);

ALTER TABLE ONLY community_purchase_allocation_snapshots
    ADD CONSTRAINT community_purchase_allocation_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_availability_reservations
    ADD CONSTRAINT community_purchase_availability_reservations_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES community_commerce_listings(listing_id);

ALTER TABLE ONLY community_purchase_availability_reservations
    ADD CONSTRAINT community_purchase_availability_reservations_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES community_purchase_intents(purchase_id);

ALTER TABLE ONLY community_purchase_correction_events
    ADD CONSTRAINT community_purchase_correction_events_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_correction_events
    ADD CONSTRAINT community_purchase_correction_events_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES community_purchase_intents(purchase_id);

ALTER TABLE ONLY community_purchase_correction_events
    ADD CONSTRAINT community_purchase_correction_events_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_donation_snapshots
    ADD CONSTRAINT community_purchase_donation_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_eligibility_snapshots
    ADD CONSTRAINT community_purchase_eligibility_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_funding_journal
    ADD CONSTRAINT community_purchase_funding_journal_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_funding_journal
    ADD CONSTRAINT community_purchase_funding_journal_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_purchase_funding_plans
    ADD CONSTRAINT community_purchase_funding_plans_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_purchase_funding_receipts
    ADD CONSTRAINT community_purchase_funding_receipts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_funding_reconciliation_attempts
    ADD CONSTRAINT community_purchase_funding_reconciliation_att_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_funding_reconciliation_operator_actions
    ADD CONSTRAINT community_purchase_funding_reconciliation_ope_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_reconciliation_attempts(operation_id);

ALTER TABLE ONLY community_purchase_funding_requests
    ADD CONSTRAINT community_purchase_funding_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_funding_requests
    ADD CONSTRAINT community_purchase_funding_requests_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_funding_transaction_claims
    ADD CONSTRAINT community_purchase_funding_transaction_claims_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_funding_transitions
    ADD CONSTRAINT community_purchase_funding_transitions_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES community_purchase_funding_journal(operation_id);

ALTER TABLE ONLY community_purchase_intents
    ADD CONSTRAINT community_purchase_intents_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_intents
    ADD CONSTRAINT community_purchase_intents_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_purchase_intents
    ADD CONSTRAINT community_purchase_intents_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES community_commerce_listings(listing_id);

ALTER TABLE ONLY community_purchase_pricing_snapshots
    ADD CONSTRAINT community_purchase_pricing_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES community_commerce_listings(listing_id);

ALTER TABLE ONLY community_purchase_quotes
    ADD CONSTRAINT community_purchase_quotes_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES community_purchase_intents(purchase_id);

ALTER TABLE ONLY community_purchase_route_snapshots
    ADD CONSTRAINT community_purchase_route_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_settlement_snapshots
    ADD CONSTRAINT community_purchase_settlement_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_purchase_verification_snapshots
    ADD CONSTRAINT community_purchase_verificatio_community_id_policy_version_fkey FOREIGN KEY (community_id, policy_version) REFERENCES community_commerce_policy_revisions(community_id, policy_version);

ALTER TABLE ONLY community_purchase_verification_snapshots
    ADD CONSTRAINT community_purchase_verification_snapshots_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_purchase_verification_snapshots
    ADD CONSTRAINT community_purchase_verification_snapshots_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES community_purchase_quotes(quote_id);

ALTER TABLE ONLY community_route_app_host_health
    ADD CONSTRAINT community_route_app_host_health_route_fk FOREIGN KEY (route_binding_id, family) REFERENCES community_canonical_route_bindings(route_binding_id, family);

ALTER TABLE ONLY community_route_attachment_ceremony_attempts
    ADD CONSTRAINT community_route_attachment_ceremony_attempts_intent_fk FOREIGN KEY (actor_id, attachment_intent_id) REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_attachment_ceremony_attempts
    ADD CONSTRAINT community_route_attachment_ceremony_attempts_state_fk FOREIGN KEY (attachment_intent_id, requirement_kind) REFERENCES community_route_attachment_requirement_states(attachment_intent_id, requirement_kind) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_attachment_ceremony_results
    ADD CONSTRAINT community_route_attachment_ceremony_results_attempt_fk FOREIGN KEY (actor_id, attachment_intent_id, requirement_kind, generation, ceremony_intent_id) REFERENCES community_route_attachment_ceremony_attempts(actor_id, attachment_intent_id, requirement_kind, generation, ceremony_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_attachment_ceremony_results
    ADD CONSTRAINT community_route_attachment_ceremony_results_evidence_fk FOREIGN KEY (evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_attachment_intent_revisions
    ADD CONSTRAINT community_route_attachment_intent_rev_attachment_intent_id_fkey FOREIGN KEY (attachment_intent_id) REFERENCES community_route_attachment_intents(attachment_intent_id);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_authority_grant_id_fkey FOREIGN KEY (authority_grant_id) REFERENCES community_route_authority_grants(grant_id);

ALTER TABLE ONLY community_route_attachment_intents
    ADD CONSTRAINT community_route_attachment_intents_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_route_attachment_requirement_states
    ADD CONSTRAINT community_route_attachment_requirement_current_ceremony_fk FOREIGN KEY (current_ceremony_intent_id) REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_attachment_requirement_states
    ADD CONSTRAINT community_route_attachment_requirement_states_intent_fk FOREIGN KEY (actor_id, attachment_intent_id) REFERENCES community_route_attachment_intents(actor_id, attachment_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_authority_grants
    ADD CONSTRAINT community_route_authority_grants_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_route_authority_grants
    ADD CONSTRAINT community_route_authority_grants_granted_by_user_id_fkey FOREIGN KEY (granted_by_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_route_authority_grants
    ADD CONSTRAINT community_route_authority_grants_principal_user_id_fkey FOREIGN KEY (principal_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_route_authority_grants
    ADD CONSTRAINT community_route_authority_grants_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_route_lifecycle_transitions
    ADD CONSTRAINT community_route_lifecycle_transition_binding_fk FOREIGN KEY (community_id, route_binding_id) REFERENCES community_canonical_route_bindings(community_id, route_binding_id);

ALTER TABLE ONLY community_route_lifecycle_transitions
    ADD CONSTRAINT community_route_lifecycle_transition_evidence_fk FOREIGN KEY (expected_verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref);

ALTER TABLE ONLY community_route_operator_override_audit
    ADD CONSTRAINT community_route_operator_override_audit_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_attachment_ceremony_fk FOREIGN KEY (route_attachment_ceremony_intent_id) REFERENCES community_route_attachment_ceremony_attempts(ceremony_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_creation_ceremony_fk FOREIGN KEY (creation_ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(ceremony_intent_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_evidence_receipt_id_fkey FOREIGN KEY (evidence_receipt_id) REFERENCES evidence_receipts(evidence_receipt_id);

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_revalidation_attempt_fk FOREIGN KEY (route_revalidation_attempt_id) REFERENCES community_route_revalidation_completion_attempts(route_revalidation_attempt_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_ownership_evidence
    ADD CONSTRAINT community_route_ownership_evidence_verified_by_actor_id_fkey FOREIGN KEY (verified_by_actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation__expected_verified_evidence_r_fkey FOREIGN KEY (expected_verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_attempts_session_fk FOREIGN KEY (route_revalidation_id, revalidation_session_id, route_binding_id, expected_binding_generation) REFERENCES community_route_revalidation_sessions(route_revalidation_id, revalidation_session_id, route_binding_id, expected_binding_generation);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_expected_verified_evidence_r_fkey1 FOREIGN KEY (expected_verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref);

ALTER TABLE ONLY community_route_revalidation_completion_attempts
    ADD CONSTRAINT community_route_revalidation_expected_verified_evidence_r_fkey2 FOREIGN KEY (expected_verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref);

ALTER TABLE ONLY community_route_revalidation_evidence_snapshots
    ADD CONSTRAINT community_route_revalidation_expected_verified_evidence_r_fkey3 FOREIGN KEY (expected_verified_evidence_ref) REFERENCES community_route_ownership_evidence(evidence_ref);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_binding_fk FOREIGN KEY (community_id, route_binding_id) REFERENCES community_canonical_route_bindings(community_id, route_binding_id);

ALTER TABLE ONLY community_route_revalidation_sessions
    ADD CONSTRAINT community_route_revalidation_sessions_start_fk FOREIGN KEY (route_revalidation_id, start_fence_token) REFERENCES community_route_revalidation_start_reservations(route_revalidation_id, fence_token) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY community_route_revalidation_evidence_snapshots
    ADD CONSTRAINT community_route_revalidation_snapshots_attempt_fk FOREIGN KEY (route_revalidation_attempt_id, fence_token) REFERENCES community_route_revalidation_completion_attempts(route_revalidation_attempt_id, fence_token);

ALTER TABLE ONLY community_route_revalidation_evidence_snapshots
    ADD CONSTRAINT community_route_revalidation_snapshots_session_fk FOREIGN KEY (route_revalidation_id, revalidation_session_id, route_binding_id, expected_binding_generation) REFERENCES community_route_revalidation_sessions(route_revalidation_id, revalidation_session_id, route_binding_id, expected_binding_generation);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start_binding_fk FOREIGN KEY (community_id, route_binding_id) REFERENCES community_canonical_route_bindings(community_id, route_binding_id);

ALTER TABLE ONLY community_route_revalidation_start_reservations
    ADD CONSTRAINT community_route_revalidation_start_reservatio_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY content_publication_outbox
    ADD CONSTRAINT content_publication_outbox_comment_fk FOREIGN KEY (community_id, comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY content_publication_outbox
    ADD CONSTRAINT content_publication_outbox_submission_fk FOREIGN KEY (community_id, submission_id) REFERENCES text_content_submissions(community_id, submission_id);

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_policy_hash_fk FOREIGN KEY (community_id, policy_version_id, policy_hash) REFERENCES policy_versions(community_id, policy_version_id, policy_hash);

ALTER TABLE ONLY decision_records
    ADD CONSTRAINT decision_records_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_session_actor_fk FOREIGN KEY (proof_session_id, user_id) REFERENCES proof_sessions(proof_session_id, actor_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_subject_binding_fk FOREIGN KEY (subject_binding_event_id, subject_key_id, subject_binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY evidence_receipts
    ADD CONSTRAINT evidence_receipts_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY hns_control_observer_operations
    ADD CONSTRAINT hns_control_observer_operations_configuration_fk FOREIGN KEY (provider_configuration_reference, provider_configuration_version, provider_configuration_digest) REFERENCES hns_control_observer_configurations(provider_configuration_reference, provider_configuration_version, provider_configuration_digest);

ALTER TABLE ONLY hns_control_observer_reservations
    ADD CONSTRAINT hns_control_observer_reservations_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES hns_control_observer_operations(observation_id);

ALTER TABLE ONLY hns_control_observer_snapshot_transcript_entries
    ADD CONSTRAINT hns_control_observer_snapshot_transcrip_snapshot_reference_fkey FOREIGN KEY (snapshot_reference) REFERENCES hns_control_observer_snapshots(snapshot_reference);

ALTER TABLE ONLY hns_control_observer_snapshots
    ADD CONSTRAINT hns_control_observer_snapshots_operation_fk FOREIGN KEY (observation_id, snapshot_reference) REFERENCES hns_control_observer_operations(observation_id, snapshot_reference);

ALTER TABLE ONLY hns_control_observer_snapshots
    ADD CONSTRAINT hns_control_observer_snapshots_reservation_fk FOREIGN KEY (observation_id, observer_fence) REFERENCES hns_control_observer_reservations(observation_id, observer_fence);

ALTER TABLE ONLY home_feed_projection
    ADD CONSTRAINT home_feed_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY identity_credentials
    ADD CONSTRAINT identity_credentials_canonical_user_id_fkey FOREIGN KEY (canonical_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_community_id_actor_user_id_pos_fkey FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections(community_id, actor_user_id, post_id);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_community_id_actor_user_id_sub_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_current_artifact_ref_current_a_fkey FOREIGN KEY (current_artifact_ref, current_artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256) REFERENCES media_timed_lyrics_artifacts(artifact_ref, artifact_revision, community_id, actor_user_id, submission_id, operation_id, post_id, audio_revision, analysis_revision, canonical_audio_sha256);

ALTER TABLE ONLY media_alignment_projections
    ADD CONSTRAINT media_alignment_projections_current_artifact_ref_fkey FOREIGN KEY (current_artifact_ref) REFERENCES media_timed_lyrics_artifacts(artifact_ref);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_evidence_community_id_actor_user_id_submis_fkey1 FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id, bound_reference_asset_id, bound_reference_audio_revision, bound_reference_analysis_revision, bound_reference_audio_sha256) REFERENCES media_reference_evidence(community_id, actor_user_id, submission_id, operation_id, asset_id, evidence_audio_revision, evidence_analysis_revision, evidence_audio_sha256);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_evidence_community_id_actor_user_id_submiss_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_evidence_submission_id_audio_revision_canon_fkey FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256, finalized_audio_ref) REFERENCES media_audio_revisions(submission_id, audio_revision, canonical_sha256, immutable_ref);

ALTER TABLE ONLY media_analysis_evidence
    ADD CONSTRAINT media_analysis_transcript_fk FOREIGN KEY (transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256) REFERENCES media_transcript_artifacts(transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id, audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256);

ALTER TABLE ONLY media_audio_revisions
    ADD CONSTRAINT media_audio_revisions_community_id_actor_user_id_submissio_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_audio_revisions
    ADD CONSTRAINT media_audio_revisions_community_id_immutable_ref_canonical_fkey FOREIGN KEY (community_id, immutable_ref, canonical_sha256, content_type, size_bytes) REFERENCES media_immutable_objects(community_id, immutable_ref, canonical_sha256, content_type, size_bytes);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_community_id_actor_user_id_reserva_fkey FOREIGN KEY (community_id, actor_user_id, reservation_id, submission_id, operation_id) REFERENCES media_upload_reservations(community_id, actor_user_id, reservation_id, submission_id, operation_id);

ALTER TABLE ONLY media_immutable_objects
    ADD CONSTRAINT media_immutable_objects_community_id_actor_user_id_submiss_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_moderation_actions
    ADD CONSTRAINT media_moderation_actions_authority_actor_user_id_fkey FOREIGN KEY (authority_actor_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY media_moderation_actions
    ADD CONSTRAINT media_moderation_actions_community_id_actor_user_id_submis_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_moderation_actions
    ADD CONSTRAINT media_moderation_actions_submission_id_decision_revision_fkey FOREIGN KEY (submission_id, decision_revision) REFERENCES media_publication_decisions(submission_id, decision_revision);

ALTER TABLE ONLY media_moderation_projections
    ADD CONSTRAINT media_moderation_projections_community_id_actor_user_id_su_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY media_post_submissions
    ADD CONSTRAINT media_post_submissions_reservation_fk FOREIGN KEY (community_id, actor_user_id, audio_reservation_id) REFERENCES media_upload_reservations(community_id, actor_user_id, reservation_id);

ALTER TABLE ONLY media_processing_attempts
    ADD CONSTRAINT media_processing_attempts_community_id_actor_user_id_submi_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_processing_attempts
    ADD CONSTRAINT media_processing_attempts_submission_id_audio_revision_fkey FOREIGN KEY (submission_id, audio_revision) REFERENCES media_audio_revisions(submission_id, audio_revision);

ALTER TABLE ONLY media_publication_decisions
    ADD CONSTRAINT media_publication_decisions_community_id_actor_user_id_sub_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_publication_decisions
    ADD CONSTRAINT media_publication_decisions_submission_id_audio_revision_a_fkey FOREIGN KEY (submission_id, audio_revision, analysis_revision, canonical_audio_sha256) REFERENCES media_analysis_evidence(submission_id, audio_revision, analysis_revision, canonical_audio_sha256);

ALTER TABLE ONLY media_publication_decisions
    ADD CONSTRAINT media_publication_decisions_submission_id_creation_revisio_fkey FOREIGN KEY (submission_id, creation_revision) REFERENCES media_submission_terms(submission_id, creation_revision);

ALTER TABLE ONLY media_publication_projections
    ADD CONSTRAINT media_publication_projections_community_id_actor_user_id_s_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_publication_projections
    ADD CONSTRAINT media_publication_projections_community_id_post_id_fkey FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY media_reference_evidence
    ADD CONSTRAINT media_reference_evidence_community_id_actor_user_id_submis_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_submission_command_replays
    ADD CONSTRAINT media_submission_command_replays_submission_fk FOREIGN KEY (community_id, submission_actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_submission_events
    ADD CONSTRAINT media_submission_events_community_id_actor_user_id_submiss_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_submission_outbox
    ADD CONSTRAINT media_submission_outbox_community_id_actor_user_id_submiss_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_submission_terms
    ADD CONSTRAINT media_submission_terms_community_id_actor_user_id_submissi_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_timed_lyrics_artifacts
    ADD CONSTRAINT media_timed_lyrics_artifacts_community_id_actor_user_id_po_fkey FOREIGN KEY (community_id, actor_user_id, post_id) REFERENCES media_publication_projections(community_id, actor_user_id, post_id);

ALTER TABLE ONLY media_timed_lyrics_artifacts
    ADD CONSTRAINT media_timed_lyrics_artifacts_community_id_actor_user_id_su_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_transcript_artifacts
    ADD CONSTRAINT media_transcript_artifacts_community_id_actor_user_id_subm_fkey FOREIGN KEY (community_id, actor_user_id, submission_id, operation_id) REFERENCES media_post_submissions(community_id, actor_user_id, submission_id, operation_id);

ALTER TABLE ONLY media_transcript_artifacts
    ADD CONSTRAINT media_transcript_artifacts_submission_id_audio_revision_ca_fkey FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256) REFERENCES media_audio_revisions(submission_id, audio_revision, canonical_sha256);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY media_upload_reservations
    ADD CONSTRAINT media_upload_reservations_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY moderation_actions
    ADD CONSTRAINT moderation_actions_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY moderation_reports
    ADD CONSTRAINT moderation_reports_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY namespace_ownership_completion_attempts
    ADD CONSTRAINT namespace_ownership_completion_attempts_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY namespace_ownership_completion_attempts
    ADD CONSTRAINT namespace_ownership_completion_attempts_session_actor_fk FOREIGN KEY (namespace_session_id, actor_id) REFERENCES namespace_ownership_sessions(namespace_session_id, actor_id);

ALTER TABLE ONLY namespace_ownership_evidence_snapshots
    ADD CONSTRAINT namespace_ownership_evidence_snapshots_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY namespace_ownership_evidence_snapshots
    ADD CONSTRAINT namespace_ownership_evidence_snapshots_attempt_fk FOREIGN KEY (completion_attempt_id) REFERENCES namespace_ownership_completion_attempts(completion_attempt_id);

ALTER TABLE ONLY namespace_ownership_evidence_snapshots
    ADD CONSTRAINT namespace_ownership_evidence_snapshots_session_actor_fk FOREIGN KEY (namespace_session_id, actor_id) REFERENCES namespace_ownership_sessions(namespace_session_id, actor_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_actor_intent_fk FOREIGN KEY (actor_id, creation_intent_id) REFERENCES community_creation_intents(actor_id, intent_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_ceremony_fk FOREIGN KEY (actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, intent_id, requirement_kind, generation, ceremony_intent_id);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_requirement_fk FOREIGN KEY (creation_intent_id, requirement_kind) REFERENCES community_creation_requirement_states(intent_id, requirement_kind);

ALTER TABLE ONLY namespace_ownership_sessions
    ADD CONSTRAINT namespace_ownership_sessions_start_reservation_fk FOREIGN KEY (start_reservation_id, start_fence_token) REFERENCES namespace_ownership_start_reservations(reservation_id, fence_token) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_actor_intent_fk FOREIGN KEY (actor_id, creation_intent_id) REFERENCES community_creation_intents(actor_id, intent_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_ceremony_fk FOREIGN KEY (actor_id, creation_intent_id, requirement_kind, generation, ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, intent_id, requirement_kind, generation, ceremony_intent_id);

ALTER TABLE ONLY namespace_ownership_start_reservations
    ADD CONSTRAINT namespace_ownership_start_reservations_requirement_fk FOREIGN KEY (creation_intent_id, requirement_kind) REFERENCES community_creation_requirement_states(intent_id, requirement_kind);

ALTER TABLE ONLY observations
    ADD CONSTRAINT observations_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_author_fk FOREIGN KEY (created_by_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY policy_versions
    ADD CONSTRAINT policy_versions_uniqueness_authority_fk FOREIGN KEY (uniqueness_authority_id) REFERENCES reward_uniqueness_authorities(campaign_id);

ALTER TABLE ONLY post_vote_actions
    ADD CONSTRAINT post_vote_actions_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY post_votes
    ADD CONSTRAINT post_votes_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY post_votes
    ADD CONSTRAINT post_votes_post_fk FOREIGN KEY (community_id, post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY posts
    ADD CONSTRAINT posts_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY proof_session_completion_events
    ADD CONSTRAINT proof_session_completion_events_session_actor_fk FOREIGN KEY (proof_session_id, actor_id) REFERENCES proof_sessions(proof_session_id, actor_id);

ALTER TABLE ONLY proof_session_presentations
    ADD CONSTRAINT proof_session_presentations_session_fk FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_creation_ceremony_actor_fk FOREIGN KEY (actor_id, creation_ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, ceremony_intent_id);

ALTER TABLE ONLY proof_sessions
    ADD CONSTRAINT proof_sessions_creation_ceremony_intent_id_fkey FOREIGN KEY (creation_ceremony_intent_id) REFERENCES community_creation_ceremony_attempts(ceremony_intent_id);

ALTER TABLE ONLY public_handle_index
    ADD CONSTRAINT public_handle_index_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(user_id);

ALTER TABLE ONLY public_handle_index
    ADD CONSTRAINT public_handle_index_redirect_fk FOREIGN KEY (redirect_target_handle_id) REFERENCES public_handle_index(handle_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_binding_fk FOREIGN KEY (binding_event_id, subject_key_id, binding_epoch, user_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id, binding_epoch, user_id);

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_campaign_fk FOREIGN KEY (campaign_id) REFERENCES reward_uniqueness_authorities(campaign_id);

ALTER TABLE ONLY reward_subject_consumptions
    ADD CONSTRAINT reward_subject_consumptions_receipt_fk FOREIGN KEY (evidence_receipt_id, subject_key_id, binding_event_id, binding_epoch, user_id) REFERENCES evidence_receipts(evidence_receipt_id, subject_key_id, subject_binding_event_id, subject_binding_epoch, user_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_previous_fk FOREIGN KEY (previous_binding_event_id, subject_key_id) REFERENCES subject_key_binding_events(binding_event_id, subject_key_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_session_actor_fk FOREIGN KEY (proof_session_id, user_id) REFERENCES proof_sessions(proof_session_id, actor_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_subject_fk FOREIGN KEY (subject_key_id) REFERENCES subject_keys(subject_key_id);

ALTER TABLE ONLY subject_key_binding_events
    ADD CONSTRAINT subject_key_binding_events_user_fk FOREIGN KEY (user_id) REFERENCES users(user_id);

ALTER TABLE ONLY text_content_held_revisions
    ADD CONSTRAINT text_content_held_revisions_submission_fk FOREIGN KEY (community_id, submission_id) REFERENCES text_content_submissions(community_id, submission_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_comment_fk FOREIGN KEY (community_id, published_comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_community_fk FOREIGN KEY (community_id) REFERENCES communities(community_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_policy_fk FOREIGN KEY (policy_revision_id, policy_hash) REFERENCES text_moderation_policy_revisions(policy_revision_id, policy_hash);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_post_fk FOREIGN KEY (community_id, published_post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_target_parent_fk FOREIGN KEY (community_id, target_parent_comment_id) REFERENCES comments(community_id, comment_id);

ALTER TABLE ONLY text_content_submissions
    ADD CONSTRAINT text_content_submissions_target_post_fk FOREIGN KEY (community_id, target_post_id) REFERENCES posts(community_id, post_id);

ALTER TABLE ONLY text_moderation_cases
    ADD CONSTRAINT text_moderation_cases_submission_fk FOREIGN KEY (community_id, submission_id) REFERENCES text_content_submissions(community_id, submission_id);

ALTER TABLE ONLY text_moderation_policy_current
    ADD CONSTRAINT text_moderation_policy_current_revision_fk FOREIGN KEY (policy_revision_id) REFERENCES text_moderation_policy_revisions(policy_revision_id);

ALTER TABLE ONLY used_action_grants
    ADD CONSTRAINT used_action_grants_grant_intent_fk FOREIGN KEY (action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash) REFERENCES action_grants(action_grant_id, grant_nonce, action_intent_id, action_kind, action_scope, action_payload_hash);

ALTER TABLE ONLY verification_completion_attempts
    ADD CONSTRAINT verification_completion_attempts_session_fk FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);

ALTER TABLE ONLY verification_start_reservations
    ADD CONSTRAINT verification_start_reservations_actor_fk FOREIGN KEY (actor_id) REFERENCES users(user_id);

ALTER TABLE ONLY verification_start_reservations
    ADD CONSTRAINT verification_start_reservations_creation_ceremony_fk FOREIGN KEY (actor_id, creation_intent_id, creation_requirement_kind, creation_generation, intent_id) REFERENCES community_creation_ceremony_attempts(actor_id, intent_id, requirement_kind, generation, ceremony_intent_id);
