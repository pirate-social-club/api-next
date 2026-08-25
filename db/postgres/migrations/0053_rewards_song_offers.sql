-- Backend-only song rewards and Megapot v2 custody settlement foundation.
--
-- This migration stores private account beneficiaries separately from the
-- public commitment artifact, treats every chain write as a nonce-fenced
-- effect, and keeps confirmed funding, ticket inventory, reward liabilities,
-- refunds, and solvency independently reconcilable.

CREATE FUNCTION reward_distinct_nonempty_text_array(candidate TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT candidate IS NOT NULL
    AND cardinality(candidate) > 0
    AND NOT EXISTS (
      SELECT 1
        FROM unnest(candidate) AS entry(value)
       WHERE value IS NULL OR btrim(value) = '' OR value <> btrim(value)
    )
    AND cardinality(candidate) = (
      SELECT count(DISTINCT value) FROM unnest(candidate) AS entry(value)
    )
$$;

CREATE TABLE reward_asset_whitelist (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 77),
  symbol TEXT NOT NULL CHECK (
    btrim(symbol) <> '' AND symbol = btrim(symbol) AND octet_length(symbol) <= 32
  ),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('settlement_usdc', 'bonus_asset')),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'staging', 'production')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  policy_version TEXT NOT NULL CHECK (
    btrim(policy_version) <> '' AND policy_version = btrim(policy_version)
    AND octet_length(policy_version) <= 128
  ),
  activated_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, token_address),
  CONSTRAINT reward_asset_whitelist_environment_chain CHECK (
    (environment = 'production' AND chain_id = 8453)
    OR (environment IN ('test', 'staging') AND chain_id = 84532)
  ),
  CONSTRAINT reward_asset_whitelist_status_shape CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retired_at >= activated_at)
  )
);

CREATE TABLE megapot_deployment_attestations (
  attestation_id TEXT PRIMARY KEY CHECK (
    btrim(attestation_id) <> '' AND attestation_id = btrim(attestation_id)
    AND octet_length(attestation_id) <= 128
  ),
  environment TEXT NOT NULL CHECK (environment IN ('test', 'staging', 'production')),
  chain_id BIGINT NOT NULL CHECK (chain_id IN (8453, 84532)),
  jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-f]{40}$'),
  usdc_address TEXT NOT NULL CHECK (usdc_address ~ '^0x[0-9a-f]{40}$'),
  ticket_nft_address TEXT NOT NULL CHECK (ticket_nft_address ~ '^0x[0-9a-f]{40}$'),
  custody_address TEXT NOT NULL CHECK (custody_address ~ '^0x[0-9a-f]{40}$'),
  referrer_address TEXT CHECK (
    referrer_address IS NULL OR referrer_address ~ '^0x[0-9a-f]{40}$'
  ),
  source_tag TEXT NOT NULL CHECK (source_tag ~ '^0x[0-9a-f]{64}$'),
  jackpot_code_hash TEXT NOT NULL CHECK (jackpot_code_hash ~ '^0x[0-9a-f]{64}$'),
  usdc_code_hash TEXT NOT NULL CHECK (usdc_code_hash ~ '^0x[0-9a-f]{64}$'),
  ticket_nft_code_hash TEXT NOT NULL CHECK (ticket_nft_code_hash ~ '^0x[0-9a-f]{64}$'),
  attestation_block_number BIGINT NOT NULL CHECK (attestation_block_number >= 0),
  attestation_block_hash TEXT NOT NULL CHECK (attestation_block_hash ~ '^0x[0-9a-f]{64}$'),
  abi_version TEXT NOT NULL CHECK (abi_version = 'megapot_v2'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  verified_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attestation_id, chain_id),
  UNIQUE (attestation_id, chain_id, jackpot_address, usdc_address, custody_address),
  CONSTRAINT megapot_attestation_environment_chain CHECK (
    (environment = 'production' AND chain_id = 8453)
    OR (environment IN ('test', 'staging') AND chain_id = 84532)
  ),
  CONSTRAINT megapot_attestation_status_shape CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL AND retired_at >= verified_at)
  )
);
CREATE UNIQUE INDEX megapot_one_active_attestation_per_environment_uidx
  ON megapot_deployment_attestations (environment) WHERE status = 'active';

CREATE TABLE megapot_drawing_observations (
  observation_id TEXT PRIMARY KEY CHECK (
    btrim(observation_id) <> '' AND observation_id = btrim(observation_id)
    AND octet_length(observation_id) <= 128
  ),
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  chain_id BIGINT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
  ticket_price_atomic NUMERIC(78, 0) NOT NULL CHECK (ticket_price_atomic > 0),
  drawing_time TIMESTAMPTZ NOT NULL,
  ball_max SMALLINT NOT NULL CHECK (ball_max BETWEEN 5 AND 255),
  bonusball_max SMALLINT NOT NULL CHECK (bonusball_max BETWEEN 1 AND 255),
  drawing_locked BOOLEAN NOT NULL,
  referral_fee_wei NUMERIC(78, 0) NOT NULL CHECK (
    referral_fee_wei BETWEEN 0 AND 1000000000000000000
  ),
  referral_win_share_wei NUMERIC(78, 0) NOT NULL CHECK (
    referral_win_share_wei BETWEEN 0 AND 1000000000000000000
  ),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_timestamp TIMESTAMPTZ NOT NULL,
  confirmations INTEGER NOT NULL CHECK (confirmations >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  raw_state_hash TEXT NOT NULL CHECK (raw_state_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attestation_id, drawing_id, block_hash),
  FOREIGN KEY (attestation_id, chain_id)
    REFERENCES megapot_deployment_attestations (attestation_id, chain_id),
  CONSTRAINT megapot_drawing_observation_time_order CHECK (
    observed_at >= block_timestamp AND expires_at > observed_at
  )
);
CREATE INDEX megapot_drawing_observations_latest_idx
  ON megapot_drawing_observations (attestation_id, drawing_id, block_number DESC, observation_id);

CREATE TABLE song_reward_offers (
  offer_id TEXT PRIMARY KEY CHECK (
    btrim(offer_id) <> '' AND offer_id = btrim(offer_id) AND octet_length(offer_id) <= 128
  ),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  created_by_account_id TEXT NOT NULL REFERENCES users (user_id),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'paused', 'exhausted', 'expired', 'ended', 'operational_hold')
  ),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  owner_policy_snapshot JSONB NOT NULL CHECK (jsonb_typeof(owner_policy_snapshot) = 'object'),
  terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  activated_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT song_reward_offer_time_order CHECK (
    ends_at > starts_at AND updated_at >= created_at
    AND (activated_at IS NULL OR activated_at >= created_at)
  ),
  CONSTRAINT song_reward_offer_terminal_shape CHECK (
    (status IN ('draft', 'active', 'paused', 'operational_hold') AND terminal_at IS NULL)
    OR (status IN ('exhausted', 'expired', 'ended') AND terminal_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX song_reward_offers_one_nonterminal_per_post_uidx
  ON song_reward_offers (community_id, post_id)
  WHERE status IN ('draft', 'active', 'paused', 'operational_hold');

CREATE TABLE song_reward_offer_legs (
  leg_id TEXT PRIMARY KEY CHECK (
    btrim(leg_id) <> '' AND leg_id = btrim(leg_id) AND octet_length(leg_id) <= 128
  ),
  offer_id TEXT NOT NULL REFERENCES song_reward_offers (offer_id),
  kind TEXT NOT NULL CHECK (kind IN ('megapot_pool', 'asset_bonus')),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'funding', 'active', 'paused', 'exhausted', 'ended', 'operational_hold')
  ),
  funder_account_id TEXT NOT NULL REFERENCES users (user_id),
  refund_policy TEXT NOT NULL CHECK (refund_policy = 'refund_to_funders_pro_rata'),
  leg_terms_hash TEXT NOT NULL CHECK (leg_terms_hash ~ '^0x[0-9a-f]{64}$'),
  participation_starts_at TIMESTAMPTZ NOT NULL,
  participation_ends_at TIMESTAMPTZ,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 77),
  amount_per_claim_atomic NUMERIC(78, 0),
  max_claims BIGINT,
  tickets_per_drawing SMALLINT,
  max_ticket_price_atomic NUMERIC(78, 0),
  entry_cutoff_seconds INTEGER,
  beneficiary_algorithm_version TEXT,
  ticket_selection_version TEXT,
  attestation_id TEXT,
  participation_starts_drawing_id NUMERIC(78, 0),
  eligible_activities TEXT[],
  min_score_bps INTEGER,
  empty_pool_policy TEXT,
  funding_source TEXT,
  fallback_beneficiary_account_id TEXT,
  fallback_payout_persona_id TEXT,
  referral_allocation_version TEXT,
  referral_policy_hash TEXT,
  referral_disclosed_at TIMESTAMPTZ,
  legal_activation_gate TEXT NOT NULL DEFAULT 'test_only'
    CHECK (legal_activation_gate IN ('test_only', 'production_approved')),
  funded_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (funded_atomic >= 0),
  reserved_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  spent_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (spent_atomic >= 0),
  fulfilled_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (fulfilled_atomic >= 0),
  refunded_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (refunded_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (chain_id, token_address)
    REFERENCES reward_asset_whitelist (chain_id, token_address),
  FOREIGN KEY (fallback_beneficiary_account_id, fallback_payout_persona_id)
    REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (attestation_id, chain_id)
    REFERENCES megapot_deployment_attestations (attestation_id, chain_id),
  CONSTRAINT song_reward_leg_budget_conservation CHECK (
    reserved_atomic + spent_atomic + fulfilled_atomic + refunded_atomic <= funded_atomic
  ),
  CONSTRAINT song_reward_leg_time_order CHECK (
    participation_ends_at IS NULL OR participation_ends_at > participation_starts_at
  ),
  CONSTRAINT song_reward_leg_terminal_shape CHECK (
    (status IN ('draft', 'funding', 'active', 'paused', 'operational_hold')
      AND participation_ends_at IS NULL)
    OR (status IN ('exhausted', 'ended') AND participation_ends_at IS NOT NULL)
  ),
  CONSTRAINT song_reward_leg_kind_shape CHECK (
    (kind = 'asset_bonus'
      AND amount_per_claim_atomic > 0 AND max_claims > 0
      AND tickets_per_drawing IS NULL AND max_ticket_price_atomic IS NULL
      AND entry_cutoff_seconds IS NULL AND beneficiary_algorithm_version IS NULL
      AND ticket_selection_version IS NULL AND attestation_id IS NULL
      AND participation_starts_drawing_id IS NULL AND eligible_activities IS NULL
      AND min_score_bps IS NULL AND empty_pool_policy IS NULL AND funding_source IS NULL
      AND fallback_beneficiary_account_id IS NULL AND fallback_payout_persona_id IS NULL
      AND referral_allocation_version IS NULL AND referral_policy_hash IS NULL
      AND referral_disclosed_at IS NULL AND legal_activation_gate = 'test_only')
    OR
    (kind = 'megapot_pool'
      AND amount_per_claim_atomic IS NULL AND max_claims IS NULL
      AND tickets_per_drawing = 1 AND max_ticket_price_atomic > 0
      AND entry_cutoff_seconds > 0
      AND beneficiary_algorithm_version = 'equal_v1'
      AND ticket_selection_version = 'keccak_packed_v1'
      AND attestation_id IS NOT NULL AND participation_starts_drawing_id >= 0
      AND reward_distinct_nonempty_text_array(eligible_activities)
      AND min_score_bps BETWEEN 7000 AND 10000
      AND empty_pool_policy IN ('no_purchase', 'funder_fallback')
      AND funding_source IN ('leg_budget', 'shared_sponsor_budget'))
  ),
  CONSTRAINT song_reward_pool_fallback_shape CHECK (
    kind <> 'megapot_pool'
    OR (empty_pool_policy = 'no_purchase'
      AND funding_source = 'leg_budget'
      AND fallback_beneficiary_account_id IS NULL
      AND fallback_payout_persona_id IS NULL
      AND referral_allocation_version IS NULL
      AND referral_policy_hash IS NULL
      AND referral_disclosed_at IS NULL)
    OR (empty_pool_policy = 'funder_fallback'
      AND fallback_beneficiary_account_id IS NOT NULL
      AND ((funding_source = 'leg_budget'
          AND fallback_beneficiary_account_id = funder_account_id
          AND fallback_payout_persona_id IS NOT NULL
          AND min_score_bps = 7000
          AND referral_allocation_version IS NOT NULL
          AND btrim(referral_allocation_version) <> ''
          AND referral_policy_hash ~ '^[0-9a-f]{64}$'
          AND referral_disclosed_at IS NOT NULL)
        OR (funding_source = 'shared_sponsor_budget'
          AND fallback_payout_persona_id IS NULL
          AND funded_atomic = 0 AND reserved_atomic = 0 AND spent_atomic = 0
          AND fulfilled_atomic = 0 AND refunded_atomic = 0)))
  )
);
CREATE UNIQUE INDEX song_reward_offer_one_open_pool_leg_uidx
  ON song_reward_offer_legs (offer_id)
  WHERE kind = 'megapot_pool' AND participation_ends_at IS NULL;
CREATE INDEX song_reward_offer_legs_active_idx
  ON song_reward_offer_legs (offer_id, status, kind, leg_id);

CREATE TABLE reward_eligibility_decisions (
  eligibility_decision_id TEXT PRIMARY KEY CHECK (
    btrim(eligibility_decision_id) <> '' AND eligibility_decision_id = btrim(eligibility_decision_id)
    AND octet_length(eligibility_decision_id) <= 128
  ),
  leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN ('pool_share', 'asset_claim', 'fallback_activation', 'fallback_cutoff')
  ),
  qualification_id TEXT REFERENCES activity_qualifications (qualification_id),
  drawing_id NUMERIC(78, 0),
  decision_record_id TEXT REFERENCES decision_records (decision_record_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('eligible', 'ineligible')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'verification_missing', 'verification_stale', 'verification_failed',
    'subject_already_consumed', 'age_ineligible', 'geography_ineligible',
    'disclosure_unacknowledged', 'fallback_unavailable', 'fallback_ceiling'
  )),
  policy_version TEXT NOT NULL CHECK (btrim(policy_version) <> ''),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  decided_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  CONSTRAINT reward_eligibility_decision_shape CHECK (
    expires_at > decided_at
    AND ((outcome = 'eligible' AND reason IS NULL)
      OR (outcome = 'ineligible' AND reason IS NOT NULL))
    AND ((purpose IN ('pool_share', 'asset_claim') AND qualification_id IS NOT NULL)
      OR (purpose IN ('fallback_activation', 'fallback_cutoff') AND qualification_id IS NULL))
    AND ((purpose IN ('pool_share', 'fallback_cutoff') AND drawing_id IS NOT NULL)
      OR (purpose IN ('asset_claim', 'fallback_activation') AND drawing_id IS NULL))
  )
);
CREATE INDEX reward_eligibility_decisions_lookup_idx
  ON reward_eligibility_decisions (leg_id, account_id, purpose, drawing_id, decided_at DESC);

CREATE TABLE reward_activity_availability_observations (
  availability_observation_id TEXT PRIMARY KEY CHECK (
    btrim(availability_observation_id) <> ''
    AND availability_observation_id = btrim(availability_observation_id)
    AND octet_length(availability_observation_id) <= 128
  ),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  activity_key TEXT NOT NULL REFERENCES activity_registry (activity_key),
  producer_id TEXT NOT NULL CHECK (btrim(producer_id) <> ''),
  producer_revision TEXT NOT NULL CHECK (btrim(producer_revision) <> ''),
  state TEXT NOT NULL CHECK (state IN ('available', 'unavailable')),
  study_item_count INTEGER,
  karaoke_revision_id TEXT,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  UNIQUE (community_id, post_id, audio_revision, activity_key, evidence_hash),
  CONSTRAINT reward_activity_availability_shape CHECK (
    expires_at > observed_at
    AND ((activity_key = 'study'
        AND ((state = 'available' AND study_item_count > 0)
          OR (state = 'unavailable' AND (study_item_count IS NULL OR study_item_count = 0)))
        AND karaoke_revision_id IS NULL)
      OR (activity_key = 'karaoke'
        AND study_item_count IS NULL
        AND ((state = 'available' AND btrim(karaoke_revision_id) <> '')
          OR (state = 'unavailable' AND karaoke_revision_id IS NULL)))
      OR (activity_key NOT IN ('study', 'karaoke')
        AND state = 'unavailable' AND study_item_count IS NULL
        AND karaoke_revision_id IS NULL))
  )
);
CREATE INDEX reward_activity_availability_latest_idx
  ON reward_activity_availability_observations (
    community_id, post_id, audio_revision, activity_key, observed_at DESC,
    availability_observation_id
  );

CREATE TABLE song_reward_leg_funding_effects (
  funding_effect_id TEXT PRIMARY KEY CHECK (
    btrim(funding_effect_id) <> '' AND funding_effect_id = btrim(funding_effect_id)
    AND octet_length(funding_effect_id) <= 128
  ),
  leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  funder_account_id TEXT NOT NULL REFERENCES users (user_id),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  sender_address TEXT NOT NULL CHECK (sender_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  expected_amount_atomic NUMERIC(78, 0) NOT NULL CHECK (expected_amount_atomic > 0),
  confirmed_amount_atomic NUMERIC(78, 0) CHECK (confirmed_amount_atomic > 0),
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations > 0),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'confirming', 'confirmed', 'reverted', 'reclaimable_failed',
    'reconciliation_required'
  )),
  transaction_hash TEXT CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  log_index INTEGER CHECK (log_index IS NULL OR log_index >= 0),
  block_number BIGINT CHECK (block_number IS NULL OR block_number >= 0),
  block_hash TEXT CHECK (block_hash IS NULL OR block_hash ~ '^0x[0-9a-f]{64}$'),
  observation_hash TEXT CHECK (
    observation_hash IS NULL OR observation_hash ~ '^[0-9a-f]{64}$'
  ),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  confirmed_at TIMESTAMPTZ,
  FOREIGN KEY (chain_id, token_address)
    REFERENCES reward_asset_whitelist (chain_id, token_address),
  CONSTRAINT song_reward_funding_state_shape CHECK (
    (state IN ('planned', 'confirming')
      AND confirmed_amount_atomic IS NULL AND block_number IS NULL
      AND block_hash IS NULL AND observation_hash IS NULL AND confirmed_at IS NULL
      AND failure_reason IS NULL)
    OR (state = 'confirmed'
      AND confirmed_amount_atomic = expected_amount_atomic
      AND transaction_hash IS NOT NULL AND log_index IS NOT NULL
      AND block_number IS NOT NULL AND block_hash IS NOT NULL
      AND observation_hash IS NOT NULL AND confirmed_at IS NOT NULL
      AND failure_reason IS NULL)
    OR (state = 'reverted'
      AND transaction_hash IS NOT NULL AND confirmed_amount_atomic IS NULL
      AND log_index IS NULL AND block_number IS NOT NULL AND block_hash IS NOT NULL
      AND observation_hash IS NOT NULL AND confirmed_at IS NULL
      AND failure_reason IS NULL)
    OR (state IN ('reclaimable_failed', 'reconciliation_required')
      AND confirmed_amount_atomic IS NULL AND confirmed_at IS NULL
      AND btrim(failure_reason) <> '')
  ),
  CONSTRAINT song_reward_funding_time_order CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX song_reward_funding_transaction_log_uidx
  ON song_reward_leg_funding_effects (chain_id, transaction_hash, log_index)
  WHERE transaction_hash IS NOT NULL AND log_index IS NOT NULL;

CREATE TABLE sponsor_daily_ticket_totals (
  sponsor_account_id TEXT NOT NULL REFERENCES users (user_id),
  sponsor_day DATE NOT NULL,
  sponsor_kind TEXT NOT NULL CHECK (sponsor_kind IN ('shared_platform', 'external_fallback')),
  ticket_ceiling INTEGER NOT NULL CHECK (ticket_ceiling > 0),
  spend_ceiling_atomic NUMERIC(78, 0) NOT NULL CHECK (spend_ceiling_atomic > 0),
  reserved_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_ticket_count >= 0),
  confirmed_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_ticket_count >= 0),
  released_ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (released_ticket_count >= 0),
  reserved_spend_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_spend_atomic >= 0),
  confirmed_spend_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (confirmed_spend_atomic >= 0),
  released_spend_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (released_spend_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sponsor_account_id, sponsor_day, sponsor_kind),
  CONSTRAINT sponsor_daily_ticket_conservation CHECK (
    released_ticket_count <= reserved_ticket_count
    AND confirmed_ticket_count + reserved_ticket_count - released_ticket_count <= ticket_ceiling
    AND released_spend_atomic <= reserved_spend_atomic
    AND confirmed_spend_atomic + reserved_spend_atomic - released_spend_atomic <= spend_ceiling_atomic
  ),
  CONSTRAINT sponsor_daily_ticket_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE megapot_pool_drawings (
  pool_leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
  observation_id TEXT NOT NULL REFERENCES megapot_drawing_observations (observation_id),
  status TEXT NOT NULL CHECK (status IN (
    'entry_open', 'cutoff_frozen', 'committed', 'purchase_pending',
    'tickets_confirmed', 'drawing_pending', 'no_win', 'winnings_detected',
    'claim_pending', 'claimed', 'allocated', 'credited', 'closed_no_entries',
    'closed_unfunded', 'closed_fallback_ineligible',
    'closed_fallback_unavailable', 'closed_fallback_ceiling', 'operational_hold'
  )),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  entry_cutoff_at TIMESTAMPTZ NOT NULL,
  ticket_price_ceiling_atomic NUMERIC(78, 0) NOT NULL CHECK (ticket_price_ceiling_atomic > 0),
  reserved_ticket_cost_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0
    CHECK (reserved_ticket_cost_atomic >= 0),
  actual_ticket_cost_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0
    CHECK (actual_ticket_cost_atomic >= 0),
  gross_winnings_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (gross_winnings_atomic >= 0),
  net_winnings_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (net_winnings_atomic >= 0),
  frozen_share_count INTEGER,
  fallback_beneficiary BOOLEAN,
  snapshot_id TEXT,
  commitment_effect_id TEXT,
  purchase_effect_id TEXT,
  claim_effect_id TEXT,
  allocation_batch_id TEXT,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  cutoff_frozen_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  PRIMARY KEY (pool_leg_id, drawing_id),
  UNIQUE (pool_leg_id, drawing_id, observation_id),
  CONSTRAINT megapot_pool_drawing_reservation CHECK (
    actual_ticket_cost_atomic <= reserved_ticket_cost_atomic
    AND reserved_ticket_cost_atomic <= ticket_price_ceiling_atomic
    AND net_winnings_atomic <= gross_winnings_atomic
  ),
  CONSTRAINT megapot_pool_drawing_purchase_amount_shape CHECK (
    status = 'operational_hold'
    OR (status IN ('entry_open', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling')
      AND reserved_ticket_cost_atomic = 0 AND actual_ticket_cost_atomic = 0)
    OR (status IN ('cutoff_frozen', 'committed', 'purchase_pending')
      AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic = 0)
    OR (status IN ('tickets_confirmed', 'drawing_pending', 'no_win',
        'winnings_detected', 'claim_pending', 'claimed', 'allocated', 'credited')
      AND reserved_ticket_cost_atomic > 0 AND actual_ticket_cost_atomic > 0)
  ),
  CONSTRAINT megapot_pool_drawing_freeze_shape CHECK (
    (status = 'entry_open' AND frozen_share_count IS NULL
      AND fallback_beneficiary IS NULL AND snapshot_id IS NULL
      AND cutoff_frozen_at IS NULL)
    OR status = 'operational_hold'
    OR (status NOT IN ('entry_open', 'operational_hold') AND frozen_share_count IS NOT NULL
      AND frozen_share_count >= 0 AND fallback_beneficiary IS NOT NULL
      AND cutoff_frozen_at IS NOT NULL)
  ),
  CONSTRAINT megapot_pool_drawing_snapshot_shape CHECK (
    status = 'operational_hold'
    OR
    (status IN ('entry_open', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling') AND snapshot_id IS NULL)
    OR (status IN ('cutoff_frozen', 'committed', 'purchase_pending',
        'tickets_confirmed', 'drawing_pending', 'no_win', 'winnings_detected',
        'claim_pending', 'claimed', 'allocated', 'credited') AND snapshot_id IS NOT NULL)
  ),
  CONSTRAINT megapot_pool_drawing_effect_shape CHECK (
    status = 'operational_hold'
    OR
    (status IN ('entry_open', 'cutoff_frozen', 'closed_no_entries', 'closed_unfunded',
        'closed_fallback_ineligible', 'closed_fallback_unavailable',
        'closed_fallback_ceiling') AND commitment_effect_id IS NULL
      AND purchase_effect_id IS NULL AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
    OR (status = 'committed' AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NULL AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
    OR (status IN ('purchase_pending', 'tickets_confirmed', 'drawing_pending', 'no_win',
        'winnings_detected') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NULL AND allocation_batch_id IS NULL)
    OR (status IN ('claim_pending', 'claimed') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NOT NULL
      AND allocation_batch_id IS NULL)
    OR (status IN ('allocated', 'credited') AND commitment_effect_id IS NOT NULL
      AND purchase_effect_id IS NOT NULL AND claim_effect_id IS NOT NULL
      AND allocation_batch_id IS NOT NULL)
  ),
  CONSTRAINT megapot_pool_drawing_terminal_shape CHECK (
    (status IN ('no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'operational_hold')
      AND terminal_at IS NOT NULL)
    OR (status NOT IN ('no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'operational_hold')
      AND terminal_at IS NULL)
  ),
  CONSTRAINT megapot_pool_drawing_time_order CHECK (
    updated_at >= created_at
    AND (cutoff_frozen_at IS NULL OR cutoff_frozen_at >= created_at)
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  )
);
CREATE INDEX megapot_pool_drawings_work_idx
  ON megapot_pool_drawings (status, entry_cutoff_at, pool_leg_id, drawing_id);

CREATE TABLE megapot_fallback_cutoff_evidence (
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  sponsor_account_id TEXT NOT NULL REFERENCES users (user_id),
  payout_persona_id TEXT,
  eligibility_decision_id TEXT NOT NULL
    REFERENCES reward_eligibility_decisions (eligibility_decision_id),
  sponsor_day DATE NOT NULL,
  sponsor_kind TEXT NOT NULL CHECK (sponsor_kind IN ('shared_platform', 'external_fallback')),
  public_discovery_evidence_hash TEXT NOT NULL CHECK (
    public_discovery_evidence_hash ~ '^[0-9a-f]{64}$'
  ),
  availability_set_hash TEXT NOT NULL CHECK (availability_set_hash ~ '^[0-9a-f]{64}$'),
  checked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pool_leg_id, drawing_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  FOREIGN KEY (sponsor_account_id, payout_persona_id)
    REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (sponsor_account_id, sponsor_day, sponsor_kind)
    REFERENCES sponsor_daily_ticket_totals (sponsor_account_id, sponsor_day, sponsor_kind),
  CONSTRAINT megapot_fallback_cutoff_persona_shape CHECK (
    (sponsor_kind = 'external_fallback' AND payout_persona_id IS NOT NULL)
    OR (sponsor_kind = 'shared_platform' AND payout_persona_id IS NULL)
  )
);

CREATE TABLE megapot_fallback_cutoff_activity_evidence (
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  activity_key TEXT NOT NULL REFERENCES activity_registry (activity_key),
  availability_observation_id TEXT NOT NULL UNIQUE
    REFERENCES reward_activity_availability_observations (availability_observation_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pool_leg_id, drawing_id, activity_key),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_fallback_cutoff_evidence (pool_leg_id, drawing_id)
);

CREATE TABLE megapot_pool_shares (
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  qualification_id TEXT NOT NULL REFERENCES activity_qualifications (qualification_id),
  eligibility_decision_id TEXT NOT NULL
    REFERENCES reward_eligibility_decisions (eligibility_decision_id),
  qualified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, pool_leg_id, drawing_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  UNIQUE (pool_leg_id, drawing_id, qualification_id)
);
CREATE INDEX megapot_pool_shares_drawing_idx
  ON megapot_pool_shares (pool_leg_id, drawing_id, account_id);

CREATE TABLE megapot_pool_beneficiary_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (
    btrim(snapshot_id) <> '' AND snapshot_id = btrim(snapshot_id)
    AND octet_length(snapshot_id) <= 128
  ),
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  domain TEXT NOT NULL CHECK (domain = 'pirate.megapot-pool-beneficiary-snapshot.v2'),
  terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^0x[0-9a-f]{64}$'),
  algorithm_version TEXT NOT NULL CHECK (algorithm_version = 'equal_v1'),
  fallback BOOLEAN NOT NULL,
  leaf_count INTEGER NOT NULL CHECK (leaf_count > 0),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  published_artifact JSONB NOT NULL CHECK (jsonb_typeof(published_artifact) = 'object'),
  frozen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (pool_leg_id, drawing_id),
  UNIQUE (snapshot_hash),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE megapot_pool_snapshot_private_leaves (
  snapshot_id TEXT NOT NULL REFERENCES megapot_pool_beneficiary_snapshots (snapshot_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  order_key TEXT NOT NULL CHECK (order_key ~ '^0x[0-9a-f]{64}$'),
  leaf_commitment TEXT NOT NULL CHECK (leaf_commitment ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, account_id),
  UNIQUE (snapshot_id, order_key),
  UNIQUE (snapshot_id, leaf_commitment),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id)
);

CREATE TABLE megapot_pool_commitment_effects (
  commitment_effect_id TEXT PRIMARY KEY CHECK (
    btrim(commitment_effect_id) <> '' AND commitment_effect_id = btrim(commitment_effect_id)
    AND octet_length(commitment_effect_id) <= 128
  ),
  snapshot_id TEXT NOT NULL UNIQUE
    REFERENCES megapot_pool_beneficiary_snapshots (snapshot_id),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  signing_key_id TEXT NOT NULL CHECK (btrim(signing_key_id) <> ''),
  signature TEXT NOT NULL CHECK (btrim(signature) <> ''),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'published')),
  prepared_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  public_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT megapot_commitment_effect_shape CHECK (
    (state = 'prepared' AND published_at IS NULL AND public_reference IS NULL)
    OR (state = 'published' AND published_at IS NOT NULL
      AND btrim(public_reference) <> '' AND published_at >= prepared_at)
  )
);

CREATE TABLE reward_signer_nonces (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  next_nonce NUMERIC(78, 0) NOT NULL CHECK (next_nonce >= 0),
  fence_version BIGINT NOT NULL DEFAULT 1 CHECK (fence_version > 0),
  observed_pending_nonce NUMERIC(78, 0) NOT NULL CHECK (observed_pending_nonce >= 0),
  observed_block_number BIGINT NOT NULL CHECK (observed_block_number >= 0),
  observed_block_hash TEXT NOT NULL CHECK (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id, signer_address),
  CONSTRAINT reward_signer_nonce_floor CHECK (next_nonce >= observed_pending_nonce)
);

CREATE TABLE reward_chain_effects (
  effect_id TEXT PRIMARY KEY CHECK (
    btrim(effect_id) <> '' AND effect_id = btrim(effect_id) AND octet_length(effect_id) <= 128
  ),
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'usdc_approval', 'ticket_purchase', 'winnings_claim', 'reward_payout',
    'reward_refund', 'sponsor_withdrawal'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'nonce_reserved', 'prepared', 'broadcast_pending', 'confirming',
    'confirmed', 'reverted', 'replaced', 'reclaimable_failed',
    'reconciliation_required', 'terminal_failed'
  )),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  target_address TEXT NOT NULL CHECK (target_address ~ '^0x[0-9a-f]{40}$'),
  value_wei NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (value_wei >= 0),
  reserved_amount_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_amount_atomic >= 0),
  settled_amount_atomic NUMERIC(78, 0) CHECK (settled_amount_atomic >= 0),
  nonce NUMERIC(78, 0),
  calldata TEXT,
  calldata_hash TEXT,
  signed_transaction TEXT,
  signed_transaction_hash TEXT,
  transaction_hash TEXT,
  replacement_of_effect_id TEXT REFERENCES reward_chain_effects (effect_id),
  replaced_by_effect_id TEXT REFERENCES reward_chain_effects (effect_id),
  receipt_status TEXT CHECK (receipt_status IS NULL OR receipt_status IN ('success', 'reverted')),
  receipt_block_number BIGINT CHECK (receipt_block_number IS NULL OR receipt_block_number >= 0),
  receipt_block_hash TEXT CHECK (
    receipt_block_hash IS NULL OR receipt_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  receipt_hash TEXT CHECK (receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'),
  confirmations INTEGER CHECK (confirmations IS NULL OR confirmations >= 0),
  failure_class TEXT,
  failure_reason TEXT,
  lease_owner TEXT,
  lease_fence_token BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence_token >= 0),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  prepared_at TIMESTAMPTZ,
  broadcast_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (chain_id, signer_address)
    REFERENCES reward_signer_nonces (chain_id, signer_address),
  CONSTRAINT reward_chain_effect_prepared_shape CHECK (
    (state = 'planned' AND nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
      AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
      AND transaction_hash IS NULL AND prepared_at IS NULL)
    OR (state = 'nonce_reserved' AND nonce IS NOT NULL AND calldata IS NULL
      AND calldata_hash IS NULL AND signed_transaction IS NULL
      AND signed_transaction_hash IS NULL AND transaction_hash IS NULL
      AND prepared_at IS NULL)
    OR (state IN ('prepared', 'broadcast_pending', 'confirming', 'confirmed', 'reverted',
        'replaced', 'reconciliation_required')
      AND nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
      AND calldata_hash ~ '^[0-9a-f]{64}$'
      AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
      AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
      AND prepared_at IS NOT NULL)
    OR (state IN ('reclaimable_failed', 'terminal_failed')
      AND ((nonce IS NULL AND calldata IS NULL AND calldata_hash IS NULL
          AND signed_transaction IS NULL AND signed_transaction_hash IS NULL
          AND prepared_at IS NULL)
        OR (nonce IS NOT NULL AND calldata ~ '^0x([0-9a-f]{2})*$'
          AND calldata_hash ~ '^[0-9a-f]{64}$'
          AND signed_transaction ~ '^0x([0-9a-f]{2})+$'
          AND signed_transaction_hash ~ '^0x[0-9a-f]{64}$'
          AND prepared_at IS NOT NULL)))
  ),
  CONSTRAINT reward_chain_effect_transaction_shape CHECK (
    (state IN ('planned', 'nonce_reserved', 'prepared', 'reclaimable_failed', 'terminal_failed')
      AND transaction_hash IS NULL AND broadcast_at IS NULL)
    OR (state IN ('broadcast_pending', 'confirming', 'confirmed', 'reverted', 'replaced',
        'reconciliation_required')
      AND transaction_hash ~ '^0x[0-9a-f]{64}$' AND broadcast_at IS NOT NULL)
  ),
  CONSTRAINT reward_chain_effect_receipt_shape CHECK (
    (state NOT IN ('confirmed', 'reverted') AND receipt_status IS NULL
      AND receipt_block_number IS NULL AND receipt_block_hash IS NULL
      AND receipt_hash IS NULL AND confirmations IS NULL AND confirmed_at IS NULL)
    OR (state = 'confirmed' AND receipt_status = 'success'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NOT NULL)
    OR (state = 'reverted' AND receipt_status = 'reverted'
      AND receipt_block_number IS NOT NULL AND receipt_block_hash IS NOT NULL
      AND receipt_hash IS NOT NULL AND confirmations IS NOT NULL AND confirmed_at IS NOT NULL
      AND settled_amount_atomic IS NULL)
  ),
  CONSTRAINT reward_chain_effect_failure_shape CHECK (
    (state NOT IN ('reclaimable_failed', 'reconciliation_required', 'terminal_failed')
      AND failure_class IS NULL AND failure_reason IS NULL)
    OR (state IN ('reclaimable_failed', 'reconciliation_required', 'terminal_failed')
      AND btrim(failure_class) <> '' AND btrim(failure_reason) <> '')
  ),
  CONSTRAINT reward_chain_effect_replacement_shape CHECK (
    (state = 'replaced' AND replaced_by_effect_id IS NOT NULL)
    OR (state <> 'replaced')
  ),
  CONSTRAINT reward_chain_effect_lease_shape CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT reward_chain_effect_time_order CHECK (
    updated_at >= created_at
    AND (prepared_at IS NULL OR prepared_at >= created_at)
    AND (broadcast_at IS NULL OR broadcast_at >= prepared_at)
    AND (confirmed_at IS NULL OR confirmed_at >= broadcast_at)
  )
);
CREATE UNIQUE INDEX reward_chain_effect_nonce_uidx
  ON reward_chain_effects (chain_id, signer_address, nonce)
  WHERE nonce IS NOT NULL AND state <> 'replaced';
CREATE UNIQUE INDEX reward_chain_effect_signed_hash_uidx
  ON reward_chain_effects (chain_id, signed_transaction_hash)
  WHERE signed_transaction_hash IS NOT NULL;
CREATE UNIQUE INDEX reward_chain_effect_transaction_hash_uidx
  ON reward_chain_effects (chain_id, transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE INDEX reward_chain_effect_work_idx
  ON reward_chain_effects (state, lease_expires_at, updated_at, effect_id);

CREATE TABLE reward_chain_effect_transitions (
  effect_id TEXT NOT NULL REFERENCES reward_chain_effects (effect_id),
  target_version BIGINT NOT NULL CHECK (target_version > 1),
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (effect_id, target_version)
);

CREATE TABLE megapot_usdc_approval_effects (
  approval_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  spender_address TEXT NOT NULL CHECK (spender_address ~ '^0x[0-9a-f]{40}$'),
  allowance_before_atomic NUMERIC(78, 0) NOT NULL CHECK (allowance_before_atomic >= 0),
  minimum_allowance_atomic NUMERIC(78, 0) NOT NULL CHECK (minimum_allowance_atomic > 0),
  approved_amount_atomic NUMERIC(78, 0) NOT NULL CHECK (
    approved_amount_atomic >= minimum_allowance_atomic
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE megapot_usdc_approval_receipt_evidence (
  approval_effect_id TEXT PRIMARY KEY
    REFERENCES megapot_usdc_approval_effects (approval_effect_id),
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  approval_log_index INTEGER NOT NULL CHECK (approval_log_index >= 0),
  approved_amount_atomic NUMERIC(78, 0) NOT NULL CHECK (approved_amount_atomic > 0),
  allowance_after_atomic NUMERIC(78, 0) NOT NULL CHECK (allowance_after_atomic >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attestation_id, transaction_hash, approval_log_index),
  CONSTRAINT megapot_usdc_approval_receipt_allowance CHECK (
    allowance_after_atomic >= approved_amount_atomic
  )
);

CREATE TABLE megapot_ticket_purchase_effects (
  purchase_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  drawing_observation_id TEXT NOT NULL REFERENCES megapot_drawing_observations (observation_id),
  snapshot_id TEXT NOT NULL REFERENCES megapot_pool_beneficiary_snapshots (snapshot_id),
  commitment_effect_id TEXT NOT NULL REFERENCES megapot_pool_commitment_effects (commitment_effect_id),
  source_tag TEXT NOT NULL CHECK (source_tag ~ '^0x[0-9a-f]{64}$'),
  recipient_address TEXT NOT NULL CHECK (recipient_address ~ '^0x[0-9a-f]{40}$'),
  ticket_price_atomic NUMERIC(78, 0) NOT NULL CHECK (ticket_price_atomic > 0),
  normal_one SMALLINT NOT NULL,
  normal_two SMALLINT NOT NULL,
  normal_three SMALLINT NOT NULL,
  normal_four SMALLINT NOT NULL,
  normal_five SMALLINT NOT NULL,
  bonusball SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (pool_leg_id, drawing_id),
  FOREIGN KEY (pool_leg_id, drawing_id, drawing_observation_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id, observation_id),
  CONSTRAINT megapot_purchase_ticket_numbers CHECK (
    normal_one >= 1 AND normal_one < normal_two AND normal_two < normal_three
    AND normal_three < normal_four AND normal_four < normal_five
    AND bonusball >= 1
  )
);

CREATE TABLE megapot_ticket_inventory (
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  ticket_id NUMERIC(78, 0) NOT NULL CHECK (ticket_id >= 0),
  purchase_effect_id TEXT NOT NULL UNIQUE
    REFERENCES megapot_ticket_purchase_effects (purchase_effect_id),
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  custody_address TEXT NOT NULL CHECK (custody_address ~ '^0x[0-9a-f]{40}$'),
  owner_observation_block_number BIGINT NOT NULL CHECK (owner_observation_block_number >= 0),
  owner_observation_block_hash TEXT NOT NULL CHECK (
    owner_observation_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  minted_transaction_hash TEXT NOT NULL CHECK (minted_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  minted_log_index INTEGER NOT NULL CHECK (minted_log_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('custodied', 'claim_pending', 'claimed', 'no_win')),
  claimed_transaction_hash TEXT CHECK (
    claimed_transaction_hash IS NULL OR claimed_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  acquired_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (attestation_id, ticket_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  UNIQUE (attestation_id, minted_transaction_hash, minted_log_index),
  CONSTRAINT megapot_ticket_inventory_terminal_shape CHECK (
    (status IN ('custodied', 'claim_pending')
      AND claimed_transaction_hash IS NULL AND terminal_at IS NULL)
    OR (status = 'claimed' AND claimed_transaction_hash IS NOT NULL AND terminal_at IS NOT NULL)
    OR (status = 'no_win' AND claimed_transaction_hash IS NULL AND terminal_at IS NOT NULL)
  )
);
CREATE INDEX megapot_ticket_inventory_work_idx
  ON megapot_ticket_inventory (status, drawing_id, attestation_id, ticket_id);

CREATE TABLE megapot_purchase_receipt_evidence (
  purchase_effect_id TEXT PRIMARY KEY
    REFERENCES megapot_ticket_purchase_effects (purchase_effect_id),
  attestation_id TEXT NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  purchase_log_index INTEGER NOT NULL CHECK (purchase_log_index >= 0),
  mint_log_index INTEGER NOT NULL CHECK (mint_log_index >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  referral_fees_atomic NUMERIC(78, 0) NOT NULL CHECK (referral_fees_atomic >= 0),
  lp_earnings_atomic NUMERIC(78, 0) NOT NULL CHECK (lp_earnings_atomic >= 0),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  UNIQUE (attestation_id, transaction_hash, purchase_log_index),
  UNIQUE (attestation_id, transaction_hash, mint_log_index),
  CONSTRAINT megapot_purchase_receipt_distinct_logs CHECK (
    purchase_log_index <> mint_log_index
  )
);

CREATE TABLE megapot_drawing_sweeps (
  sweep_id TEXT PRIMARY KEY CHECK (
    btrim(sweep_id) <> '' AND sweep_id = btrim(sweep_id) AND octet_length(sweep_id) <= 128
  ),
  pool_leg_id TEXT NOT NULL,
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  drawing_id NUMERIC(78, 0) NOT NULL CHECK (drawing_id >= 0),
  observation_block_number BIGINT NOT NULL CHECK (observation_block_number >= 0),
  observation_block_hash TEXT NOT NULL CHECK (observation_block_hash ~ '^0x[0-9a-f]{64}$'),
  drawing_state_hash TEXT NOT NULL CHECK (drawing_state_hash ~ '^[0-9a-f]{64}$'),
  ticket_count INTEGER NOT NULL CHECK (ticket_count >= 0),
  winning_ticket_count INTEGER NOT NULL CHECK (
    winning_ticket_count >= 0 AND winning_ticket_count <= ticket_count
  ),
  state TEXT NOT NULL CHECK (state IN ('observed', 'reconciliation_required', 'complete')),
  observed_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  UNIQUE (pool_leg_id, drawing_id),
  UNIQUE (attestation_id, drawing_id, observation_block_hash, pool_leg_id),
  CONSTRAINT megapot_drawing_sweep_shape CHECK (
    (state IN ('observed', 'reconciliation_required') AND completed_at IS NULL)
    OR (state = 'complete' AND completed_at IS NOT NULL AND completed_at >= observed_at)
  )
);

CREATE TABLE megapot_sweep_ticket_evidence (
  sweep_id TEXT NOT NULL REFERENCES megapot_drawing_sweeps (sweep_id),
  attestation_id TEXT NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  tier_id SMALLINT NOT NULL CHECK (tier_id BETWEEN 0 AND 11),
  custody_owner_address TEXT NOT NULL CHECK (
    custody_owner_address ~ '^0x[0-9a-f]{40}$'
  ),
  gross_winnings_atomic NUMERIC(78, 0) NOT NULL CHECK (gross_winnings_atomic >= 0),
  referral_win_share_atomic NUMERIC(78, 0) NOT NULL CHECK (
    referral_win_share_atomic BETWEEN 0 AND 1000000000000000000
  ),
  referral_accrual_atomic NUMERIC(78, 0) NOT NULL CHECK (
    referral_accrual_atomic >= 0
  ),
  net_winnings_atomic NUMERIC(78, 0) NOT NULL CHECK (net_winnings_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sweep_id, ticket_id),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  CONSTRAINT megapot_sweep_ticket_conservation CHECK (
    gross_winnings_atomic = net_winnings_atomic + referral_accrual_atomic
    AND referral_accrual_atomic =
      trunc(gross_winnings_atomic * referral_win_share_atomic / 1000000000000000000)
    AND ((tier_id IN (0, 2) AND gross_winnings_atomic = 0)
      OR (tier_id NOT IN (0, 2) AND gross_winnings_atomic > 0))
  )
);

CREATE TABLE megapot_claim_effects (
  claim_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  attestation_id TEXT NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  sweep_id TEXT NOT NULL REFERENCES megapot_drawing_sweeps (sweep_id),
  expected_gross_winnings_atomic NUMERIC(78, 0) NOT NULL
    CHECK (expected_gross_winnings_atomic > 0),
  expected_net_winnings_atomic NUMERIC(78, 0) NOT NULL
    CHECK (expected_net_winnings_atomic > 0),
  expected_referral_accrual_atomic NUMERIC(78, 0) NOT NULL
    CHECK (expected_referral_accrual_atomic >= 0),
  custody_balance_before_atomic NUMERIC(78, 0) NOT NULL
    CHECK (custody_balance_before_atomic >= 0),
  referral_balance_before_atomic NUMERIC(78, 0) NOT NULL
    CHECK (referral_balance_before_atomic >= 0),
  preflight_block_number BIGINT NOT NULL CHECK (preflight_block_number >= 0),
  preflight_block_hash TEXT NOT NULL CHECK (preflight_block_hash ~ '^0x[0-9a-f]{64}$'),
  received_atomic NUMERIC(78, 0) CHECK (received_atomic >= 0),
  referral_accrual_atomic NUMERIC(78, 0) CHECK (referral_accrual_atomic >= 0),
  claim_log_index INTEGER CHECK (claim_log_index IS NULL OR claim_log_index >= 0),
  burn_log_index INTEGER CHECK (burn_log_index IS NULL OR burn_log_index >= 0),
  referral_log_index INTEGER CHECK (referral_log_index IS NULL OR referral_log_index >= 0),
  transfer_log_index INTEGER CHECK (transfer_log_index IS NULL OR transfer_log_index >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  UNIQUE (attestation_id, ticket_id),
  CONSTRAINT megapot_claim_expected_order CHECK (
    expected_gross_winnings_atomic =
      expected_net_winnings_atomic + expected_referral_accrual_atomic
    AND ((received_atomic IS NULL AND referral_accrual_atomic IS NULL
      AND claim_log_index IS NULL AND burn_log_index IS NULL
      AND referral_log_index IS NULL AND transfer_log_index IS NULL)
      OR (received_atomic = expected_net_winnings_atomic
        AND referral_accrual_atomic = expected_referral_accrual_atomic
        AND claim_log_index IS NOT NULL AND burn_log_index IS NOT NULL
        AND referral_log_index IS NOT NULL AND transfer_log_index IS NOT NULL))
  )
);

CREATE TABLE megapot_claim_receipt_evidence (
  claim_effect_id TEXT PRIMARY KEY REFERENCES megapot_claim_effects (claim_effect_id),
  attestation_id TEXT NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  claim_log_index INTEGER NOT NULL CHECK (claim_log_index >= 0),
  burn_log_index INTEGER NOT NULL CHECK (burn_log_index >= 0),
  referral_log_index INTEGER NOT NULL CHECK (referral_log_index >= 0),
  transfer_log_index INTEGER NOT NULL CHECK (transfer_log_index >= 0),
  gross_winnings_atomic NUMERIC(78, 0) NOT NULL CHECK (gross_winnings_atomic > 0),
  referral_accrual_atomic NUMERIC(78, 0) NOT NULL CHECK (referral_accrual_atomic >= 0),
  net_winnings_atomic NUMERIC(78, 0) NOT NULL CHECK (net_winnings_atomic > 0),
  custody_balance_before_atomic NUMERIC(78, 0) NOT NULL
    CHECK (custody_balance_before_atomic >= 0),
  custody_balance_after_atomic NUMERIC(78, 0) NOT NULL
    CHECK (custody_balance_after_atomic >= 0),
  referral_balance_before_atomic NUMERIC(78, 0) NOT NULL
    CHECK (referral_balance_before_atomic >= 0),
  referral_balance_after_atomic NUMERIC(78, 0) NOT NULL
    CHECK (referral_balance_after_atomic >= 0),
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  UNIQUE (attestation_id, transaction_hash, claim_log_index),
  UNIQUE (attestation_id, transaction_hash, burn_log_index),
  UNIQUE (attestation_id, transaction_hash, referral_log_index),
  UNIQUE (attestation_id, transaction_hash, transfer_log_index),
  CONSTRAINT megapot_claim_receipt_conservation CHECK (
    gross_winnings_atomic = net_winnings_atomic + referral_accrual_atomic
    AND custody_balance_after_atomic = custody_balance_before_atomic + net_winnings_atomic
    AND referral_balance_after_atomic =
      referral_balance_before_atomic + referral_accrual_atomic
    AND claim_log_index <> burn_log_index
    AND claim_log_index <> referral_log_index
    AND claim_log_index <> transfer_log_index
    AND burn_log_index <> referral_log_index
    AND burn_log_index <> transfer_log_index
    AND referral_log_index <> transfer_log_index
  )
);

CREATE TABLE megapot_allocation_batches (
  allocation_batch_id TEXT PRIMARY KEY CHECK (
    btrim(allocation_batch_id) <> '' AND allocation_batch_id = btrim(allocation_batch_id)
    AND octet_length(allocation_batch_id) <= 128
  ),
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES megapot_pool_beneficiary_snapshots (snapshot_id),
  claim_effect_id TEXT NOT NULL UNIQUE REFERENCES megapot_claim_effects (claim_effect_id),
  algorithm_version TEXT NOT NULL CHECK (algorithm_version = 'equal_v1'),
  net_winnings_atomic NUMERIC(78, 0) NOT NULL CHECK (net_winnings_atomic >= 0),
  allocation_count INTEGER NOT NULL CHECK (allocation_count > 0),
  allocation_hash TEXT NOT NULL CHECK (allocation_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'credited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  credited_at TIMESTAMPTZ,
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (pool_leg_id, drawing_id),
  CONSTRAINT megapot_allocation_batch_state_shape CHECK (
    (state = 'prepared' AND credited_at IS NULL)
    OR (state = 'credited' AND credited_at IS NOT NULL AND credited_at >= created_at)
  )
);

CREATE TABLE reward_ledger_credits (
  credit_id TEXT PRIMARY KEY CHECK (
    btrim(credit_id) <> '' AND credit_id = btrim(credit_id) AND octet_length(credit_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  payout_persona_id TEXT NOT NULL,
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('megapot_allocation', 'asset_bonus', 'external_fallback')
  ),
  source_reference TEXT NOT NULL CHECK (btrim(source_reference) <> ''),
  state TEXT NOT NULL CHECK (state IN (
    'credited', 'payout_reserved', 'payout_pending', 'sent', 'reconciliation_required'
  )),
  reserved_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  paid_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (paid_atomic >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  FOREIGN KEY (account_id, payout_persona_id)
    REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (chain_id, token_address)
    REFERENCES reward_asset_whitelist (chain_id, token_address),
  UNIQUE (source_kind, source_reference, account_id),
  CONSTRAINT reward_ledger_credit_conservation CHECK (
    reserved_atomic + paid_atomic <= amount_atomic
  ),
  CONSTRAINT reward_ledger_credit_state_shape CHECK (
    (state IN ('credited', 'payout_reserved', 'payout_pending', 'reconciliation_required')
      AND settled_at IS NULL)
    OR (state = 'sent' AND paid_atomic = amount_atomic
      AND reserved_atomic = 0 AND settled_at IS NOT NULL)
  )
);
CREATE INDEX reward_ledger_credits_account_idx
  ON reward_ledger_credits (account_id, state, created_at, credit_id);

CREATE TABLE megapot_allocations (
  allocation_batch_id TEXT NOT NULL REFERENCES megapot_allocation_batches (allocation_batch_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  allocation_kind TEXT NOT NULL CHECK (
    allocation_kind IN ('participant', 'external_fallback', 'platform_sponsorship')
  ),
  credit_id TEXT UNIQUE REFERENCES reward_ledger_credits (credit_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (allocation_batch_id, ordinal),
  UNIQUE (allocation_batch_id, account_id),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  CONSTRAINT megapot_allocation_credit_shape CHECK (
    (allocation_kind IN ('participant', 'external_fallback') AND credit_id IS NOT NULL)
    OR (allocation_kind = 'platform_sponsorship' AND credit_id IS NULL)
  )
);

CREATE TABLE reward_payout_effects (
  payout_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  credit_id TEXT NOT NULL UNIQUE REFERENCES reward_ledger_credits (credit_id),
  account_id TEXT NOT NULL,
  payout_persona_id TEXT NOT NULL,
  destination_address TEXT NOT NULL CHECK (destination_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  wallet_assignment_id TEXT NOT NULL REFERENCES persona_wallet_assignments (assignment_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, payout_persona_id)
    REFERENCES personas (account_id, persona_id)
);

CREATE TABLE reward_refund_effects (
  refund_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  funding_effect_id TEXT NOT NULL REFERENCES song_reward_leg_funding_effects (funding_effect_id),
  funder_account_id TEXT NOT NULL REFERENCES users (user_id),
  destination_address TEXT NOT NULL CHECK (destination_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  pro_rata_numerator_atomic NUMERIC(78, 0) NOT NULL CHECK (pro_rata_numerator_atomic > 0),
  pro_rata_denominator_atomic NUMERIC(78, 0) NOT NULL CHECK (pro_rata_denominator_atomic > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (leg_id, funding_effect_id),
  CONSTRAINT reward_refund_fraction CHECK (
    pro_rata_numerator_atomic <= pro_rata_denominator_atomic
  )
);

CREATE TABLE custody_solvency_observations (
  observation_id TEXT PRIMARY KEY CHECK (
    btrim(observation_id) <> '' AND observation_id = btrim(observation_id)
    AND octet_length(observation_id) <= 128
  ),
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  chain_id BIGINT NOT NULL,
  custody_address TEXT NOT NULL CHECK (custody_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  balance_atomic NUMERIC(78, 0) NOT NULL CHECK (balance_atomic >= 0),
  reserved_purchase_atomic NUMERIC(78, 0) NOT NULL CHECK (reserved_purchase_atomic >= 0),
  outstanding_credit_atomic NUMERIC(78, 0) NOT NULL CHECK (outstanding_credit_atomic >= 0),
  pending_refund_atomic NUMERIC(78, 0) NOT NULL CHECK (pending_refund_atomic >= 0),
  shared_sponsorship_atomic NUMERIC(78, 0) NOT NULL CHECK (shared_sponsorship_atomic >= 0),
  solvent BOOLEAN GENERATED ALWAYS AS (
    balance_atomic >= reserved_purchase_atomic + outstanding_credit_atomic
      + pending_refund_atomic + shared_sponsorship_atomic
  ) STORED,
  block_number BIGINT NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attestation_id, chain_id)
    REFERENCES megapot_deployment_attestations (attestation_id, chain_id),
  CONSTRAINT custody_solvency_observation_time CHECK (expires_at > observed_at)
);
CREATE INDEX custody_solvency_observations_latest_idx
  ON custody_solvency_observations (attestation_id, block_number DESC, observation_id);

CREATE TABLE platform_referral_revenue_ledger (
  revenue_entry_id TEXT PRIMARY KEY CHECK (
    btrim(revenue_entry_id) <> '' AND revenue_entry_id = btrim(revenue_entry_id)
    AND octet_length(revenue_entry_id) <= 128
  ),
  attestation_id TEXT NOT NULL REFERENCES megapot_deployment_attestations (attestation_id),
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  ticket_id NUMERIC(78, 0) NOT NULL,
  revenue_kind TEXT NOT NULL CHECK (revenue_kind IN ('purchase_referral_fee', 'win_share')),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  allocation_policy_version TEXT NOT NULL CHECK (btrim(allocation_policy_version) <> ''),
  observation_hash TEXT NOT NULL CHECK (observation_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (attestation_id, ticket_id)
    REFERENCES megapot_ticket_inventory (attestation_id, ticket_id),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id),
  UNIQUE (attestation_id, ticket_id, revenue_kind)
);

CREATE TABLE platform_sponsorship_budgets (
  sponsor_account_id TEXT PRIMARY KEY REFERENCES users (user_id),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  funded_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (funded_atomic >= 0),
  winnings_credited_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0
    CHECK (winnings_credited_atomic >= 0),
  reserved_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  spent_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (spent_atomic >= 0),
  withdrawn_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (withdrawn_atomic >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (chain_id, token_address)
    REFERENCES reward_asset_whitelist (chain_id, token_address),
  CONSTRAINT platform_sponsorship_budget_conservation CHECK (
    reserved_atomic + spent_atomic + withdrawn_atomic <= funded_atomic + winnings_credited_atomic
  )
);

CREATE TABLE platform_sponsorship_budget_entries (
  budget_entry_id TEXT PRIMARY KEY CHECK (
    btrim(budget_entry_id) <> '' AND budget_entry_id = btrim(budget_entry_id)
    AND octet_length(budget_entry_id) <= 128
  ),
  sponsor_account_id TEXT NOT NULL REFERENCES platform_sponsorship_budgets (sponsor_account_id),
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN ('funded', 'purchase_reserved', 'purchase_released',
      'purchase_confirmed', 'winnings_credited', 'withdrawal_reserved',
      'withdrawal_released', 'withdrawal_confirmed')
  ),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  source_reference TEXT NOT NULL CHECK (btrim(source_reference) <> ''),
  balance_hash TEXT NOT NULL CHECK (balance_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (entry_kind, source_reference)
);

CREATE TABLE song_reward_bundle_claims (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  offer_id TEXT NOT NULL REFERENCES song_reward_offers (offer_id),
  persona_id TEXT NOT NULL,
  qualification_id TEXT NOT NULL REFERENCES activity_qualifications (qualification_id),
  eligibility_decision_id TEXT NOT NULL
    REFERENCES reward_eligibility_decisions (eligibility_decision_id),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'credited', 'ineligible')),
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, offer_id),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  CONSTRAINT song_reward_bundle_claim_state_shape CHECK (
    (state IN ('reserved', 'credited') AND terminal_reason IS NULL)
    OR (state = 'ineligible' AND btrim(terminal_reason) <> '')
  )
);

CREATE TABLE song_reward_bundle_claim_legs (
  account_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  leg_id TEXT NOT NULL REFERENCES song_reward_offer_legs (leg_id),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  credit_id TEXT UNIQUE REFERENCES reward_ledger_credits (credit_id),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'credited', 'unavailable')),
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, offer_id, leg_id),
  FOREIGN KEY (account_id, offer_id)
    REFERENCES song_reward_bundle_claims (account_id, offer_id),
  CONSTRAINT song_reward_bundle_claim_leg_state_shape CHECK (
    (state = 'reserved' AND credit_id IS NULL AND terminal_reason IS NULL)
    OR (state = 'credited' AND credit_id IS NOT NULL AND terminal_reason IS NULL)
    OR (state = 'unavailable' AND credit_id IS NULL AND btrim(terminal_reason) <> '')
  )
);

CREATE TABLE sponsor_withdrawal_effects (
  withdrawal_effect_id TEXT PRIMARY KEY REFERENCES reward_chain_effects (effect_id),
  sponsor_account_id TEXT NOT NULL REFERENCES platform_sponsorship_budgets (sponsor_account_id),
  destination_address TEXT NOT NULL CHECK (destination_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE megapot_pool_drawing_transitions (
  pool_leg_id TEXT NOT NULL,
  drawing_id NUMERIC(78, 0) NOT NULL,
  target_version BIGINT NOT NULL CHECK (target_version > 1),
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pool_leg_id, drawing_id, target_version),
  FOREIGN KEY (pool_leg_id, drawing_id)
    REFERENCES megapot_pool_drawings (pool_leg_id, drawing_id)
);

ALTER TABLE megapot_pool_drawings
  ADD CONSTRAINT megapot_pool_drawings_snapshot_fk
  FOREIGN KEY (snapshot_id) REFERENCES megapot_pool_beneficiary_snapshots (snapshot_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT megapot_pool_drawings_commitment_fk
  FOREIGN KEY (commitment_effect_id)
  REFERENCES megapot_pool_commitment_effects (commitment_effect_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT megapot_pool_drawings_purchase_fk
  FOREIGN KEY (purchase_effect_id) REFERENCES megapot_ticket_purchase_effects (purchase_effect_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT megapot_pool_drawings_claim_fk
  FOREIGN KEY (claim_effect_id) REFERENCES megapot_claim_effects (claim_effect_id)
  DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT megapot_pool_drawings_allocation_fk
  FOREIGN KEY (allocation_batch_id)
  REFERENCES megapot_allocation_batches (allocation_batch_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION reward_json_contains_private_identity(candidate JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry RECORD;
BEGIN
  IF jsonb_typeof(candidate) = 'object' THEN
    FOR entry IN SELECT key, value FROM jsonb_each(candidate)
    LOOP
      IF entry.key IN ('account_id', 'accountId', 'persona_id', 'personaId')
         OR reward_json_contains_private_identity(entry.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(candidate) = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(candidate)
    LOOP
      IF reward_json_contains_private_identity(entry.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END
$$;

CREATE FUNCTION guard_song_reward_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  post_record posts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song reward offers cannot be deleted';
  END IF;
  SELECT * INTO post_record FROM posts
   WHERE community_id = NEW.community_id AND post_id = NEW.post_id FOR SHARE;
  IF post_record.post_id IS NULL OR post_record.post_type <> 'song'
     OR NOT EXISTS (
       SELECT 1 FROM media_publication_projections publication
        WHERE publication.community_id = NEW.community_id
          AND publication.post_id = NEW.post_id
          AND publication.audio_revision = NEW.audio_revision
     ) THEN
    RAISE EXCEPTION 'song reward offer requires exact published song revision';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'song reward offer must begin as draft';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.offer_id, NEW.community_id, NEW.post_id, NEW.audio_revision,
      NEW.created_by_account_id, NEW.starts_at, NEW.ends_at,
      NEW.owner_policy_snapshot, NEW.terms_hash, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.offer_id, OLD.community_id, OLD.post_id, OLD.audio_revision,
      OLD.created_by_account_id, OLD.starts_at, OLD.ends_at,
      OLD.owner_policy_snapshot, OLD.terms_hash, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'song reward offer terms are immutable';
    END IF;
    IF OLD.status IN ('exhausted', 'expired', 'ended') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal song reward offer is immutable';
    END IF;
    IF NOT (
      NEW.status = OLD.status
      OR (OLD.status = 'draft' AND NEW.status IN ('active', 'ended'))
      OR (OLD.status = 'active' AND NEW.status IN (
        'paused', 'exhausted', 'expired', 'ended', 'operational_hold'
      ))
      OR (OLD.status = 'paused' AND NEW.status IN ('active', 'expired', 'ended', 'operational_hold'))
      OR (OLD.status = 'operational_hold' AND NEW.status IN ('active', 'ended'))
    ) THEN
      RAISE EXCEPTION 'invalid song reward offer transition';
    END IF;
    IF NEW.status <> OLD.status AND NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'song reward offer transition time must advance';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_offers_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_reward_offers
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_offer();

CREATE FUNCTION guard_song_reward_offer_leg() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offer_record song_reward_offers%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  activity TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song reward offer legs cannot be deleted';
  END IF;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = NEW.offer_id FOR SHARE;
  IF offer_record.offer_id IS NULL THEN
    RAISE EXCEPTION 'song reward offer leg requires offer';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'song reward offer leg must begin as draft';
  END IF;
  IF NEW.kind = 'megapot_pool' THEN
    SELECT * INTO attestation_record FROM megapot_deployment_attestations
     WHERE attestation_id = NEW.attestation_id FOR SHARE;
    IF attestation_record.attestation_id IS NULL
       OR attestation_record.chain_id <> NEW.chain_id
       OR attestation_record.usdc_address <> NEW.token_address
       OR attestation_record.status <> 'active' THEN
      RAISE EXCEPTION 'Megapot pool leg requires active exact deployment attestation';
    END IF;
    FOREACH activity IN ARRAY NEW.eligible_activities
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM activity_registry registry
         WHERE registry.activity_key = activity AND registry.status = 'active'
      ) THEN
        RAISE EXCEPTION 'Megapot pool leg activity is not active';
      END IF;
    END LOOP;
    IF NEW.status = 'active' THEN
      IF offer_record.status <> 'active' THEN
        RAISE EXCEPTION 'Megapot pool leg requires active offer';
      END IF;
      IF attestation_record.environment = 'production'
         AND NEW.legal_activation_gate <> 'production_approved' THEN
        RAISE EXCEPTION 'production Megapot pool activation is not legally approved';
      END IF;
      IF NEW.empty_pool_policy = 'funder_fallback'
         AND NEW.funding_source = 'leg_budget' THEN
        IF NOT EXISTS (
          SELECT 1 FROM posts post
           WHERE post.community_id = offer_record.community_id
             AND post.post_id = offer_record.post_id
             AND post.post_type = 'song' AND post.status = 'published'
             AND post.visibility = 'public'
        ) THEN
          RAISE EXCEPTION 'external fallback requires discoverable song';
        END IF;
        FOREACH activity IN ARRAY NEW.eligible_activities
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM reward_activity_availability_observations availability
             WHERE availability.community_id = offer_record.community_id
               AND availability.post_id = offer_record.post_id
               AND availability.audio_revision = offer_record.audio_revision
               AND availability.activity_key = activity
               AND availability.state = 'available'
               AND availability.expires_at > clock_timestamp()
          ) THEN
            RAISE EXCEPTION 'external fallback activity is unavailable';
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.leg_id, NEW.offer_id, NEW.kind, NEW.funder_account_id, NEW.refund_policy,
      NEW.leg_terms_hash, NEW.participation_starts_at, NEW.chain_id, NEW.token_address,
      NEW.token_decimals, NEW.amount_per_claim_atomic, NEW.max_claims,
      NEW.tickets_per_drawing, NEW.max_ticket_price_atomic, NEW.entry_cutoff_seconds,
      NEW.beneficiary_algorithm_version, NEW.ticket_selection_version, NEW.attestation_id,
      NEW.participation_starts_drawing_id, NEW.eligible_activities, NEW.min_score_bps,
      NEW.empty_pool_policy, NEW.funding_source, NEW.fallback_beneficiary_account_id,
      NEW.fallback_payout_persona_id, NEW.referral_allocation_version,
      NEW.referral_policy_hash, NEW.referral_disclosed_at, NEW.legal_activation_gate,
      NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.leg_id, OLD.offer_id, OLD.kind, OLD.funder_account_id, OLD.refund_policy,
      OLD.leg_terms_hash, OLD.participation_starts_at, OLD.chain_id, OLD.token_address,
      OLD.token_decimals, OLD.amount_per_claim_atomic, OLD.max_claims,
      OLD.tickets_per_drawing, OLD.max_ticket_price_atomic, OLD.entry_cutoff_seconds,
      OLD.beneficiary_algorithm_version, OLD.ticket_selection_version, OLD.attestation_id,
      OLD.participation_starts_drawing_id, OLD.eligible_activities, OLD.min_score_bps,
      OLD.empty_pool_policy, OLD.funding_source, OLD.fallback_beneficiary_account_id,
      OLD.fallback_payout_persona_id, OLD.referral_allocation_version,
      OLD.referral_policy_hash, OLD.referral_disclosed_at, OLD.legal_activation_gate,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'song reward offer leg terms are immutable';
    END IF;
    IF NEW.funded_atomic < OLD.funded_atomic OR NEW.reserved_atomic < 0
       OR NEW.spent_atomic < OLD.spent_atomic OR NEW.fulfilled_atomic < OLD.fulfilled_atomic
       OR NEW.refunded_atomic < OLD.refunded_atomic THEN
      RAISE EXCEPTION 'song reward offer leg accounting cannot reverse';
    END IF;
    IF OLD.status IN ('exhausted', 'ended') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal song reward offer leg is immutable';
    END IF;
    IF NOT (
      NEW.status = OLD.status
      OR (OLD.status = 'draft' AND NEW.status IN ('funding', 'active', 'ended'))
      OR (OLD.status = 'funding' AND NEW.status IN ('active', 'ended', 'operational_hold'))
      OR (OLD.status = 'active' AND NEW.status IN (
        'paused', 'exhausted', 'ended', 'operational_hold'
      ))
      OR (OLD.status = 'paused' AND NEW.status IN ('active', 'ended', 'operational_hold'))
      OR (OLD.status = 'operational_hold' AND NEW.status IN ('active', 'ended'))
    ) THEN
      RAISE EXCEPTION 'invalid song reward offer leg transition';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'song reward offer leg update time cannot reverse';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_offer_legs_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_offer_leg();

CREATE FUNCTION guard_reward_availability_observation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward activity availability observations are append-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM posts post
     WHERE post.community_id = NEW.community_id AND post.post_id = NEW.post_id
       AND post.post_type = 'song'
  ) OR NOT EXISTS (
    SELECT 1 FROM media_publication_projections publication
     WHERE publication.community_id = NEW.community_id
       AND publication.post_id = NEW.post_id
       AND publication.audio_revision = NEW.audio_revision
  ) THEN
    RAISE EXCEPTION 'reward availability requires exact song publication';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_activity_availability_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_activity_availability_observations
FOR EACH ROW EXECUTE FUNCTION guard_reward_availability_observation();

CREATE FUNCTION guard_song_reward_funding_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song reward funding effects cannot be deleted';
  END IF;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = NEW.leg_id FOR SHARE;
  IF leg_record.leg_id IS NULL OR NEW.chain_id <> leg_record.chain_id
     OR NEW.token_address <> leg_record.token_address THEN
    RAISE EXCEPTION 'song reward funding asset does not match leg';
  END IF;
  IF leg_record.kind = 'megapot_pool'
     AND leg_record.empty_pool_policy = 'funder_fallback'
     AND NEW.funder_account_id <> leg_record.funder_account_id THEN
    RAISE EXCEPTION 'fallback_sponsor_mismatch';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.funding_effect_id, NEW.leg_id, NEW.funder_account_id, NEW.chain_id,
      NEW.token_address, NEW.sender_address, NEW.recipient_address,
      NEW.expected_amount_atomic, NEW.required_confirmations, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.funding_effect_id, OLD.leg_id, OLD.funder_account_id, OLD.chain_id,
      OLD.token_address, OLD.sender_address, OLD.recipient_address,
      OLD.expected_amount_atomic, OLD.required_confirmations, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'song reward funding identity is immutable';
    END IF;
    IF NOT (
      NEW.state = OLD.state
      OR (OLD.state = 'planned' AND NEW.state IN (
        'confirming', 'reclaimable_failed', 'reconciliation_required'
      ))
      OR (OLD.state = 'confirming' AND NEW.state IN (
        'confirmed', 'reverted', 'reclaimable_failed', 'reconciliation_required'
      ))
      OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
        'confirming', 'confirmed', 'reverted'
      ))
    ) THEN
      RAISE EXCEPTION 'invalid song reward funding transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_reward_leg_funding_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON song_reward_leg_funding_effects
FOR EACH ROW EXECUTE FUNCTION guard_song_reward_funding_effect();

CREATE FUNCTION guard_megapot_pool_drawing() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  observation_record megapot_drawing_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot pool drawings cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO leg_record FROM song_reward_offer_legs
     WHERE leg_id = NEW.pool_leg_id FOR SHARE;
    SELECT * INTO observation_record FROM megapot_drawing_observations
     WHERE observation_id = NEW.observation_id FOR SHARE;
    IF NEW.status <> 'entry_open' OR leg_record.kind <> 'megapot_pool'
       OR leg_record.status <> 'active'
       OR NEW.drawing_id < leg_record.participation_starts_drawing_id
       OR observation_record.observation_id IS NULL
       OR observation_record.attestation_id <> leg_record.attestation_id
       OR observation_record.drawing_id <> NEW.drawing_id
       OR observation_record.drawing_locked
       OR observation_record.expires_at <= clock_timestamp()
       OR NEW.entry_cutoff_at <> observation_record.drawing_time
            - make_interval(secs => leg_record.entry_cutoff_seconds)
       OR NEW.ticket_price_ceiling_atomic <> leg_record.max_ticket_price_atomic THEN
      RAISE EXCEPTION 'Megapot pool drawing does not match live leg and observation';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.pool_leg_id, NEW.drawing_id, NEW.observation_id, NEW.entry_cutoff_at,
    NEW.ticket_price_ceiling_atomic, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.pool_leg_id, OLD.drawing_id, OLD.observation_id, OLD.entry_cutoff_at,
    OLD.ticket_price_ceiling_atomic, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Megapot pool drawing identity is immutable';
  END IF;
  IF OLD.status IN (
    'no_win', 'credited', 'closed_no_entries', 'closed_unfunded',
    'closed_fallback_ineligible', 'closed_fallback_unavailable',
    'closed_fallback_ceiling', 'operational_hold'
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal Megapot pool drawing is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'Megapot pool drawing transition requires next version and time';
  END IF;
  IF NOT (
    (OLD.status = 'entry_open' AND NEW.status IN (
      'cutoff_frozen', 'closed_no_entries', 'closed_unfunded',
      'closed_fallback_ineligible', 'closed_fallback_unavailable',
      'closed_fallback_ceiling', 'operational_hold'
    ))
    OR (OLD.status = 'cutoff_frozen' AND NEW.status IN ('committed', 'operational_hold'))
    OR (OLD.status = 'committed' AND NEW.status IN ('purchase_pending', 'operational_hold'))
    OR (OLD.status = 'purchase_pending' AND NEW.status IN ('tickets_confirmed', 'operational_hold'))
    OR (OLD.status = 'tickets_confirmed' AND NEW.status IN ('drawing_pending', 'operational_hold'))
    OR (OLD.status = 'drawing_pending' AND NEW.status IN (
      'no_win', 'winnings_detected', 'operational_hold'
    ))
    OR (OLD.status = 'winnings_detected' AND NEW.status IN ('claim_pending', 'operational_hold'))
    OR (OLD.status = 'claim_pending' AND NEW.status IN ('claimed', 'operational_hold'))
    OR (OLD.status = 'claimed' AND NEW.status IN ('allocated', 'operational_hold'))
    OR (OLD.status = 'allocated' AND NEW.status IN ('credited', 'operational_hold'))
  ) THEN
    RAISE EXCEPTION 'invalid Megapot pool drawing transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_pool_drawings_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_pool_drawings
FOR EACH ROW EXECUTE FUNCTION guard_megapot_pool_drawing();

CREATE FUNCTION validate_megapot_pool_drawing_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM megapot_pool_drawing_transitions transition
     WHERE transition.pool_leg_id = NEW.pool_leg_id
       AND transition.drawing_id = NEW.drawing_id
       AND transition.target_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'Megapot pool drawing transition event is missing';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER megapot_pool_drawing_transition_pair
AFTER UPDATE ON megapot_pool_drawings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_pool_drawing_transition();

CREATE FUNCTION guard_megapot_pool_share() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  drawing_record megapot_pool_drawings%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  qualification_record activity_qualifications%ROWTYPE;
  eligibility_record reward_eligibility_decisions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot pool shares are append-only';
  END IF;
  SELECT * INTO drawing_record FROM megapot_pool_drawings
   WHERE pool_leg_id = NEW.pool_leg_id AND drawing_id = NEW.drawing_id FOR UPDATE;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = NEW.pool_leg_id FOR SHARE;
  SELECT * INTO offer_record FROM song_reward_offers
   WHERE offer_id = leg_record.offer_id FOR SHARE;
  SELECT * INTO qualification_record FROM activity_qualifications
   WHERE qualification_id = NEW.qualification_id FOR SHARE;
  SELECT * INTO eligibility_record FROM reward_eligibility_decisions
   WHERE eligibility_decision_id = NEW.eligibility_decision_id FOR SHARE;
  IF drawing_record.status <> 'entry_open'
     OR clock_timestamp() >= drawing_record.entry_cutoff_at
     OR qualification_record.account_id <> NEW.account_id
     OR qualification_record.persona_id <> NEW.persona_id
     OR qualification_record.community_id <> offer_record.community_id
     OR qualification_record.post_id <> offer_record.post_id
     OR qualification_record.audio_revision <> offer_record.audio_revision
     OR NOT qualification_record.activity_key = ANY(leg_record.eligible_activities)
     OR qualification_record.score_bps < leg_record.min_score_bps
     OR qualification_record.qualified_at >= drawing_record.entry_cutoff_at
     OR qualification_record.qualified_at < leg_record.participation_starts_at
     OR NEW.qualified_at <> qualification_record.qualified_at
     OR eligibility_record.leg_id <> NEW.pool_leg_id
     OR eligibility_record.account_id <> NEW.account_id
     OR eligibility_record.persona_id <> NEW.persona_id
     OR eligibility_record.purpose <> 'pool_share'
     OR eligibility_record.qualification_id <> NEW.qualification_id
     OR eligibility_record.drawing_id <> NEW.drawing_id
     OR eligibility_record.outcome <> 'eligible'
     OR eligibility_record.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Megapot pool share is not exact eligible qualification output';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_pool_shares_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_pool_shares
FOR EACH ROW EXECUTE FUNCTION guard_megapot_pool_share();

CREATE FUNCTION validate_megapot_fallback_cutoff() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  leg_record song_reward_offer_legs%ROWTYPE;
  offer_record song_reward_offers%ROWTYPE;
  evidence_record megapot_fallback_cutoff_evidence%ROWTYPE;
  decision_record reward_eligibility_decisions%ROWTYPE;
  activity TEXT;
  activity_count INTEGER;
BEGIN
  IF NEW.fallback_beneficiary IS DISTINCT FROM TRUE
     OR NEW.status NOT IN ('cutoff_frozen', 'committed', 'purchase_pending',
       'tickets_confirmed', 'drawing_pending', 'winnings_detected', 'claim_pending',
       'claimed', 'allocated', 'credited') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO leg_record FROM song_reward_offer_legs WHERE leg_id = NEW.pool_leg_id;
  SELECT * INTO offer_record FROM song_reward_offers WHERE offer_id = leg_record.offer_id;
  SELECT * INTO evidence_record FROM megapot_fallback_cutoff_evidence
   WHERE pool_leg_id = NEW.pool_leg_id AND drawing_id = NEW.drawing_id;
  SELECT * INTO decision_record FROM reward_eligibility_decisions
   WHERE eligibility_decision_id = evidence_record.eligibility_decision_id;
  IF evidence_record.pool_leg_id IS NULL
     OR leg_record.empty_pool_policy <> 'funder_fallback'
     OR evidence_record.sponsor_account_id <> leg_record.fallback_beneficiary_account_id
     OR evidence_record.payout_persona_id IS DISTINCT FROM leg_record.fallback_payout_persona_id
     OR decision_record.leg_id <> NEW.pool_leg_id
     OR decision_record.account_id <> evidence_record.sponsor_account_id
     OR decision_record.purpose <> 'fallback_cutoff'
     OR decision_record.drawing_id <> NEW.drawing_id
     OR decision_record.outcome <> 'eligible'
     OR decision_record.expires_at <= evidence_record.checked_at
     OR NOT EXISTS (
       SELECT 1 FROM sponsor_daily_ticket_totals total
        WHERE total.sponsor_account_id = evidence_record.sponsor_account_id
          AND total.sponsor_day = evidence_record.sponsor_day
          AND total.sponsor_kind = evidence_record.sponsor_kind
          AND total.confirmed_ticket_count + total.reserved_ticket_count
                - total.released_ticket_count >= 1
          AND total.confirmed_spend_atomic + total.reserved_spend_atomic
                - total.released_spend_atomic >= NEW.reserved_ticket_cost_atomic
     )
     OR NOT EXISTS (
       SELECT 1 FROM posts post
        WHERE post.community_id = offer_record.community_id
          AND post.post_id = offer_record.post_id
          AND post.post_type = 'song' AND post.status = 'published'
          AND post.visibility = 'public'
     ) THEN
    RAISE EXCEPTION 'Megapot fallback cutoff evidence is invalid';
  END IF;
  SELECT count(*) INTO activity_count
    FROM megapot_fallback_cutoff_activity_evidence activity_evidence
   WHERE activity_evidence.pool_leg_id = NEW.pool_leg_id
     AND activity_evidence.drawing_id = NEW.drawing_id;
  IF activity_count <> cardinality(leg_record.eligible_activities) THEN
    RAISE EXCEPTION 'Megapot fallback cutoff activity evidence is incomplete';
  END IF;
  FOREACH activity IN ARRAY leg_record.eligible_activities
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM megapot_fallback_cutoff_activity_evidence activity_evidence
        JOIN reward_activity_availability_observations availability
          ON availability.availability_observation_id =
             activity_evidence.availability_observation_id
       WHERE activity_evidence.pool_leg_id = NEW.pool_leg_id
         AND activity_evidence.drawing_id = NEW.drawing_id
         AND activity_evidence.activity_key = activity
         AND availability.community_id = offer_record.community_id
         AND availability.post_id = offer_record.post_id
         AND availability.audio_revision = offer_record.audio_revision
         AND availability.activity_key = activity
         AND availability.state = 'available'
         AND availability.observed_at <= evidence_record.checked_at
         AND availability.expires_at > evidence_record.checked_at
    ) THEN
      RAISE EXCEPTION 'Megapot fallback cutoff activity is unavailable';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER megapot_fallback_cutoff_pair
AFTER INSERT OR UPDATE ON megapot_pool_drawings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_fallback_cutoff();

CREATE FUNCTION validate_megapot_beneficiary_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_snapshot_id TEXT;
  snapshot_record megapot_pool_beneficiary_snapshots%ROWTYPE;
  drawing_record megapot_pool_drawings%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  leaf_total INTEGER;
  share_total INTEGER;
  commitments JSONB;
BEGIN
  target_snapshot_id := CASE
    WHEN TG_TABLE_NAME = 'megapot_pool_beneficiary_snapshots' THEN NEW.snapshot_id
    ELSE NEW.snapshot_id
  END;
  SELECT * INTO snapshot_record FROM megapot_pool_beneficiary_snapshots
   WHERE snapshot_id = target_snapshot_id;
  IF snapshot_record.snapshot_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO drawing_record FROM megapot_pool_drawings
   WHERE pool_leg_id = snapshot_record.pool_leg_id
     AND drawing_id = snapshot_record.drawing_id;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = snapshot_record.pool_leg_id;
  SELECT count(*), jsonb_agg(leaf_commitment ORDER BY ordinal)
    INTO leaf_total, commitments
    FROM megapot_pool_snapshot_private_leaves
   WHERE snapshot_id = snapshot_record.snapshot_id;
  SELECT count(*) INTO share_total FROM megapot_pool_shares
   WHERE pool_leg_id = snapshot_record.pool_leg_id
     AND drawing_id = snapshot_record.drawing_id;
  IF drawing_record.snapshot_id IS DISTINCT FROM snapshot_record.snapshot_id
     OR drawing_record.frozen_share_count IS DISTINCT FROM share_total
     OR snapshot_record.leaf_count <> leaf_total
     OR reward_json_contains_private_identity(snapshot_record.published_artifact)
     OR snapshot_record.published_artifact <> jsonb_build_object(
       'domain', snapshot_record.domain,
       'poolLegId', snapshot_record.pool_leg_id,
       'drawingId', snapshot_record.drawing_id::text,
       'termsHash', snapshot_record.terms_hash,
       'algorithmVersion', snapshot_record.algorithm_version,
       'fallback', snapshot_record.fallback,
       'leafCount', snapshot_record.leaf_count,
       'leafCommitments', commitments,
       'snapshotHash', snapshot_record.snapshot_hash
     ) THEN
    RAISE EXCEPTION 'Megapot beneficiary snapshot artifact is not exact';
  END IF;
  IF snapshot_record.fallback THEN
    IF share_total <> 0 OR snapshot_record.leaf_count <> 1
       OR drawing_record.fallback_beneficiary IS DISTINCT FROM TRUE
       OR NOT EXISTS (
         SELECT 1 FROM megapot_pool_snapshot_private_leaves leaf
          WHERE leaf.snapshot_id = snapshot_record.snapshot_id
            AND leaf.ordinal = 0
            AND leaf.account_id = leg_record.fallback_beneficiary_account_id
            AND (leg_record.funding_source = 'shared_sponsor_budget'
              OR leaf.persona_id = leg_record.fallback_payout_persona_id)
       ) THEN
      RAISE EXCEPTION 'Megapot fallback beneficiary snapshot is not exact';
    END IF;
  ELSE
    IF snapshot_record.leaf_count <> share_total
       OR drawing_record.fallback_beneficiary IS DISTINCT FROM FALSE
       OR EXISTS (
         (SELECT share.account_id, share.persona_id
            FROM megapot_pool_shares share
           WHERE share.pool_leg_id = snapshot_record.pool_leg_id
             AND share.drawing_id = snapshot_record.drawing_id)
         EXCEPT
         (SELECT leaf.account_id, leaf.persona_id
            FROM megapot_pool_snapshot_private_leaves leaf
           WHERE leaf.snapshot_id = snapshot_record.snapshot_id)
       ) OR EXISTS (
         (SELECT leaf.account_id, leaf.persona_id
            FROM megapot_pool_snapshot_private_leaves leaf
           WHERE leaf.snapshot_id = snapshot_record.snapshot_id)
         EXCEPT
         (SELECT share.account_id, share.persona_id
            FROM megapot_pool_shares share
           WHERE share.pool_leg_id = snapshot_record.pool_leg_id
             AND share.drawing_id = snapshot_record.drawing_id)
       ) THEN
      RAISE EXCEPTION 'Megapot participant beneficiary snapshot is not exact';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER megapot_beneficiary_snapshot_exact
AFTER INSERT ON megapot_pool_beneficiary_snapshots DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_beneficiary_snapshot();
CREATE CONSTRAINT TRIGGER megapot_beneficiary_leaf_exact
AFTER INSERT ON megapot_pool_snapshot_private_leaves DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_beneficiary_snapshot();

CREATE FUNCTION reject_megapot_snapshot_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Megapot beneficiary snapshots are append-only';
END
$$;
CREATE TRIGGER megapot_beneficiary_snapshots_append_only
BEFORE UPDATE OR DELETE ON megapot_pool_beneficiary_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_megapot_snapshot_change();
CREATE TRIGGER megapot_beneficiary_leaves_append_only
BEFORE UPDATE OR DELETE ON megapot_pool_snapshot_private_leaves
FOR EACH ROW EXECUTE FUNCTION reject_megapot_snapshot_change();

CREATE FUNCTION guard_reward_chain_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_record reward_chain_effects%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward chain effects cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'planned' THEN
      RAISE EXCEPTION 'reward chain effect must begin planned';
    END IF;
    IF NEW.replacement_of_effect_id IS NOT NULL THEN
      SELECT * INTO previous_record FROM reward_chain_effects
       WHERE effect_id = NEW.replacement_of_effect_id FOR UPDATE;
      IF previous_record.effect_id IS NULL OR previous_record.state <> 'replaced'
         OR previous_record.replaced_by_effect_id <> NEW.effect_id
         OR previous_record.effect_kind <> NEW.effect_kind
         OR previous_record.chain_id <> NEW.chain_id
         OR previous_record.signer_address <> NEW.signer_address
         OR previous_record.target_address <> NEW.target_address
         OR previous_record.value_wei <> NEW.value_wei
         OR previous_record.reserved_amount_atomic <> NEW.reserved_amount_atomic THEN
        RAISE EXCEPTION 'reward replacement effect identity is invalid';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.effect_id, NEW.effect_kind, NEW.chain_id, NEW.signer_address,
    NEW.target_address, NEW.value_wei, NEW.reserved_amount_atomic,
    NEW.replacement_of_effect_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.effect_id, OLD.effect_kind, OLD.chain_id, OLD.signer_address,
    OLD.target_address, OLD.value_wei, OLD.reserved_amount_atomic,
    OLD.replacement_of_effect_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'reward chain effect identity is immutable';
  END IF;
  IF OLD.signed_transaction IS NOT NULL AND ROW(
    NEW.nonce, NEW.calldata, NEW.calldata_hash,
    NEW.signed_transaction, NEW.signed_transaction_hash
  ) IS DISTINCT FROM ROW(
    OLD.nonce, OLD.calldata, OLD.calldata_hash,
    OLD.signed_transaction, OLD.signed_transaction_hash
  ) THEN
    RAISE EXCEPTION 'prepared reward transaction bytes are immutable';
  END IF;
  IF NEW.version = OLD.version THEN
    IF ROW(
      NEW.state, NEW.settled_amount_atomic, NEW.nonce, NEW.calldata, NEW.calldata_hash,
      NEW.signed_transaction, NEW.signed_transaction_hash, NEW.transaction_hash,
      NEW.replaced_by_effect_id, NEW.receipt_status, NEW.receipt_block_number,
      NEW.receipt_block_hash, NEW.receipt_hash, NEW.confirmations,
      NEW.failure_class, NEW.failure_reason, NEW.prepared_at,
      NEW.broadcast_at, NEW.confirmed_at
    ) IS DISTINCT FROM ROW(
      OLD.state, OLD.settled_amount_atomic, OLD.nonce, OLD.calldata, OLD.calldata_hash,
      OLD.signed_transaction, OLD.signed_transaction_hash, OLD.transaction_hash,
      OLD.replaced_by_effect_id, OLD.receipt_status, OLD.receipt_block_number,
      OLD.receipt_block_hash, OLD.receipt_hash, OLD.confirmations,
      OLD.failure_class, OLD.failure_reason, OLD.prepared_at,
      OLD.broadcast_at, OLD.confirmed_at
    ) THEN
      RAISE EXCEPTION 'reward chain state change requires next version';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'reward chain transition requires next version and time';
  END IF;
  IF NOT (
    (OLD.state = 'planned' AND NEW.state IN ('nonce_reserved', 'reclaimable_failed', 'terminal_failed'))
    OR (OLD.state = 'nonce_reserved' AND NEW.state IN ('prepared', 'reclaimable_failed', 'terminal_failed'))
    OR (OLD.state = 'prepared' AND NEW.state IN (
      'broadcast_pending', 'reclaimable_failed', 'terminal_failed'
    ))
    OR (OLD.state = 'broadcast_pending' AND NEW.state IN (
      'confirming', 'confirmed', 'reverted', 'replaced', 'reconciliation_required'
    ))
    OR (OLD.state = 'confirming' AND NEW.state IN (
      'confirmed', 'reverted', 'replaced', 'reconciliation_required'
    ))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'confirming', 'confirmed', 'reverted', 'replaced', 'terminal_failed'
    ))
  ) THEN
    RAISE EXCEPTION 'invalid reward chain effect transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_chain_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_chain_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_chain_effect();

CREATE FUNCTION validate_reward_chain_effect_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version > OLD.version AND NOT EXISTS (
    SELECT 1 FROM reward_chain_effect_transitions transition
     WHERE transition.effect_id = NEW.effect_id
       AND transition.target_version = NEW.version
  ) THEN
    RAISE EXCEPTION 'reward chain effect transition event is missing';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER reward_chain_effect_transition_pair
AFTER UPDATE ON reward_chain_effects DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_reward_chain_effect_transition();

CREATE FUNCTION guard_megapot_usdc_approval_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot USDC approval effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.approval_effect_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  IF chain_record.effect_kind <> 'usdc_approval'
     OR chain_record.chain_id <> attestation_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> attestation_record.usdc_address
     OR chain_record.reserved_amount_atomic <> 0
     OR NEW.spender_address <> attestation_record.jackpot_address THEN
    RAISE EXCEPTION 'Megapot USDC approval effect does not match deployment';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_usdc_approval_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_usdc_approval_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_usdc_approval_effect();

CREATE FUNCTION guard_megapot_usdc_approval_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  approval_record megapot_usdc_approval_effects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot USDC approval receipt evidence is append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.approval_effect_id FOR SHARE;
  SELECT * INTO approval_record FROM megapot_usdc_approval_effects
   WHERE approval_effect_id = NEW.approval_effect_id FOR SHARE;
  IF chain_record.state <> 'confirmed'
     OR chain_record.receipt_status <> 'success'
     OR chain_record.transaction_hash <> NEW.transaction_hash
     OR chain_record.receipt_block_number <> NEW.block_number
     OR chain_record.receipt_block_hash <> NEW.block_hash
     OR chain_record.receipt_hash <> NEW.receipt_hash
     OR chain_record.confirmations <> NEW.confirmations
     OR approval_record.attestation_id <> NEW.attestation_id
     OR approval_record.approved_amount_atomic <> NEW.approved_amount_atomic
     OR NEW.allowance_after_atomic < approval_record.minimum_allowance_atomic THEN
    RAISE EXCEPTION 'Megapot USDC approval receipt does not prove allowance';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_usdc_approval_receipt_evidence_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_usdc_approval_receipt_evidence
FOR EACH ROW EXECUTE FUNCTION guard_megapot_usdc_approval_receipt();

CREATE FUNCTION guard_megapot_purchase_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  observation_record megapot_drawing_observations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot purchase effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.purchase_effect_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  SELECT * INTO observation_record FROM megapot_drawing_observations
   WHERE observation_id = NEW.drawing_observation_id FOR SHARE;
  IF chain_record.effect_kind <> 'ticket_purchase'
     OR chain_record.chain_id <> attestation_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> attestation_record.jackpot_address
     OR chain_record.reserved_amount_atomic <> NEW.ticket_price_atomic
     OR NEW.recipient_address <> attestation_record.custody_address
     OR NEW.source_tag <> attestation_record.source_tag
     OR observation_record.attestation_id <> NEW.attestation_id
     OR observation_record.drawing_id <> NEW.drawing_id
     OR observation_record.ticket_price_atomic <> NEW.ticket_price_atomic
     OR NEW.normal_five > observation_record.ball_max
     OR NEW.bonusball > observation_record.bonusball_max THEN
    RAISE EXCEPTION 'Megapot purchase effect does not match deployment and drawing';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_ticket_purchase_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_ticket_purchase_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_purchase_effect();

CREATE FUNCTION guard_megapot_ticket_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purchase_record megapot_ticket_purchase_effects%ROWTYPE;
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot ticket inventory cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO purchase_record FROM megapot_ticket_purchase_effects
     WHERE purchase_effect_id = NEW.purchase_effect_id FOR SHARE;
    SELECT * INTO chain_record FROM reward_chain_effects
     WHERE effect_id = NEW.purchase_effect_id FOR SHARE;
    SELECT * INTO attestation_record FROM megapot_deployment_attestations
     WHERE attestation_id = NEW.attestation_id FOR SHARE;
    IF chain_record.state <> 'confirmed' OR chain_record.receipt_status <> 'success'
       OR chain_record.transaction_hash <> NEW.minted_transaction_hash
       OR purchase_record.pool_leg_id <> NEW.pool_leg_id
       OR purchase_record.drawing_id <> NEW.drawing_id
       OR purchase_record.attestation_id <> NEW.attestation_id
       OR NEW.custody_address <> attestation_record.custody_address
       OR NEW.status <> 'custodied' THEN
      RAISE EXCEPTION 'Megapot ticket inventory requires confirmed custody mint';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.attestation_id, NEW.ticket_id, NEW.purchase_effect_id,
    NEW.pool_leg_id, NEW.drawing_id, NEW.custody_address,
    NEW.owner_observation_block_number, NEW.owner_observation_block_hash,
    NEW.minted_transaction_hash, NEW.minted_log_index, NEW.acquired_at
  ) IS DISTINCT FROM ROW(
    OLD.attestation_id, OLD.ticket_id, OLD.purchase_effect_id,
    OLD.pool_leg_id, OLD.drawing_id, OLD.custody_address,
    OLD.owner_observation_block_number, OLD.owner_observation_block_hash,
    OLD.minted_transaction_hash, OLD.minted_log_index, OLD.acquired_at
  ) THEN
    RAISE EXCEPTION 'Megapot ticket inventory identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'custodied' AND NEW.status IN ('claim_pending', 'no_win'))
    OR (OLD.status = 'claim_pending' AND NEW.status = 'claimed')
  ) THEN
    RAISE EXCEPTION 'invalid Megapot ticket inventory transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_ticket_inventory_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON megapot_ticket_inventory
FOR EACH ROW EXECUTE FUNCTION guard_megapot_ticket_inventory();

CREATE FUNCTION guard_megapot_claim_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  attestation_record megapot_deployment_attestations%ROWTYPE;
  ticket_record megapot_ticket_inventory%ROWTYPE;
  sweep_record megapot_drawing_sweeps%ROWTYPE;
  sweep_evidence megapot_sweep_ticket_evidence%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Megapot claim effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.claim_effect_id FOR SHARE;
  SELECT * INTO attestation_record FROM megapot_deployment_attestations
   WHERE attestation_id = NEW.attestation_id FOR SHARE;
  SELECT * INTO ticket_record FROM megapot_ticket_inventory
   WHERE attestation_id = NEW.attestation_id AND ticket_id = NEW.ticket_id FOR SHARE;
  SELECT * INTO sweep_record FROM megapot_drawing_sweeps
   WHERE sweep_id = NEW.sweep_id FOR SHARE;
  SELECT * INTO sweep_evidence FROM megapot_sweep_ticket_evidence
   WHERE sweep_id = NEW.sweep_id AND ticket_id = NEW.ticket_id FOR SHARE;
  IF chain_record.effect_kind <> 'winnings_claim'
     OR chain_record.chain_id <> attestation_record.chain_id
     OR chain_record.signer_address <> attestation_record.custody_address
     OR chain_record.target_address <> attestation_record.jackpot_address
     OR ticket_record.pool_leg_id <> NEW.pool_leg_id
     OR ticket_record.drawing_id <> NEW.drawing_id
     OR ticket_record.status <> 'claim_pending'
     OR sweep_record.state <> 'complete'
     OR sweep_record.pool_leg_id <> NEW.pool_leg_id
     OR sweep_record.drawing_id <> NEW.drawing_id
     OR sweep_evidence.attestation_id <> NEW.attestation_id
     OR sweep_evidence.tier_id IN (0, 2)
     OR sweep_evidence.gross_winnings_atomic <> NEW.expected_gross_winnings_atomic
     OR sweep_evidence.net_winnings_atomic <> NEW.expected_net_winnings_atomic
     OR sweep_evidence.referral_accrual_atomic <>
          NEW.expected_referral_accrual_atomic THEN
    RAISE EXCEPTION 'Megapot claim effect does not match custody ticket';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_claim_effects_change_guard
BEFORE INSERT ON megapot_claim_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_claim_effect();

CREATE FUNCTION validate_megapot_allocation_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_batch_id TEXT;
  batch_record megapot_allocation_batches%ROWTYPE;
  snapshot_record megapot_pool_beneficiary_snapshots%ROWTYPE;
  leg_record song_reward_offer_legs%ROWTYPE;
  allocation_total NUMERIC(78, 0);
  row_total INTEGER;
BEGIN
  target_batch_id := NEW.allocation_batch_id;
  SELECT * INTO batch_record FROM megapot_allocation_batches
   WHERE allocation_batch_id = target_batch_id;
  IF batch_record.allocation_batch_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO snapshot_record FROM megapot_pool_beneficiary_snapshots
   WHERE snapshot_id = batch_record.snapshot_id;
  SELECT * INTO leg_record FROM song_reward_offer_legs
   WHERE leg_id = batch_record.pool_leg_id;
  SELECT count(*), COALESCE(sum(amount_atomic), 0)
    INTO row_total, allocation_total FROM megapot_allocations
   WHERE allocation_batch_id = target_batch_id;
  IF row_total <> batch_record.allocation_count
     OR allocation_total <> batch_record.net_winnings_atomic
     OR row_total <> snapshot_record.leaf_count
     OR EXISTS (
       SELECT 1 FROM megapot_allocations allocation
       LEFT JOIN megapot_pool_snapshot_private_leaves leaf
         ON leaf.snapshot_id = snapshot_record.snapshot_id
        AND leaf.account_id = allocation.account_id
        AND leaf.persona_id = allocation.persona_id
       WHERE allocation.allocation_batch_id = target_batch_id
         AND leaf.account_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Megapot allocation batch does not conserve exact snapshot winnings';
  END IF;
  IF snapshot_record.fallback THEN
    IF row_total <> 1 OR NOT EXISTS (
      SELECT 1 FROM megapot_allocations allocation
       WHERE allocation.allocation_batch_id = target_batch_id
         AND allocation.account_id = leg_record.fallback_beneficiary_account_id
         AND ((leg_record.funding_source = 'leg_budget'
             AND allocation.allocation_kind = 'external_fallback')
           OR (leg_record.funding_source = 'shared_sponsor_budget'
             AND allocation.allocation_kind = 'platform_sponsorship'))
    ) THEN
      RAISE EXCEPTION 'Megapot fallback allocation is not exact';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM megapot_allocations allocation
     WHERE allocation.allocation_batch_id = target_batch_id
       AND allocation.allocation_kind <> 'participant'
  ) THEN
    RAISE EXCEPTION 'Megapot participant allocation contains fallback beneficiary';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER megapot_allocation_batch_exact
AFTER INSERT ON megapot_allocation_batches DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_allocation_batch();
CREATE CONSTRAINT TRIGGER megapot_allocation_row_exact
AFTER INSERT ON megapot_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_allocation_batch();

CREATE FUNCTION guard_reward_payout_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  credit_record reward_ledger_credits%ROWTYPE;
  wallet_record persona_wallet_assignments%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward payout effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.payout_effect_id FOR SHARE;
  SELECT * INTO credit_record FROM reward_ledger_credits
   WHERE credit_id = NEW.credit_id FOR SHARE;
  SELECT * INTO wallet_record FROM persona_wallet_assignments
   WHERE assignment_id = NEW.wallet_assignment_id FOR SHARE;
  IF chain_record.effect_kind <> 'reward_payout'
     OR chain_record.reserved_amount_atomic <> NEW.amount_atomic
     OR credit_record.account_id <> NEW.account_id
     OR credit_record.payout_persona_id <> NEW.payout_persona_id
     OR credit_record.amount_atomic - credit_record.paid_atomic < NEW.amount_atomic
     OR wallet_record.account_id <> NEW.account_id
     OR wallet_record.persona_id <> NEW.payout_persona_id
     OR wallet_record.status <> 'active'
     OR wallet_record.address <> NEW.destination_address
     OR chain_record.target_address <> NEW.destination_address THEN
    RAISE EXCEPTION 'reward payout does not match credit and active persona wallet';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_payout_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_payout_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_payout_effect();

CREATE FUNCTION guard_reward_refund_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
  funding_record song_reward_leg_funding_effects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward refund effects are append-only';
  END IF;
  SELECT * INTO chain_record FROM reward_chain_effects
   WHERE effect_id = NEW.refund_effect_id FOR SHARE;
  SELECT * INTO funding_record FROM song_reward_leg_funding_effects
   WHERE funding_effect_id = NEW.funding_effect_id FOR SHARE;
  IF chain_record.effect_kind <> 'reward_refund'
     OR chain_record.reserved_amount_atomic <> NEW.amount_atomic
     OR chain_record.target_address <> NEW.destination_address
     OR funding_record.leg_id <> NEW.leg_id
     OR funding_record.funder_account_id <> NEW.funder_account_id
     OR funding_record.state <> 'confirmed'
     OR NEW.amount_atomic > funding_record.confirmed_amount_atomic THEN
    RAISE EXCEPTION 'reward refund does not match confirmed contribution';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_refund_effects_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON reward_refund_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_refund_effect();

CREATE FUNCTION guard_megapot_commitment_effect() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot commitment effects cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.commitment_effect_id, NEW.snapshot_id, NEW.payload_hash,
      NEW.signing_key_id, NEW.signature, NEW.prepared_at, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.commitment_effect_id, OLD.snapshot_id, OLD.payload_hash,
      OLD.signing_key_id, OLD.signature, OLD.prepared_at, OLD.created_at
    ) OR OLD.state <> 'prepared' OR NEW.state <> 'published' THEN
      RAISE EXCEPTION 'invalid Megapot commitment publication';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_commitment_effects_change_guard
BEFORE UPDATE OR DELETE ON megapot_pool_commitment_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_commitment_effect();

CREATE FUNCTION guard_megapot_claim_effect_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chain_record reward_chain_effects%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot claim effects cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.claim_effect_id, NEW.attestation_id, NEW.ticket_id, NEW.pool_leg_id,
      NEW.drawing_id, NEW.sweep_id, NEW.expected_gross_winnings_atomic,
      NEW.expected_net_winnings_atomic, NEW.expected_referral_accrual_atomic,
      NEW.custody_balance_before_atomic, NEW.referral_balance_before_atomic,
      NEW.preflight_block_number, NEW.preflight_block_hash, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.claim_effect_id, OLD.attestation_id, OLD.ticket_id, OLD.pool_leg_id,
      OLD.drawing_id, OLD.sweep_id, OLD.expected_gross_winnings_atomic,
      OLD.expected_net_winnings_atomic, OLD.expected_referral_accrual_atomic,
      OLD.custody_balance_before_atomic, OLD.referral_balance_before_atomic,
      OLD.preflight_block_number, OLD.preflight_block_hash, OLD.created_at
    ) OR OLD.received_atomic IS NOT NULL OR OLD.referral_accrual_atomic IS NOT NULL
       OR OLD.claim_log_index IS NOT NULL OR OLD.burn_log_index IS NOT NULL
       OR OLD.referral_log_index IS NOT NULL OR OLD.transfer_log_index IS NOT NULL
       OR NEW.received_atomic IS NULL OR NEW.referral_accrual_atomic IS NULL
       OR NEW.claim_log_index IS NULL OR NEW.burn_log_index IS NULL
       OR NEW.referral_log_index IS NULL OR NEW.transfer_log_index IS NULL THEN
      RAISE EXCEPTION 'invalid Megapot claim observation update';
    END IF;
    SELECT * INTO chain_record FROM reward_chain_effects
     WHERE effect_id = NEW.claim_effect_id FOR SHARE;
    IF chain_record.state <> 'confirmed'
       OR chain_record.settled_amount_atomic <> NEW.received_atomic THEN
      RAISE EXCEPTION 'Megapot claim observation requires confirmed exact receipt';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_claim_effects_update_guard
BEFORE UPDATE OR DELETE ON megapot_claim_effects
FOR EACH ROW EXECUTE FUNCTION guard_megapot_claim_effect_change();

CREATE FUNCTION guard_megapot_allocation_batch_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot allocation batches cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(
      NEW.allocation_batch_id, NEW.pool_leg_id, NEW.drawing_id, NEW.snapshot_id,
      NEW.claim_effect_id, NEW.algorithm_version, NEW.net_winnings_atomic,
      NEW.allocation_count, NEW.allocation_hash, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.allocation_batch_id, OLD.pool_leg_id, OLD.drawing_id, OLD.snapshot_id,
      OLD.claim_effect_id, OLD.algorithm_version, OLD.net_winnings_atomic,
      OLD.allocation_count, OLD.allocation_hash, OLD.created_at
    ) OR OLD.state <> 'prepared' OR NEW.state <> 'credited'
  ) THEN
    RAISE EXCEPTION 'invalid Megapot allocation batch transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_allocation_batches_change_guard
BEFORE UPDATE OR DELETE ON megapot_allocation_batches
FOR EACH ROW EXECUTE FUNCTION guard_megapot_allocation_batch_change();

CREATE FUNCTION guard_reward_ledger_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward ledger credits cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.credit_id, NEW.account_id, NEW.payout_persona_id, NEW.chain_id,
      NEW.token_address, NEW.amount_atomic, NEW.source_kind,
      NEW.source_reference, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.credit_id, OLD.account_id, OLD.payout_persona_id, OLD.chain_id,
      OLD.token_address, OLD.amount_atomic, OLD.source_kind,
      OLD.source_reference, OLD.created_at
    ) OR NEW.reserved_atomic < 0 OR NEW.paid_atomic < OLD.paid_atomic
       OR NEW.updated_at <= OLD.updated_at
       OR NOT (
         NEW.state = OLD.state
         OR (OLD.state = 'credited' AND NEW.state IN ('payout_reserved', 'reconciliation_required'))
         OR (OLD.state = 'payout_reserved' AND NEW.state IN (
           'credited', 'payout_pending', 'reconciliation_required'
         ))
         OR (OLD.state = 'payout_pending' AND NEW.state IN ('sent', 'reconciliation_required'))
         OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
           'credited', 'payout_reserved', 'payout_pending', 'sent'
         ))
       ) THEN
      RAISE EXCEPTION 'invalid reward ledger credit transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_ledger_credits_change_guard
BEFORE UPDATE OR DELETE ON reward_ledger_credits
FOR EACH ROW EXECUTE FUNCTION guard_reward_ledger_credit();

CREATE FUNCTION validate_reward_ledger_credit_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind IN ('megapot_allocation', 'external_fallback') THEN
    IF NOT EXISTS (
      SELECT 1 FROM megapot_allocations allocation
       WHERE allocation.credit_id = NEW.credit_id
         AND allocation.account_id = NEW.account_id
         AND allocation.persona_id = NEW.payout_persona_id
         AND allocation.amount_atomic = NEW.amount_atomic
         AND ((NEW.source_kind = 'megapot_allocation'
              AND allocation.allocation_kind = 'participant')
           OR (NEW.source_kind = 'external_fallback'
              AND allocation.allocation_kind = 'external_fallback'))
    ) THEN
      RAISE EXCEPTION 'reward ledger credit lacks exact Megapot allocation';
    END IF;
  ELSIF NEW.source_kind = 'asset_bonus' AND NOT EXISTS (
    SELECT 1 FROM song_reward_bundle_claim_legs claim_leg
     WHERE claim_leg.credit_id = NEW.credit_id
       AND claim_leg.account_id = NEW.account_id
       AND claim_leg.amount_atomic = NEW.amount_atomic
  ) THEN
    RAISE EXCEPTION 'reward ledger credit lacks exact asset claim';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER reward_ledger_credit_source_pair
AFTER INSERT ON reward_ledger_credits DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_reward_ledger_credit_source();

CREATE FUNCTION reject_reward_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;
CREATE TRIGGER megapot_drawing_observations_append_only
BEFORE UPDATE OR DELETE ON megapot_drawing_observations
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER reward_eligibility_decisions_append_only
BEFORE UPDATE OR DELETE ON reward_eligibility_decisions
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER fallback_cutoff_evidence_append_only
BEFORE UPDATE OR DELETE ON megapot_fallback_cutoff_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER fallback_cutoff_activity_evidence_append_only
BEFORE UPDATE OR DELETE ON megapot_fallback_cutoff_activity_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER reward_chain_effect_transitions_append_only
BEFORE UPDATE OR DELETE ON reward_chain_effect_transitions
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER megapot_drawing_transitions_append_only
BEFORE UPDATE OR DELETE ON megapot_pool_drawing_transitions
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER megapot_allocations_append_only
BEFORE UPDATE OR DELETE ON megapot_allocations
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER megapot_purchase_receipt_evidence_append_only
BEFORE UPDATE OR DELETE ON megapot_purchase_receipt_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER megapot_sweep_ticket_evidence_append_only
BEFORE UPDATE OR DELETE ON megapot_sweep_ticket_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER megapot_claim_receipt_evidence_append_only
BEFORE UPDATE OR DELETE ON megapot_claim_receipt_evidence
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER custody_solvency_observations_append_only
BEFORE UPDATE OR DELETE ON custody_solvency_observations
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER platform_referral_revenue_append_only
BEFORE UPDATE OR DELETE ON platform_referral_revenue_ledger
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();
CREATE TRIGGER platform_sponsorship_budget_entries_append_only
BEFORE UPDATE OR DELETE ON platform_sponsorship_budget_entries
FOR EACH ROW EXECUTE FUNCTION reject_reward_append_only_change();

CREATE FUNCTION guard_reward_asset_whitelist_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward asset whitelist rows cannot be deleted';
  END IF;
  IF ROW(
    NEW.chain_id, NEW.token_address, NEW.decimals, NEW.symbol, NEW.asset_kind,
    NEW.environment, NEW.policy_version, NEW.activated_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.chain_id, OLD.token_address, OLD.decimals, OLD.symbol, OLD.asset_kind,
    OLD.environment, OLD.policy_version, OLD.activated_at, OLD.created_at
  ) OR OLD.status <> 'active' OR NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'reward asset whitelist only permits retirement';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_asset_whitelist_change_guard
BEFORE UPDATE OR DELETE ON reward_asset_whitelist
FOR EACH ROW EXECUTE FUNCTION guard_reward_asset_whitelist_change();

CREATE FUNCTION guard_megapot_attestation_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot deployment attestations cannot be deleted';
  END IF;
  IF ROW(
    NEW.attestation_id, NEW.environment, NEW.chain_id, NEW.jackpot_address,
    NEW.usdc_address, NEW.ticket_nft_address, NEW.custody_address,
    NEW.referrer_address, NEW.source_tag, NEW.jackpot_code_hash,
    NEW.usdc_code_hash, NEW.ticket_nft_code_hash, NEW.attestation_block_number,
    NEW.attestation_block_hash, NEW.abi_version, NEW.verified_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.attestation_id, OLD.environment, OLD.chain_id, OLD.jackpot_address,
    OLD.usdc_address, OLD.ticket_nft_address, OLD.custody_address,
    OLD.referrer_address, OLD.source_tag, OLD.jackpot_code_hash,
    OLD.usdc_code_hash, OLD.ticket_nft_code_hash, OLD.attestation_block_number,
    OLD.attestation_block_hash, OLD.abi_version, OLD.verified_at, OLD.created_at
  ) OR OLD.status <> 'active' OR NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'Megapot deployment attestation only permits retirement';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_deployment_attestations_change_guard
BEFORE UPDATE OR DELETE ON megapot_deployment_attestations
FOR EACH ROW EXECUTE FUNCTION guard_megapot_attestation_change();

CREATE FUNCTION guard_reward_signer_nonce() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward signer nonce fences cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.chain_id <> OLD.chain_id OR NEW.signer_address <> OLD.signer_address
    OR NEW.next_nonce < OLD.next_nonce OR NEW.fence_version <> OLD.fence_version + 1
    OR NEW.observed_block_number < OLD.observed_block_number
    OR NEW.observed_at < OLD.observed_at OR NEW.updated_at <= OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'invalid reward signer nonce fence update';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reward_signer_nonces_change_guard
BEFORE UPDATE OR DELETE ON reward_signer_nonces
FOR EACH ROW EXECUTE FUNCTION guard_reward_signer_nonce();

CREATE FUNCTION guard_sponsor_daily_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sponsor daily totals cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW.sponsor_account_id, NEW.sponsor_day, NEW.sponsor_kind,
      NEW.ticket_ceiling, NEW.spend_ceiling_atomic, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.sponsor_account_id, OLD.sponsor_day, OLD.sponsor_kind,
      OLD.ticket_ceiling, OLD.spend_ceiling_atomic, OLD.created_at)
    OR NEW.reserved_ticket_count < OLD.reserved_ticket_count
    OR NEW.confirmed_ticket_count < OLD.confirmed_ticket_count
    OR NEW.released_ticket_count < OLD.released_ticket_count
    OR NEW.reserved_spend_atomic < OLD.reserved_spend_atomic
    OR NEW.confirmed_spend_atomic < OLD.confirmed_spend_atomic
    OR NEW.released_spend_atomic < OLD.released_spend_atomic
    OR NEW.updated_at <= OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'invalid sponsor daily total update';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sponsor_daily_ticket_totals_change_guard
BEFORE UPDATE OR DELETE ON sponsor_daily_ticket_totals
FOR EACH ROW EXECUTE FUNCTION guard_sponsor_daily_totals();

CREATE FUNCTION guard_megapot_drawing_sweep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Megapot drawing sweeps cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(
      NEW.sweep_id, NEW.pool_leg_id, NEW.attestation_id, NEW.drawing_id,
      NEW.observation_block_number, NEW.observation_block_hash,
      NEW.drawing_state_hash, NEW.ticket_count, NEW.winning_ticket_count,
      NEW.observed_at, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.sweep_id, OLD.pool_leg_id, OLD.attestation_id, OLD.drawing_id,
      OLD.observation_block_number, OLD.observation_block_hash,
      OLD.drawing_state_hash, OLD.ticket_count, OLD.winning_ticket_count,
      OLD.observed_at, OLD.created_at
    ) OR OLD.state <> 'observed'
       OR NEW.state NOT IN ('complete', 'reconciliation_required')
  ) THEN
    RAISE EXCEPTION 'invalid Megapot drawing sweep transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER megapot_drawing_sweeps_change_guard
BEFORE UPDATE OR DELETE ON megapot_drawing_sweeps
FOR EACH ROW EXECUTE FUNCTION guard_megapot_drawing_sweep();

CREATE FUNCTION validate_megapot_sweep_ticket_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_sweep_id TEXT;
  sweep_record megapot_drawing_sweeps%ROWTYPE;
  evidence_count INTEGER;
  winning_count INTEGER;
BEGIN
  target_sweep_id := NEW.sweep_id;
  SELECT * INTO sweep_record FROM megapot_drawing_sweeps
   WHERE sweep_id=target_sweep_id;
  IF sweep_record.sweep_id IS NULL OR sweep_record.state <> 'complete' THEN
    RAISE EXCEPTION 'Megapot sweep evidence requires a complete sweep';
  END IF;
  IF EXISTS (
    SELECT 1 FROM megapot_sweep_ticket_evidence evidence
    JOIN megapot_ticket_inventory ticket
      ON ticket.attestation_id=evidence.attestation_id
     AND ticket.ticket_id=evidence.ticket_id
    JOIN megapot_deployment_attestations attestation
      ON attestation.attestation_id=evidence.attestation_id
    WHERE evidence.sweep_id=target_sweep_id
      AND (ticket.pool_leg_id <> sweep_record.pool_leg_id
        OR ticket.drawing_id <> sweep_record.drawing_id
        OR evidence.attestation_id <> sweep_record.attestation_id
        OR evidence.custody_owner_address <> attestation.custody_address)
  ) THEN
    RAISE EXCEPTION 'Megapot sweep ticket evidence identity mismatch';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE tier_id NOT IN (0, 2))
    INTO evidence_count, winning_count
    FROM megapot_sweep_ticket_evidence WHERE sweep_id=target_sweep_id;
  IF evidence_count <> sweep_record.ticket_count
     OR winning_count <> sweep_record.winning_ticket_count THEN
    RAISE EXCEPTION 'Megapot sweep ticket evidence count mismatch';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER megapot_drawing_sweep_evidence_exact
AFTER INSERT ON megapot_drawing_sweeps DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_sweep_ticket_evidence();
CREATE CONSTRAINT TRIGGER megapot_sweep_ticket_evidence_exact
AFTER INSERT ON megapot_sweep_ticket_evidence DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_megapot_sweep_ticket_evidence();
