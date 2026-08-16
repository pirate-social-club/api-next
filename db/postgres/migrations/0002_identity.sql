-- api-next identity records used by session exchange and bearer verification.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  account JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_id_not_blank CHECK (btrim(user_id) <> '')
);

CREATE TABLE IF NOT EXISTS account_aliases (
  source_user_id TEXT PRIMARY KEY,
  canonical_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('alias', 'merge')),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'finalizing', 'completed', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_aliases_source_not_blank CHECK (btrim(source_user_id) <> ''),
  CONSTRAINT account_aliases_canonical_not_blank CHECK (btrim(canonical_user_id) <> '')
);

CREATE INDEX IF NOT EXISTS account_aliases_canonical_idx
  ON account_aliases (canonical_user_id);
