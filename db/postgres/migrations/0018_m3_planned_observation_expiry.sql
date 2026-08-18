-- Silent-checkout expiry edge for the M3 community-purchase funding journal.
--
-- A planned operation abandoned without a transaction hash parks as
-- legacy-ambiguous via the reducer event planned_observation_window_expired
-- (never reclaimable, never terminal: silence proves no explicit failure and
-- cannot prove that no value moved). This migration replaces only the journal
-- update guard's transition matrix with exactly one new edge:
--
--   planned → reconciliation_required
--
-- No other edge is added or removed, the failure-coherence constraint is
-- unchanged, and plan binding (migration 0014) is untouched.

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
    (OLD.state = 'planned' AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reclaimable_failed', 'reconciliation_required'))
    OR (OLD.state = 'confirming' AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reconciliation_required'))
    OR (OLD.state = 'confirmed' AND NEW.state IN ('confirmed', 'reconciliation_required'))
    OR (OLD.state = 'reverted' AND NEW.state IN ('reverted', 'reconciliation_required'))
    OR (OLD.state = 'reclaimable_failed' AND NEW.state = 'planned')
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('confirming', 'confirmed', 'reverted'))
  ) THEN
    RAISE EXCEPTION 'journal transition is not allowed: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;
