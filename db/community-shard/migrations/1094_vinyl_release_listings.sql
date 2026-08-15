ALTER TABLE listings
ADD COLUMN vinyl_release_provider TEXT CHECK (
    vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage')
);

ALTER TABLE listings
ADD COLUMN vinyl_release_url TEXT;

ALTER TABLE purchases
ADD COLUMN vinyl_release_provider TEXT CHECK (
    vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage')
);

ALTER TABLE purchases
ADD COLUMN vinyl_release_url TEXT;
