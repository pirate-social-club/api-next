ALTER TABLE community_assistant_policy
    ADD COLUMN telegram_private_assistant_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (telegram_private_assistant_enabled IN (0, 1));

ALTER TABLE community_assistant_policy
    ADD COLUMN telegram_preview_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (telegram_preview_enabled IN (0, 1));

ALTER TABLE community_assistant_policy
    ADD COLUMN telegram_preview_daily_cap INTEGER NOT NULL DEFAULT 5
        CHECK (telegram_preview_daily_cap BETWEEN 0 AND 50);
