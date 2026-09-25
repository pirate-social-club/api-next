-- A durable, fail-closed record of a Megapot winner sending their claimed,
-- paid USDC onward from the wallet that received the payout. The client signs
-- the transfer in the winner's own wallet; the server never signs. The record
-- exists before anything is signed and fixes the sender's nonce, so every
-- retry or fee bump reuses that nonce and at most one transfer can ever be
-- mined for an attempt. A new attempt, with a fresh and strictly higher nonce,
-- is possible only after the previous attempt's transaction was mined and
-- reverted, which consumed its nonce without moving any USDC.
--
-- A wallet has at most one open send (retryable or pending) per chain, and
-- every reserved nonce is above every nonce the wallet reserved before, so
-- two credits paid to one wallet can never share a nonce. The repository
-- takes a per-sender advisory lock before it reads and reserves a nonce.
--
-- An open send that will not be signed is cancelled on chain, never deleted
-- or expired: the winner signs a zero-value, empty-calldata self-transaction
-- with the reserved nonce, and once that receipt is finalized the record is
-- cancelled. Only one transaction can use the nonce, so the transfer and the
-- cancellation cannot both land. A cancelled record releases the wallet and
-- its credit, which may then start a new record with a fresh nonce: one
-- non-cancelled record per credit.
--
-- Attempts, accepted transaction hashes and final outcomes are append-only.
-- Status changes only from chain observations; no transition depends on
-- elapsed time.

CREATE TABLE reward_winner_sends (
  send_id TEXT PRIMARY KEY CHECK (
    btrim(send_id) <> '' AND send_id = btrim(send_id) AND octet_length(send_id) <= 128
  ),
  credit_id TEXT NOT NULL REFERENCES reward_ledger_credits (credit_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  wallet_assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments (assignment_id),
  chain_id BIGINT NOT NULL CHECK (chain_id = 84532),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'retryable', 'pending', 'confirmed', 'reverted', 'settled_unverified', 'cancelled'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  CONSTRAINT reward_winner_send_sender_not_token CHECK (sender_address <> token_address),
  CONSTRAINT reward_winner_send_time_order CHECK (updated_at >= created_at)
);
CREATE INDEX reward_winner_sends_account_idx ON reward_winner_sends (account_id, created_at);
CREATE UNIQUE INDEX reward_winner_sends_credit_live_uidx
  ON reward_winner_sends (credit_id) WHERE status <> 'cancelled';
CREATE INDEX reward_winner_sends_credit_idx ON reward_winner_sends (credit_id, created_at);
CREATE UNIQUE INDEX reward_winner_sends_open_sender_uidx
  ON reward_winner_sends (chain_id, sender_address) WHERE status IN ('retryable', 'pending');

CREATE TABLE reward_winner_send_attempts (
  send_id TEXT NOT NULL REFERENCES reward_winner_sends (send_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  recipient_address TEXT NOT NULL CHECK (
    recipient_address ~ '^0x[0-9a-f]{40}$'
    AND recipient_address <> '0x0000000000000000000000000000000000000000'
  ),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  nonce BIGINT NOT NULL CHECK (nonce >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (send_id, attempt),
  UNIQUE (send_id, nonce),
  UNIQUE (account_id, idempotency_key)
);

-- Every transaction hash the server accepted for an attempt: several hashes
-- may share the attempt's nonce after re-signing or a fee bump. kind transfer
-- is the ERC-20 transfer; kind cancel is a zero-value self-transaction that
-- consumes the nonce instead.
CREATE TABLE reward_winner_send_transactions (
  transaction_hash TEXT PRIMARY KEY CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  send_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transfer', 'cancel')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (send_id, attempt) REFERENCES reward_winner_send_attempts (send_id, attempt)
);
CREATE INDEX reward_winner_send_transactions_attempt_idx
  ON reward_winner_send_transactions (send_id, attempt, created_at);

-- The final chain outcome of an attempt, observed in a finalized block at the
-- required depth. settled_unverified: the attempt's nonce was consumed there
-- but no accepted hash has a receipt, so the send cannot be retried. A later
-- verified hash whose finalized receipt proves the transfer, its revert, or
-- cancellation adds the corresponding outcome for the same attempt.
CREATE TABLE reward_winner_send_outcomes (
  send_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'confirmed', 'reverted', 'settled_unverified', 'cancelled'
  )),
  transaction_hash TEXT REFERENCES reward_winner_send_transactions (transaction_hash),
  block_number BIGINT CHECK (block_number >= 0),
  block_hash TEXT CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  observed_head_block_number BIGINT NOT NULL CHECK (observed_head_block_number >= 0),
  observed_confirmed_nonce BIGINT NOT NULL CHECK (observed_confirmed_nonce >= 0),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (send_id, attempt, outcome),
  FOREIGN KEY (send_id, attempt) REFERENCES reward_winner_send_attempts (send_id, attempt),
  CONSTRAINT reward_winner_send_outcome_shape CHECK (
    (outcome IN ('confirmed', 'reverted', 'cancelled') AND transaction_hash IS NOT NULL
      AND block_number IS NOT NULL AND block_hash IS NOT NULL
      AND observed_head_block_number >= block_number)
    OR (outcome = 'settled_unverified' AND transaction_hash IS NULL
      AND block_number IS NULL AND block_hash IS NULL)
  )
);

CREATE FUNCTION guard_reward_winner_send() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outcome_row reward_winner_send_outcomes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward winner sends are never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'retryable' OR NEW.attempt <> 1 THEN
      RAISE EXCEPTION 'a reward winner send must begin retryable at attempt 1';
    END IF;
    -- Only the caller's own claimed, paid Megapot participant credit.
    IF NOT EXISTS (
      SELECT 1
        FROM reward_ledger_credits credit
        JOIN megapot_participant_claims claim
          ON claim.credit_id = credit.credit_id AND claim.status = 'accepted'
       WHERE credit.credit_id = NEW.credit_id
         AND credit.account_id = NEW.account_id
         AND credit.payout_persona_id = NEW.persona_id
         AND credit.source_kind = 'megapot_allocation'
         AND credit.state = 'sent'
         AND credit.chain_id = NEW.chain_id
         AND credit.token_address = NEW.token_address
    ) THEN
      RAISE EXCEPTION 'a reward winner send requires a claimed and paid participant credit';
    END IF;
    -- The sender is the wallet that received the credit's confirmed USDC payout.
    IF NOT EXISTS (
      SELECT 1
        FROM reward_payout_effects payout
        JOIN reward_chain_effects payout_effect
          ON payout_effect.effect_id = payout.payout_effect_id
         AND payout_effect.state = 'confirmed'
        JOIN reward_erc20_transfer_receipt_evidence evidence
          ON evidence.effect_id = payout.payout_effect_id
         AND evidence.transfer_purpose = 'reward_payout'
         AND evidence.recipient_address = payout.destination_address
       WHERE payout.credit_id = NEW.credit_id
         AND payout.account_id = NEW.account_id
         AND payout.payout_persona_id = NEW.persona_id
         AND payout.destination_address = NEW.sender_address
         AND payout.wallet_assignment_id = NEW.wallet_assignment_id
    ) THEN
      RAISE EXCEPTION 'a reward winner send must come from the confirmed payout wallet';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.send_id, NEW.credit_id, NEW.account_id, NEW.persona_id, NEW.wallet_assignment_id,
    NEW.chain_id, NEW.token_address, NEW.sender_address, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.send_id, OLD.credit_id, OLD.account_id, OLD.persona_id, OLD.wallet_assignment_id,
    OLD.chain_id, OLD.token_address, OLD.sender_address, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'reward winner send identity is immutable';
  END IF;
  IF OLD.status IN ('confirmed', 'cancelled') THEN
    RAISE EXCEPTION 'a confirmed or cancelled reward winner send is terminal';
  END IF;
  IF OLD.status = 'settled_unverified' THEN
    -- Only late-hash recovery: the same attempt, proven by a finalized receipt.
    IF NEW.status NOT IN ('confirmed', 'reverted', 'cancelled')
       OR NEW.attempt <> OLD.attempt OR NOT EXISTS (
      SELECT 1 FROM reward_winner_send_outcomes outcome
       WHERE outcome.send_id = NEW.send_id AND outcome.attempt = NEW.attempt
         AND outcome.outcome = NEW.status
    ) THEN
      RAISE EXCEPTION 'a settled_unverified reward winner send requires a proven outcome';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.attempt <> OLD.attempt THEN
    -- A new attempt only after the current one was mined and reverted at depth.
    SELECT * INTO outcome_row FROM reward_winner_send_outcomes
     WHERE send_id = OLD.send_id AND attempt = OLD.attempt AND outcome = 'reverted';
    IF NEW.attempt <> OLD.attempt + 1 OR OLD.status <> 'reverted'
       OR NEW.status <> 'retryable' OR outcome_row.outcome IS NULL THEN
      RAISE EXCEPTION 'a reward winner send may start a new attempt only after a revert';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM reward_winner_send_attempts
       WHERE send_id = NEW.send_id AND attempt = NEW.attempt
    ) THEN
      RAISE EXCEPTION 'a reward winner send attempt must be recorded before it is current';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'reverted' THEN
    RAISE EXCEPTION 'a reverted reward winner send changes only by a new attempt';
  END IF;
  IF NEW.status IN ('retryable', 'pending') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM reward_winner_send_outcomes outcome
     WHERE outcome.send_id = NEW.send_id AND outcome.attempt = NEW.attempt
       AND outcome.outcome = NEW.status
  ) THEN
    RAISE EXCEPTION 'a final reward winner send status requires its recorded outcome';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_winner_sends_guard
  BEFORE INSERT OR UPDATE OR DELETE ON reward_winner_sends
  FOR EACH ROW EXECUTE FUNCTION guard_reward_winner_send();

-- At commit, a record's current attempt must exist.
CREATE FUNCTION validate_reward_winner_send_attempt_present() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reward_winner_send_attempts attempt
      JOIN reward_winner_sends send ON send.send_id = attempt.send_id
     WHERE attempt.send_id = NEW.send_id AND attempt.attempt = send.attempt
  ) THEN
    RAISE EXCEPTION 'a reward winner send has no current attempt';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER reward_winner_sends_attempt_present
  AFTER INSERT OR UPDATE ON reward_winner_sends
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_reward_winner_send_attempt_present();

CREATE FUNCTION guard_reward_winner_send_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  send_record reward_winner_sends%ROWTYPE;
  previous_nonce BIGINT;
  paid NUMERIC(78, 0);
BEGIN
  SELECT * INTO send_record FROM reward_winner_sends WHERE send_id = NEW.send_id FOR UPDATE;
  IF send_record.send_id IS NULL OR send_record.account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'a reward winner send attempt must belong to its record''s account';
  END IF;
  IF NEW.recipient_address IN (send_record.sender_address, send_record.token_address) THEN
    RAISE EXCEPTION 'a reward winner send recipient cannot be the sender or the token';
  END IF;
  SELECT credit.paid_atomic INTO paid FROM reward_ledger_credits credit
   WHERE credit.credit_id = send_record.credit_id;
  IF paid IS NULL OR NEW.amount_atomic > paid THEN
    RAISE EXCEPTION 'a reward winner send amount cannot exceed the credit''s paid amount';
  END IF;
  -- A wallet's nonces only move forward: every earlier reservation by this
  -- sender on this chain was consumed before a new one could open.
  IF EXISTS (
    SELECT 1
      FROM reward_winner_send_attempts attempt
      JOIN reward_winner_sends send ON send.send_id = attempt.send_id
     WHERE send.chain_id = send_record.chain_id
       AND send.sender_address = send_record.sender_address
       AND attempt.nonce >= NEW.nonce
  ) THEN
    RAISE EXCEPTION 'a reward winner send nonce must exceed every nonce its sender reserved';
  END IF;
  IF NEW.attempt = 1 THEN
    IF send_record.attempt <> 1 OR send_record.status <> 'retryable' THEN
      RAISE EXCEPTION 'the first reward winner send attempt belongs to a new record';
    END IF;
    RETURN NEW;
  END IF;
  SELECT attempt.nonce INTO previous_nonce FROM reward_winner_send_attempts attempt
   WHERE attempt.send_id = NEW.send_id AND attempt.attempt = NEW.attempt - 1;
  IF NEW.attempt <> send_record.attempt + 1 OR send_record.status <> 'reverted'
     OR previous_nonce IS NULL OR NEW.nonce <= previous_nonce
     OR NOT EXISTS (
       SELECT 1 FROM reward_winner_send_outcomes outcome
        WHERE outcome.send_id = NEW.send_id AND outcome.attempt = send_record.attempt
          AND outcome.outcome = 'reverted'
     ) THEN
    RAISE EXCEPTION 'a reward winner send retry needs a reverted attempt and a higher nonce';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_winner_send_attempts_guard
  BEFORE INSERT ON reward_winner_send_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_reward_winner_send_attempt();
CREATE TRIGGER reward_winner_send_attempts_append_only
  BEFORE UPDATE OR DELETE ON reward_winner_send_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();

-- A hash joins the current attempt while it is open, or while it is
-- settled_unverified for late-hash recovery, which must prove a final outcome
-- in the same transaction (checked at commit below).
CREATE FUNCTION guard_reward_winner_send_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reward_winner_sends send
     WHERE send.send_id = NEW.send_id AND send.attempt = NEW.attempt
       AND send.status IN ('retryable', 'pending', 'settled_unverified')
  ) THEN
    RAISE EXCEPTION 'a reward winner send transaction must belong to its open current attempt';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION validate_reward_winner_send_late_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM reward_winner_sends send
      JOIN reward_winner_send_outcomes outcome
        ON outcome.send_id = send.send_id AND outcome.attempt = send.attempt
       AND outcome.outcome = 'settled_unverified'
     WHERE send.send_id = NEW.send_id AND send.attempt = NEW.attempt
       AND send.status = 'settled_unverified'
       AND NEW.created_at > outcome.created_at
  ) THEN
    RAISE EXCEPTION 'a hash accepted after settled_unverified must prove a final outcome';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER reward_winner_send_transactions_late_proof
  AFTER INSERT ON reward_winner_send_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_reward_winner_send_late_transaction();
CREATE TRIGGER reward_winner_send_transactions_guard
  BEFORE INSERT ON reward_winner_send_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_reward_winner_send_transaction();
CREATE TRIGGER reward_winner_send_transactions_append_only
  BEFORE UPDATE OR DELETE ON reward_winner_send_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();

CREATE FUNCTION guard_reward_winner_send_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reward_winner_sends send
     WHERE send.send_id = NEW.send_id AND send.attempt = NEW.attempt
       AND (send.status IN ('retryable', 'pending')
         OR (send.status = 'settled_unverified'
           AND NEW.outcome IN ('confirmed', 'reverted', 'cancelled')))
  ) THEN
    RAISE EXCEPTION 'a reward winner send outcome must settle its open current attempt';
  END IF;
  -- cancelled cites a cancel hash; confirmed and reverted cite a transfer.
  IF NEW.transaction_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM reward_winner_send_transactions transaction
     WHERE transaction.transaction_hash = NEW.transaction_hash
       AND transaction.send_id = NEW.send_id AND transaction.attempt = NEW.attempt
       AND transaction.kind = CASE WHEN NEW.outcome = 'cancelled' THEN 'cancel' ELSE 'transfer' END
  ) THEN
    RAISE EXCEPTION 'a reward winner send outcome must cite a hash accepted for its attempt';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_winner_send_outcomes_guard
  BEFORE INSERT ON reward_winner_send_outcomes
  FOR EACH ROW EXECUTE FUNCTION guard_reward_winner_send_outcome();
CREATE TRIGGER reward_winner_send_outcomes_append_only
  BEFORE UPDATE OR DELETE ON reward_winner_send_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
