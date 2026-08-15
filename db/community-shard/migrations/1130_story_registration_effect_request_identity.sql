-- SQLite requires a non-NULL DEFAULT when ADD COLUMN introduces a NOT NULL
-- constraint on a table that may contain rows. The Story registration runtime
-- has not shipped, so production tables are empty. These sentinels are defense
-- in depth for restored/legacy rows: they cannot equal a valid chain, signer,
-- or calldata fingerprint, so request matching fails closed.
ALTER TABLE story_registration_effects ADD COLUMN chain_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE story_registration_effects ADD COLUMN signer_address TEXT NOT NULL DEFAULT '';
ALTER TABLE story_registration_effects ADD COLUMN call_data_hash TEXT NOT NULL DEFAULT '';
