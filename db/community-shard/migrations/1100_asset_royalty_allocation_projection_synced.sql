-- Durable marker for royalty-allocation control-plane projection publication.
-- Set to 0 (atomically with the asset + allocation rows) when a verified
-- allocation still needs its global projection published. A scheduled
-- reconciler republishes from this community DB and flips it to 1, so a
-- transient control-plane outage cannot permanently hide collaborators from
-- discovery and notifications. Defaults to 1 (synced / not applicable) for
-- existing and single-owner assets. See core/specs/domain/royalty-allocation.md.
ALTER TABLE assets
ADD COLUMN royalty_allocation_projection_synced INTEGER NOT NULL DEFAULT 1 CHECK (
    royalty_allocation_projection_synced IN (0, 1)
);
