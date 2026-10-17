-- Branch-local next ordinal, not a reservation. Renumber in actual merge order.
-- Forward-only terminal producer observations. Never backfill old completions.
-- Deferred capture observes qualification after the whole producer transaction,
-- including qualification/day projection writes, without changing its policy.
CREATE TABLE activity_completion_decisions (
  activity_key TEXT NOT NULL CHECK (activity_key IN ('study','karaoke')),
  session_id TEXT NOT NULL,
  attempt_id TEXT,
  account_id TEXT NOT NULL REFERENCES users(user_id),
  persona_id TEXT NOT NULL REFERENCES personas(persona_id),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  qualification_id TEXT UNIQUE REFERENCES activity_qualifications(qualification_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('qualified','not_qualified')),
  decided_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (activity_key,session_id),
  FOREIGN KEY (community_id,post_id) REFERENCES posts(community_id,post_id),
  CHECK ((activity_key='study' AND attempt_id IS NULL)
    OR (activity_key='karaoke' AND attempt_id IS NOT NULL)),
  CHECK ((outcome='qualified') = (qualification_id IS NOT NULL))
);
CREATE TRIGGER activity_completion_decisions_immutable
BEFORE UPDATE OR DELETE ON activity_completion_decisions
FOR EACH ROW EXECUTE FUNCTION guard_reward_day_ledger();

CREATE FUNCTION capture_activity_completion_decision_private_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  source RECORD;
  qualification TEXT;
BEGIN
  IF TG_TABLE_NAME='study_sessions_v2' THEN
    SELECT s.account_id,s.persona_id,s.community_id,s.post_id,s.audio_revision,
      s.session_id,NULL::text AS attempt_id,s.completed_at,'study'::text AS activity_key
      INTO STRICT source FROM study_sessions_v2 s WHERE s.session_id=NEW.session_id
      AND s.status='completed';
    SELECT q.qualification_id INTO qualification FROM activity_qualifications q
      WHERE q.activity_key='study' AND q.study_session_id=source.session_id
        AND q.account_id=source.account_id AND q.persona_id=source.persona_id
        AND q.community_id=source.community_id AND q.post_id=source.post_id
        AND q.audio_revision=source.audio_revision AND q.qualified_at=source.completed_at;
  ELSE
    SELECT s.account_id,s.persona_id,s.community_id,s.post_id,s.audio_revision,
      s.session_id,a.attempt_id,a.completed_at,'karaoke'::text AS activity_key
      INTO STRICT source FROM karaoke_sessions s JOIN karaoke_attempts a
        ON a.session_id=s.session_id AND a.attempt_id=s.attempt_id
      WHERE a.attempt_id=NEW.attempt_id AND s.status='completed';
    SELECT q.qualification_id INTO qualification FROM activity_qualifications q
      WHERE q.activity_key='karaoke' AND q.karaoke_session_id=source.session_id
        AND q.karaoke_attempt_id=source.attempt_id
        AND q.account_id=source.account_id AND q.persona_id=source.persona_id
        AND q.community_id=source.community_id AND q.post_id=source.post_id
        AND q.audio_revision=source.audio_revision AND q.qualified_at=source.completed_at;
  END IF;
  INSERT INTO activity_completion_decisions(activity_key,session_id,attempt_id,account_id,
    persona_id,community_id,post_id,audio_revision,qualification_id,outcome,decided_at)
  VALUES(source.activity_key,source.session_id,source.attempt_id,source.account_id,
    source.persona_id,source.community_id,source.post_id,source.audio_revision,qualification,
    CASE WHEN qualification IS NULL THEN 'not_qualified' ELSE 'qualified' END,source.completed_at);
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER study_v2_completion_decision
AFTER UPDATE ON study_sessions_v2 DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.status='active' AND NEW.status='completed')
EXECUTE FUNCTION capture_activity_completion_decision_private_v1();
CREATE CONSTRAINT TRIGGER karaoke_completion_decision
AFTER UPDATE ON karaoke_sessions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.status='active' AND NEW.status='completed')
EXECUTE FUNCTION capture_activity_completion_decision_private_v1();

DO $$
DECLARE schema_name TEXT := current_schema(); reader RECORD; grant_row RECORD;
BEGIN
  EXECUTE format('ALTER FUNCTION capture_activity_completion_decision_private_v1() SET search_path TO pg_catalog,%I,pg_temp',schema_name);
  REVOKE ALL ON FUNCTION capture_activity_completion_decision_private_v1() FROM PUBLIC;
  -- Function defaults may also grant EXECUTE directly to application roles.
  -- Trigger invocation needs no caller EXECUTE authority on this private helper.
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_proc p,
    LATERAL aclexplode(p.proacl) acl
    WHERE p.oid='capture_activity_completion_decision_private_v1()'::regprocedure
    AND acl.grantee<>0 AND acl.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION capture_activity_completion_decision_private_v1() FROM %I',pg_get_userbyid(grant_row.grantee));
  END LOOP;
  REVOKE ALL ON activity_completion_decisions FROM PUBLIC;
  -- Default privileges must not give an application writer authority to invent
  -- terminal decisions. Only the source triggers write this table.
  FOR grant_row IN SELECT DISTINCT acl.grantee FROM pg_class c,
    LATERAL aclexplode(c.relacl) acl WHERE c.oid='activity_completion_decisions'::regclass
    AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
    EXECUTE format('REVOKE ALL ON activity_completion_decisions FROM %I',pg_get_userbyid(grant_row.grantee));
  END LOOP;
  -- Preserve the existing private qualification readers, including role grants
  -- inherited by runtime logins. No public access and no new mutation grants.
  FOR reader IN SELECT DISTINCT acl.grantee FROM pg_class c,
    LATERAL aclexplode(c.relacl) acl WHERE c.oid='activity_qualifications'::regclass
    AND acl.privilege_type='SELECT' AND acl.grantee<>0 AND acl.grantee<>c.relowner LOOP
    EXECUTE format('GRANT SELECT ON activity_completion_decisions TO %I',pg_get_userbyid(reader.grantee));
  END LOOP;
END;
$$;
