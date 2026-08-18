-- External authentication subjects are credentials, not canonical account ids.

CREATE TABLE identity_credentials (
  credential_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('privy')),
  provider_app_id TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  canonical_user_id TEXT NOT NULL REFERENCES users (user_id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'tombstoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT identity_credentials_id_not_blank CHECK (btrim(credential_id) <> ''),
  CONSTRAINT identity_credentials_app_not_blank CHECK (btrim(provider_app_id) <> ''),
  CONSTRAINT identity_credentials_subject_not_blank CHECK (btrim(provider_subject) <> ''),
  CONSTRAINT identity_credentials_user_not_blank CHECK (btrim(canonical_user_id) <> ''),
  CONSTRAINT identity_credentials_canonical_values CHECK (
    provider_app_id = btrim(provider_app_id)
    AND provider_subject = btrim(provider_subject)
  ),
  CONSTRAINT identity_credentials_provider_subject_unique
    UNIQUE (provider, provider_app_id, provider_subject)
);

CREATE INDEX identity_credentials_user_status_idx
  ON identity_credentials (canonical_user_id, status, created_at DESC);
