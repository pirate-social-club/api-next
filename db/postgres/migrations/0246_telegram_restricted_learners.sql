-- Phase-one restricted Telegram practice identity (Specs 006, 014 and 026).
-- One private learner account per numeric Telegram user across every bot. The
-- evidence is authenticated bot ingress only: it is never an independent
-- account association, a credential or a browser principal.
CREATE TABLE telegram_restricted_learners (
  telegram_user_id text PRIMARY KEY CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  account_id text NOT NULL UNIQUE REFERENCES users(user_id),
  evidence text NOT NULL DEFAULT 'ingress_observed' CHECK (evidence = 'ingress_observed'),
  -- The ingress that carried the explicit 16-or-older chat action.
  affirmed_community_id text NOT NULL REFERENCES communities(community_id),
  affirmed_bot_id text NOT NULL CHECK (affirmed_bot_id ~ '^[1-9][0-9]{0,15}$'),
  affirmed_bot_epoch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One neutral study persona per learner account and community, reused forever.
CREATE TABLE telegram_restricted_study_personas (
  account_id text NOT NULL REFERENCES telegram_restricted_learners(account_id),
  community_id text NOT NULL REFERENCES communities(community_id),
  persona_id text NOT NULL UNIQUE REFERENCES personas(persona_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, community_id)
);

-- Stable identifiers let a later recovery contract upgrade the same account in
-- place. Nothing may repoint a reservation or a study persona.
CREATE FUNCTION protect_telegram_restricted_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Restricted Telegram practice identity is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER telegram_restricted_learners_immutable BEFORE UPDATE ON telegram_restricted_learners
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_restricted_identity();
CREATE TRIGGER telegram_restricted_study_personas_immutable BEFORE UPDATE ON telegram_restricted_study_personas
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_restricted_identity();

-- A restricted learner's sessions are practice only, whatever path started them.
CREATE FUNCTION require_restricted_learner_practice_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.telegram_practice_only AND EXISTS (
    SELECT 1 FROM telegram_restricted_learners WHERE account_id=NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Restricted Telegram learner sessions are practice only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER study_restricted_learner_practice_only BEFORE INSERT ON study_sessions_v2
  FOR EACH ROW EXECUTE FUNCTION require_restricted_learner_practice_only();
