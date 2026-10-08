-- Phase-one restricted Telegram practice identity (Specs 006, 014 and 026).
-- The evidence is authenticated bot ingress only: it is never an independent
-- account association, a credential or a browser principal.
--
-- A row with no local_bot_id is the one private learner account reserved for a
-- numeric Telegram user across every bot. A row naming local_bot_id is an
-- isolated practice owner for that bot alone. It is issued when the sender
-- already has an independently associated Pirate account but no grant for the
-- bot, so that no second promotable account exists for the same person.
CREATE TABLE telegram_restricted_learners (
  account_id text PRIMARY KEY REFERENCES users(user_id),
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,15}$'),
  local_bot_id text CHECK (local_bot_id ~ '^[1-9][0-9]{0,15}$'),
  evidence text NOT NULL DEFAULT 'ingress_observed' CHECK (evidence = 'ingress_observed'),
  -- The ingress that carried the explicit 16-or-older chat action.
  affirmed_community_id text NOT NULL REFERENCES communities(community_id),
  affirmed_bot_id text NOT NULL CHECK (affirmed_bot_id ~ '^[1-9][0-9]{0,15}$'),
  affirmed_bot_epoch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (local_bot_id IS NULL OR local_bot_id = affirmed_bot_id)
);
CREATE UNIQUE INDEX telegram_restricted_learners_one_account
  ON telegram_restricted_learners(telegram_user_id) WHERE local_bot_id IS NULL;
CREATE UNIQUE INDEX telegram_restricted_learners_one_local_owner
  ON telegram_restricted_learners(telegram_user_id, local_bot_id) WHERE local_bot_id IS NOT NULL;

-- One neutral study persona per practice account and community, reused forever.
CREATE TABLE telegram_restricted_study_personas (
  account_id text NOT NULL REFERENCES telegram_restricted_learners(account_id),
  community_id text NOT NULL REFERENCES communities(community_id),
  persona_id text NOT NULL UNIQUE REFERENCES personas(persona_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, community_id)
);

-- The explicit 16-or-older answer is given once per community bot, by every
-- sender alike. A replaced bot is a new bot identity and asks again, whichever
-- kind of practice account the sender has, so the question never reveals whether
-- a Pirate account is associated with the sender.
CREATE TABLE telegram_restricted_bot_affirmations (
  account_id text NOT NULL REFERENCES telegram_restricted_learners(account_id),
  community_id text NOT NULL REFERENCES communities(community_id),
  bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,15}$'),
  bot_epoch text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, community_id, bot_id)
);

-- Stable identifiers let a later recovery contract upgrade the same account in
-- place. Nothing may repoint a reservation, a study persona or an affirmation.
CREATE FUNCTION protect_telegram_restricted_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Restricted Telegram practice identity is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER telegram_restricted_learners_immutable BEFORE UPDATE ON telegram_restricted_learners
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_restricted_identity();
CREATE TRIGGER telegram_restricted_study_personas_immutable BEFORE UPDATE ON telegram_restricted_study_personas
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_restricted_identity();
CREATE TRIGGER telegram_restricted_bot_affirmations_immutable BEFORE UPDATE ON telegram_restricted_bot_affirmations
  FOR EACH ROW EXECUTE FUNCTION protect_telegram_restricted_identity();

-- A restricted learner's sessions are practice only, whatever path started them.
-- Every Study session insert runs this, including ordinary website Study, so it
-- reads the reservation with definer rights instead of requiring a table grant
-- on each serving role.
CREATE FUNCTION require_restricted_learner_practice_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT NEW.telegram_practice_only AND EXISTS (
    SELECT 1 FROM telegram_restricted_learners WHERE account_id=NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Restricted Telegram learner sessions are practice only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
-- Only the trigger may run a definer function; no role can attach it elsewhere.
REVOKE ALL ON FUNCTION require_restricted_learner_practice_only() FROM PUBLIC;
DO $restricted_learner_practice_only$
DECLARE role_name TEXT;
BEGIN
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid='require_restricted_learner_practice_only()'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION require_restricted_learner_practice_only() FROM %I', role_name
    );
  END LOOP;
  EXECUTE format(
    'ALTER FUNCTION require_restricted_learner_practice_only() SET search_path TO %I, pg_temp',
    current_schema()
  );
END;
$restricted_learner_practice_only$;
CREATE TRIGGER study_restricted_learner_practice_only BEFORE INSERT ON study_sessions_v2
  FOR EACH ROW EXECUTE FUNCTION require_restricted_learner_practice_only();
