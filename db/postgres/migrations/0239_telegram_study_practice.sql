-- Telegram practice shares Study selection and grading, never reward admission.
ALTER TABLE study_sessions_v2 ADD COLUMN telegram_practice_only boolean NOT NULL DEFAULT FALSE;

CREATE FUNCTION protect_telegram_practice_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.telegram_practice_only IS DISTINCT FROM OLD.telegram_practice_only THEN
    RAISE EXCEPTION 'Study practice mode is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER study_telegram_practice_mode_immutable BEFORE UPDATE ON study_sessions_v2
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_practice_mode();

CREATE FUNCTION reject_telegram_practice_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.study_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM study_sessions_v2 WHERE session_id=NEW.study_session_id AND telegram_practice_only
  ) THEN
    RAISE EXCEPTION 'Telegram practice cannot create reward qualification' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_00_telegram_practice_not_rewarded BEFORE INSERT OR UPDATE ON activity_qualifications
  FOR EACH ROW EXECUTE FUNCTION reject_telegram_practice_qualification();

CREATE TABLE telegram_study_conversations (
  community_id text NOT NULL REFERENCES communities(community_id),
  bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  bot_epoch text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state)='object' AND octet_length(state::text)<=32768),
  lease_token text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,bot_id,telegram_user_id),
  CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);

CREATE INDEX telegram_link_transactions_pending_callback_idx
  ON telegram_link_transactions(state_hash,account_id,session_hash,browser_hash)
  WHERE state='pending';
