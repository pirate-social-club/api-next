-- Scheduling progress survives Worker restarts and missed cron deliveries.
-- This cursor grants no custody authority and changes no financial limits.
CREATE TABLE reward_joint_cycle_turn_v1 (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  next_work TEXT NOT NULL CHECK(next_work IN ('financial','funding')),
  revision BIGINT NOT NULL CHECK(revision>0)
);
INSERT INTO reward_joint_cycle_turn_v1 VALUES(TRUE,'financial',1);

CREATE FUNCTION take_reward_joint_cycle_turn_v1() RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE first_work TEXT;
BEGIN
  SELECT next_work INTO STRICT first_work FROM reward_joint_cycle_turn_v1
    WHERE singleton FOR UPDATE;
  UPDATE reward_joint_cycle_turn_v1 SET
    next_work=CASE first_work WHEN 'financial' THEN 'funding' ELSE 'financial' END,
    revision=revision+1 WHERE singleton;
  RETURN first_work;
END $$;

DO $acl$
DECLARE owned_table REGCLASS; grant_row RECORD;
BEGIN
  owned_table:='reward_joint_cycle_turn_v1'::REGCLASS;
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',owned_table);
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE c.oid=owned_table AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',owned_table,pg_get_userbyid(grant_row.grantee));
  END LOOP;
  EXECUTE format('ALTER FUNCTION take_reward_joint_cycle_turn_v1() SET search_path TO pg_catalog,%I,pg_temp',current_schema());
  REVOKE ALL ON FUNCTION take_reward_joint_cycle_turn_v1() FROM PUBLIC;
  FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='take_reward_joint_cycle_turn_v1()'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION take_reward_joint_cycle_turn_v1() FROM %I',pg_get_userbyid(grant_row.grantee));
  END LOOP;
END $acl$;
