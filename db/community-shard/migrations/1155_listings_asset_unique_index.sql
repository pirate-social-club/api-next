-- A paid asset may have at most one listing in a community. The previous
-- non-unique lookup index left a read-then-write race in concurrent retries.
--
-- Do not silently reconcile duplicate rows here: listings are money-path
-- records and require an explicit operator decision before this migration can
-- succeed on a shard that already contains duplicates.
CREATE UNIQUE INDEX idx_listings_community_asset_unique
    ON listings(community_id, asset_id)
    WHERE asset_id IS NOT NULL;

-- Create first so a duplicate-data failure leaves the legacy lookup intact;
-- dropping it afterward is only an optimization.
DROP INDEX IF EXISTS idx_listings_asset;
