/** Shared exact-witness read predicate; does not create or attest evidence. */
export const megapotVeryEvidenceCte = `WITH exact_evidence AS (
  SELECT DISTINCT ON (subject.subject_key_id)
         subject.subject_key_id,
         active_binding.binding_event_id,
         active_binding.binding_epoch::integer AS binding_epoch,
         binding.binding_group_id,
         receipt.evidence_receipt_id,
         receipt.proof_session_id,
         receipt.evidence_hash,
         personhood.assertion_id AS personhood_assertion_id,
         subject_unique.assertion_id AS subject_unique_assertion_id,
         LEAST(receipt.expires_at, personhood.expires_at, subject_unique.expires_at)
           AS evidence_expires_at,
         receipt.observed_at
    FROM subject_keys subject
    JOIN active_subject_key_bindings active_binding
      ON active_binding.subject_key_id=subject.subject_key_id
     AND active_binding.user_id=$1
    JOIN assertion_bindings binding
      ON binding.user_id=$1
     AND binding.binding_mode='same_subject'
     AND binding.subject_key_id=subject.subject_key_id
     AND binding.subject_binding_event_id=active_binding.binding_event_id
     AND binding.subject_binding_epoch=active_binding.binding_epoch
    JOIN assertions personhood
      ON personhood.binding_group_id=binding.binding_group_id
     AND personhood.user_id=$1
     AND personhood.subject_key_id=subject.subject_key_id
     AND personhood.claim_id='human.personhood'
     AND personhood.assertion_value='{"personhood": true}'::jsonb
     AND personhood.assurance='provider_attested'
    JOIN assertions subject_unique
      ON subject_unique.binding_group_id=binding.binding_group_id
     AND subject_unique.user_id=$1
     AND subject_unique.subject_key_id=subject.subject_key_id
     AND subject_unique.evidence_receipt_id=personhood.evidence_receipt_id
     AND subject_unique.claim_id='credential.subject_unique'
     AND subject_unique.assertion_value='{"subject_unique": true}'::jsonb
     AND subject_unique.assurance='provider_attested'
    JOIN evidence_receipts receipt
      ON receipt.evidence_receipt_id=personhood.evidence_receipt_id
     AND receipt.user_id=$1
     AND receipt.subject_key_id=subject.subject_key_id
     AND receipt.subject_binding_event_id=active_binding.binding_event_id
     AND receipt.subject_binding_epoch=active_binding.binding_epoch
     AND receipt.provider_id='very.web'
     AND receipt.issuer='https://verify.very.org'
     AND receipt.method='palm_web'
     AND receipt.scope_kind='issuer_rp_scope'
     AND receipt.issuer_rp_scope='pirate-social'
     AND receipt.issuer_rp_action_scope IS NULL
     AND receipt.protocol_version='very-web-v1'
     AND receipt.evidence_kind='very.web.server-verified.v1'
     AND receipt.provenance_kind='proof_session'
    JOIN proof_sessions session
      ON session.proof_session_id=receipt.proof_session_id
     AND session.actor_id=$1
     AND session.status='completed'
     AND session.completed_at=session.terminal_at
     AND session.provider_id=receipt.provider_id
     AND session.issuer=receipt.issuer
     AND session.method=receipt.method
     AND session.scope_kind=receipt.scope_kind
     AND session.issuer_rp_scope=receipt.issuer_rp_scope
     AND session.issuer_rp_action_scope IS NOT DISTINCT FROM receipt.issuer_rp_action_scope
     AND session.protocol_version=receipt.protocol_version
     AND session.requested_requirements=
       '[{"claim_id":"credential.subject_unique"},{"claim_id":"human.personhood"}]'::jsonb
     AND session.requested_claim_ids=
       '["credential.subject_unique","human.personhood"]'::jsonb
   WHERE subject.issuer='https://verify.very.org'
     AND subject.method='palm_web'
     AND subject.scope_kind='issuer_rp_scope'
     AND subject.issuer_rp_scope='pirate-social'
     AND subject.issuer_rp_action_scope IS NULL
     AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp() + interval '5 seconds')
     AND (personhood.expires_at IS NULL OR personhood.expires_at > clock_timestamp() + interval '5 seconds')
     AND (subject_unique.expires_at IS NULL OR subject_unique.expires_at > clock_timestamp() + interval '5 seconds')
     AND COALESCE((
       SELECT event.outcome FROM assertion_revalidation_events event
        WHERE event.assertion_id=personhood.assertion_id
        ORDER BY event.observed_at DESC, event.assertion_revalidation_event_id DESC LIMIT 1
     ), 'accepted')='accepted'
     AND COALESCE((
       SELECT event.outcome FROM assertion_revalidation_events event
        WHERE event.assertion_id=subject_unique.assertion_id
        ORDER BY event.observed_at DESC, event.assertion_revalidation_event_id DESC LIMIT 1
     ), 'accepted')='accepted'
   ORDER BY subject.subject_key_id, receipt.observed_at DESC, receipt.evidence_receipt_id DESC
)`;
