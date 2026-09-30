-- HTTP reads are advisory; insertion serializes with the operator pause.
-- Receipt updates and instruction replays admitted before pause remain valid.
CREATE FUNCTION guard_reward_http_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE operations_paused BOOLEAN;
BEGIN
  SELECT paused INTO operations_paused FROM reward_operations_control
   WHERE singleton FOR SHARE;
  IF NOT FOUND OR operations_paused IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION guard_reward_http_admission() FROM PUBLIC;
DO $admission_permissions$
DECLARE role_name TEXT;
BEGIN
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid='guard_reward_http_admission()'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION guard_reward_http_admission() FROM %I',role_name);
  END LOOP;
  EXECUTE format('ALTER FUNCTION guard_reward_http_admission() SET search_path TO %I, pg_temp',current_schema());
END;
$admission_permissions$;
CREATE TRIGGER reward_http_admission_guard BEFORE INSERT ON song_reward_offers
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
CREATE TRIGGER reward_http_admission_guard BEFORE INSERT ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
CREATE TRIGGER reward_http_admission_guard BEFORE INSERT ON song_reward_leg_funding_effects
FOR EACH ROW EXECUTE FUNCTION guard_reward_http_admission();
