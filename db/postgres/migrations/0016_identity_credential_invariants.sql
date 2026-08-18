-- Credential tombstones are terminal and ownership cannot change without a future,
-- explicitly audited recovery mechanism.

ALTER TABLE identity_credentials
  ADD COLUMN tombstoned_at TIMESTAMPTZ;

ALTER TABLE identity_credentials
  ADD CONSTRAINT identity_credentials_tombstone_time_check CHECK (
    (status = 'active' AND tombstoned_at IS NULL)
    OR (status = 'tombstoned' AND tombstoned_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION identity_credentials_enforce_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'identity credentials must be inserted active'
        USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_insert_active';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_app_id IS DISTINCT FROM OLD.provider_app_id
    OR NEW.provider_subject IS DISTINCT FROM OLD.provider_subject
    OR NEW.canonical_user_id IS DISTINCT FROM OLD.canonical_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity credential ownership and identity are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_identity_immutable';
  END IF;

  IF OLD.status = 'tombstoned' THEN
    RAISE EXCEPTION 'identity credential tombstones are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_tombstone_terminal';
  END IF;

  IF NEW.status = 'tombstoned' THEN
    NEW.tombstoned_at := COALESCE(NEW.tombstoned_at, now());
  ELSIF NEW.status <> 'active' OR NEW.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid identity credential lifecycle transition'
      USING ERRCODE = '23514', CONSTRAINT = 'identity_credentials_lifecycle';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_credentials_enforce_lifecycle
BEFORE INSERT OR UPDATE ON identity_credentials
FOR EACH ROW
EXECUTE FUNCTION identity_credentials_enforce_lifecycle();
