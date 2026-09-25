-- Spec 014 §12.2. A browser may start provider creation once. After that,
-- recovery reads provider inventory and never repeats the create call.
CREATE TABLE spaces_taproot_creation_intents (
  assignment_id TEXT PRIMARY KEY REFERENCES persona_wallet_assignments(assignment_id),
  account_id TEXT NOT NULL REFERENCES users(user_id),
  persona_id TEXT NOT NULL REFERENCES personas(persona_id),
  bitcoin_network TEXT NOT NULL REFERENCES spaces_network_configuration(network),
  baseline_wallets JSONB NOT NULL CHECK (jsonb_typeof(baseline_wallets)='array'),
  challenge_nonce_hex TEXT NOT NULL CHECK (challenge_nonce_hex ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('prepared','create_started','ambiguous','active')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  candidate_privy_wallet_id TEXT,
  confirm_signature_hex TEXT,
  confirmed_at TIMESTAMPTZ,
  CHECK (
    (state='prepared' AND started_at IS NULL AND candidate_privy_wallet_id IS NULL
      AND confirm_signature_hex IS NULL AND confirmed_at IS NULL)
    OR (state IN ('create_started','ambiguous') AND started_at IS NOT NULL
      AND candidate_privy_wallet_id IS NULL AND confirm_signature_hex IS NULL
      AND confirmed_at IS NULL)
    OR (state='active' AND started_at IS NOT NULL AND confirmed_at >= started_at
      AND candidate_privy_wallet_id IS NOT NULL
      AND confirm_signature_hex ~ '^[0-9a-f]{128}$')
  )
);

CREATE FUNCTION guard_spaces_taproot_creation_intent_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Taproot creation intent cannot be deleted';
  END IF;
  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.persona_id IS DISTINCT FROM OLD.persona_id
    OR NEW.bitcoin_network IS DISTINCT FROM OLD.bitcoin_network
    OR NEW.baseline_wallets IS DISTINCT FROM OLD.baseline_wallets
    OR NEW.challenge_nonce_hex IS DISTINCT FROM OLD.challenge_nonce_hex
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Taproot creation intent identity is immutable';
  END IF;
  IF OLD.state='prepared' AND NEW.state NOT IN ('prepared','create_started') THEN
    RAISE EXCEPTION 'Taproot create must be marked before reconciliation';
  END IF;
  IF OLD.state='create_started' AND NEW.state NOT IN ('create_started','ambiguous','active') THEN
    RAISE EXCEPTION 'Taproot create state cannot move backward';
  END IF;
  IF OLD.state IN ('ambiguous','active') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Taproot create state is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_taproot_creation_intents_change_guard
BEFORE UPDATE OR DELETE ON spaces_taproot_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_spaces_taproot_creation_intent_v1();

-- A Taproot index is unknown before the provider creates the wallet. Allow
-- exactly one pending-to-active fill while keeping all EVM indexes immutable.
CREATE OR REPLACE FUNCTION guard_persona_wallet_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'persona wallet assignment cannot be deleted';
  END IF;
  IF NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.persona_id IS DISTINCT FROM OLD.persona_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.chain_account_kind IS DISTINCT FROM OLD.chain_account_kind
     OR (NEW.hd_wallet_index IS DISTINCT FROM OLD.hd_wallet_index AND NOT
       (OLD.chain_account_kind='bitcoin-taproot' AND OLD.status='pending'
        AND NEW.status='active' AND OLD.hd_wallet_index IS NULL
        AND NEW.hd_wallet_index IS NOT NULL))
     OR NEW.reservation_idempotency_key IS DISTINCT FROM OLD.reservation_idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.bitcoin_network IS DISTINCT FROM OLD.bitcoin_network THEN
    RAISE EXCEPTION 'persona wallet assignment identity is immutable';
  END IF;
  IF OLD.status = 'tombstoned' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'tombstoned persona wallet assignment is immutable';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('active', 'tombstoned') THEN
    RAISE EXCEPTION 'active persona wallet assignment cannot be reopened';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'active', 'tombstoned') THEN
    RAISE EXCEPTION 'invalid persona wallet assignment transition';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.privy_wallet_id IS DISTINCT FROM OLD.privy_wallet_id
       OR NEW.address IS DISTINCT FROM OLD.address
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.output_script_hex IS DISTINCT FROM OLD.output_script_hex) THEN
    RAISE EXCEPTION 'assigned persona wallet authority is immutable';
  END IF;
  RETURN NEW;
END
$$;
