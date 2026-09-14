-- Spec 006 section 6.1: account-scoped renewable age ceremonies, isolated from
-- membership and handle intent lineages. Nationality evidence never satisfies age.
-- Provider switching advances generation; each renewal gets a fresh parent intent.
CREATE TABLE age_verification_ceremony_attempts (
  ceremony_intent_id text NOT NULL,
  actor_id text NOT NULL,
  action_kind text NOT NULL,
  intent_id text NOT NULL,
  requirement_kind text NOT NULL,
  generation bigint NOT NULL,
  requirement_hash text NOT NULL,
  provider_id text NOT NULL,
  provider_binding_hash text NOT NULL,
  provider_configuration_kind text NOT NULL,
  provider_configuration_ref text NOT NULL,
  provider_configuration_version text NOT NULL,
  reservation_request_hash text NOT NULL,
  reservation_request jsonb NOT NULL,
  reserved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT age_verification_ceremony_attempts_pkey PRIMARY KEY (ceremony_intent_id),
  CONSTRAINT age_verification_ceremony_attempts_actor_ceremony_unique UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT age_verification_ceremony_attempts_generation_unique UNIQUE (action_kind, intent_id, requirement_kind, generation),
  CONSTRAINT age_verification_ceremony_attempts_identity_unique UNIQUE (actor_id, action_kind, intent_id, requirement_kind, generation, ceremony_intent_id),
  CONSTRAINT age_verification_ceremony_attempts_action_kind_check CHECK ((action_kind = ANY (ARRAY['adult_view'::text]))),
  CONSTRAINT age_verification_ceremony_attempts_requirement_kind_check CHECK ((requirement_kind = 'age_18'::text)),
  CONSTRAINT age_verification_ceremony_attempts_generation_check CHECK ((generation > 0)),
  CONSTRAINT age_verification_ceremony_attempts_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
  CONSTRAINT age_verification_ceremony_attempts_hash_shape_check CHECK (((requirement_hash ~ '^[0-9a-f]{64}$'::text) AND (provider_binding_hash ~ '^[0-9a-f]{64}$'::text) AND (reservation_request_hash ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT age_verification_ceremony_attempts_reservation_request_check CHECK ((jsonb_typeof(reservation_request) = 'object'::text)),
  CONSTRAINT age_verification_ceremony_attempts_identifiers_not_blank CHECK (((btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(intent_id) <> ''::text) AND (intent_id = btrim(intent_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version))))
);

CREATE TABLE age_verification_requirement_states (
  action_kind text NOT NULL,
  intent_id text NOT NULL,
  requirement_kind text NOT NULL,
  actor_id text NOT NULL,
  status text NOT NULL,
  requirement_hash text NOT NULL,
  accepted_provider_ids jsonb NOT NULL,
  generation bigint DEFAULT 0 NOT NULL,
  current_ceremony_intent_id text,
  current_provider_id text,
  current_provider_binding_hash text,
  current_provider_configuration_kind text,
  current_provider_configuration_ref text,
  current_provider_configuration_version text,
  satisfied_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT age_verification_requirement_states_actor_intent_unique UNIQUE (actor_id, intent_id),
  CONSTRAINT age_verification_requirement_states_pkey PRIMARY KEY (action_kind, intent_id, requirement_kind),
  CONSTRAINT age_verification_requirement_states_actor_generation_unique UNIQUE (actor_id, action_kind, intent_id, requirement_kind, generation),
  CONSTRAINT age_verification_requirement_states_action_kind_check CHECK ((action_kind = ANY (ARRAY['adult_view'::text]))),
  CONSTRAINT age_verification_requirement_states_requirement_kind_check CHECK ((requirement_kind = 'age_18'::text)),
  CONSTRAINT age_verification_requirement_states_status_check CHECK ((status = ANY (ARRAY['unmet'::text, 'pending'::text, 'failed'::text, 'expired'::text, 'satisfied'::text]))),
  CONSTRAINT age_verification_requirement_states_generation_check CHECK ((generation >= 0)),
  CONSTRAINT age_verification_requirement_states_hash_shape_check CHECK (((requirement_hash ~ '^[0-9a-f]{64}$'::text) AND ((current_provider_binding_hash IS NULL) OR (current_provider_binding_hash ~ '^[0-9a-f]{64}$'::text)))),
  CONSTRAINT age_verification_requirement_states_accepted_providers_shape CHECK ((jsonb_typeof(accepted_provider_ids) = 'array'::text) AND (jsonb_array_length(accepted_provider_ids) = 2)),
  CONSTRAINT age_verification_requirement_states_progress_shape CHECK ((((status = 'unmet'::text) AND (generation = 0) AND (current_ceremony_intent_id IS NULL) AND (current_provider_id IS NULL) AND (current_provider_binding_hash IS NULL) AND (current_provider_configuration_kind IS NULL) AND (current_provider_configuration_ref IS NULL) AND (current_provider_configuration_version IS NULL) AND (satisfied_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'failed'::text, 'expired'::text])) AND (generation > 0) AND (btrim(current_ceremony_intent_id) <> ''::text) AND (current_ceremony_intent_id = btrim(current_ceremony_intent_id)) AND (btrim(current_provider_id) <> '') AND (current_provider_binding_hash IS NOT NULL) AND (current_provider_configuration_kind IS NOT NULL) AND (current_provider_configuration_ref IS NOT NULL) AND (current_provider_configuration_version IS NOT NULL) AND (satisfied_at IS NULL)) OR ((status = 'satisfied'::text) AND (generation > 0) AND (btrim(current_ceremony_intent_id) <> '') AND (current_provider_id IS NOT NULL) AND (satisfied_at IS NOT NULL)))),
  CONSTRAINT age_verification_requirement_states_time_order CHECK ((updated_at >= created_at))
);

CREATE FUNCTION reject_age_verification_ceremony_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    RAISE EXCEPTION 'age verification ceremony attempts are append-only evidence';
  END; $$;

CREATE TRIGGER age_verification_ceremony_attempt_append_only
  BEFORE UPDATE OR DELETE ON age_verification_ceremony_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_age_verification_ceremony_mutation();

CREATE FUNCTION validate_age_verification_ceremony_attempt_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  state_record age_verification_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO state_record
    FROM age_verification_requirement_states
   WHERE action_kind = NEW.action_kind
     AND intent_id = NEW.intent_id
     AND requirement_kind = NEW.requirement_kind
   FOR UPDATE;

  IF NOT FOUND
    OR state_record.actor_id <> NEW.actor_id
    OR state_record.requirement_hash <> NEW.requirement_hash
    OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(state_record.accepted_provider_ids) AS accepted
          WHERE accepted.value = NEW.provider_id
       )
    OR NEW.generation <> state_record.generation + 1
    OR state_record.status NOT IN ('unmet', 'failed', 'expired', 'pending') THEN
    RAISE EXCEPTION 'age verification ceremony reservation does not match the current requirement state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER age_verification_ceremony_attempt_insert_guard
  BEFORE INSERT ON age_verification_ceremony_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_age_verification_ceremony_attempt_insert();

CREATE FUNCTION validate_age_verification_requirement_state_providers() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  accepted text[];
BEGIN
  SELECT array_agg(value ORDER BY value)::text[]
    INTO accepted
    FROM jsonb_array_elements_text(NEW.accepted_provider_ids);

  IF accepted IS DISTINCT FROM ARRAY['self.pass', 'zkpassport']::text[] THEN
    RAISE EXCEPTION 'age verification requirements accept exactly Self and ZKPassport';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER age_verification_requirement_state_provider_guard
  BEFORE INSERT OR UPDATE ON age_verification_requirement_states
  FOR EACH ROW EXECUTE FUNCTION validate_age_verification_requirement_state_providers();

CREATE FUNCTION guard_age_verification_requirement_state_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    IF NEW.action_kind <> OLD.action_kind
      OR NEW.intent_id <> OLD.intent_id
      OR NEW.requirement_kind <> OLD.requirement_kind
      OR NEW.actor_id <> OLD.actor_id
      OR NEW.requirement_hash <> OLD.requirement_hash
      OR NEW.accepted_provider_ids <> OLD.accepted_provider_ids THEN
      RAISE EXCEPTION 'age verification requirement identity is immutable';
    END IF;
    IF OLD.status = 'satisfied' AND NEW.status <> 'satisfied' THEN
      RAISE EXCEPTION 'satisfied age verification requirements cannot regress';
    END IF;
    IF NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'age verification requirement generations never decrease';
    END IF;
    RETURN NEW;
  END; $$;

CREATE TRIGGER age_verification_requirement_state_update_guard
  BEFORE UPDATE ON age_verification_requirement_states
  FOR EACH ROW EXECUTE FUNCTION guard_age_verification_requirement_state_update();

CREATE TABLE account_age_verification_current (
  account_id text PRIMARY KEY,
  intent_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, intent_id)
    REFERENCES age_verification_requirement_states (actor_id, intent_id),
  CHECK (updated_at >= created_at)
);

-- One full evidence witness drives capability and its public expiry/provider metadata.
-- The legacy catalog remains valid; only server-issued current age children join it.
CREATE FUNCTION current_account_age_evidence_v2(target_account_id text)
RETURNS TABLE(provider_id text, policy_reference text, evidence_expires_at timestamptz)
LANGUAGE sql STABLE AS $age_evidence$
    SELECT receipt.provider_id,
           concat(receipt.provider_configuration_ref, '@', receipt.provider_configuration_version),
           LEAST(assertion.expires_at, receipt.expires_at,
                 credential_witness.expires_at, document_witness.expires_at)
      FROM assertions AS assertion
      JOIN evidence_receipts AS receipt
        ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
       AND receipt.user_id = assertion.user_id
      JOIN proof_sessions AS session
        ON session.proof_session_id = receipt.proof_session_id
       AND session.actor_id = assertion.user_id
       AND session.status = 'completed'
       AND session.completed_at = session.terminal_at
       AND (session.intent_id = 'platform.document.age-18' OR EXISTS (
         SELECT 1
           FROM age_verification_ceremony_attempts AS attempt
           JOIN age_verification_requirement_states AS state
             ON state.action_kind = attempt.action_kind AND state.intent_id = attempt.intent_id
            AND state.requirement_kind = attempt.requirement_kind
            AND state.actor_id = attempt.actor_id AND state.generation = attempt.generation
            AND state.current_ceremony_intent_id = attempt.ceremony_intent_id
            AND state.current_provider_id = attempt.provider_id
            AND state.current_provider_binding_hash = attempt.provider_binding_hash
            AND state.requirement_hash = attempt.requirement_hash
            AND state.status IN ('pending', 'satisfied')
           JOIN account_age_verification_current AS current
             ON current.account_id = attempt.actor_id AND current.intent_id = attempt.intent_id
          WHERE attempt.ceremony_intent_id = session.intent_id
            AND attempt.actor_id = session.actor_id AND attempt.action_kind = 'adult_view'
            AND attempt.requirement_kind = 'age_18'
            AND attempt.provider_id = session.provider_id
            AND attempt.provider_configuration_kind = session.provider_configuration_kind
            AND attempt.provider_configuration_ref = session.provider_configuration_ref
            AND attempt.provider_configuration_version = session.provider_configuration_version
            AND session.started_at >= attempt.reserved_at
            AND session.completed_at < attempt.expires_at
            AND session.completed_at < session.expires_at
       ))
       AND session.method = 'document'
       AND session.scope_kind = 'issuer_rp_scope'
       AND session.issuer_rp_scope = 'pirate-social'
       AND session.issuer_rp_action_scope IS NULL
       AND session.requested_requirements = '[{"claim_id":"age.minimum","minimum_age":"18"},{"claim_id":"credential.subject_unique"},{"claim_id":"document.valid"}]'::jsonb
       AND session.requested_claim_ids = '["age.minimum","credential.subject_unique","document.valid"]'::jsonb
      JOIN assertion_bindings AS binding
        ON binding.binding_group_id = assertion.binding_group_id
       AND binding.user_id = assertion.user_id
       AND binding.binding_mode = 'same_subject'
       AND binding.subject_key_id = assertion.subject_key_id
      JOIN active_subject_key_bindings AS active_binding
        ON active_binding.subject_key_id = assertion.subject_key_id
       AND active_binding.user_id = assertion.user_id
       AND active_binding.binding_event_id = binding.subject_binding_event_id
       AND active_binding.binding_epoch = binding.subject_binding_epoch
      JOIN LATERAL (
         SELECT LEAST(credential.expires_at, credential_receipt.expires_at) AS expires_at
           FROM assertions AS credential
           JOIN evidence_receipts AS credential_receipt
             ON credential_receipt.evidence_receipt_id = credential.evidence_receipt_id
            AND credential_receipt.proof_session_id = session.proof_session_id
            AND credential_receipt.user_id = assertion.user_id
            AND credential_receipt.subject_key_id = assertion.subject_key_id
          WHERE credential.user_id = assertion.user_id
            AND credential.binding_group_id = assertion.binding_group_id
            AND credential.subject_key_id = assertion.subject_key_id
            AND credential.claim_id = 'credential.subject_unique'
            AND credential.assertion_value = '{"subject_unique":true}'::jsonb
            AND credential.assurance = 'document_zk'
            AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
            AND (credential_receipt.expires_at IS NULL OR credential_receipt.expires_at > clock_timestamp())
            AND credential.observed_at <= clock_timestamp()
            AND credential_receipt.observed_at <= clock_timestamp()
          ORDER BY LEAST(credential.expires_at, credential_receipt.expires_at) DESC NULLS FIRST, credential.assertion_id DESC
          LIMIT 1
      ) AS credential_witness ON TRUE
      JOIN LATERAL (
         SELECT LEAST(document.expires_at, document_receipt.expires_at) AS expires_at
           FROM assertions AS document
           JOIN evidence_receipts AS document_receipt
             ON document_receipt.evidence_receipt_id = document.evidence_receipt_id
            AND document_receipt.proof_session_id = session.proof_session_id
            AND document_receipt.user_id = assertion.user_id
            AND document_receipt.subject_key_id = assertion.subject_key_id
          WHERE document.user_id = assertion.user_id
            AND document.binding_group_id = assertion.binding_group_id
            AND document.subject_key_id = assertion.subject_key_id
            AND document.claim_id = 'document.valid'
            AND document.assertion_value = '{"valid":true}'::jsonb
            AND document.assurance = 'document_zk'
            AND (document.expires_at IS NULL OR document.expires_at > clock_timestamp())
            AND (document_receipt.expires_at IS NULL OR document_receipt.expires_at > clock_timestamp())
            AND document.observed_at <= clock_timestamp()
            AND document_receipt.observed_at <= clock_timestamp()
          ORDER BY LEAST(document.expires_at, document_receipt.expires_at) DESC NULLS FIRST, document.assertion_id DESC
          LIMIT 1
      ) AS document_witness ON TRUE
     WHERE assertion.user_id = target_account_id
       AND assertion.claim_id = 'age.minimum'
       AND assertion.assurance = 'document_zk'
       AND receipt.provider_id IN ('self.pass', 'self.enterprise', 'zkpassport')
       AND receipt.subject_key_id = assertion.subject_key_id
       AND assertion.assertion_value ? 'minimum_age'
       AND assertion.assertion_value->>'minimum_age' ~ '^(0|[1-9][0-9]*)$'
       AND (assertion.assertion_value->>'minimum_age')::NUMERIC >= 18
       AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
       AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())


       AND NOT EXISTS (
         SELECT 1
           FROM LATERAL (
             SELECT event.outcome
               FROM assertion_revalidation_events AS event
              WHERE event.assertion_id = assertion.assertion_id
                AND event.user_id = assertion.user_id
           ORDER BY event.observed_at DESC, event.created_at DESC,
                    event.assertion_revalidation_event_id DESC
              LIMIT 1
           ) AS latest
          WHERE latest.outcome <> 'accepted'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM assertions AS sibling
           JOIN LATERAL (
             SELECT event.outcome
               FROM assertion_revalidation_events AS event
              WHERE event.assertion_id = sibling.assertion_id
                AND event.user_id = sibling.user_id
           ORDER BY event.observed_at DESC, event.created_at DESC,
                    event.assertion_revalidation_event_id DESC
              LIMIT 1
           ) AS latest ON TRUE
          WHERE sibling.user_id = assertion.user_id
            AND sibling.binding_group_id = assertion.binding_group_id
            AND latest.outcome <> 'accepted'
       )

       AND assertion.observed_at <= clock_timestamp()
       AND receipt.observed_at <= clock_timestamp()
     ORDER BY assertion.observed_at DESC, assertion.assertion_id DESC
     LIMIT 1;
$age_evidence$;

CREATE OR REPLACE FUNCTION current_account_age_capability_v1(target_account_id text)
RETURNS text LANGUAGE sql STABLE AS $age_capability$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM current_account_age_evidence_v2(target_account_id))
    THEN 'adult_18' ELSE 'general' END;
$age_capability$;
