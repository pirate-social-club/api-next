-- Spec 014 §§10-10.5: a public persona is activated only after its reserved
-- indexed EVM wallet has been confirmed. This migration performs no repair:
-- retained walletless public identities fail closed before any schema change.

DO $$
DECLARE
  active_without_one BIGINT;
  suspended_without_one BIGINT;
BEGIN
  SELECT count(*) INTO active_without_one
    FROM personas AS persona
   WHERE persona.status = 'active'
     AND 1 <> (
       SELECT count(*) FROM persona_wallet_assignments AS assignment
        WHERE assignment.persona_id = persona.persona_id
          AND assignment.chain_account_kind = 'evm'
          AND assignment.status = 'active'
     );
  SELECT count(*) INTO suspended_without_one
    FROM personas AS persona
   WHERE persona.status = 'suspended'
     AND 1 <> (
       SELECT count(*) FROM persona_wallet_assignments AS assignment
        WHERE assignment.persona_id = persona.persona_id
          AND assignment.chain_account_kind = 'evm'
          AND assignment.status = 'active'
     );
  IF active_without_one <> 0 OR suspended_without_one <> 0 THEN
    RAISE EXCEPTION 'persona wallet activation preflight failed: active_count=%, suspended_count=%',
      active_without_one, suspended_without_one USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE personas DROP CONSTRAINT personas_status_check;
ALTER TABLE personas ADD CONSTRAINT personas_status_check
  CHECK (status IN ('pending_wallet', 'active', 'suspended', 'retired'));

CREATE TABLE persona_pending_profiles (
  persona_id TEXT PRIMARY KEY REFERENCES personas (persona_id),
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) <= 80),
  avatar_ref TEXT CHECK (avatar_ref IS NULL OR char_length(avatar_ref) <= 2048),
  cover_ref TEXT CHECK (cover_ref IS NULL OR char_length(cover_ref) <= 2048),
  bio TEXT CHECK (bio IS NULL OR char_length(bio) <= 2000),
  preferred_locale TEXT CHECK (preferred_locale IS NULL OR char_length(preferred_locale) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE persona_pending_first_handles (
  persona_id TEXT PRIMARY KEY REFERENCES personas (persona_id),
  handle_id TEXT NOT NULL UNIQUE,
  label_normalized TEXT NOT NULL UNIQUE,
  label_display TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_persona_wallet_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_persona_id TEXT := COALESCE(NEW.persona_id, OLD.persona_id);
  target_status TEXT;
  active_wallets BIGINT;
  pending_wallets BIGINT;
  profiles BIGINT;
  pending_profiles BIGINT;
BEGIN
  SELECT status INTO target_status FROM personas WHERE persona_id = target_persona_id;
  IF target_status IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) FILTER (WHERE status = 'active'),
         count(*) FILTER (WHERE status = 'pending')
    INTO active_wallets, pending_wallets
    FROM persona_wallet_assignments
   WHERE persona_id = target_persona_id AND chain_account_kind = 'evm';
  SELECT count(*) INTO profiles FROM persona_profiles WHERE persona_id = target_persona_id;
  SELECT count(*) INTO pending_profiles
    FROM persona_pending_profiles WHERE persona_id = target_persona_id;

  IF target_status IN ('active', 'suspended')
     AND (active_wallets <> 1 OR profiles <> 1 OR pending_profiles <> 0) THEN
    RAISE EXCEPTION 'public persona requires one confirmed wallet and profile'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  IF target_status = 'pending_wallet'
     AND (pending_wallets <> 1 OR active_wallets <> 0 OR profiles <> 0 OR pending_profiles <> 1) THEN
    RAISE EXCEPTION 'pending persona requires one reserved wallet and private profile draft'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER personas_wallet_activation_invariant
AFTER INSERT OR UPDATE OF status ON personas
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_persona_wallet_activation();
CREATE CONSTRAINT TRIGGER persona_wallets_activation_invariant
AFTER INSERT OR UPDATE OF status ON persona_wallet_assignments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_persona_wallet_activation();
CREATE CONSTRAINT TRIGGER persona_profiles_activation_invariant
AFTER INSERT OR DELETE ON persona_profiles
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_persona_wallet_activation();
CREATE CONSTRAINT TRIGGER persona_pending_profiles_activation_invariant
AFTER INSERT OR DELETE ON persona_pending_profiles
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION validate_persona_wallet_activation();

CREATE OR REPLACE FUNCTION public_persona_projection(expected_persona_id TEXT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'persona_id', persona.persona_id,
    'object', 'persona',
    'display_name', profile.display_name,
    'avatar_ref', profile.avatar_ref,
    'primary_public_handle', handle.label_display
  )
    FROM personas AS persona
    JOIN persona_profiles AS profile ON profile.persona_id = persona.persona_id
    LEFT JOIN LATERAL (
      SELECT candidate.label_display
        FROM public_handle_index AS candidate
       WHERE candidate.owner_persona_id = persona.persona_id
         AND candidate.status = 'active'
       ORDER BY candidate.updated_at DESC, candidate.handle_id
       LIMIT 1
    ) AS handle ON true
   WHERE persona.persona_id = expected_persona_id
     AND persona.status = 'active'
$$;

CREATE OR REPLACE FUNCTION provision_first_persona_for_new_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  first_persona_id TEXT := 'persona_' || replace(gen_random_uuid()::text, '-', '');
  first_assignment_id TEXT := 'persona_wallet_' || replace(gen_random_uuid()::text, '-', '');
  handle_label TEXT := lower(NEW.account #>> '{global_handle,label_display}');
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  INSERT INTO personas (
    persona_id, account_id, status, is_first_persona, created_at, retired_at
  ) VALUES (first_persona_id, NEW.user_id, 'pending_wallet', true, NEW.created_at, NULL);
  INSERT INTO persona_pending_profiles (
    persona_id, display_name, avatar_ref, cover_ref, bio, preferred_locale, created_at
  ) VALUES (
    first_persona_id,
    NEW.account #>> '{profile,display_name}', NEW.account #>> '{profile,avatar_ref}',
    NEW.account #>> '{profile,cover_ref}', NEW.account #>> '{profile,bio}',
    NEW.account #>> '{profile,preferred_locale}', NEW.created_at
  );
  INSERT INTO persona_wallet_assignments (
    assignment_id, persona_id, account_id, chain_account_kind, privy_wallet_id,
    hd_wallet_index, address, status, reservation_idempotency_key,
    assigned_at, tombstoned_at, created_at, updated_at
  ) VALUES (
    first_assignment_id, first_persona_id, NEW.user_id, 'evm', NULL,
    0, NULL, 'pending', 'first-persona-wallet-onboarding',
    NULL, NULL, NEW.created_at, NEW.created_at
  );
  IF handle_label IS NOT NULL
     AND NEW.account #>> '{global_handle,global_handle_id}' IS NOT NULL THEN
    INSERT INTO persona_pending_first_handles (
      persona_id, handle_id, label_normalized, label_display, created_at
    ) VALUES (
      first_persona_id, NEW.account #>> '{global_handle,global_handle_id}',
      left(handle_label, -length('.pirate')), handle_label, NEW.created_at
    );
  END IF;
  RETURN NEW;
END
$$;
