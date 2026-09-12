-- A delivery operation can race a newer canonical revision. `desired` holds
-- the newest revision, while an operation that is sending or awaiting review
-- must remain pinned to the revision it started with so operator resolution
-- confirms or discards that operation rather than a payload enqueued later.
--
-- `intended`/`intended_hash` snapshot the operated revision at claim time.
-- Claiming overwrites them for each new operation. Confirmed finalization
-- clears them; failed and uncertain rows retain them for resolution. A
-- differing `desired_hash` then queues the newer revision instead of losing
-- it. Existing rows adopt their current desired state as their operated
-- revision.

ALTER TABLE community_telegram_deliveries
  ADD COLUMN intended JSONB,
  ADD COLUMN intended_hash TEXT;
ALTER TABLE community_telegram_deliveries
  ADD CONSTRAINT community_telegram_delivery_intent_pair
  CHECK ((intended IS NULL) = (intended_hash IS NULL));
UPDATE community_telegram_deliveries
  SET intended = desired, intended_hash = desired_hash;
