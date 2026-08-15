ALTER TABLE assets
ADD COLUMN locked_delivery_storage_ref TEXT;

ALTER TABLE assets
ADD COLUMN locked_delivery_secret_json TEXT;
