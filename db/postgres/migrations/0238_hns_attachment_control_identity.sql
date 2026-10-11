-- Ordinary frontend imports retain the same immutable verifier control facts
-- as creation, recovery and renewal. No lease or route state is extended.
CREATE OR REPLACE FUNCTION validate_community_route_hns_control_identity_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  creation_snapshot namespace_ownership_evidence_snapshots%ROWTYPE;
  recovery_snapshot community_route_revalidation_evidence_snapshots%ROWTYPE;
  renewal_snapshot community_route_active_lease_renewal_evidence_snapshots%ROWTYPE;
  attachment_snapshot RECORD;
  matching_snapshots INTEGER := 0;
BEGIN
  SELECT * INTO creation_snapshot
    FROM namespace_ownership_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF creation_snapshot.root_label <> NEW.root_label
      OR creation_snapshot.ownership_source <> NEW.ownership_source
      OR creation_snapshot.challenge_name <> NEW.txt_name
      OR creation_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR creation_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR creation_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR creation_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match creation evidence';
    END IF;
  END IF;

  SELECT * INTO recovery_snapshot
    FROM community_route_revalidation_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF recovery_snapshot.root_label <> NEW.root_label
      OR recovery_snapshot.ownership_source <> NEW.ownership_source
      OR recovery_snapshot.challenge_name <> NEW.txt_name
      OR recovery_snapshot.challenge_value_sha256 <> NEW.expected_txt_value_sha256
      OR recovery_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR recovery_snapshot.observation ->> 'control_identity_digest'
           IS DISTINCT FROM NEW.control_identity_digest
      OR recovery_snapshot.observation ->> 'chain_authority_digest'
           IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match recovery evidence';
    END IF;
  END IF;

  SELECT * INTO renewal_snapshot
    FROM community_route_active_lease_renewal_evidence_snapshots
   WHERE evidence_ref = NEW.evidence_ref
   FOR SHARE;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF renewal_snapshot.root_label <> NEW.root_label
      OR renewal_snapshot.ownership_source <> NEW.ownership_source
      OR renewal_snapshot.txt_name <> NEW.txt_name
      OR renewal_snapshot.expected_txt_value_sha256 <> NEW.expected_txt_value_sha256
      OR renewal_snapshot.provider_evidence_ref <> NEW.provider_evidence_ref
      OR renewal_snapshot.control_identity_digest <> NEW.control_identity_digest
      OR renewal_snapshot.chain_authority_digest <> NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match renewal evidence';
    END IF;
  END IF;

  SELECT session.route_root_label, session.upstream_session_ref,
         convert_from(observation.raw_response_bytes, 'UTF8')::jsonb AS response
    INTO attachment_snapshot
    FROM community_route_attachment_ceremony_results AS result
    JOIN community_route_attachment_completion_observations AS observation
      ON observation.result_hash=result.result_hash
     AND observation.ceremony_intent_id=result.ceremony_intent_id
     AND observation.actor_id=result.actor_id
     AND observation.attachment_intent_id=result.attachment_intent_id
     AND observation.evidence_digest=result.evidence_digest
     AND observation.provider_identity_digest=result.provider_identity_digest
    JOIN community_route_attachment_namespace_sessions AS session
      ON session.namespace_session_id=observation.namespace_session_id
     AND session.actor_id=observation.actor_id
     AND session.ceremony_intent_id=result.ceremony_intent_id
    JOIN community_route_ownership_evidence AS evidence
      ON evidence.evidence_ref=result.evidence_ref
     AND evidence.origin='route_attachment'
     AND evidence.route_attachment_ceremony_intent_id=result.ceremony_intent_id
     AND evidence.verified_by_actor_id=result.actor_id
     AND evidence.root_label=session.route_root_label
     AND evidence.evidence_digest=result.evidence_digest
     AND evidence.provider_identity_digest=result.provider_identity_digest
     AND evidence.expires_at IS NOT DISTINCT FROM observation.expires_at
   WHERE result.evidence_ref=NEW.evidence_ref
     AND result.outcome_status='satisfied' AND observation.status='verified'
     AND observation.provider_response_sha256=encode(sha256(observation.raw_response_bytes),'hex')
   FOR SHARE OF result,observation,session,evidence;
  IF FOUND THEN
    matching_snapshots := matching_snapshots + 1;
    IF attachment_snapshot.route_root_label IS DISTINCT FROM NEW.root_label
      OR attachment_snapshot.response->>'status' IS DISTINCT FROM 'verified'
      OR (attachment_snapshot.response->>'observation_contract_version' IN (
        'pirate-hns-target-observation-v2','pirate-hns-target-observation-v3')) IS NOT TRUE
      OR attachment_snapshot.response->>'upstream_session_ref'
           IS DISTINCT FROM attachment_snapshot.upstream_session_ref
      OR attachment_snapshot.response->>'ownership_source' IS DISTINCT FROM NEW.ownership_source
      OR attachment_snapshot.response->>'challenge_name' IS DISTINCT FROM NEW.txt_name
      OR attachment_snapshot.response->>'challenge_value'
           IS DISTINCT FROM 'pirate-verification='||attachment_snapshot.upstream_session_ref
      OR attachment_snapshot.response->>'expected_txt_value_sha256'
           IS DISTINCT FROM NEW.expected_txt_value_sha256
      OR encode(sha256(convert_to(attachment_snapshot.response->>'challenge_value','UTF8')),'hex')
           IS DISTINCT FROM NEW.expected_txt_value_sha256
      OR attachment_snapshot.response->>'provider_evidence_ref' IS DISTINCT FROM NEW.provider_evidence_ref
      OR attachment_snapshot.response->>'control_identity_digest' IS DISTINCT FROM NEW.control_identity_digest
      OR attachment_snapshot.response->>'chain_authority_digest' IS DISTINCT FROM NEW.chain_authority_digest
    THEN
      RAISE EXCEPTION 'HNS control identity does not match attachment evidence';
    END IF;
  END IF;

  IF matching_snapshots <> 1 THEN
    RAISE EXCEPTION 'HNS control identity requires exactly one immutable evidence snapshot';
  END IF;
  RETURN NEW;
END;
$$;

-- Populate missing identities from already retained, qualified attachment
-- observations. The trigger above validates every row. Factless legacy
-- observations remain ineligible; existing identities are never overwritten.
INSERT INTO community_route_hns_control_identities (
  evidence_ref,ownership_source,root_label,txt_name,expected_txt_value_sha256,
  control_identity_digest,chain_authority_digest,provider_evidence_ref
)
SELECT result.evidence_ref,response->>'ownership_source',session.route_root_label,
       response->>'challenge_name',response->>'expected_txt_value_sha256',
       response->>'control_identity_digest',response->>'chain_authority_digest',
       response->>'provider_evidence_ref'
  FROM community_route_attachment_ceremony_results AS result
  JOIN community_route_attachment_completion_observations AS observation
    ON observation.result_hash=result.result_hash
  JOIN community_route_attachment_namespace_sessions AS session
    ON session.namespace_session_id=observation.namespace_session_id
   AND session.actor_id=observation.actor_id
  JOIN community_route_ownership_evidence AS evidence
    ON evidence.evidence_ref=result.evidence_ref AND evidence.origin='route_attachment'
  CROSS JOIN LATERAL (SELECT convert_from(observation.raw_response_bytes,'UTF8')::jsonb AS response) decoded
 WHERE result.outcome_status='satisfied' AND observation.status='verified'
   AND response->>'observation_contract_version' IN (
     'pirate-hns-target-observation-v2','pirate-hns-target-observation-v3')
   AND NOT EXISTS (SELECT 1 FROM community_route_hns_control_identities identity
                    WHERE identity.evidence_ref=result.evidence_ref);
