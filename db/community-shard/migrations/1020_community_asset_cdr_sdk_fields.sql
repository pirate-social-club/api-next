ALTER TABLE assets
ADD COLUMN story_cdr_encrypted_cid TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_allocate_tx_ref TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_write_tx_ref TEXT;
