-- Allow both ratified HNS TXT challenge topologies at the persistence boundary.
--
-- The application and evidence ABI already distinguish parent-chain apex TXT
-- from owner-authoritative _pirate TXT. The previous trigger accidentally
-- accepted only the latter.

CREATE OR REPLACE FUNCTION validate_namespace_ownership_evidence_snapshot_insert()
RETURNS trigger
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

