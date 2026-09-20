-- Creator-verification removal, ratified 2026-09-19. Historical attempts,
-- requirement states, proof sessions and results remain evidence. They no
-- longer authorize creation or appear in the creation response. Join and
-- handle-claim evidence and ceremonies are unchanged.
LOCK TABLE community_creation_intents, nationality_requirement_states,
  nationality_ceremony_attempts IN ACCESS EXCLUSIVE MODE;

-- gate_unsupported is normally immutable. Permit only this migration's
-- precise cutover under an exclusive lock, then restore the normal guard.
ALTER TABLE community_creation_intents DISABLE TRIGGER community_creation_intent_update_guard;
UPDATE community_creation_intents AS intent
   SET status = 'expired', revision = revision + 1, updated_at = clock_timestamp()
 WHERE creation_contract_version = 'optional_route_v2'
   AND status IN ('verification_required', 'gate_unsupported')
   AND (
     EXISTS (
       SELECT 1 FROM nationality_requirement_states AS state
        WHERE state.action_kind = 'community_creation'
          AND state.intent_id = intent.intent_id AND state.actor_id = intent.actor_id
     )
     OR jsonb_path_exists(intent.draft, '$.policy.accessPaths[*].requirements[*] ? (@.requirement == "nationality-allowed")')
   );
-- Flush deferred cardinality checks before changing the table trigger state.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE community_creation_intents ENABLE TRIGGER community_creation_intent_update_guard;

-- Preserve satisfied rows unchanged: their immutability is part of the
-- evidence contract. Pending ceremonies are retired, never satisfied by cutover.
UPDATE nationality_requirement_states
   SET status = 'expired', updated_at = clock_timestamp()
 WHERE action_kind = 'community_creation' AND status IN ('pending', 'failed');

CREATE FUNCTION reject_retired_creation_nationality_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_kind = 'community_creation' THEN
    RAISE EXCEPTION 'creator nationality verification is retired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nationality_creation_state_retired
  BEFORE INSERT OR UPDATE ON nationality_requirement_states
  FOR EACH ROW EXECUTE FUNCTION reject_retired_creation_nationality_write();
CREATE TRIGGER nationality_creation_attempt_retired
  BEFORE INSERT ON nationality_ceremony_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_retired_creation_nationality_write();
