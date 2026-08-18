-- M3 buyer-funding dormancy and explicit indefinite retention.
--
-- A bound plan may have been broadcast by the browser even when api-next never
-- receives the transaction hash. Dormancy therefore removes an unobserved
-- operation from hot scheduling without claiming that no value moved. Late
-- evidence may resume observation from this state.

ALTER TABLE community_purchase_funding_journal
  DROP CONSTRAINT community_purchase_funding_state_check,
  ADD CONSTRAINT community_purchase_funding_state_check CHECK (state IN (
    'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
    'reclaimable_failed', 'reconciliation_required'
  ));

ALTER TABLE community_purchase_funding_journal
  DROP CONSTRAINT community_purchase_funding_failure_coherence_check,
  ADD CONSTRAINT community_purchase_funding_failure_coherence_check CHECK (
    (state IN (
      'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted'
    ) AND failure_tag IS NULL AND failure_reason IS NULL)
    OR (state = 'reclaimable_failed'
      AND failure_tag = 'reclaimable' AND btrim(failure_reason) <> '')
    OR (state = 'reconciliation_required'
      AND failure_tag IN ('ambiguous', 'legacy') AND btrim(failure_reason) <> '')
  );

ALTER TABLE community_purchase_funding_requests
  DROP CONSTRAINT community_purchase_funding_requests_status_check,
  ADD CONSTRAINT community_purchase_funding_requests_status_check CHECK (status IN (
    'planned', 'dormant_unobserved', 'confirming', 'confirmed', 'reverted',
    'reclaimable_failed', 'reconciliation_required'
  ));

CREATE INDEX community_purchase_funding_planned_dormancy_idx
  ON community_purchase_funding_journal (created_at, operation_id)
  WHERE state = 'planned' AND funding_transaction_hash IS NULL;

CREATE OR REPLACE FUNCTION guard_community_purchase_funding_journal_update()
RETURNS trigger
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

-- M3's retention policy is explicit: canonical funding records have no
-- automated deletion. These guards also protect against accidental direct SQL
-- deletion by a broadly granted development role.
CREATE TRIGGER community_purchase_funding_journal_delete_guard
BEFORE DELETE ON community_purchase_funding_journal
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_requests_delete_guard
BEFORE DELETE ON community_purchase_funding_requests
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_plans_delete_guard
BEFORE DELETE ON community_purchase_funding_plans
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();
