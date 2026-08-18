-- Immutable M3 community-purchase funding quote/plan.
--
-- A plan is the durable boundary between quote pricing and the funding
-- journal.  Its terms are fixed at creation; only its binding lifecycle may
-- advance from active to bound or cancelled.

CREATE TABLE community_purchase_funding_plans (
    quote_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    purchase_id text NOT NULL UNIQUE,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    quoted_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'active',
    operation_id text UNIQUE REFERENCES community_purchase_funding_journal (operation_id),
    CONSTRAINT community_purchase_funding_plans_quote_not_blank CHECK (btrim(quote_id) <> ''),
    CONSTRAINT community_purchase_funding_plans_buyer_wallet_check CHECK (
      buyer_wallet_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_plans_buyer_chain_check CHECK (
      buyer_chain_id > 0 AND buyer_chain_id = chain_id
    ),
    CONSTRAINT community_purchase_funding_plans_purchase_not_blank CHECK (btrim(purchase_id) <> ''),
    CONSTRAINT community_purchase_funding_plans_policy_version_check CHECK (policy_version > 0),
    CONSTRAINT community_purchase_funding_plans_chain_id_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_plans_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_funding_plans_treasury_check CHECK (
      treasury_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_plans_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_funding_plans_confirmations_check CHECK (
      required_confirmations > 0
    ),
    CONSTRAINT community_purchase_funding_plans_expiry_check CHECK (expires_at > quoted_at),
    CONSTRAINT community_purchase_funding_plans_status_check CHECK (
      status IN ('active', 'bound', 'cancelled')
    ),
    CONSTRAINT community_purchase_funding_plans_operation_coherence_check CHECK (
      (status = 'bound' AND operation_id IS NOT NULL)
      OR (status IN ('active', 'cancelled') AND operation_id IS NULL)
    )
);

CREATE INDEX community_purchase_funding_plans_actor_status_idx
    ON community_purchase_funding_plans (actor_id, status, expires_at, quote_id);

CREATE INDEX community_purchase_funding_plans_community_status_idx
    ON community_purchase_funding_plans (community_id, status, expires_at, quote_id);

CREATE OR REPLACE FUNCTION guard_community_purchase_funding_plan_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.community_id, NEW.actor_id, NEW.buyer_wallet_address,
    NEW.buyer_chain_id, NEW.purchase_id, NEW.policy_version, NEW.chain_id, NEW.token_contract,
    NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.community_id, OLD.actor_id, OLD.buyer_wallet_address,
    OLD.buyer_chain_id, OLD.purchase_id, OLD.policy_version, OLD.chain_id, OLD.token_contract,
    OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase funding plan terms are immutable';
  END IF;

  IF OLD.status = 'active' THEN
    IF NEW.status IN ('active', 'cancelled') AND NEW.operation_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'bound'
      AND OLD.operation_id IS NULL AND NEW.operation_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.status = 'bound'
    AND NEW.status = 'bound'
    AND NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status = 'cancelled' AND NEW.operation_id IS NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'community purchase funding plan transition is not allowed: % -> %',
    OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_purchase_funding_plans_update_guard
BEFORE UPDATE ON community_purchase_funding_plans
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_plan_update();
