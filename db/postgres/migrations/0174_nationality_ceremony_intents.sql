-- Spec 006 sections 2.2/3 and the 2026-09-12 slice order: nationality
-- ceremonies for community joins and handle claims need their own child
-- intent identities, because proof sessions are unique on (actor_id,
-- intent_id) and the Palm join ceremony already occupies the join action
-- intent. These two tables copy the community-creation requirement-state
-- pattern: append-only ceremony attempts unique per action intent,
-- requirement kind, and generation, plus one mutable requirement state row
-- per action intent and requirement kind. The state row pins the exact
-- nationality requirement hash and the accepted provider alternatives; the
-- insert guard fences stale or duplicate issuance to generation + 1 and
-- confines the provider to the accepted set. A pending attempt may advance
-- to the next generation only for an explicit provider switch, which binds a
-- separately identified session rather than mutating the pending one.
CREATE TABLE nationality_ceremony_attempts (
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
  CONSTRAINT nationality_ceremony_attempts_pkey PRIMARY KEY (ceremony_intent_id),
  CONSTRAINT nationality_ceremony_attempts_actor_ceremony_unique UNIQUE (actor_id, ceremony_intent_id),
  CONSTRAINT nationality_ceremony_attempts_generation_unique UNIQUE (action_kind, intent_id, requirement_kind, generation),
  CONSTRAINT nationality_ceremony_attempts_identity_unique UNIQUE (actor_id, action_kind, intent_id, requirement_kind, generation, ceremony_intent_id),
  CONSTRAINT nationality_ceremony_attempts_action_kind_check CHECK ((action_kind = ANY (ARRAY['community_join'::text, 'handle_claim'::text]))),
  CONSTRAINT nationality_ceremony_attempts_requirement_kind_check CHECK ((requirement_kind = 'nationality'::text)),
  CONSTRAINT nationality_ceremony_attempts_generation_check CHECK ((generation > 0)),
  CONSTRAINT nationality_ceremony_attempts_provider_configuration_kind_check CHECK ((provider_configuration_kind = ANY (ARRAY['managed'::text, 'dynamic'::text]))),
  CONSTRAINT nationality_ceremony_attempts_hash_shape_check CHECK (((requirement_hash ~ '^[0-9a-f]{64}$'::text) AND (provider_binding_hash ~ '^[0-9a-f]{64}$'::text) AND (reservation_request_hash ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT nationality_ceremony_attempts_reservation_request_check CHECK ((jsonb_typeof(reservation_request) = 'object'::text)),
  CONSTRAINT nationality_ceremony_attempts_identifiers_not_blank CHECK (((btrim(ceremony_intent_id) <> ''::text) AND (ceremony_intent_id = btrim(ceremony_intent_id)) AND (btrim(intent_id) <> ''::text) AND (intent_id = btrim(intent_id)) AND (btrim(provider_id) <> ''::text) AND (provider_id = btrim(provider_id)) AND (btrim(provider_configuration_ref) <> ''::text) AND (provider_configuration_ref = btrim(provider_configuration_ref)) AND (btrim(provider_configuration_version) <> ''::text) AND (provider_configuration_version = btrim(provider_configuration_version))))
);

CREATE TABLE nationality_requirement_states (
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
  CONSTRAINT nationality_requirement_states_pkey PRIMARY KEY (action_kind, intent_id, requirement_kind),
  CONSTRAINT nationality_requirement_states_actor_generation_unique UNIQUE (actor_id, action_kind, intent_id, requirement_kind, generation),
  CONSTRAINT nationality_requirement_states_action_kind_check CHECK ((action_kind = ANY (ARRAY['community_join'::text, 'handle_claim'::text]))),
  CONSTRAINT nationality_requirement_states_requirement_kind_check CHECK ((requirement_kind = 'nationality'::text)),
  CONSTRAINT nationality_requirement_states_status_check CHECK ((status = ANY (ARRAY['unmet'::text, 'pending'::text, 'failed'::text, 'expired'::text, 'satisfied'::text]))),
  CONSTRAINT nationality_requirement_states_generation_check CHECK ((generation >= 0)),
  CONSTRAINT nationality_requirement_states_hash_shape_check CHECK (((requirement_hash ~ '^[0-9a-f]{64}$'::text) AND ((current_provider_binding_hash IS NULL) OR (current_provider_binding_hash ~ '^[0-9a-f]{64}$'::text)))),
  CONSTRAINT nationality_requirement_states_accepted_providers_shape CHECK ((jsonb_typeof(accepted_provider_ids) = 'array'::text) AND (jsonb_array_length(accepted_provider_ids) = 2)),
  CONSTRAINT nationality_requirement_states_progress_shape CHECK ((((status = 'unmet'::text) AND (generation = 0) AND (current_ceremony_intent_id IS NULL) AND (current_provider_id IS NULL) AND (current_provider_binding_hash IS NULL) AND (current_provider_configuration_kind IS NULL) AND (current_provider_configuration_ref IS NULL) AND (current_provider_configuration_version IS NULL) AND (satisfied_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'failed'::text, 'expired'::text])) AND (generation > 0) AND (btrim(current_ceremony_intent_id) <> ''::text) AND (current_ceremony_intent_id = btrim(current_ceremony_intent_id)) AND (btrim(current_provider_id) <> '') AND (current_provider_binding_hash IS NOT NULL) AND (current_provider_configuration_kind IS NOT NULL) AND (current_provider_configuration_ref IS NOT NULL) AND (current_provider_configuration_version IS NOT NULL) AND (satisfied_at IS NULL)) OR ((status = 'satisfied'::text) AND (generation > 0) AND (btrim(current_ceremony_intent_id) <> '') AND (current_provider_id IS NOT NULL) AND (satisfied_at IS NOT NULL)))),
  CONSTRAINT nationality_requirement_states_time_order CHECK ((updated_at >= created_at))
);

CREATE FUNCTION reject_nationality_ceremony_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    RAISE EXCEPTION 'nationality ceremony attempts are append-only evidence';
  END; $$;

CREATE TRIGGER nationality_ceremony_attempt_append_only
  BEFORE UPDATE OR DELETE ON nationality_ceremony_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_nationality_ceremony_mutation();

CREATE FUNCTION validate_nationality_ceremony_attempt_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  state_record nationality_requirement_states%ROWTYPE;
BEGIN
  SELECT * INTO state_record
    FROM nationality_requirement_states
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
    RAISE EXCEPTION 'nationality ceremony reservation does not match the current requirement state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER nationality_ceremony_attempt_insert_guard
  BEFORE INSERT ON nationality_ceremony_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_nationality_ceremony_attempt_insert();

CREATE FUNCTION validate_nationality_requirement_state_providers() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  accepted text[];
BEGIN
  SELECT array_agg(value ORDER BY value)::text[]
    INTO accepted
    FROM jsonb_array_elements_text(NEW.accepted_provider_ids);

  IF accepted IS DISTINCT FROM ARRAY['self.pass', 'zkpassport']::text[] THEN
    RAISE EXCEPTION 'nationality requirements accept exactly Self and ZKPassport';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER nationality_requirement_state_provider_guard
  BEFORE INSERT OR UPDATE ON nationality_requirement_states
  FOR EACH ROW EXECUTE FUNCTION validate_nationality_requirement_state_providers();

CREATE FUNCTION guard_nationality_requirement_state_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN
    IF NEW.action_kind <> OLD.action_kind
      OR NEW.intent_id <> OLD.intent_id
      OR NEW.requirement_kind <> OLD.requirement_kind
      OR NEW.actor_id <> OLD.actor_id
      OR NEW.requirement_hash <> OLD.requirement_hash
      OR NEW.accepted_provider_ids <> OLD.accepted_provider_ids THEN
      RAISE EXCEPTION 'nationality requirement identity is immutable';
    END IF;
    IF OLD.status = 'satisfied' AND NEW.status <> 'satisfied' THEN
      RAISE EXCEPTION 'satisfied nationality requirements cannot regress';
    END IF;
    IF NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'nationality requirement generations never decrease';
    END IF;
    RETURN NEW;
  END; $$;

CREATE TRIGGER nationality_requirement_state_update_guard
  BEFORE UPDATE ON nationality_requirement_states
  FOR EACH ROW EXECUTE FUNCTION guard_nationality_requirement_state_update();
