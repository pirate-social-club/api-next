-- A community owner may be published by an authenticated Pirate session
-- before its reserved EVM assignment is confirmed. The persona and profile
-- are public, but the pending assignment carries no wallet authority.
CREATE OR REPLACE FUNCTION validate_persona_wallet_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_persona_id TEXT := COALESCE(NEW.persona_id, OLD.persona_id);
  target_status TEXT;
  active_wallets BIGINT;
  pending_wallets BIGINT;
  tombstoned_wallets BIGINT;
  profiles BIGINT;
  pending_profiles BIGINT;
BEGIN
  SELECT status INTO target_status FROM personas WHERE persona_id = target_persona_id;
  IF target_status IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) FILTER (WHERE status = 'active'),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status = 'tombstoned')
    INTO active_wallets, pending_wallets, tombstoned_wallets
    FROM persona_wallet_assignments
   WHERE persona_id = target_persona_id AND chain_account_kind = 'evm';
  SELECT count(*) INTO profiles FROM persona_profiles WHERE persona_id = target_persona_id;
  SELECT count(*) INTO pending_profiles
    FROM persona_pending_profiles WHERE persona_id = target_persona_id;

  IF target_status = 'active'
     AND (profiles <> 1 OR pending_profiles <> 0 OR tombstoned_wallets <> 0
       OR NOT (
         (active_wallets = 1 AND pending_wallets = 0)
         OR (active_wallets = 0 AND pending_wallets = 1)
       )) THEN
    RAISE EXCEPTION 'public persona requires one reserved or confirmed wallet and profile'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  IF target_status = 'suspended'
     AND (active_wallets <> 1 OR pending_wallets <> 0 OR profiles <> 1 OR pending_profiles <> 0) THEN
    RAISE EXCEPTION 'suspended persona requires one confirmed wallet and profile'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  IF target_status = 'pending_wallet'
     AND (pending_wallets <> 1 OR active_wallets <> 0 OR profiles <> 0 OR pending_profiles <> 1) THEN
    RAISE EXCEPTION 'pending persona requires one reserved wallet and private profile draft'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  IF target_status = 'retired'
     AND (active_wallets <> 0 OR pending_wallets <> 0 OR tombstoned_wallets <> 1) THEN
    RAISE EXCEPTION 'retired persona requires one tombstoned wallet assignment'
      USING ERRCODE = '23514', CONSTRAINT = 'persona_wallet_activation_invariant';
  END IF;
  RETURN NULL;
END
$$;
