CREATE UNIQUE INDEX IF NOT EXISTS idx_community_handles_claim_blocking_namespace_label
    ON community_handles(namespace_id, label_normalized)
    WHERE status IN ('active', 'reserved');
