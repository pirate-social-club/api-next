ALTER TABLE posts
ADD COLUMN access_mode TEXT
CHECK (
    access_mode IS NULL OR access_mode IN ('public', 'locked')
);
