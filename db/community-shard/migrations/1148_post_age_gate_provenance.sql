-- Record why an age gate was first applied. Existing gated rows predate durable
-- provenance and must remain explicitly unknown rather than being misattributed.

ALTER TABLE posts
    ADD COLUMN age_gate_source TEXT CHECK (
        age_gate_source IS NULL OR age_gate_source IN (
            'author',
            'community_default',
            'post_moderation',
            'bundle_moderation',
            'moderator',
            'legacy_unknown'
        )
    );

ALTER TABLE posts
    ADD COLUMN age_gate_evidence_ref TEXT;

ALTER TABLE posts
    ADD COLUMN age_gate_set_at TEXT;

UPDATE posts
SET age_gate_source = 'legacy_unknown',
    age_gate_set_at = updated_at
WHERE age_gate_policy = '18_plus';
