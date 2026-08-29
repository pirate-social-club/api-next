-- Account-private language roles. Persona/public profile locale remains a
-- compatibility field and is not authority for either preference.

CREATE TABLE account_language_preferences (
  account_id TEXT PRIMARY KEY REFERENCES users (user_id),
  ui_locale TEXT CHECK (
    ui_locale IS NULL OR (
      char_length(ui_locale) <= 64
      AND ui_locale ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
    )
  ),
  study_helper_language TEXT CHECK (
    study_helper_language IS NULL OR (
      char_length(study_helper_language) <= 64
      AND study_helper_language ~ '^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
    )
  ),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION guard_account_language_preferences_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.account_id IS DISTINCT FROM NEW.account_id
     OR NEW.revision <> OLD.revision + 1
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'language preference update requires stable account and next revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_language_preferences_update_guard
  BEFORE UPDATE ON account_language_preferences
  FOR EACH ROW EXECUTE FUNCTION guard_account_language_preferences_update();

CREATE TRIGGER account_language_preferences_delete_guard
  BEFORE DELETE ON account_language_preferences
  FOR EACH ROW EXECUTE FUNCTION reject_localization_immutable_mutation();
