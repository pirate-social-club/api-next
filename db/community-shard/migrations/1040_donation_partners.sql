CREATE TABLE IF NOT EXISTS donation_partners (
    donation_partner_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('endaoment')),
    provider_partner_ref TEXT,
    image_url TEXT,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'approved', 'rejected')),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
