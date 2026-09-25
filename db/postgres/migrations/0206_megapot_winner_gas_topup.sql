-- Owner decision 2026-09-25: a Megapot reward winner whose claimed USDC was
-- paid to their persona's embedded EOA may receive a bounded, platform-funded
-- Base native-ETH gas top-up, so they can send that USDC onward. The ETH comes
-- from a platform gas wallet that is never the Megapot custody signer. The
-- server tops up only the shortfall to a fixed target, capped per transfer,
-- per account per UTC day (count) and by a platform daily wei budget, and each
-- request is idempotent. The transfer reuses the generic reward chain-effect
-- fence (nonce reservation, one transition per version, receipt evidence).

ALTER TABLE reward_chain_effects
  DROP CONSTRAINT reward_chain_effects_effect_kind_check,
  ADD CONSTRAINT reward_chain_effects_effect_kind_check CHECK (effect_kind IN (
    'usdc_approval', 'ticket_purchase', 'winnings_claim', 'reward_payout',
    'reward_refund', 'sponsor_withdrawal', 'gas_topup'
  ));

-- The platform gas wallet. At most one active signer per chain. Retiring a
-- signer is the only transition; a retired signer never returns.
CREATE TABLE reward_gas_topup_wallets (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (chain_id, signer_address),
  CONSTRAINT reward_gas_topup_wallet_shape CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retired_at >= created_at)
  )
);
CREATE UNIQUE INDEX reward_gas_topup_wallet_active_uidx
  ON reward_gas_topup_wallets (chain_id) WHERE status = 'active';

CREATE FUNCTION guard_reward_gas_topup_wallet() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward gas top-up wallets are never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.chain_id <> OLD.chain_id OR NEW.signer_address <> OLD.signer_address
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'reward gas top-up wallet identity is immutable';
    END IF;
    IF OLD.status = 'retired' THEN
      RAISE EXCEPTION 'a retired reward gas top-up wallet is terminal';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'a reward gas top-up wallet must begin active';
  END IF;
  -- Separate from Megapot custody: the gas wallet may never be a custody signer.
  IF EXISTS (
    SELECT 1 FROM megapot_deployment_attestations attestation
     WHERE attestation.chain_id = NEW.chain_id
       AND lower(attestation.custody_address) = NEW.signer_address
  ) THEN
    RAISE EXCEPTION 'the reward gas top-up wallet cannot be a Megapot custody signer';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_gas_topup_wallets_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reward_gas_topup_wallets
  FOR EACH ROW EXECUTE FUNCTION guard_reward_gas_topup_wallet();

-- A gas_topup chain effect may only be signed by the chain's active gas
-- wallet, never by custody or any other signer.
CREATE FUNCTION guard_reward_gas_topup_effect_signer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect_kind = 'gas_topup' AND NOT EXISTS (
    SELECT 1 FROM reward_gas_topup_wallets wallet
     WHERE wallet.chain_id = NEW.chain_id
       AND wallet.signer_address = NEW.signer_address
       AND wallet.status = 'active'
  ) THEN
    RAISE EXCEPTION 'a gas top-up effect must be signed by the active gas wallet';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_chain_effects_gas_topup_signer
  BEFORE INSERT ON reward_chain_effects
  FOR EACH ROW EXECUTE FUNCTION guard_reward_gas_topup_effect_signer();

-- Platform daily wei budget per chain and UTC day. A top-up reserves its
-- amount at request time; confirmation moves it to confirmed_wei and a
-- terminal failure or release returns it.
CREATE TABLE reward_gas_topup_daily_budgets (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  budget_day DATE NOT NULL,
  ceiling_wei NUMERIC(78, 0) NOT NULL CHECK (ceiling_wei >= 0),
  reserved_wei NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_wei >= 0),
  confirmed_wei NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (confirmed_wei >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, budget_day),
  CONSTRAINT reward_gas_topup_budget_conservation CHECK (reserved_wei + confirmed_wei <= ceiling_wei),
  CONSTRAINT reward_gas_topup_budget_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE reward_gas_topups (
  topup_id TEXT PRIMARY KEY CHECK (
    btrim(topup_id) <> '' AND topup_id = btrim(topup_id) AND octet_length(topup_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  credit_id TEXT NOT NULL REFERENCES reward_ledger_credits (credit_id),
  wallet_assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments (assignment_id),
  recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  balance_before_wei NUMERIC(78, 0) NOT NULL CHECK (balance_before_wei >= 0),
  target_balance_wei NUMERIC(78, 0) NOT NULL CHECK (target_balance_wei > 0),
  amount_wei NUMERIC(78, 0) NOT NULL CHECK (amount_wei > 0),
  budget_day DATE NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  status TEXT NOT NULL CHECK (status IN ('requested', 'broadcast', 'confirmed', 'released')),
  release_reason TEXT,
  effect_id TEXT UNIQUE REFERENCES reward_chain_effects (effect_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (chain_id, budget_day) REFERENCES reward_gas_topup_daily_budgets (chain_id, budget_day),
  CONSTRAINT reward_gas_topup_shortfall CHECK (balance_before_wei + amount_wei <= target_balance_wei),
  CONSTRAINT reward_gas_topup_shape CHECK (
    (status = 'requested' AND broadcast_at IS NULL AND confirmed_at IS NULL
      AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'broadcast' AND effect_id IS NOT NULL AND broadcast_at IS NOT NULL
      AND confirmed_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'confirmed' AND effect_id IS NOT NULL AND broadcast_at IS NOT NULL
      AND confirmed_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND confirmed_at IS NULL AND released_at IS NOT NULL
      AND release_reason IS NOT NULL AND btrim(release_reason) <> '')
  ),
  CONSTRAINT reward_gas_topup_time_order CHECK (updated_at >= created_at)
);
CREATE INDEX reward_gas_topup_account_day_idx
  ON reward_gas_topups (account_id, budget_day);
CREATE INDEX reward_gas_topup_work_idx
  ON reward_gas_topups (created_at, topup_id) WHERE status IN ('requested', 'broadcast');
CREATE INDEX reward_gas_topup_recipient_open_idx
  ON reward_gas_topups (recipient_address) WHERE status IN ('requested', 'broadcast');

CREATE FUNCTION guard_reward_gas_topup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  active_signer TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward gas top-ups are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.effect_id IS NOT NULL THEN
      RAISE EXCEPTION 'a reward gas top-up must begin requested without an effect';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.topup_id, NEW.account_id, NEW.persona_id, NEW.credit_id, NEW.wallet_assignment_id,
    NEW.recipient_address, NEW.chain_id, NEW.balance_before_wei, NEW.target_balance_wei,
    NEW.amount_wei, NEW.budget_day, NEW.idempotency_key, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.topup_id, OLD.account_id, OLD.persona_id, OLD.credit_id, OLD.wallet_assignment_id,
    OLD.recipient_address, OLD.chain_id, OLD.balance_before_wei, OLD.target_balance_wei,
    OLD.amount_wei, OLD.budget_day, OLD.idempotency_key, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'reward gas top-up identity is immutable';
  END IF;
  IF OLD.effect_id IS NOT NULL AND NEW.effect_id IS DISTINCT FROM OLD.effect_id THEN
    RAISE EXCEPTION 'a reward gas top-up effect binding is immutable';
  END IF;
  IF OLD.status IN ('confirmed', 'released') THEN
    RAISE EXCEPTION 'a confirmed or released reward gas top-up is terminal';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'requested' AND NEW.status IN ('broadcast', 'released'))
    OR (OLD.status = 'broadcast' AND NEW.status IN ('confirmed', 'released'))
  ) THEN
    RAISE EXCEPTION 'invalid reward gas top-up transition';
  END IF;
  IF NEW.effect_id IS NOT NULL AND OLD.effect_id IS NULL THEN
    SELECT * INTO chain_record FROM reward_chain_effects WHERE effect_id = NEW.effect_id;
    SELECT wallet.signer_address INTO active_signer
      FROM reward_gas_topup_wallets wallet
     WHERE wallet.chain_id = NEW.chain_id AND wallet.status = 'active';
    IF chain_record.effect_id IS NULL
       OR chain_record.effect_kind <> 'gas_topup'
       OR chain_record.chain_id <> NEW.chain_id
       OR active_signer IS NULL
       OR chain_record.signer_address <> active_signer
       OR chain_record.target_address <> NEW.recipient_address
       OR chain_record.value_wei <> NEW.amount_wei
       OR chain_record.reserved_amount_atomic <> 0 THEN
      RAISE EXCEPTION 'reward gas top-up effect does not match the top-up';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NEW.effect_id IS NOT NULL THEN
    SELECT * INTO chain_record FROM reward_chain_effects WHERE effect_id = NEW.effect_id;
    IF (NEW.status = 'broadcast' AND chain_record.transaction_hash IS NULL)
       OR (NEW.status = 'confirmed' AND chain_record.state <> 'confirmed')
       OR (NEW.status = 'released' AND chain_record.state NOT IN ('reverted', 'terminal_failed',
         'reclaimable_failed')) THEN
      RAISE EXCEPTION 'reward gas top-up status disagrees with its chain effect';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_gas_topups_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reward_gas_topups
  FOR EACH ROW EXECUTE FUNCTION guard_reward_gas_topup();

-- Confirmed native value-transfer evidence. The receipt carries no value, so
-- the amount is the signed transaction's value, bound by its hash.
CREATE TABLE reward_native_transfer_receipt_evidence (
  effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  amount_wei NUMERIC(78, 0) NOT NULL CHECK (amount_wei > 0),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_reward_native_transfer_receipt_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
BEGIN
  SELECT * INTO chain_record FROM reward_chain_effects WHERE effect_id = NEW.effect_id;
  IF chain_record.effect_id IS NULL
     OR chain_record.effect_kind <> 'gas_topup'
     OR chain_record.state <> 'confirmed'
     OR chain_record.signer_address <> NEW.sender_address
     OR chain_record.target_address <> NEW.recipient_address
     OR chain_record.value_wei <> NEW.amount_wei
     OR chain_record.transaction_hash <> NEW.transaction_hash
     OR chain_record.receipt_block_number <> NEW.block_number
     OR chain_record.receipt_block_hash <> NEW.block_hash
     OR chain_record.receipt_hash <> NEW.receipt_hash THEN
    RAISE EXCEPTION 'native transfer receipt evidence does not match its chain effect';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_native_transfer_receipt_evidence_validate
  BEFORE INSERT ON reward_native_transfer_receipt_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_reward_native_transfer_receipt_evidence();
CREATE TRIGGER reward_native_transfer_receipt_evidence_append_only
  BEFORE UPDATE OR DELETE ON reward_native_transfer_receipt_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
