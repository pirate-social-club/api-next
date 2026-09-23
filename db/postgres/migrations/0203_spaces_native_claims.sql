-- Native Spaces quote, reservation, and atomic claim.
--
-- Spec 012 §5.3.13.6-§5.3.13.8 and §5.3.13.12. A Spaces quote, reservation,
-- claim, and grant carry exactly one immutable persona Taproot recipient; the
-- HNS shape carries none. A Spaces claim is written issuance_pending with a
-- null grant in the same transaction as its registry item, its verification
-- schedule, its pending key fence, and its account-cap reservation. No Spaces
-- grant can be written until final issuance evidence exists, so this
-- migration refuses every Spaces grant insert. Every HNS predicate, branch,
-- and guard is preserved verbatim in its HNS arm.

-- The active-membership predicate of source revision 1 (§5.3.13.12): the
-- account holds a Spec 016 membership with status member. Pending, left, and
-- banned memberships, follows, and community-bound personas never satisfy it.
CREATE FUNCTION handle_spaces_membership_satisfied_v1(
  input_community_id TEXT,
  input_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM community_memberships AS membership
     WHERE membership.community_id = input_community_id
       AND membership.user_id = input_account_id
       AND membership.status = 'member'
  )
$$;

-- A recipient reference names the exact persona, network, and verified output
-- script of one Spec 014 §12 Taproot assignment.
CREATE UNIQUE INDEX persona_wallet_assignments_recipient_binding_uidx
  ON persona_wallet_assignments (assignment_id, persona_id, bitcoin_network, output_script_hex);

-- Recipient columns and family shapes (§5.3.13.6). The HNS arm of each check
-- repeats the original family and fulfillment predicates and requires every
-- recipient column to be null; the Spaces arm requires the persona Taproot
-- recipient and no nationality pin.
ALTER TABLE handle_quotes
  ADD COLUMN recipient_kind TEXT,
  ADD COLUMN recipient_network TEXT,
  ADD COLUMN recipient_taproot_assignment_id TEXT,
  ADD COLUMN recipient_script_pubkey_hex TEXT,
  DROP CONSTRAINT handle_quotes_family_check,
  DROP CONSTRAINT handle_quotes_fulfillment_kind_check,
  ADD CONSTRAINT handle_quote_family_shape CHECK (
    ((family = 'hns'::text)
      AND (fulfillment_kind = 'hosted_persona_v1'::text)
      AND recipient_kind IS NULL
      AND recipient_network IS NULL
      AND recipient_taproot_assignment_id IS NULL
      AND recipient_script_pubkey_hex IS NULL)
    OR ((family = 'spaces'
      AND fulfillment_kind = 'spaces_native_v1'
      AND recipient_kind = 'persona_taproot_v1'
      AND recipient_network IN ('mainnet', 'testnet4', 'regtest')
      AND is_handle_sales_identifier_v1(recipient_taproot_assignment_id, 128)
      AND recipient_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
      AND cardinality(evidence_use_ids) = 0
      AND nationality_qualification_pin IS NULL
      AND nationality_decision_id IS NULL) IS TRUE)
  ),
  ADD CONSTRAINT handle_quote_recipient_fk FOREIGN KEY (
    recipient_taproot_assignment_id,
    owner_persona_id,
    recipient_network,
    recipient_script_pubkey_hex
  ) REFERENCES persona_wallet_assignments (
    assignment_id,
    persona_id,
    bitcoin_network,
    output_script_hex
  );

ALTER TABLE handle_reservations
  ADD COLUMN recipient_kind TEXT,
  ADD COLUMN recipient_network TEXT,
  ADD COLUMN recipient_taproot_assignment_id TEXT,
  ADD COLUMN recipient_script_pubkey_hex TEXT,
  DROP CONSTRAINT handle_reservations_family_check,
  DROP CONSTRAINT handle_reservations_fulfillment_kind_check,
  ADD CONSTRAINT handle_reservation_family_shape CHECK (
    ((family = 'hns'::text)
      AND (fulfillment_kind = 'hosted_persona_v1'::text)
      AND recipient_kind IS NULL
      AND recipient_network IS NULL
      AND recipient_taproot_assignment_id IS NULL
      AND recipient_script_pubkey_hex IS NULL)
    OR ((family = 'spaces'
      AND fulfillment_kind = 'spaces_native_v1'
      AND recipient_kind = 'persona_taproot_v1'
      AND recipient_network IN ('mainnet', 'testnet4', 'regtest')
      AND is_handle_sales_identifier_v1(recipient_taproot_assignment_id, 128)
      AND recipient_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
      AND nationality_decision_id IS NULL) IS TRUE)
  ),
  ADD CONSTRAINT handle_reservation_recipient_fk FOREIGN KEY (
    recipient_taproot_assignment_id,
    owner_persona_id,
    recipient_network,
    recipient_script_pubkey_hex
  ) REFERENCES persona_wallet_assignments (
    assignment_id,
    persona_id,
    bitcoin_network,
    output_script_hex
  );

-- A Spaces claim never enters the HNS blocked state, and its single issuance
-- operation is derived from the claim id (§5.3.13.7).
ALTER TABLE handle_claims
  ADD COLUMN recipient_kind TEXT,
  ADD COLUMN recipient_network TEXT,
  ADD COLUMN recipient_taproot_assignment_id TEXT,
  ADD COLUMN recipient_script_pubkey_hex TEXT,
  DROP CONSTRAINT handle_claims_family_check,
  DROP CONSTRAINT handle_claims_fulfillment_kind_check,
  ADD CONSTRAINT handle_claim_family_shape CHECK (
    ((family = 'hns'::text)
      AND (fulfillment_kind = 'hosted_persona_v1'::text)
      AND recipient_kind IS NULL
      AND recipient_network IS NULL
      AND recipient_taproot_assignment_id IS NULL
      AND recipient_script_pubkey_hex IS NULL)
    OR ((family = 'spaces'
      AND fulfillment_kind = 'spaces_native_v1'
      AND recipient_kind = 'persona_taproot_v1'
      AND recipient_network IN ('mainnet', 'testnet4', 'regtest')
      AND is_handle_sales_identifier_v1(recipient_taproot_assignment_id, 128)
      AND recipient_script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
      AND state IN ('issuance_pending', 'issued', 'issuance_failed')
      AND issuance_operation_id = 'issuance:spaces-native:' || claim_id
      AND nationality_decision_id IS NULL) IS TRUE)
  ),
  ADD CONSTRAINT handle_claim_recipient_fk FOREIGN KEY (
    recipient_taproot_assignment_id,
    owner_persona_id,
    recipient_network,
    recipient_script_pubkey_hex
  ) REFERENCES persona_wallet_assignments (
    assignment_id,
    persona_id,
    bitcoin_network,
    output_script_hex
  ),
  ADD CONSTRAINT handle_claim_key_identity_unique UNIQUE (
    claim_id,
    family,
    namespace_root,
    handle_label
  );

ALTER TABLE handle_grants
  ADD COLUMN recipient_kind TEXT,
  ADD COLUMN recipient_network TEXT,
  ADD COLUMN recipient_taproot_assignment_id TEXT,
  ADD COLUMN recipient_script_pubkey_hex TEXT,
  DROP CONSTRAINT handle_grants_family_check,
  DROP CONSTRAINT handle_grants_fulfillment_kind_check,
  ADD CONSTRAINT handle_grant_family_shape CHECK (
    ((family = 'hns'::text)
      AND (fulfillment_kind = 'hosted_persona_v1'::text)
      AND recipient_kind IS NULL
      AND recipient_network IS NULL
      AND recipient_taproot_assignment_id IS NULL
      AND recipient_script_pubkey_hex IS NULL)
    OR ((family = 'spaces'
      AND fulfillment_kind = 'spaces_native_v1'
      AND recipient_kind = 'persona_taproot_v1'
      AND recipient_network IN ('mainnet', 'testnet4', 'regtest')
      AND is_handle_sales_identifier_v1(recipient_taproot_assignment_id, 128)
      AND recipient_script_pubkey_hex ~ '^5120[0-9a-f]{64}$') IS TRUE)
  ),
  ADD CONSTRAINT handle_grant_recipient_fk FOREIGN KEY (
    recipient_taproot_assignment_id,
    owner_persona_id,
    recipient_network,
    recipient_script_pubkey_hex
  ) REFERENCES persona_wallet_assignments (
    assignment_id,
    persona_id,
    bitcoin_network,
    output_script_hex
  );

-- External conflicts (§5.3.13.8). This minimal table exists so the key fence
-- can reference its conflict evidence; the registry acknowledgment and
-- occupancy observations that create rows, and any clearance record, arrive
-- with the registry contract. An observation is append-only and names the key
-- it blocks.
CREATE TABLE spaces_external_conflict_observations (
  observation_id TEXT PRIMARY KEY,
  family TEXT NOT NULL CHECK (family = 'spaces'),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (
    evidence_kind IN ('registry_acknowledgment_v1', 'occupancy_observation_v1')
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT spaces_external_conflict_key_unique UNIQUE (
    observation_id,
    family,
    namespace_root,
    handle_label
  ),
  CONSTRAINT spaces_external_conflict_identity_check CHECK (
    is_handle_sales_identifier_v1(observation_id, 128)
    AND is_community_route_root_label('spaces', namespace_root)
    AND handle_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    AND handle_label !~ '^xn--'
    AND octet_length(handle_label) BETWEEN 1 AND 62
    AND observed_at <= recorded_at
  )
);

CREATE TRIGGER spaces_external_conflict_observations_append_only
BEFORE UPDATE OR DELETE ON spaces_external_conflict_observations
FOR EACH ROW EXECUTE FUNCTION reject_handle_sales_append_only_change_v1();

-- The key fence gains two Spaces-only states (§5.3.13.8): pending issuance,
-- which references the claim, and external conflict, which references its
-- observation. Each reference carries the fence key, so a fence can never
-- point at another key's claim or observation. HNS fences keep the original
-- shape and never carry either state; a Spaces fence holds exactly one state.
ALTER TABLE handle_key_fences
  ADD COLUMN pending_claim_id TEXT,
  ADD COLUMN external_conflict_observation_id TEXT,
  DROP CONSTRAINT handle_key_fence_shape,
  ADD CONSTRAINT handle_key_fence_shape CHECK (
    ((family = 'hns'::text)
      AND ((live_reservation_id IS NOT NULL) OR (permanent_grant_id IS NOT NULL))
      AND pending_claim_id IS NULL
      AND external_conflict_observation_id IS NULL)
    OR ((family = 'spaces'
      AND num_nonnulls(
        live_reservation_id,
        permanent_grant_id,
        pending_claim_id,
        external_conflict_observation_id
      ) = 1) IS TRUE)
  ),
  ADD CONSTRAINT handle_key_fence_pending_claim_fk FOREIGN KEY (
    pending_claim_id,
    family,
    namespace_root,
    handle_label
  ) REFERENCES handle_claims (claim_id, family, namespace_root, handle_label),
  ADD CONSTRAINT handle_key_fence_external_conflict_fk FOREIGN KEY (
    external_conflict_observation_id,
    family,
    namespace_root,
    handle_label
  ) REFERENCES spaces_external_conflict_observations (
    observation_id,
    family,
    namespace_root,
    handle_label
  );

-- A pending Spaces claim occupies an account-cap slot from submission until it
-- is issued or fails terminally (§5.3.13.8). Sibling personas share the
-- account-scoped counter.
ALTER TABLE handle_account_offering_grant_counters
  ADD COLUMN pending_issuance_count BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT handle_account_offering_pending_issuance_count_check CHECK (
    pending_issuance_count >= 0
  );

-- One registry item per Spaces claim (§5.3.13.5), created in the claim
-- transaction with the claim's single immutable recipient. The item states are
-- the S1 issuance reducer states. While an unresolved item exists for a key,
-- no other operation may use that key.
CREATE TABLE spaces_registry_items (
  claim_id TEXT PRIMARY KEY,
  issuance_operation_id TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL CHECK (family = 'spaces'),
  network TEXT NOT NULL REFERENCES spaces_network_configuration (network),
  namespace_root TEXT NOT NULL,
  handle_label TEXT NOT NULL,
  handle TEXT NOT NULL,
  script_pubkey_hex TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'undelivered',
      'delivered',
      'redelivery_stopped',
      'settled_same_spk',
      'settled_different_spk',
      'settled_invalid',
      'withdrawn'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_registry_item_claim_fk FOREIGN KEY (
    claim_id,
    family,
    namespace_root,
    handle_label
  ) REFERENCES handle_claims (claim_id, family, namespace_root, handle_label),
  CONSTRAINT spaces_registry_item_identity_check CHECK (
    is_handle_sales_identifier_v1(claim_id, 128)
    AND issuance_operation_id = 'issuance:spaces-native:' || claim_id
    AND is_community_route_root_label('spaces', namespace_root)
    AND handle_label ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    AND handle_label !~ '^xn--'
    AND octet_length(handle_label) BETWEEN 1 AND 62
    AND handle = handle_label || '@' || namespace_root
    AND script_pubkey_hex ~ '^5120[0-9a-f]{64}$'
    AND updated_at >= created_at
  )
);

CREATE UNIQUE INDEX spaces_registry_items_unresolved_key_uidx
  ON spaces_registry_items (network, namespace_root, handle_label)
  WHERE state IN ('undelivered', 'delivered', 'redelivery_stopped');

-- A registry item matches its pending claim exactly at creation. Afterwards
-- only its state moves: it is withdrawn only before any delivery, never
-- returns to undelivered or delivered once redelivery stops, and a settled or
-- withdrawn item is final.
CREATE FUNCTION guard_spaces_registry_item_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces registry item cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
    IF claim.claim_id IS NULL
      OR claim.family <> 'spaces'
      OR claim.state <> 'issuance_pending'
      OR claim.issuance_operation_id <> NEW.issuance_operation_id
      OR claim.recipient_network <> NEW.network
      OR claim.recipient_script_pubkey_hex <> NEW.script_pubkey_hex
      OR claim.namespace_root <> NEW.namespace_root
      OR claim.handle_label <> NEW.handle_label
      OR NEW.state <> 'undelivered'
      OR NEW.created_at <> claim.created_at
      OR NEW.updated_at <> claim.created_at THEN
      RAISE EXCEPTION 'Spaces registry item must match its pending claim';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) - ARRAY['state','updated_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['state','updated_at']
    OR NEW.updated_at < OLD.updated_at
    OR OLD.state IN ('settled_same_spk', 'settled_different_spk', 'settled_invalid', 'withdrawn')
    OR (NEW.state = 'undelivered' AND OLD.state <> 'undelivered')
    OR (NEW.state = 'withdrawn' AND OLD.state <> 'undelivered')
    OR (NEW.state = 'delivered' AND OLD.state NOT IN ('undelivered', 'delivered')) THEN
    RAISE EXCEPTION 'Spaces registry item transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_registry_item_guard
BEFORE INSERT OR UPDATE OR DELETE ON spaces_registry_items
FOR EACH ROW EXECUTE FUNCTION guard_spaces_registry_item_v1();

-- The reconciler leases every due nonterminal Spaces claim, including one with
-- no acknowledgment or commit notification (§5.3.13.7). A registry callback
-- only marks verification due sooner. The overdue mark is what makes a
-- pending claim `delayed`; final evidence arrives with the reconciler.
CREATE TABLE spaces_issuance_verifications (
  claim_id TEXT PRIMARY KEY REFERENCES spaces_registry_items (claim_id),
  issuance_operation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'closed')),
  verification_due BOOLEAN NOT NULL,
  next_verification_at TIMESTAMPTZ NOT NULL,
  attempt_count BIGINT NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  last_attempted_at TIMESTAMPTZ,
  overdue_marked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT spaces_issuance_verification_identity_check CHECK (
    issuance_operation_id = 'issuance:spaces-native:' || claim_id
    AND updated_at >= created_at
    AND (last_attempted_at IS NULL OR last_attempted_at >= created_at)
    AND (overdue_marked_at IS NULL OR overdue_marked_at >= created_at)
  )
);

CREATE INDEX spaces_issuance_verifications_due_idx
  ON spaces_issuance_verifications (next_verification_at, claim_id)
  WHERE status = 'pending';

CREATE FUNCTION guard_spaces_issuance_verification_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Spaces issuance verification cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
    IF claim.claim_id IS NULL
      OR claim.family <> 'spaces'
      OR claim.state <> 'issuance_pending'
      OR claim.issuance_operation_id <> NEW.issuance_operation_id
      OR NEW.status <> 'pending'
      OR NEW.verification_due
      OR NEW.attempt_count <> 0
      OR NEW.last_attempted_at IS NOT NULL
      OR NEW.overdue_marked_at IS NOT NULL
      OR NEW.created_at <> claim.created_at
      OR NEW.updated_at <> claim.created_at
      OR NEW.next_verification_at < claim.created_at THEN
      RAISE EXCEPTION 'Spaces issuance verification must start pending with its claim';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.issuance_operation_id IS DISTINCT FROM OLD.issuance_operation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
    OR NEW.attempt_count < OLD.attempt_count
    OR (OLD.overdue_marked_at IS NOT NULL
      AND NEW.overdue_marked_at IS DISTINCT FROM OLD.overdue_marked_at)
    OR OLD.status <> 'pending'
    OR NEW.status NOT IN ('pending', 'verified', 'closed') THEN
    RAISE EXCEPTION 'Spaces issuance verification transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_issuance_verification_guard
BEFORE INSERT OR UPDATE OR DELETE ON spaces_issuance_verifications
FOR EACH ROW EXECUTE FUNCTION guard_spaces_issuance_verification_v1();

-- The persona's live Taproot recipient for the activation's network: active,
-- owned by the quoting account, and naming its verified output script. The
-- read reserves nothing and confers no wallet authority (§5.3.13.6).
CREATE FUNCTION is_spaces_handle_recipient_live_v1(
  input_account_id TEXT,
  input_persona_id TEXT,
  input_network TEXT,
  input_recipient_kind TEXT,
  input_recipient_network TEXT,
  input_taproot_assignment_id TEXT,
  input_script_pubkey_hex TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT input_recipient_kind = 'persona_taproot_v1'
     AND input_recipient_network = input_network
     AND EXISTS (
       SELECT 1
         FROM persona_wallet_assignments AS assignment
        WHERE assignment.assignment_id = input_taproot_assignment_id
          AND assignment.account_id = input_account_id
          AND assignment.persona_id = input_persona_id
          AND assignment.chain_account_kind = 'bitcoin-taproot'
          AND assignment.status = 'active'
          AND assignment.bitcoin_network = input_network
          AND assignment.output_script_hex = input_script_pubkey_hex
     )
$$;

-- Spaces quote guard (§5.3.13.6 and §5.3.13.12). It keeps every HNS offering
-- predicate except the display rule, which becomes `label@root` with the
-- Unicode display root (ruling Q9), and adds the Spaces grammar, the live
-- recipient on the activation's network, and the current membership.
CREATE FUNCTION assert_spaces_handle_quote_insert_v1(candidate handle_quotes)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  offering community_handle_offering_revisions%ROWTYPE;
  activation community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = candidate.offering_id
     AND offering_revision = candidate.offering_revision
   FOR SHARE;
  SELECT * INTO activation
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = candidate.sale_namespace_activation_id
     AND sale_namespace_activation_generation = candidate.sale_namespace_activation_generation
   FOR SHARE;
  IF offering.offering_id IS NULL
    OR activation.sale_namespace_activation_id IS NULL
    OR activation.family <> 'spaces'
    OR offering.offering_hash <> candidate.offering_hash
    OR offering.sale_namespace_activation_id <> candidate.sale_namespace_activation_id
    OR offering.sale_namespace_activation_generation <> candidate.sale_namespace_activation_generation
    OR offering.fulfillment_kind <> candidate.fulfillment_kind
    OR offering.family <> candidate.family
    OR offering.namespace_root <> candidate.namespace_root
    OR offering.display_root <> candidate.display_root
    OR offering.pricing_id <> candidate.pricing_id
    OR offering.pricing_revision <> candidate.pricing_revision
    OR offering.pricing_hash <> candidate.pricing_hash
    OR offering.atomic_amount <> candidate.atomic_amount
    OR offering.qualification_policy_revision <> candidate.eligibility_policy_revision
    OR offering.qualification_policy_hash <> candidate.eligibility_policy_hash
    OR candidate.status <> 'quoted'
    OR candidate.expires_at <> candidate.quoted_at + make_interval(secs => offering.quote_ttl_seconds)
    OR candidate.display_identifier <> candidate.handle_label || '@' || offering.display_root
    OR offering.label_scope_kind <> 'label_rule_v2'
    OR octet_length(candidate.handle_label)
         NOT BETWEEN offering.min_label_length AND offering.max_label_length
    OR candidate.handle_label !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    OR candidate.handle_label ~ '^xn--'
    OR octet_length(candidate.handle_label) > 62 THEN
    RAISE EXCEPTION 'Spaces handle quote does not match its immutable offering';
  END IF;
  IF is_spaces_handle_recipient_live_v1(
    candidate.actor_account_id,
    candidate.owner_persona_id,
    activation.spaces_network,
    candidate.recipient_kind,
    candidate.recipient_network,
    candidate.recipient_taproot_assignment_id,
    candidate.recipient_script_pubkey_hex
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle quote requires the persona''s live Taproot recipient';
  END IF;
  IF handle_spaces_membership_satisfied_v1(offering.community_id, candidate.actor_account_id)
       IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle quote requires an active community membership';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_handle_quote_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_handle_quote_insert_v1(NEW);
    RETURN NEW;
  END IF;

  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = NEW.offering_id
     AND offering_revision = NEW.offering_revision
   FOR SHARE;
  IF offering.offering_id IS NULL
    OR offering.offering_hash <> NEW.offering_hash
    OR offering.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR offering.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR offering.fulfillment_kind <> NEW.fulfillment_kind
    OR offering.family <> NEW.family
    OR offering.namespace_root <> NEW.namespace_root
    OR offering.display_root <> NEW.display_root
    OR offering.pricing_id <> NEW.pricing_id
    OR offering.pricing_revision <> NEW.pricing_revision
    OR offering.pricing_hash <> NEW.pricing_hash
    OR offering.atomic_amount <> NEW.atomic_amount
    OR offering.qualification_policy_revision <> NEW.eligibility_policy_revision
    OR offering.qualification_policy_hash <> NEW.eligibility_policy_hash
    OR NEW.status <> 'quoted'
    OR NEW.expires_at <> NEW.quoted_at + make_interval(secs => offering.quote_ttl_seconds)
    OR NEW.display_identifier <> NEW.handle_label || '.' || offering.display_root
    OR NOT (
      (offering.label_scope_kind = 'exact_label_v2' AND offering.exact_label = NEW.handle_label)
      OR (offering.label_scope_kind = 'label_rule_v2'
        AND octet_length(NEW.handle_label)
            BETWEEN offering.min_label_length AND offering.max_label_length)
    ) THEN
    RAISE EXCEPTION 'handle quote does not match its immutable offering';
  END IF;
  RETURN NEW;
END;
$$;

-- Spaces reservation guard: every HNS quote predicate, plus the quote's exact
-- recipient, still live, and the current membership (§5.1.3 recheck).
CREATE FUNCTION assert_spaces_handle_reservation_insert_v1(candidate handle_reservations)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  quote handle_quotes%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
  activation community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  SELECT * INTO quote FROM handle_quotes WHERE quote_id = candidate.quote_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = quote.offering_id
     AND offering_revision = quote.offering_revision
   FOR SHARE;
  SELECT * INTO activation
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = quote.sale_namespace_activation_id
     AND sale_namespace_activation_generation = quote.sale_namespace_activation_generation
   FOR SHARE;
  IF quote.quote_id IS NULL
    OR activation.sale_namespace_activation_id IS NULL
    OR quote.status <> 'quoted'
    OR quote.quote_hash <> candidate.quote_hash
    OR quote.actor_account_id <> candidate.actor_account_id
    OR quote.owner_persona_id <> candidate.owner_persona_id
    OR quote.offering_id <> candidate.offering_id
    OR quote.offering_hash <> candidate.offering_hash
    OR quote.sale_namespace_activation_id <> candidate.sale_namespace_activation_id
    OR quote.sale_namespace_activation_generation <> candidate.sale_namespace_activation_generation
    OR quote.fulfillment_kind <> candidate.fulfillment_kind
    OR quote.family <> candidate.family
    OR quote.namespace_root <> candidate.namespace_root
    OR quote.handle_label <> candidate.handle_label
    OR candidate.status <> 'reserved'
    OR candidate.expires_at
         <> candidate.reserved_at + make_interval(secs => offering.reservation_ttl_seconds)
    OR candidate.reserved_at >= quote.expires_at THEN
    RAISE EXCEPTION 'Spaces handle reservation does not match its immutable quote';
  END IF;
  IF ROW(
      candidate.recipient_kind,
      candidate.recipient_network,
      candidate.recipient_taproot_assignment_id,
      candidate.recipient_script_pubkey_hex
    ) IS DISTINCT FROM ROW(
      quote.recipient_kind,
      quote.recipient_network,
      quote.recipient_taproot_assignment_id,
      quote.recipient_script_pubkey_hex
    )
    OR is_spaces_handle_recipient_live_v1(
      candidate.actor_account_id,
      candidate.owner_persona_id,
      activation.spaces_network,
      candidate.recipient_kind,
      candidate.recipient_network,
      candidate.recipient_taproot_assignment_id,
      candidate.recipient_script_pubkey_hex
    ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle reservation recipient changed since its quote';
  END IF;
  IF handle_spaces_membership_satisfied_v1(offering.community_id, candidate.actor_account_id)
       IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle reservation requires an active community membership';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_handle_reservation_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quote handle_quotes%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_handle_reservation_insert_v1(NEW);
    RETURN NEW;
  END IF;

  SELECT * INTO quote FROM handle_quotes WHERE quote_id = NEW.quote_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = quote.offering_id
     AND offering_revision = quote.offering_revision
   FOR SHARE;
  IF quote.quote_id IS NULL
    OR quote.status <> 'quoted'
    OR quote.quote_hash <> NEW.quote_hash
    OR quote.actor_account_id <> NEW.actor_account_id
    OR quote.owner_persona_id <> NEW.owner_persona_id
    OR quote.offering_id <> NEW.offering_id
    OR quote.offering_hash <> NEW.offering_hash
    OR quote.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR quote.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR quote.fulfillment_kind <> NEW.fulfillment_kind
    OR quote.family <> NEW.family
    OR quote.namespace_root <> NEW.namespace_root
    OR quote.handle_label <> NEW.handle_label
    OR NEW.status <> 'reserved'
    OR NEW.expires_at <> NEW.reserved_at + make_interval(secs => offering.reservation_ttl_seconds)
    OR NEW.reserved_at >= quote.expires_at THEN
    RAISE EXCEPTION 'handle reservation does not match its immutable quote';
  END IF;
  RETURN NEW;
END;
$$;

-- Spaces claim guard (§5.3.13.7): every HNS reservation predicate, the
-- reservation's exact recipient still live, the current membership frozen for
-- the claim, and the pending state with a null grant.
CREATE FUNCTION assert_spaces_handle_claim_insert_v1(candidate handle_claims)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  reservation handle_reservations%ROWTYPE;
  quote handle_quotes%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
  activation community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  SELECT * INTO reservation
    FROM handle_reservations
   WHERE reservation_id = candidate.reservation_id
   FOR SHARE;
  SELECT * INTO quote FROM handle_quotes WHERE quote_id = reservation.quote_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = quote.offering_id
     AND offering_revision = quote.offering_revision
   FOR SHARE;
  SELECT * INTO activation
    FROM community_handle_sale_namespace_activation_revisions
   WHERE sale_namespace_activation_id = reservation.sale_namespace_activation_id
     AND sale_namespace_activation_generation = reservation.sale_namespace_activation_generation
   FOR SHARE;
  IF reservation.reservation_id IS NULL
    OR activation.sale_namespace_activation_id IS NULL
    OR reservation.status <> 'reserved'
    OR reservation.reservation_hash <> candidate.reservation_hash
    OR reservation.actor_account_id <> candidate.actor_account_id
    OR reservation.owner_persona_id <> candidate.owner_persona_id
    OR reservation.quote_id <> candidate.quote_id
    OR reservation.offering_id <> candidate.offering_id
    OR reservation.offering_hash <> candidate.offering_hash
    OR reservation.sale_namespace_activation_id <> candidate.sale_namespace_activation_id
    OR reservation.sale_namespace_activation_generation
         <> candidate.sale_namespace_activation_generation
    OR reservation.fulfillment_kind <> candidate.fulfillment_kind
    OR reservation.family <> candidate.family
    OR reservation.namespace_root <> candidate.namespace_root
    OR reservation.handle_label <> candidate.handle_label
    OR quote.display_identifier <> candidate.display_identifier
    OR quote.pricing_revision <> candidate.pricing_revision
    OR quote.pricing_hash <> candidate.pricing_hash
    OR quote.atomic_amount <> candidate.atomic_amount
    OR candidate.state <> 'issuance_pending'
    OR candidate.grant_id IS NOT NULL THEN
    RAISE EXCEPTION 'Spaces handle claim does not match its immutable reservation';
  END IF;
  IF ROW(
      candidate.recipient_kind,
      candidate.recipient_network,
      candidate.recipient_taproot_assignment_id,
      candidate.recipient_script_pubkey_hex
    ) IS DISTINCT FROM ROW(
      reservation.recipient_kind,
      reservation.recipient_network,
      reservation.recipient_taproot_assignment_id,
      reservation.recipient_script_pubkey_hex
    )
    OR is_spaces_handle_recipient_live_v1(
      candidate.actor_account_id,
      candidate.owner_persona_id,
      activation.spaces_network,
      candidate.recipient_kind,
      candidate.recipient_network,
      candidate.recipient_taproot_assignment_id,
      candidate.recipient_script_pubkey_hex
    ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle claim recipient changed since its reservation';
  END IF;
  IF handle_spaces_membership_satisfied_v1(offering.community_id, candidate.actor_account_id)
       IS NOT TRUE THEN
    RAISE EXCEPTION 'Spaces handle claim requires an active community membership';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_handle_claim_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  reservation handle_reservations%ROWTYPE;
  quote handle_quotes%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_handle_claim_insert_v1(NEW);
    RETURN NEW;
  END IF;

  SELECT * INTO reservation
    FROM handle_reservations
   WHERE reservation_id = NEW.reservation_id
   FOR SHARE;
  SELECT * INTO quote FROM handle_quotes WHERE quote_id = reservation.quote_id FOR SHARE;
  IF reservation.reservation_id IS NULL
    OR reservation.status <> 'reserved'
    OR reservation.reservation_hash <> NEW.reservation_hash
    OR reservation.actor_account_id <> NEW.actor_account_id
    OR reservation.owner_persona_id <> NEW.owner_persona_id
    OR reservation.quote_id <> NEW.quote_id
    OR reservation.offering_id <> NEW.offering_id
    OR reservation.offering_hash <> NEW.offering_hash
    OR reservation.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR reservation.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR reservation.fulfillment_kind <> NEW.fulfillment_kind
    OR reservation.family <> NEW.family
    OR reservation.namespace_root <> NEW.namespace_root
    OR reservation.handle_label <> NEW.handle_label
    OR quote.display_identifier <> NEW.display_identifier
    OR quote.pricing_revision <> NEW.pricing_revision
    OR quote.pricing_hash <> NEW.pricing_hash
    OR quote.atomic_amount <> NEW.atomic_amount THEN
    RAISE EXCEPTION 'handle claim does not match its immutable reservation';
  END IF;
  RETURN NEW;
END;
$$;

-- A Spaces grant is created only by the final-issuance reconciler, from
-- verified final evidence (§5.3.13.7). Until that path exists, every Spaces
-- grant insert is refused; the HNS branch is unchanged.
CREATE OR REPLACE FUNCTION validate_handle_grant_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim handle_claims%ROWTYPE;
  offering community_handle_offering_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    RAISE EXCEPTION 'Spaces handle grants require verified final issuance evidence';
  END IF;

  SELECT * INTO claim FROM handle_claims WHERE claim_id = NEW.claim_id FOR SHARE;
  SELECT * INTO offering
    FROM community_handle_offering_revisions
   WHERE offering_id = claim.offering_id
     AND offering_hash = claim.offering_hash
   FOR SHARE;
  IF claim.claim_id IS NULL
    OR claim.state <> 'issued'
    OR claim.grant_id <> NEW.grant_id
    OR offering.community_id <> NEW.community_id
    OR claim.actor_account_id <> NEW.owner_account_id
    OR claim.owner_persona_id <> NEW.owner_persona_id
    OR claim.offering_id <> NEW.offering_id
    OR claim.offering_hash <> NEW.offering_hash
    OR claim.sale_namespace_activation_id <> NEW.sale_namespace_activation_id
    OR claim.sale_namespace_activation_generation <> NEW.sale_namespace_activation_generation
    OR claim.fulfillment_kind <> NEW.fulfillment_kind
    OR claim.family <> NEW.family
    OR claim.namespace_root <> NEW.namespace_root
    OR claim.handle_label <> NEW.handle_label
    OR claim.display_identifier <> NEW.display_identifier
    OR NEW.status <> 'active'
    OR NEW.issued_at <> claim.created_at THEN
    RAISE EXCEPTION 'handle grant does not match its immutable claim';
  END IF;
  RETURN NEW;
END;
$$;

-- Claim changes (§5.3.13.7). An HNS claim is written in its final state and
-- stays immutable. A Spaces claim may move once, from issuance_pending to
-- issued or issuance_failed; its identity, recipient, operation, and hashes
-- never change, and no claim is ever deleted.
CREATE FUNCTION guard_handle_claim_change_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'handle claim cannot be deleted';
  END IF;
  IF OLD.family <> 'spaces' THEN
    RAISE EXCEPTION 'HNS handle claim is immutable';
  END IF;
  IF to_jsonb(NEW) - ARRAY['state','safe_reason','grant_id','updated_at']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['state','safe_reason','grant_id','updated_at']
    OR OLD.state <> 'issuance_pending'
    OR NEW.state NOT IN ('issued', 'issuance_failed')
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Spaces handle claim transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER handle_claim_change_guard
BEFORE UPDATE OR DELETE ON handle_claims
FOR EACH ROW EXECUTE FUNCTION guard_handle_claim_change_v1();
