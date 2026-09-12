-- Spec 008 section 3A: a song confirmed before the terms evidence existed can
-- have that evidence filled from its own confirming receipt. The registration
-- itself is not touched: only a complete null-to-recorded fill is allowed, and
-- the attachment coordinates must be the confirming transaction's own.

CREATE OR REPLACE FUNCTION guard_data_registration_operation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DATA registration operation cannot be deleted';
  END IF;
  IF ROW(
    NEW.registration_operation_id, NEW.community_id, NEW.actor_user_id,
    NEW.submission_id, NEW.media_operation_id, NEW.post_id, NEW.asset_id,
    NEW.chain_id, NEW.registration_revision, NEW.publication_creation_revision,
    NEW.publication_audio_revision, NEW.publication_analysis_revision,
    NEW.publication_decision_revision, NEW.canonical_audio_sha256,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.registration_operation_id, OLD.community_id, OLD.actor_user_id,
    OLD.submission_id, OLD.media_operation_id, OLD.post_id, OLD.asset_id,
    OLD.chain_id, OLD.registration_revision, OLD.publication_creation_revision,
    OLD.publication_audio_revision, OLD.publication_analysis_revision,
    OLD.publication_decision_revision, OLD.canonical_audio_sha256,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'DATA registration operation identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'DATA registration operation timestamp must advance';
  END IF;
  -- Terms backfill: a registered song whose confirmation predates the terms
  -- evidence gains it in place, from the transaction that confirmed the
  -- registration. The fill must be complete, the share must follow the
  -- commercial-remix preset, and nothing else about the row may move. A row
  -- that already has terms is never rewritten here.
  IF OLD.state = 'registered' AND NEW.state = 'registered'
     AND OLD.media_kind = 'song' AND NEW.media_kind = 'song'
     AND OLD.attached_license_terms_id IS NULL
     AND NEW.attached_license_terms_id IS NOT NULL
     AND NEW.attached_license_template IS NOT NULL
     AND NEW.attached_license_preset IS NOT NULL
     AND (NEW.attached_license_preset = 'commercial-remix')
         = (NEW.attached_commercial_rev_share_bps IS NOT NULL)
     AND NEW.terms_attachment_transaction_hash = NEW.confirmed_transaction_hash
     AND NEW.terms_attachment_block_number = NEW.confirmed_block_number
     AND NEW.terms_attachment_block_hash = NEW.confirmed_block_hash
     AND NEW.terms_attachment_log_index IS NOT NULL
     AND ROW(
       NEW.workflow_revision, NEW.workflow_instance_id, NEW.current_attempt_id,
       NEW.registered_ip_id, NEW.confirmed_transaction_hash, NEW.confirmed_block_number,
       NEW.confirmed_block_hash, NEW.confirmed_log_index, NEW.confirmed_at,
       NEW.failure_code, NEW.failure_evidence_ref
     ) IS NOT DISTINCT FROM ROW(
       OLD.workflow_revision, OLD.workflow_instance_id, OLD.current_attempt_id,
       OLD.registered_ip_id, OLD.confirmed_transaction_hash, OLD.confirmed_block_number,
       OLD.confirmed_block_hash, OLD.confirmed_log_index, OLD.confirmed_at,
       OLD.failure_code, OLD.failure_evidence_ref
     ) THEN
    RETURN NEW;
  END IF;
  -- Terms evidence is written with a registration and cleared only when the
  -- registration itself is withdrawn; nothing else may rewrite it.
  IF ROW(
    NEW.attached_license_template, NEW.attached_license_terms_id,
    NEW.attached_license_preset, NEW.attached_commercial_rev_share_bps,
    NEW.terms_attachment_transaction_hash, NEW.terms_attachment_block_number,
    NEW.terms_attachment_block_hash, NEW.terms_attachment_log_index
  ) IS DISTINCT FROM ROW(
    OLD.attached_license_template, OLD.attached_license_terms_id,
    OLD.attached_license_preset, OLD.attached_commercial_rev_share_bps,
    OLD.terms_attachment_transaction_hash, OLD.terms_attachment_block_number,
    OLD.terms_attachment_block_hash, OLD.terms_attachment_log_index
  ) AND NOT (
    (OLD.state <> 'registered' AND NEW.state = 'registered')
    OR (OLD.state = 'registered' AND NEW.state <> 'registered')
  ) THEN
    RAISE EXCEPTION 'DATA attached terms evidence changes only with registration';
  END IF;
  IF NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision
     OR NEW.workflow_instance_id IS DISTINCT FROM OLD.workflow_instance_id THEN
    IF OLD.state = 'registered'
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision + 1
       OR NEW.workflow_instance_id IS DISTINCT FROM
          'data-registration-workflow:' || NEW.registration_operation_id || ':r' || NEW.workflow_revision::text
       OR ROW(
         NEW.state, NEW.current_attempt_id, NEW.registered_ip_id,
         NEW.confirmed_transaction_hash, NEW.confirmed_block_number,
         NEW.confirmed_block_hash, NEW.confirmed_log_index, NEW.confirmed_at,
         NEW.failure_code, NEW.failure_evidence_ref
       ) IS DISTINCT FROM ROW(
         OLD.state, OLD.current_attempt_id, OLD.registered_ip_id,
         OLD.confirmed_transaction_hash, OLD.confirmed_block_number,
         OLD.confirmed_block_hash, OLD.confirmed_log_index, OLD.confirmed_at,
         OLD.failure_code, OLD.failure_evidence_ref
       ) THEN
      RAISE EXCEPTION 'DATA registration workflow replacement is invalid';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('signing', 'failed', 'waiting_parent'))
    OR (OLD.state = 'waiting_parent' AND NEW.state IN ('pending', 'failed'))
    OR (OLD.state = 'signing' AND NEW.state IN (
      'broadcast', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'broadcast' AND NEW.state IN (
      'signing', 'confirming', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirming' AND NEW.state IN (
      'signing', 'broadcast', 'registered', 'failed', 'reconciliation_required'
    ))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'signing', 'broadcast', 'confirming', 'registered', 'failed'
    ))
    OR (OLD.state = 'failed' AND NEW.state = 'registered')
    OR (OLD.state = 'registered' AND NEW.state IN ('failed', 'reconciliation_required'))
  ) THEN
    RAISE EXCEPTION 'invalid DATA registration operation transition';
  END IF;
  -- Only a derivative waits on a parent.
  IF NEW.state = 'waiting_parent' AND NEW.rights_basis <> 'derivative' THEN
    RAISE EXCEPTION 'only a derivative DATA registration waits for its parent';
  END IF;
  -- A song registers only with the terms it attached.
  IF NEW.state = 'registered' AND OLD.state <> 'registered'
     AND NEW.media_kind = 'song' AND NEW.attached_license_terms_id IS NULL THEN
    RAISE EXCEPTION 'a song DATA registration confirms only with its attached terms';
  END IF;
  RETURN NEW;
END;
$$;
