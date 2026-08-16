-- New registrations persist the complete immutable SDK request before any
-- broadcast. Existing rows remain NULL and must be reconciled explicitly;
-- runtime code never backfills them from newly recomputed inputs.
ALTER TABLE story_registration_effects ADD COLUMN durable_request_json TEXT;
