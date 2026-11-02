-- No decisions are seeded. Source acceptance does not approve songs or a policy.
CREATE TABLE study_learner_catalogue_decisions (
  community_id text NOT NULL,
  post_id text NOT NULL,
  decision_revision integer NOT NULL CHECK (decision_revision>0),
  policy_revision text NOT NULL CHECK (length(policy_revision) BETWEEN 1 AND 128),
  disposition text NOT NULL CHECK (disposition IN ('eligible','ineligible','fixture_only')),
  audio_revision integer NOT NULL CHECK (audio_revision>0),
  lyrics_revision integer NOT NULL CHECK (lyrics_revision>0),
  language_profile_revision integer NOT NULL CHECK (language_profile_revision>0),
  content_rating text NOT NULL,
  learner_band text,
  learning_language text NOT NULL,
  exercise_type text NOT NULL,
  reviewer_role text NOT NULL CHECK (length(reviewer_role) BETWEEN 1 AND 128),
  review_evidence_sha256 text NOT NULL CHECK (review_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id,post_id,decision_revision),
  FOREIGN KEY (community_id,post_id) REFERENCES posts(community_id,post_id)
);

CREATE FUNCTION guard_study_learner_catalogue_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous_revision integer;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'study_learner_catalogue_decision_immutable';
  END IF;
  IF NEW.effective_at>clock_timestamp() THEN
    RAISE EXCEPTION 'study_learner_catalogue_scheduling_unsupported';
  END IF;
  NEW.recorded_at := clock_timestamp();
  -- Match Study admission's community lock. A new denial cannot race acceptance.
  PERFORM community_id FROM communities WHERE community_id=NEW.community_id FOR UPDATE;
  SELECT COALESCE(max(decision_revision),0) INTO previous_revision
    FROM study_learner_catalogue_decisions
    WHERE community_id=NEW.community_id AND post_id=NEW.post_id;
  IF NEW.decision_revision<>previous_revision+1 THEN
    RAISE EXCEPTION 'study_learner_catalogue_revision_conflict';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER study_learner_catalogue_decision_guard
BEFORE INSERT OR UPDATE OR DELETE ON study_learner_catalogue_decisions
FOR EACH ROW EXECUTE FUNCTION guard_study_learner_catalogue_decision();
CREATE TRIGGER study_learner_catalogue_no_truncate
BEFORE TRUNCATE ON study_learner_catalogue_decisions
FOR EACH STATEMENT EXECUTE FUNCTION guard_study_learner_catalogue_decision();
-- Strip ambient default grants. Runtime readers are admitted separately.
DO $$
DECLARE trusted text:=current_schema(); t regclass:='study_learner_catalogue_decisions'::regclass;
  f regprocedure:='guard_study_learner_catalogue_decision()'::regprocedure; grant_row record;
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
  FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=t AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,pg_get_userbyid(grant_row.grantee)); END LOOP;
  EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f,trusted);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=f AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,pg_get_userbyid(grant_row.grantee)); END LOOP;
END $$;
