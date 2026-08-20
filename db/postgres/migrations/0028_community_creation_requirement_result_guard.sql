-- Close the deferred requirement/result coherence gap without rewriting 0027.
-- A nonterminal requirement may wait for its result, but a terminal requirement
-- must have a matching immutable result by transaction commit.

CREATE OR REPLACE FUNCTION validate_community_creation_requirement_result()
RETURNS trigger
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
