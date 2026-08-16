ALTER TABLE assets
ADD COLUMN license_preset TEXT CHECK (
    license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
);

ALTER TABLE assets
ADD COLUMN commercial_rev_share_pct INTEGER CHECK (
    commercial_rev_share_pct IS NULL
    OR (commercial_rev_share_pct >= 0 AND commercial_rev_share_pct <= 100)
);
