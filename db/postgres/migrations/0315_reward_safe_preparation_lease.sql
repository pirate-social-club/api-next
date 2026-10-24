-- Preparing a Safe call hands the owner a new call to execute, so it needs the same
-- authority as storing a newly signed EOA transaction: a running brake, and where a
-- reward run lease is required, a live lease. Migration 0310 checked only the brake,
-- so a required lease that was never acquired, had expired or had been released
-- still let a running system prepare calls. Every later transition still records
-- what the chain did and is never refused. Locks follow 0242's one order: the
-- operations control row, then the lease row.
CREATE OR REPLACE FUNCTION guard_reward_safe_call_preparation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lease_required BOOLEAN;
  operations_paused BOOLEAN;
  lease_live BOOLEAN;
BEGIN
  SELECT required INTO lease_required FROM reward_operations_run_lease WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  SELECT paused INTO operations_paused FROM reward_operations_control
   WHERE singleton FOR SHARE;
  IF NOT FOUND OR operations_paused IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  IF lease_required IS DISTINCT FROM TRUE THEN RETURN NEW; END IF;
  SELECT run_id IS NOT NULL AND clock_timestamp() < expires_at
         AND clock_timestamp() < absolute_deadline
    INTO lease_live FROM reward_operations_run_lease WHERE singleton FOR SHARE;
  IF lease_live IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'reward operations paused' USING ERRCODE='PR001';
  END IF;
  RETURN NEW;
END
$$;
-- CREATE OR REPLACE keeps the grants but resets the function's settings.
DO $safe_preparation_lease_permissions$
DECLARE
  role_name TEXT;
BEGIN
  REVOKE ALL ON FUNCTION guard_reward_safe_call_preparation() FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT pg_get_userbyid(a.grantee)
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = 'guard_reward_safe_call_preparation()'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION guard_reward_safe_call_preparation() FROM %I', role_name);
  END LOOP;
  EXECUTE format(
    'ALTER FUNCTION guard_reward_safe_call_preparation() SET search_path TO %I, pg_temp',
    current_schema()
  );
END
$safe_preparation_lease_permissions$;
