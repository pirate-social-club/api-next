-- Target-owned community commerce source for the M3 funding-plan producer.
-- All quote economics are captured from these rows in one PostgreSQL
-- transaction; no legacy commerce table is a runtime dependency.

CREATE TABLE community_commerce_policy_revisions (
    community_id text NOT NULL REFERENCES communities (community_id),
    policy_version bigint NOT NULL,
    source_revision text NOT NULL,
    issued_by text NOT NULL REFERENCES users (user_id),
    effective_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    superseded_at timestamp with time zone,
    PRIMARY KEY (community_id, policy_version),
    CONSTRAINT community_commerce_policy_revision_check CHECK (
      policy_version > 0 AND btrim(source_revision) <> ''
    )
);

CREATE TABLE community_commerce_listings (
    listing_id text PRIMARY KEY,
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    active boolean NOT NULL DEFAULT true,
    availability_mode text NOT NULL,
    available_quantity integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_commerce_listing_identity_fk
      FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_listing_mode_check CHECK (
      availability_mode IN ('unbounded', 'finite')
    ),
    CONSTRAINT community_commerce_listing_quantity_check CHECK (
      (availability_mode = 'unbounded' AND available_quantity IS NULL)
      OR (availability_mode = 'finite' AND available_quantity >= 0)
    ),
    CONSTRAINT community_commerce_listing_id_check CHECK (btrim(listing_id) <> '')
);

CREATE TABLE community_commerce_eligibility_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    verification_required boolean NOT NULL DEFAULT false,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_commerce_pricing_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_pricing_amount_check CHECK (amount_atomic > 0)
);

CREATE TABLE community_commerce_money_route_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    required_confirmations integer NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_route_chain_check CHECK (chain_id > 0),
    CONSTRAINT community_commerce_route_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_commerce_route_treasury_check CHECK (
      treasury_address ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_commerce_route_confirmations_check CHECK (required_confirmations > 0)
);

CREATE TABLE community_commerce_allocation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    allocation_mode text NOT NULL DEFAULT 'single_unit',
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_allocation_mode_check CHECK (allocation_mode = 'single_unit')
);

CREATE TABLE community_commerce_settlement_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    settlement_mode text NOT NULL,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    CONSTRAINT community_commerce_settlement_mode_check CHECK (
      settlement_mode IN ('delivery_only_story_settlement', 'royalty_native_story_payment')
    )
);

CREATE TABLE community_commerce_donation_partners (
    partner_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    name text NOT NULL,
    destination_address text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    CONSTRAINT community_commerce_donation_partner_check CHECK (
      btrim(partner_id) <> '' AND btrim(name) <> ''
      AND destination_address ~ '^0x[0-9a-f]{40}$'
    )
);

CREATE TABLE community_commerce_donation_policy_versions (
    community_id text NOT NULL,
    policy_version bigint NOT NULL,
    policy_mode text NOT NULL,
    partner_id text,
    share_bps integer NOT NULL DEFAULT 0,
    PRIMARY KEY (community_id, policy_version),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version),
    FOREIGN KEY (partner_id) REFERENCES community_commerce_donation_partners (partner_id),
    CONSTRAINT community_commerce_donation_mode_check CHECK (policy_mode IN ('none', 'partner_share')),
    CONSTRAINT community_commerce_donation_share_check CHECK (share_bps BETWEEN 0 AND 10000),
    CONSTRAINT community_commerce_donation_partner_check CHECK (
      (policy_mode = 'none' AND partner_id IS NULL AND share_bps = 0)
      OR (policy_mode = 'partner_share' AND partner_id IS NOT NULL AND share_bps > 0)
    )
);

CREATE TABLE community_purchase_intents (
    purchase_id text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES users (user_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    status text NOT NULL DEFAULT 'reserved',
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT community_purchase_intent_status_check CHECK (
      status IN ('reserved', 'consumed', 'released', 'expired')
    ),
    CONSTRAINT community_purchase_intent_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX community_purchase_intents_open_unique
  ON community_purchase_intents (actor_id, community_id, listing_id)
  WHERE status = 'reserved';

CREATE TABLE community_purchase_availability_reservations (
    purchase_id text PRIMARY KEY REFERENCES community_purchase_intents (purchase_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    state text NOT NULL DEFAULT 'held',
    expires_at timestamp with time zone NOT NULL,
    transitioned_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_reservation_state_check CHECK (
      state IN ('held', 'consumed', 'released', 'expired')
    )
);

CREATE TABLE community_purchase_quotes (
    quote_id text PRIMARY KEY,
    purchase_id text NOT NULL UNIQUE REFERENCES community_purchase_intents (purchase_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    listing_id text NOT NULL REFERENCES community_commerce_listings (listing_id),
    policy_version bigint NOT NULL,
    buyer_wallet_address text NOT NULL,
    buyer_chain_id bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    treasury_address text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    eligibility_snapshot_id text,
    pricing_snapshot_id text,
    verification_snapshot_id text,
    route_snapshot_id text,
    allocation_snapshot_id text,
    settlement_snapshot_id text,
    donation_snapshot_id text,
    quoted_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL DEFAULT 'active',
    CONSTRAINT community_purchase_quote_status_check CHECK (status IN ('active', 'bound', 'cancelled', 'expired')),
    CONSTRAINT community_purchase_quote_wallet_check CHECK (buyer_wallet_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT community_purchase_quote_chain_check CHECK (buyer_chain_id = chain_id AND chain_id > 0),
    CONSTRAINT community_purchase_quote_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_quote_treasury_check CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT community_purchase_quote_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_quote_confirmations_check CHECK (required_confirmations > 0),
    CONSTRAINT community_purchase_quote_expiry_check CHECK (expires_at > quoted_at),
    FOREIGN KEY (community_id, policy_version)
      REFERENCES community_commerce_policy_revisions (community_id, policy_version)
);

CREATE TABLE community_purchase_eligibility_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_pricing_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_verification_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text UNIQUE REFERENCES community_purchase_quotes (quote_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    policy_version bigint NOT NULL,
    provider text NOT NULL,
    verified_at timestamp with time zone,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_route_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_allocation_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_settlement_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_purchase_donation_snapshots (
    snapshot_id text PRIMARY KEY,
    quote_id text NOT NULL UNIQUE REFERENCES community_purchase_quotes (quote_id),
    policy_version bigint NOT NULL,
    snapshot jsonb NOT NULL
);

CREATE TABLE community_commerce_operator_ledger (
    event_id text PRIMARY KEY,
    operator_id text NOT NULL REFERENCES users (user_id),
    event_kind text NOT NULL,
    target_identity text NOT NULL,
    reason text NOT NULL,
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT community_commerce_operator_event_check CHECK (
      event_kind IN ('policy_issued', 'correction')
      AND btrim(target_identity) <> '' AND btrim(reason) <> ''
    )
);

CREATE TABLE community_purchase_correction_events (
    event_id text PRIMARY KEY,
    target_identity text NOT NULL,
    kind text NOT NULL,
    operator_id text NOT NULL REFERENCES users (user_id),
    reason text NOT NULL,
    quote_id text REFERENCES community_purchase_quotes (quote_id),
    purchase_id text REFERENCES community_purchase_intents (purchase_id),
    recorded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_correction_target_check CHECK (
      btrim(target_identity) <> '' AND btrim(reason) <> ''
    ),
    CONSTRAINT community_purchase_correction_kind_check CHECK (
      kind IN ('cancel_unbound_quote', 'release_unbound_reservation', 'supersede_policy')
    )
);

CREATE UNIQUE INDEX community_purchase_correction_idempotency
  ON community_purchase_correction_events (target_identity, kind);

CREATE INDEX community_commerce_listing_active_idx
  ON community_commerce_listings (community_id, active, listing_id);
CREATE INDEX community_purchase_quote_actor_status_idx
  ON community_purchase_quotes (actor_id, status, expires_at, quote_id);
