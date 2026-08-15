CREATE TABLE IF NOT EXISTS story_registration_effects (
  story_registration_effect_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  effect_key TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  registration_kind TEXT NOT NULL CHECK (registration_kind IN ('original', 'derivative')),
  creator_wallet_address TEXT NOT NULL,
  primary_content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('executing', 'confirmed', 'failed_prebroadcast', 'reconciliation_required')
  ),
  provider_tx_ref TEXT,
  result_json TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_registration_effects_asset
  ON story_registration_effects(community_id, asset_id);

CREATE INDEX IF NOT EXISTS idx_story_registration_effects_reconciliation
  ON story_registration_effects(status, updated_at)
  WHERE status = 'reconciliation_required';
