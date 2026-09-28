-- A sponsored winner send is reserved before any wallet authorization is
-- requested. Once submission begins, an uncertain provider response cannot
-- release the credit. Reference lookup or a linked canonical chain receipt is
-- required before the send can finish. An expired reservation that was never
-- submitted can be abandoned; a reverted or uncertain submission stays held
-- for operator review before another send is admitted.
CREATE TABLE reward_sponsored_sends (
  send_id TEXT PRIMARY KEY CHECK (
    btrim(send_id) <> '' AND send_id = btrim(send_id) AND octet_length(send_id) <= 128
  ),
  credit_id TEXT NOT NULL REFERENCES reward_ledger_credits (credit_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  wallet_assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments (assignment_id),
  privy_wallet_id TEXT NOT NULL CHECK (
    btrim(privy_wallet_id) <> '' AND privy_wallet_id = btrim(privy_wallet_id)
    AND octet_length(privy_wallet_id) <= 256
  ),
  chain_id BIGINT NOT NULL CHECK (chain_id IN (8453, 84532)),
  sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address TEXT NOT NULL CHECK (
    recipient_address ~ '^0x[0-9a-f]{40}$'
    AND recipient_address <> '0x0000000000000000000000000000000000000000'
  ),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  reference_id TEXT NOT NULL UNIQUE CHECK (reference_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'submitting', 'submitted', 'held', 'confirmed', 'reverted', 'abandoned'
  )),
  provider_transaction_id TEXT CHECK (
    provider_transaction_id IS NULL OR
    (btrim(provider_transaction_id) <> '' AND octet_length(provider_transaction_id) <= 256)
  ),
  user_operation_hash TEXT CHECK (
    user_operation_hash IS NULL OR user_operation_hash ~ '^0x[0-9a-f]{64}$'
  ),
  transaction_hash TEXT CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  block_number BIGINT CHECK (block_number IS NULL OR block_number >= 0),
  block_hash TEXT CHECK (
    block_hash IS NULL OR
    (block_hash ~ '^0x[0-9a-f]{64}$' AND block_hash <> ('0x' || repeat('0', 64)))
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  UNIQUE (account_id, idempotency_key),
  CONSTRAINT reward_sponsored_send_addresses CHECK (
    sender_address <> token_address AND recipient_address <> sender_address
    AND recipient_address <> token_address
  ),
  CONSTRAINT reward_sponsored_send_time_order CHECK (
    updated_at >= created_at AND request_expires_at > created_at
    AND request_expires_at <= created_at + INTERVAL '5 minutes'
  ),
  CONSTRAINT reward_sponsored_send_receipt_shape CHECK (
    (status IN ('confirmed', 'reverted') AND transaction_hash IS NOT NULL
      AND block_number IS NOT NULL AND block_hash IS NOT NULL)
    OR (status NOT IN ('confirmed', 'reverted') AND block_number IS NULL AND block_hash IS NULL)
  ),
  CONSTRAINT reward_sponsored_send_provider_shape CHECK (
    (status IN ('reserved', 'submitting', 'abandoned')
      AND provider_transaction_id IS NULL AND user_operation_hash IS NULL
      AND transaction_hash IS NULL)
    OR (status = 'submitted' AND
      (provider_transaction_id IS NOT NULL OR user_operation_hash IS NOT NULL
       OR transaction_hash IS NOT NULL))
    OR status IN ('held', 'confirmed', 'reverted')
  )
);
CREATE UNIQUE INDEX reward_sponsored_sends_credit_live_uidx
  ON reward_sponsored_sends (credit_id) WHERE status <> 'abandoned';
CREATE INDEX reward_sponsored_sends_account_day_idx
  ON reward_sponsored_sends (account_id, created_at);
CREATE INDEX reward_sponsored_sends_wallet_day_idx
  ON reward_sponsored_sends (wallet_assignment_id, created_at);
CREATE INDEX reward_sponsored_sends_day_idx
  ON reward_sponsored_sends (created_at);

-- Both modes lock the credit row before checking the other table. Two
-- concurrent requests cannot each reserve the same winning in different
-- tables, even if they enter through different API versions.
CREATE FUNCTION guard_reward_send_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM reward_ledger_credits WHERE credit_id = NEW.credit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a reward send requires an existing credit';
  END IF;
  IF TG_TABLE_NAME = 'reward_winner_sends' THEN
    IF EXISTS (
      SELECT 1 FROM reward_sponsored_sends WHERE credit_id = NEW.credit_id
        AND status <> 'abandoned'
    ) THEN
      RAISE EXCEPTION 'a credit with a sponsored send cannot start a direct send';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM reward_winner_sends WHERE credit_id = NEW.credit_id
      AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'a credit with a direct send cannot start a sponsored send';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_winner_send_mode_guard
  BEFORE INSERT ON reward_winner_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_send_mode();
CREATE TRIGGER reward_sponsored_send_mode_guard
  BEFORE INSERT ON reward_sponsored_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_send_mode();

CREATE FUNCTION guard_reward_sponsored_send() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a sponsored reward send is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' OR NEW.provider_transaction_id IS NOT NULL
       OR NEW.user_operation_hash IS NOT NULL OR NEW.transaction_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a sponsored reward send begins without provider evidence';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM reward_ledger_credits credit
        JOIN megapot_participant_claims claim
          ON claim.credit_id = credit.credit_id AND claim.status = 'accepted'
        JOIN reward_payout_effects payout
          ON payout.credit_id = credit.credit_id AND payout.account_id = credit.account_id
        JOIN reward_chain_effects payout_effect
          ON payout_effect.effect_id = payout.payout_effect_id
         AND payout_effect.state = 'confirmed'
        JOIN reward_erc20_transfer_receipt_evidence evidence
          ON evidence.effect_id = payout.payout_effect_id
         AND evidence.transfer_purpose = 'reward_payout'
         AND evidence.recipient_address = payout.destination_address
        JOIN persona_wallet_assignments wallet
          ON wallet.assignment_id = payout.wallet_assignment_id
       WHERE credit.credit_id = NEW.credit_id
         AND credit.account_id = NEW.account_id
         AND credit.payout_persona_id = NEW.persona_id
         AND credit.source_kind = 'megapot_allocation'
         AND credit.state = 'sent'
         AND credit.chain_id = NEW.chain_id
         AND credit.token_address = NEW.token_address
         AND credit.paid_atomic >= NEW.amount_atomic
         AND payout.payout_persona_id = NEW.persona_id
         AND payout.destination_address = NEW.sender_address
         AND payout.wallet_assignment_id = NEW.wallet_assignment_id
         AND wallet.account_id = NEW.account_id
         AND wallet.persona_id = NEW.persona_id
         AND wallet.privy_wallet_id = NEW.privy_wallet_id
         AND wallet.address = NEW.sender_address
    ) THEN
      RAISE EXCEPTION 'a sponsored send requires the claimed and paid credit wallet';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.send_id, NEW.credit_id, NEW.account_id, NEW.persona_id,
    NEW.wallet_assignment_id, NEW.privy_wallet_id, NEW.chain_id,
    NEW.sender_address, NEW.token_address, NEW.recipient_address,
    NEW.amount_atomic, NEW.reference_id, NEW.idempotency_key,
    NEW.request_expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.send_id, OLD.credit_id, OLD.account_id, OLD.persona_id,
    OLD.wallet_assignment_id, OLD.privy_wallet_id, OLD.chain_id,
    OLD.sender_address, OLD.token_address, OLD.recipient_address,
    OLD.amount_atomic, OLD.reference_id, OLD.idempotency_key,
    OLD.request_expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'a sponsored reward send request is immutable';
  END IF;
  IF OLD.status IN ('confirmed', 'reverted', 'abandoned') THEN
    RAISE EXCEPTION 'a sponsored reward send is terminal';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'reserved' AND NEW.status IN ('submitting', 'abandoned')) OR
      (OLD.status = 'submitting' AND NEW.status IN ('submitted', 'held')) OR
      (OLD.status = 'submitted' AND NEW.status IN ('held', 'confirmed', 'reverted')) OR
      (OLD.status = 'held' AND NEW.status IN ('confirmed', 'reverted'))
    ) THEN
      RAISE EXCEPTION 'invalid sponsored reward send transition';
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
CREATE TRIGGER reward_sponsored_sends_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reward_sponsored_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_sponsored_send();
