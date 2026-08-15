-- Shard-side projection of the control-plane claim intent. The control plane is
-- the lifecycle authority; these columns provide an idempotent issuance marker
-- and let quote revisions share one payment reservation.

ALTER TABLE community_handle_claim_quotes
    ADD COLUMN handle_claim_intent_id TEXT;

ALTER TABLE community_handle_label_reservations
    ADD COLUMN handle_claim_intent_id TEXT;

ALTER TABLE community_handles
    ADD COLUMN handle_claim_intent_id TEXT;

CREATE INDEX idx_community_handle_claim_quotes_intent
    ON community_handle_claim_quotes(handle_claim_intent_id, created_at DESC);

CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_intent
    ON community_handle_label_reservations(handle_claim_intent_id)
    WHERE status = 'active' AND handle_claim_intent_id IS NOT NULL;

CREATE UNIQUE INDEX idx_community_handles_claim_intent_once
    ON community_handles(handle_claim_intent_id)
    WHERE handle_claim_intent_id IS NOT NULL;
