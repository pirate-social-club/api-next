-- Forward repair of accepted0269; branch-local ordinal until actual merge order.
-- Account decisions remain account-only. No guest admission, grading or credit change.
-- CREATE OR REPLACE retains the existing owner and ACL; re-pin the definer path.
CREATE OR REPLACE FUNCTION capture_activity_completion_decision_private_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  source RECORD;
  qualification TEXT;
BEGIN
  IF TG_TABLE_NAME='study_sessions_v2' THEN
    -- Accepted0254 guest Study is practice-only with explicit original ownership.
    -- The validated owner discriminator, never nullable account fields, selects it.
    IF NEW.participation_owner_kind='guest' THEN RETURN NEW; END IF;
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
DO $$
DECLARE schema_name TEXT := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION capture_activity_completion_decision_private_v1() SET search_path TO pg_catalog,%I,pg_temp',schema_name);
END;
$$;
