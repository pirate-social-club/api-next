-- The first sponsored-send migration was credit scoped. It has been applied
-- only on the isolated test branch, with no rows. Convert it forward to the
-- shared Wallet reservation before sponsorship can be enabled anywhere.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reward_sponsored_sends) THEN
    RAISE EXCEPTION 'credit-scoped sponsored sends must be resolved before Wallet conversion';
  END IF;
END
$$;

DROP TRIGGER reward_winner_send_mode_guard ON reward_winner_sends;
DROP TRIGGER reward_sponsored_send_mode_guard ON reward_sponsored_sends;
DROP FUNCTION guard_reward_send_mode();
DROP TRIGGER reward_sponsored_sends_guard ON reward_sponsored_sends;
DROP FUNCTION guard_reward_sponsored_send();
DROP INDEX reward_sponsored_sends_credit_live_uidx;
ALTER TABLE reward_sponsored_sends RENAME TO wallet_sponsored_sends;
ALTER TABLE wallet_sponsored_sends DROP COLUMN credit_id;
ALTER TABLE wallet_sponsored_sends ADD COLUMN gas_budget_wei NUMERIC(78, 0) NOT NULL
  CHECK (gas_budget_wei > 0);

CREATE UNIQUE INDEX wallet_sponsored_sends_open_wallet_uidx
  ON wallet_sponsored_sends (chain_id, sender_address)
  WHERE status IN ('reserved', 'submitting', 'submitted', 'held');

-- Serialize the legacy direct-send path and the shared sponsored path for
-- the same wallet. A legacy send with an uncertain nonce remains exclusive.
CREATE FUNCTION guard_wallet_send_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.chain_id::text || ':' || NEW.sender_address, 0));
  IF TG_TABLE_NAME = 'reward_winner_sends' THEN
    IF EXISTS (
      SELECT 1 FROM wallet_sponsored_sends
       WHERE chain_id=NEW.chain_id AND sender_address=NEW.sender_address
         AND status IN ('reserved', 'submitting', 'submitted', 'held')
    ) THEN
      RAISE EXCEPTION 'a wallet with an open sponsored send cannot start a direct send';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM reward_winner_sends
     WHERE chain_id=NEW.chain_id AND sender_address=NEW.sender_address
       AND status IN ('retryable', 'pending', 'settled_unverified')
  ) THEN
    RAISE EXCEPTION 'a wallet with an open direct send cannot start a sponsored send';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_winner_send_mode_guard
  BEFORE INSERT ON reward_winner_sends
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_send_mode();
CREATE TRIGGER wallet_sponsored_send_mode_guard
  BEFORE INSERT ON wallet_sponsored_sends
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_send_mode();

CREATE FUNCTION guard_wallet_sponsored_send() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a sponsored Wallet send is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' OR NEW.provider_transaction_id IS NOT NULL
       OR NEW.user_operation_hash IS NOT NULL OR NEW.transaction_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a sponsored Wallet send begins without provider evidence';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM persona_wallet_assignments wallet
      JOIN personas persona ON persona.persona_id=wallet.persona_id
       AND persona.account_id=wallet.account_id
      WHERE wallet.assignment_id=NEW.wallet_assignment_id
        AND wallet.account_id=NEW.account_id
        AND wallet.persona_id=NEW.persona_id
        AND wallet.chain_account_kind='evm'
        AND wallet.status='active'
        AND persona.status='active'
        AND wallet.privy_wallet_id=NEW.privy_wallet_id
        AND wallet.address=NEW.sender_address
    ) THEN
      RAISE EXCEPTION 'a sponsored send requires an active assigned persona wallet';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.send_id, NEW.account_id, NEW.persona_id,
    NEW.wallet_assignment_id, NEW.privy_wallet_id, NEW.chain_id,
    NEW.sender_address, NEW.token_address, NEW.recipient_address,
    NEW.amount_atomic, NEW.gas_budget_wei, NEW.reference_id, NEW.idempotency_key,
    NEW.provider_idempotency_key, NEW.request_expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.send_id, OLD.account_id, OLD.persona_id,
    OLD.wallet_assignment_id, OLD.privy_wallet_id, OLD.chain_id,
    OLD.sender_address, OLD.token_address, OLD.recipient_address,
    OLD.amount_atomic, OLD.gas_budget_wei, OLD.reference_id, OLD.idempotency_key,
    OLD.provider_idempotency_key, OLD.request_expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'a sponsored Wallet send request is immutable';
  END IF;
  IF OLD.status IN ('confirmed', 'reverted', 'abandoned') THEN
    RAISE EXCEPTION 'a sponsored Wallet send is terminal';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'reserved' AND NEW.status IN ('submitting', 'abandoned')) OR
      (OLD.status = 'submitting' AND NEW.status IN ('submitted', 'held')) OR
      (OLD.status = 'submitted' AND NEW.status IN ('held', 'confirmed', 'reverted')) OR
      (OLD.status = 'held' AND NEW.status IN ('confirmed', 'reverted'))
    ) THEN
      RAISE EXCEPTION 'invalid sponsored Wallet send transition';
    END IF;
  END IF;
  IF NEW.status = 'abandoned' AND clock_timestamp() < OLD.request_expires_at THEN
    RAISE EXCEPTION 'an unsubmitted sponsored send can be abandoned only after expiry';
  END IF;
  IF NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id
     AND OLD.provider_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'a sponsored send provider transaction ID is immutable';
  END IF;
  IF NEW.user_operation_hash IS DISTINCT FROM OLD.user_operation_hash
     AND OLD.user_operation_hash IS NOT NULL THEN
    RAISE EXCEPTION 'a sponsored send user operation hash is immutable';
  END IF;
  IF NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash
     AND OLD.transaction_hash IS NOT NULL THEN
    RAISE EXCEPTION 'a sponsored send transaction hash is immutable';
  END IF;
  IF NEW.status IN ('confirmed', 'reverted') AND NEW.transaction_hash IS NULL THEN
    RAISE EXCEPTION 'a final sponsored send requires a transaction hash';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER wallet_sponsored_sends_guard
  BEFORE INSERT OR UPDATE OR DELETE ON wallet_sponsored_sends
  FOR EACH ROW EXECUTE FUNCTION guard_wallet_sponsored_send();
