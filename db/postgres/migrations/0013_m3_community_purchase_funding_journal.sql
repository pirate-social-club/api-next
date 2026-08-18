-- Concrete M3 community-purchase buyer-funding journal.
--
-- This is deliberately flow-specific. The shared money journal is not
-- extracted until community purchase and ordinary karaoke reward payout have
-- both proved its shape (spec 004 section 8).

CREATE TABLE community_purchase_funding_journal (
    operation_id text PRIMARY KEY,
    community_id text NOT NULL REFERENCES communities (community_id),
    actor_id text NOT NULL REFERENCES users (user_id),
    quote_id text NOT NULL,
    purchase_id text NOT NULL,
    policy_version bigint NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    token_decimals smallint NOT NULL,
    expected_sender text NOT NULL,
    expected_recipient text NOT NULL,
    expected_amount_atomic numeric(78, 0) NOT NULL,
    required_confirmations integer NOT NULL,
    state text NOT NULL,
    version bigint NOT NULL,
    snapshot jsonb NOT NULL,
    failure_tag text,
    failure_reason text,
    funding_receipt_status text,
    funding_transaction_hash text,
    funding_log_index integer,
    funding_observation_id text,
    lease_owner text,
    lease_fence_token bigint NOT NULL DEFAULT 0,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_operation_not_blank CHECK (btrim(operation_id) <> ''),
    CONSTRAINT community_purchase_funding_business_ids_not_blank CHECK (
      btrim(quote_id) <> '' AND btrim(purchase_id) <> ''
    ),
    CONSTRAINT community_purchase_funding_policy_version_check CHECK (policy_version > 0),
    CONSTRAINT community_purchase_funding_chain_id_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_token_check CHECK (
      token_contract ~ '^0x[0-9a-f]{40}$' AND token_decimals = 6
    ),
    CONSTRAINT community_purchase_funding_parties_check CHECK (
      expected_sender ~ '^0x[0-9a-f]{40}$'
      AND expected_recipient ~ '^0x[0-9a-f]{40}$'
    ),
    CONSTRAINT community_purchase_funding_amount_check CHECK (expected_amount_atomic > 0),
    CONSTRAINT community_purchase_funding_confirmations_check CHECK (required_confirmations > 0),
    CONSTRAINT community_purchase_funding_state_check CHECK (state IN (
      'planned', 'confirming', 'confirmed', 'reverted', 'reclaimable_failed',
      'reconciliation_required'
    )),
    CONSTRAINT community_purchase_funding_version_check CHECK (version > 0),
    CONSTRAINT community_purchase_funding_snapshot_object_check CHECK (jsonb_typeof(snapshot) = 'object'),
    CONSTRAINT community_purchase_funding_failure_coherence_check CHECK (
      (state IN ('planned', 'confirming', 'confirmed', 'reverted')
        AND failure_tag IS NULL AND failure_reason IS NULL)
      OR (state = 'reclaimable_failed'
        AND failure_tag = 'reclaimable' AND btrim(failure_reason) <> '')
      OR (state = 'reconciliation_required'
        AND failure_tag IN ('ambiguous', 'legacy') AND btrim(failure_reason) <> '')
    ),
    CONSTRAINT community_purchase_funding_receipt_shape_check CHECK (
      (funding_receipt_status IS NULL AND funding_transaction_hash IS NULL
        AND funding_log_index IS NULL AND funding_observation_id IS NULL)
      OR (funding_receipt_status = 'success'
        AND funding_transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND funding_log_index >= 0
        AND funding_observation_id ~ '^0x[0-9a-f]{64}$')
      OR (funding_receipt_status = 'reverted'
        AND funding_transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND funding_log_index IS NULL
        AND funding_observation_id ~ '^0x[0-9a-f]{64}$')
    ),
    CONSTRAINT community_purchase_funding_lease_shape_check CHECK (
      lease_fence_token >= 0
      AND ((lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL))
    )
);

CREATE INDEX community_purchase_funding_state_idx
    ON community_purchase_funding_journal (state, updated_at, operation_id);

CREATE INDEX community_purchase_funding_lease_idx
    ON community_purchase_funding_journal (lease_expires_at, operation_id)
    WHERE lease_owner IS NOT NULL;

CREATE TABLE community_purchase_funding_requests (
    actor_id text NOT NULL REFERENCES users (user_id),
    endpoint text NOT NULL,
    client_nonce text NOT NULL,
    request_hash text NOT NULL,
    canonical_request jsonb NOT NULL,
    operation_id text NOT NULL REFERENCES community_purchase_funding_journal (operation_id),
    status text NOT NULL,
    result jsonb NOT NULL,
    result_version bigint NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_requests_pkey PRIMARY KEY (actor_id, endpoint, client_nonce),
    CONSTRAINT community_purchase_funding_requests_endpoint_check
      CHECK (endpoint = 'community-purchase-funding'),
    CONSTRAINT community_purchase_funding_requests_nonce_not_blank CHECK (btrim(client_nonce) <> ''),
    CONSTRAINT community_purchase_funding_requests_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT community_purchase_funding_requests_request_object_check
      CHECK (jsonb_typeof(canonical_request) = 'object'),
    CONSTRAINT community_purchase_funding_requests_status_check CHECK (status IN (
      'planned', 'confirming', 'confirmed', 'reverted', 'reclaimable_failed',
      'reconciliation_required'
    )),
    CONSTRAINT community_purchase_funding_requests_result_object_check CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT community_purchase_funding_requests_result_version_check CHECK (result_version > 0)
);

CREATE INDEX community_purchase_funding_requests_operation_idx
    ON community_purchase_funding_requests (operation_id);

CREATE TABLE community_purchase_funding_transaction_claims (
    operation_id text PRIMARY KEY REFERENCES community_purchase_funding_journal (operation_id),
    chain_id bigint NOT NULL,
    transaction_hash text NOT NULL,
    successful_log_index integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_transaction_claims_chain_check CHECK (chain_id > 0),
    CONSTRAINT community_purchase_funding_transaction_claims_hash_check
      CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT community_purchase_funding_transaction_claims_log_check
      CHECK (successful_log_index IS NULL OR successful_log_index >= 0),
    CONSTRAINT community_purchase_funding_transaction_claims_hash_unique
      UNIQUE (chain_id, transaction_hash)
);

CREATE UNIQUE INDEX community_purchase_funding_transaction_claims_log_unique
    ON community_purchase_funding_transaction_claims (chain_id, transaction_hash, successful_log_index)
    WHERE successful_log_index IS NOT NULL;

CREATE TABLE community_purchase_funding_transitions (
    operation_id text NOT NULL REFERENCES community_purchase_funding_journal (operation_id),
    target_version bigint NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    event jsonb NOT NULL,
    observation_id text,
    transaction_hash text,
    log_index integer,
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_transitions_pkey PRIMARY KEY (operation_id, target_version),
    CONSTRAINT community_purchase_funding_transitions_version_check CHECK (target_version > 1),
    CONSTRAINT community_purchase_funding_transitions_source_check CHECK (source IN ('request', 'reconciler')),
    CONSTRAINT community_purchase_funding_transitions_event_type_not_blank CHECK (btrim(event_type) <> ''),
    CONSTRAINT community_purchase_funding_transitions_event_object_check CHECK (jsonb_typeof(event) = 'object'),
    CONSTRAINT community_purchase_funding_transitions_evidence_shape_check CHECK (
      (observation_id IS NULL AND transaction_hash IS NULL AND log_index IS NULL)
      OR (observation_id ~ '^0x[0-9a-f]{64}$'
        AND transaction_hash ~ '^0x[0-9a-f]{64}$'
        AND (log_index IS NULL OR log_index >= 0))
    ),
    CONSTRAINT community_purchase_funding_transitions_observation_unique
      UNIQUE (operation_id, observation_id)
);

CREATE TABLE community_purchase_funding_receipts (
    receipt_id text PRIMARY KEY,
    operation_id text NOT NULL UNIQUE REFERENCES community_purchase_funding_journal (operation_id),
    community_id text NOT NULL REFERENCES communities (community_id),
    purchase_id text NOT NULL,
    chain_id bigint NOT NULL,
    token_contract text NOT NULL,
    sender text NOT NULL,
    recipient text NOT NULL,
    amount_atomic numeric(78, 0) NOT NULL,
    transaction_hash text NOT NULL,
    log_index integer NOT NULL,
    block_number bigint NOT NULL,
    block_hash text NOT NULL,
    confirmed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT community_purchase_funding_receipts_id_not_blank CHECK (btrim(receipt_id) <> ''),
    CONSTRAINT community_purchase_funding_receipts_amount_check CHECK (amount_atomic > 0),
    CONSTRAINT community_purchase_funding_receipts_log_check CHECK (log_index >= 0),
    CONSTRAINT community_purchase_funding_receipts_transaction_unique
      UNIQUE (chain_id, transaction_hash),
    CONSTRAINT community_purchase_funding_receipts_log_unique
      UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE FUNCTION guard_community_purchase_funding_journal_update()
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
    (OLD.state = 'planned' AND NEW.state IN ('confirming', 'confirmed', 'reverted', 'reclaimable_failed'))
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

CREATE TRIGGER community_purchase_funding_journal_update_guard
BEFORE UPDATE ON community_purchase_funding_journal
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_funding_journal_update();

CREATE FUNCTION reject_community_purchase_funding_append_only_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community purchase funding evidence is append-only';
END;
$$;

CREATE TRIGGER community_purchase_funding_claims_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_transaction_claims
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_transitions_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_transitions
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();

CREATE TRIGGER community_purchase_funding_receipts_append_only
BEFORE UPDATE OR DELETE ON community_purchase_funding_receipts
FOR EACH ROW EXECUTE FUNCTION reject_community_purchase_funding_append_only_change();
