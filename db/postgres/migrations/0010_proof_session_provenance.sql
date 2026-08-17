-- Provider-neutral proof-session configuration provenance and presentation.
--
-- No provider route existed before this migration. Refuse to invent
-- configuration provenance if a database nevertheless contains gates-v2
-- evidence; operators must investigate that unexpected state explicitly.

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM proof_sessions)
    OR EXISTS (SELECT 1 FROM evidence_receipts) THEN
    RAISE EXCEPTION 'proof-session provenance migration requires an empty gates-v2 evidence ledger'
      USING ERRCODE = '23514';
  END IF;
END;
$block$;

ALTER TABLE proof_sessions
    ADD COLUMN provider_configuration_kind text NOT NULL,
    ADD COLUMN provider_configuration_ref text NOT NULL,
    ADD COLUMN provider_configuration_version text NOT NULL;

ALTER TABLE proof_sessions
    ADD CONSTRAINT proof_sessions_provider_configuration_kind_check
      CHECK (provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text])),
    ADD CONSTRAINT proof_sessions_provider_configuration_values_not_blank
      CHECK (
        btrim(provider_configuration_ref) <> ''::text
        AND provider_configuration_ref = btrim(provider_configuration_ref)
        AND btrim(provider_configuration_version) <> ''::text
        AND provider_configuration_version = btrim(provider_configuration_version)
      ),
    ADD CONSTRAINT proof_sessions_provider_configuration_mode_check
      CHECK (
        (request_mode = 'curated'::text AND provider_configuration_kind = 'managed'::text)
        OR (request_mode = 'dynamic'::text AND provider_configuration_kind = 'dynamic'::text)
      );

ALTER TABLE evidence_receipts
    ADD COLUMN provider_configuration_kind text NOT NULL,
    ADD COLUMN provider_configuration_ref text NOT NULL,
    ADD COLUMN provider_configuration_version text NOT NULL;

ALTER TABLE evidence_receipts
    ADD CONSTRAINT evidence_receipts_provider_configuration_kind_check
      CHECK (provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text])),
    ADD CONSTRAINT evidence_receipts_provider_configuration_values_not_blank
      CHECK (
        btrim(provider_configuration_ref) <> ''::text
        AND provider_configuration_ref = btrim(provider_configuration_ref)
        AND btrim(provider_configuration_version) <> ''::text
        AND provider_configuration_version = btrim(provider_configuration_version)
      );

CREATE OR REPLACE FUNCTION gates_v2_validate_evidence_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION gates_v2_validate_proof_session_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$
;

CREATE TABLE proof_session_presentations (
    proof_session_id text NOT NULL,
    presentation_kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proof_session_presentations_pkey PRIMARY KEY (proof_session_id),
    CONSTRAINT proof_session_presentations_kind_check CHECK ((presentation_kind = ANY (ARRAY['redirect'::text, 'deeplink'::text, 'embedded_sdk'::text, 'poll'::text, 'none'::text]))),
    CONSTRAINT proof_session_presentations_payload_object_check CHECK ((jsonb_typeof(payload) = 'object'::text))
);

CREATE TRIGGER proof_session_presentations_append_only
BEFORE DELETE OR UPDATE ON proof_session_presentations
FOR EACH ROW EXECUTE FUNCTION gates_v2_append_only_guard();

ALTER TABLE ONLY proof_session_presentations
    ADD CONSTRAINT proof_session_presentations_session_fk
    FOREIGN KEY (proof_session_id) REFERENCES proof_sessions(proof_session_id);
