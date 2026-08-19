-- M3 community-purchase commerce authority.
--
-- These tables are the target-owned source for quote derivation. A quote,
-- availability reservation, and the existing immutable funding plan are
-- created by one transaction; none of the values below are browser-authored.

CREATE TABLE community_commerce_policy_revisions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    source_revision text NOT NULL,
    issued_by_user_id text NOT NULL REFERENCES users (user_id),
    effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    superseded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    CONSTRAINT community_commerce_policy_revision_version_check CHECK (policy_version > 0),
    CONSTRAINT community_commerce_policy_revision_source_check CHECK (btrim(source_revision) <> '')
);

CREATE TABLE community_commerce_listings (
    listing_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    availability_mode text NOT NULL CHECK (availability_mode IN ('unbounded', 'finite')),
    available_quantity bigint,
    status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused', 'closed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_commerce_listing_id_check CHECK (btrim(listing_id) <> ''),
    CONSTRAINT community_commerce_listing_quantity_check CHECK (
      (availability_mode = 'unbounded' AND available_quantity IS NULL)
      OR (availability_mode = 'finite' AND available_quantity >= 0)
    ),
    CONSTRAINT community_commerce_listing_policy_fk
      FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE INDEX community_commerce_listings_active_idx
  ON community_commerce_listings (community_id, status, policy_version, listing_id);

CREATE TABLE community_commerce_eligibility_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    requires_verification boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_pricing_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    currency text NOT NULL DEFAULT 'USDC',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_money_route_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_allocation_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    unit_quantity bigint NOT NULL DEFAULT 1 CHECK (unit_quantity = 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_settlement_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    mode text NOT NULL CHECK (mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_donation_policy_versions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    mode text NOT NULL CHECK (mode IN ('none', 'partner_share')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_donation_partners (
    partner_id text PRIMARY KEY,
    display_name text NOT NULL,
    destination_address text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_commerce_donation_partner_id_check CHECK (btrim(partner_id) <> ''),
    CONSTRAINT community_commerce_donation_partner_name_check CHECK (btrim(display_name) <> '')
);

CREATE TABLE community_purchase_verification_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    provider text NOT NULL CHECK (provider = 'zkPassport'),
    provider_policy_version text NOT NULL,
    verified_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('valid', 'invalid')),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_verification_snapshot_id_check CHECK (btrim(snapshot_id) <> ''),
    CONSTRAINT community_purchase_verification_snapshot_expiry_check CHECK (expires_at > verified_at)
);

CREATE INDEX community_purchase_verification_actor_idx
  ON community_purchase_verification_snapshots (actor_id, community_id, status, expires_at DESC);

CREATE TABLE community_purchase_eligibility_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    policy_version bigint NOT NULL,
    verification_snapshot_id text NOT NULL REFERENCES community_purchase_verification_snapshots (snapshot_id),
    decision text NOT NULL CHECK (decision IN ('eligible', 'ineligible')),
    evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_eligibility_policy_versions (community_id, policy_version)
);

CREATE INDEX community_purchase_eligibility_lookup_idx
  ON community_purchase_eligibility_snapshots (actor_id, community_id, policy_version, decision);

CREATE TABLE community_purchase_pricing_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    policy_version bigint NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
    region_code text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_pricing_policy_versions (community_id, policy_version)
);

CREATE TABLE community_purchase_route_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL CHECK (chain_id > 0),
    token_contract text NOT NULL CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
    token_decimals smallint NOT NULL CHECK (token_decimals = 6),
    treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
    required_confirmations integer NOT NULL CHECK (required_confirmations > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_money_route_policy_versions (community_id, policy_version)
);

CREATE TABLE community_purchase_allocation_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    policy_version bigint NOT NULL,
    quantity bigint NOT NULL CHECK (quantity = 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_allocation_policy_versions (community_id, policy_version)
);

CREATE TABLE community_purchase_settlement_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    mode text NOT NULL CHECK (mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_settlement_policy_versions (community_id, policy_version)
);

CREATE TABLE community_purchase_donation_snapshots (
    snapshot_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    mode text NOT NULL CHECK (mode IN ('none', 'partner_share')),
    partner_id text REFERENCES community_commerce_donation_partners (partner_id),
    share_bps integer CHECK (share_bps IS NULL OR share_bps BETWEEN 0 AND 10_000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_donation_policy_versions (community_id, policy_version),
    CONSTRAINT community_purchase_donation_snapshot_partner_check CHECK (
      (mode = 'none' AND partner_id IS NULL AND share_bps IS NULL)
      OR (mode = 'partner_share' AND partner_id IS NOT NULL AND share_bps IS NOT NULL)
    )
);

CREATE TABLE community_purchase_intents (
    purchase_id text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES users (user_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    idempotency_key text NOT NULL,
    authenticated_wallet_address text NOT NULL CHECK (authenticated_wallet_address ~ '^0x[0-9a-f]{40}$'),
    verification_snapshot_id text NOT NULL REFERENCES community_purchase_verification_snapshots (snapshot_id),
    status text NOT NULL DEFAULT 'quoted'
      CHECK (status IN ('quoted', 'admitted', 'cancelled', 'expired')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_intent_id_check CHECK (btrim(purchase_id) <> ''),
    CONSTRAINT community_purchase_intent_key_check CHECK (btrim(idempotency_key) <> ''),
    UNIQUE (actor_id, listing_id, idempotency_key)
);

CREATE INDEX community_purchase_intents_lookup_idx
  ON community_purchase_intents (actor_id, listing_id, idempotency_key);

CREATE TABLE community_purchase_availability_reservations (
    reservation_id text PRIMARY KEY,
    purchase_id text NOT NULL UNIQUE REFERENCES community_purchase_intents (purchase_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    quantity bigint NOT NULL CHECK (quantity = 1),
    status text NOT NULL DEFAULT 'held'
      CHECK (status IN ('held', 'consumed', 'released', 'expired')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX community_purchase_reservations_expiry_idx
  ON community_purchase_availability_reservations (listing_id, status, expires_at);

CREATE TABLE community_purchase_quotes (
    quote_id text PRIMARY KEY,
    purchase_id text NOT NULL UNIQUE REFERENCES community_purchase_intents (purchase_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    policy_version bigint NOT NULL,
    eligibility_snapshot_id text NOT NULL REFERENCES community_purchase_eligibility_snapshots (snapshot_id),
    pricing_snapshot_id text NOT NULL REFERENCES community_purchase_pricing_snapshots (snapshot_id),
    verification_snapshot_id text NOT NULL REFERENCES community_purchase_verification_snapshots (snapshot_id),
    route_snapshot_id text NOT NULL REFERENCES community_purchase_route_snapshots (snapshot_id),
    allocation_snapshot_id text NOT NULL REFERENCES community_purchase_allocation_snapshots (snapshot_id),
    settlement_snapshot_id text NOT NULL REFERENCES community_purchase_settlement_snapshots (snapshot_id),
    donation_snapshot_id text NOT NULL REFERENCES community_purchase_donation_snapshots (snapshot_id),
    reservation_id text NOT NULL UNIQUE REFERENCES community_purchase_availability_reservations (reservation_id),
    buyer_wallet_address text NOT NULL CHECK (buyer_wallet_address ~ '^0x[0-9a-f]{40}$'),
    buyer_chain_id bigint NOT NULL CHECK (buyer_chain_id > 0),
    token_contract text NOT NULL CHECK (token_contract ~ '^0x[0-9a-f]{40}$'),
    token_decimals smallint NOT NULL CHECK (token_decimals = 6),
    treasury_address text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
    amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
    required_confirmations integer NOT NULL CHECK (required_confirmations > 0),
    quoted_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'bound', 'cancelled', 'expired')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_quote_id_check CHECK (btrim(quote_id) <> ''),
    CONSTRAINT community_purchase_quote_expiry_check CHECK (expires_at > quoted_at),
    CONSTRAINT community_purchase_quote_chain_check CHECK (buyer_chain_id > 0)
);

CREATE INDEX community_purchase_quotes_actor_status_idx
  ON community_purchase_quotes (actor_id, community_id, status, expires_at, quote_id);

CREATE TABLE community_purchase_correction_events (
    correction_event_id text PRIMARY KEY,
    target_identity text NOT NULL,
    kind text NOT NULL,
    operator_id text NOT NULL REFERENCES users (user_id),
    reason text NOT NULL,
    community_id text NOT NULL REFERENCES communities (community_id),
    purchase_id text REFERENCES community_purchase_intents (purchase_id),
    quote_id text REFERENCES community_purchase_quotes (quote_id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_correction_identity_check CHECK (btrim(target_identity) <> ''),
    CONSTRAINT community_purchase_correction_kind_check CHECK (btrim(kind) <> ''),
    CONSTRAINT community_purchase_correction_reason_check CHECK (btrim(reason) <> ''),
    UNIQUE (target_identity, kind)
);

CREATE INDEX community_purchase_corrections_target_idx
  ON community_purchase_correction_events (target_identity, created_at DESC);

-- Policy revisions and authority snapshots are evidence, not mutable caches.
-- Corrections issue a new revision/snapshot instead of editing an old one.
CREATE OR REPLACE FUNCTION reject_community_purchase_commerce_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_commerce_policy_revisions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_eligibility_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_eligibility_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_pricing_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_pricing_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_money_route_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_money_route_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_allocation_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_allocation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_settlement_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_settlement_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_commerce_donation_policy_versions_immutable
BEFORE UPDATE OR DELETE ON community_commerce_donation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_verification_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_verification_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_eligibility_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_eligibility_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_pricing_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_pricing_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_route_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_route_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_allocation_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_allocation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_settlement_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_settlement_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE TRIGGER community_purchase_donation_snapshots_immutable
BEFORE UPDATE OR DELETE ON community_purchase_donation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_commerce_mutation();

CREATE OR REPLACE FUNCTION guard_community_purchase_quote_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.purchase_id, NEW.community_id, NEW.actor_id, NEW.listing_id,
    NEW.policy_version, NEW.eligibility_snapshot_id, NEW.pricing_snapshot_id,
    NEW.verification_snapshot_id, NEW.route_snapshot_id, NEW.allocation_snapshot_id,
    NEW.settlement_snapshot_id, NEW.donation_snapshot_id, NEW.reservation_id,
    NEW.buyer_wallet_address, NEW.buyer_chain_id, NEW.token_contract, NEW.token_decimals,
    NEW.treasury_address, NEW.amount_atomic, NEW.required_confirmations,
    NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.purchase_id, OLD.community_id, OLD.actor_id, OLD.listing_id,
    OLD.policy_version, OLD.eligibility_snapshot_id, OLD.pricing_snapshot_id,
    OLD.verification_snapshot_id, OLD.route_snapshot_id, OLD.allocation_snapshot_id,
    OLD.settlement_snapshot_id, OLD.donation_snapshot_id, OLD.reservation_id,
    OLD.buyer_wallet_address, OLD.buyer_chain_id, OLD.token_contract, OLD.token_decimals,
    OLD.treasury_address, OLD.amount_atomic, OLD.required_confirmations,
    OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase quote terms are immutable';
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('active', 'bound', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('bound', 'cancelled', 'expired') AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'community purchase quote transition is not allowed: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_purchase_quotes_update_guard
BEFORE UPDATE ON community_purchase_quotes
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_quote_update();
