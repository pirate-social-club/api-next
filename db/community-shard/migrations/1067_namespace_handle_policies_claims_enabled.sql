ALTER TABLE namespace_handle_policies ADD COLUMN claims_enabled INTEGER NOT NULL DEFAULT 1 CHECK (claims_enabled IN (0, 1));
