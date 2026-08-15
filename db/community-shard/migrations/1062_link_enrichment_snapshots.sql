ALTER TABLE posts
    ADD COLUMN link_enrichment_snapshot_json TEXT;

ALTER TABLE posts
    ADD COLUMN link_enrichment_synced_at TEXT;
