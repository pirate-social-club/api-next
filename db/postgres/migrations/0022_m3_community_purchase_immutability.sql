-- Enforce the append-only commerce source and quote snapshot boundary.
-- Migration 0021 remains byte-for-byte immutable; these guards are forward-only.

CREATE OR REPLACE FUNCTION guard_community_commerce_policy_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.community_id, NEW.policy_version, NEW.source_revision, NEW.issued_by,
    NEW.effective_at
  ) IS DISTINCT FROM ROW(
    OLD.community_id, OLD.policy_version, OLD.source_revision, OLD.issued_by,
    OLD.effective_at
  ) THEN
    RAISE EXCEPTION 'community commerce policy revision identity is immutable';
  END IF;

  IF OLD.superseded_at IS NOT NULL
    AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession is immutable';
  END IF;

  IF NEW.superseded_at IS NOT NULL AND NEW.superseded_at < OLD.effective_at THEN
    RAISE EXCEPTION 'community commerce policy revision supersession precedes effectiveness';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER community_commerce_policy_revision_update_guard
BEFORE UPDATE ON community_commerce_policy_revisions
FOR EACH ROW EXECUTE FUNCTION guard_community_commerce_policy_revision_update();

CREATE OR REPLACE FUNCTION reject_community_commerce_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER community_commerce_policy_revision_delete_guard
BEFORE DELETE ON community_commerce_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE TRIGGER community_commerce_eligibility_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_eligibility_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_pricing_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_pricing_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_route_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_money_route_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_allocation_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_allocation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_settlement_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_settlement_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_donation_policy_append_only
BEFORE UPDATE OR DELETE ON community_commerce_donation_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_eligibility_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_eligibility_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_pricing_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_pricing_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_verification_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_verification_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_route_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_route_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_allocation_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_allocation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_settlement_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_settlement_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_donation_snapshot_append_only
BEFORE UPDATE OR DELETE ON community_purchase_donation_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_commerce_operator_ledger_append_only
BEFORE UPDATE OR DELETE ON community_commerce_operator_ledger
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();
CREATE TRIGGER community_purchase_correction_event_append_only
BEFORE UPDATE OR DELETE ON community_purchase_correction_events
FOR EACH ROW EXECUTE FUNCTION reject_community_commerce_immutable_change();

CREATE OR REPLACE FUNCTION guard_community_purchase_quote_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.quote_id, NEW.purchase_id, NEW.community_id, NEW.actor_id, NEW.listing_id,
    NEW.policy_version, NEW.buyer_wallet_address, NEW.buyer_chain_id, NEW.chain_id,
    NEW.token_contract, NEW.token_decimals, NEW.treasury_address, NEW.amount_atomic,
    NEW.required_confirmations, NEW.quoted_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.quote_id, OLD.purchase_id, OLD.community_id, OLD.actor_id, OLD.listing_id,
    OLD.policy_version, OLD.buyer_wallet_address, OLD.buyer_chain_id, OLD.chain_id,
    OLD.token_contract, OLD.token_decimals, OLD.treasury_address, OLD.amount_atomic,
    OLD.required_confirmations, OLD.quoted_at, OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'community purchase quote terms are immutable';
  END IF;

  IF OLD.eligibility_snapshot_id IS NOT NULL
    AND NEW.eligibility_snapshot_id IS DISTINCT FROM OLD.eligibility_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.pricing_snapshot_id IS NOT NULL
    AND NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.verification_snapshot_id IS NOT NULL
    AND NEW.verification_snapshot_id IS DISTINCT FROM OLD.verification_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.route_snapshot_id IS NOT NULL
    AND NEW.route_snapshot_id IS DISTINCT FROM OLD.route_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.allocation_snapshot_id IS NOT NULL
    AND NEW.allocation_snapshot_id IS DISTINCT FROM OLD.allocation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.settlement_snapshot_id IS NOT NULL
    AND NEW.settlement_snapshot_id IS DISTINCT FROM OLD.settlement_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;
  IF OLD.donation_snapshot_id IS NOT NULL
    AND NEW.donation_snapshot_id IS DISTINCT FROM OLD.donation_snapshot_id THEN
    RAISE EXCEPTION 'community purchase quote snapshot binding is immutable';
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('active', 'bound', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'community purchase quote transition is not allowed: % -> %', OLD.status, NEW.status;
END;
$$;

CREATE TRIGGER community_purchase_quote_update_guard
BEFORE UPDATE ON community_purchase_quotes
FOR EACH ROW EXECUTE FUNCTION guard_community_purchase_quote_update();
