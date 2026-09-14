-- Reconciliation reads retained accepted signals. Unknown evidence is never general.
CREATE FUNCTION retained_categories_rating_v1(categories jsonb, bound boolean, declared text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF bound IS DISTINCT FROM true OR declared NOT IN ('general','adult_18') OR declared IS NULL
     OR jsonb_typeof(categories) IS DISTINCT FROM 'array' THEN RETURN 'held'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(categories) c
      WHERE jsonb_typeof(c)<>'string' OR moderation_policy_category_ordinal_v1(c#>>'{}') IS NULL)
     OR (SELECT count(*)<>count(DISTINCT c) FROM jsonb_array_elements(categories) c)
     OR categories ? 'sexual/minors' THEN RETURN 'held'; END IF;
  IF declared='adult_18' OR categories ?| ARRAY['sexual','violence/graphic'] THEN RETURN 'adult_18'; END IF;
  RETURN 'general';
END;
$$;

CREATE FUNCTION retained_video_rating_v1(analysis jsonb, evidence jsonb, bound boolean, declared text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE inputs jsonb; frames jsonb; item jsonb; expected_hash text; expected_role text;
  categories jsonb := '[]'; idx integer; result text;
BEGIN
  IF bound IS DISTINCT FROM true OR jsonb_typeof(analysis) IS DISTINCT FROM 'object'
    OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN RETURN 'held'; END IF;
  inputs:=evidence->'inputs'; frames:=analysis->'frames'->'extracted';
  IF jsonb_typeof(inputs) IS DISTINCT FROM 'array' OR jsonb_typeof(frames) IS DISTINCT FROM 'array'
    THEN RETURN 'held'; END IF;
  IF jsonb_array_length(frames)<>3 OR jsonb_array_length(inputs)<>
    (CASE WHEN analysis->'safetyRequest'->>'captionSha256' IS NULL THEN 3 ELSE 4 END) THEN RETURN 'held'; END IF;
  FOR idx IN 0..jsonb_array_length(inputs)-1 LOOP
    item:=inputs->idx;
    expected_hash:=CASE WHEN idx<3 THEN frames->idx->>'sha256' ELSE analysis->'safetyRequest'->>'captionSha256' END;
    expected_role:=CASE WHEN idx<3 THEN (ARRAY['poster','first','midpoint'])[idx+1] ELSE 'caption' END;
    IF expected_hash IS NULL OR expected_hash !~ '^[0-9a-f]{64}$'
      OR item->>'outcome' IS DISTINCT FROM 'evaluated'
      OR item->>'role' IS DISTINCT FROM expected_role OR item->>'sha256' IS DISTINCT FROM expected_hash
      OR item->'provider'->>'input_sha256' IS DISTINCT FROM expected_hash
      OR item->'provider'->>'provider_id' IS DISTINCT FROM 'openai'
      OR (idx<3 AND (analysis->'safetyRequest'->'frameSha256s'->>idx IS DISTINCT FROM expected_hash OR frames->idx->>'role' IS DISTINCT FROM expected_role))
      OR item->'provider'->'matched_categories' IS DISTINCT FROM item->'resolution'->'matched_categories'
      THEN RETURN 'held'; END IF;
    result:=retained_categories_rating_v1(item->'provider'->'matched_categories',true,'general');
    IF result='held' THEN RETURN 'held'; END IF;
    categories:=categories || (item->'provider'->'matched_categories');
  END LOOP;
  SELECT COALESCE(jsonb_agg(DISTINCT c),'[]') INTO categories FROM jsonb_array_elements(categories) c;
  RETURN retained_categories_rating_v1(categories,true,declared);
END;
$$;

-- These private rows carry hashes and identifiers, never content or proof payloads.
CREATE VIEW retained_content_rating_sources_v1 AS
SELECT 'text'::text AS source_kind,s.community_id,s.submission_id AS source_id,
  s.published_post_id AS post_id,s.published_comment_id AS comment_id,
  retained_categories_rating_v1(s.matched_categories,
    e.outcome='evaluated' AND e.input_sha256=s.input_sha256 AND e.community_id=s.community_id
    AND e.evidence_hash ~ '^[0-9a-f]{64}$' AND e.policy_hash=s.policy_hash
    AND e.platform_policy_hash=s.platform_policy_hash AND e.community_policy_hash=s.community_policy_hash,
    s.author_declared_rating) AS outcome,
  encode(sha256(convert_to(jsonb_build_array(s.request_hash,s.input_sha256,s.evidence_ref,
    s.published_post_id,s.published_comment_id,s.matched_categories,s.author_declared_rating,to_jsonb(e))::text,'UTF8')),'hex') AS source_hash
FROM text_content_submissions s LEFT JOIN text_moderation_evidence e ON e.evidence_ref=s.evidence_ref
UNION ALL
SELECT 'media',s.community_id,s.submission_id,s.post_id,NULL,
  CASE WHEN s.media_kind='song' THEN retained_categories_rating_v1(a.analysis_snapshot->'contentModeration'->'matchedCategories',
    a.submission_id IS NOT NULL AND a.audio_revision=s.audio_revision
    AND a.analysis_snapshot->'contentModeration'->>'inputSha256' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(a.analysis_snapshot->'contentModeration'->'providerEvidence')='object'
    AND a.analysis_snapshot->'contentModeration'->'providerEvidence'->>'providerId'='openai'
    AND jsonb_typeof(a.analysis_snapshot->'contentModeration'->'providerEvidence'->'inputs')='array',s.author_declared_rating)
  ELSE retained_video_rating_v1(v.analysis_snapshot,e.evidence_snapshot,
    v.submission_id IS NOT NULL AND e.submission_id IS NOT NULL AND NOT e.platform_held
    AND e.request_id=v.analysis_snapshot->'safetyRequest'->>'requestId'
    AND e.evidence_ref=v.analysis_snapshot->'safetyRequest'->>'evidenceRef'
    AND e.evidence_snapshot->'platformHeld'='false'::jsonb
    AND e.evidence_snapshot->>'inputDigest'=e.input_sha256
    AND e.evidence_snapshot->'fact'->>'evidenceRef'=e.evidence_ref
    AND NOT EXISTS (SELECT 1 FROM media_video_safety_evidence later
      WHERE later.submission_id=s.submission_id AND later.video_revision=s.video_revision
        AND later.creation_revision BETWEEN COALESCE(p.decision_revision,s.creation_revision) AND s.creation_revision
        AND later.platform_held),s.author_declared_rating) END,
  encode(sha256(convert_to(jsonb_build_array(s.creation_revision,s.audio_revision,s.video_revision,
    s.current_analysis_revision,s.current_decision_revision,s.current_lyrics_revision,s.post_id,
    s.author_declared_rating,a.analysis_snapshot,v.analysis_snapshot,to_jsonb(e))::text,'UTF8')),'hex')
FROM media_post_submissions s
LEFT JOIN media_publication_projections p ON p.submission_id=s.submission_id AND p.post_id=s.post_id
LEFT JOIN media_analysis_evidence a ON s.media_kind='song' AND a.submission_id=s.submission_id
  AND a.community_id=s.community_id AND a.operation_id=s.operation_id
  AND a.analysis_revision=COALESCE(p.analysis_revision,s.current_analysis_revision)
LEFT JOIN media_video_analyses v ON s.media_kind='video' AND v.submission_id=s.submission_id
  AND v.community_id=s.community_id AND v.operation_id=s.operation_id AND v.video_revision=s.video_revision
  AND v.analysis_revision=COALESCE(p.analysis_revision,s.current_analysis_revision)
LEFT JOIN media_video_safety_evidence e ON s.media_kind='video' AND e.submission_id=s.submission_id
  AND e.video_revision=s.video_revision AND e.creation_revision=COALESCE(p.decision_revision,s.creation_revision);

CREATE VIEW retained_post_rating_base_v1 AS
SELECT p.community_id,p.post_id,p.post_type,
  CASE WHEN p.post_type NOT IN ('text','song','video') OR count(s.source_id)<>1 OR bool_or(s.outcome='held') THEN 'held'
    WHEN p.content_rating='adult_18' OR p.author_declared_rating='adult_18' OR bool_or(s.outcome='adult_18') THEN 'adult_18'
    ELSE 'general' END AS outcome,
  encode(sha256(convert_to(jsonb_build_array(p.post_type,p.author_declared_rating,
    jsonb_agg(jsonb_build_array(s.source_kind,s.source_id,s.source_hash,s.outcome)
      ORDER BY s.source_kind,s.source_id))::text,'UTF8')),'hex') AS source_hash
FROM posts p LEFT JOIN retained_content_rating_sources_v1 s
  ON s.community_id=p.community_id AND s.post_id=p.post_id
GROUP BY p.community_id,p.post_id;

CREATE VIEW retained_post_rating_assessment_v1 AS
SELECT b.community_id,b.post_id,
  CASE WHEN b.outcome='held' OR (s.video_intent='song_reference' AND (parent.post_id IS NULL OR parent.outcome='held')) THEN 'held'
    WHEN b.outcome='adult_18' OR parent.outcome='adult_18' THEN 'adult_18' ELSE 'general' END AS outcome,
  encode(sha256(convert_to(jsonb_build_array(b.source_hash,b.outcome,parent.source_hash,parent.outcome)::text,'UTF8')),'hex') AS source_hash
FROM retained_post_rating_base_v1 b
LEFT JOIN media_publication_projections p ON p.community_id=b.community_id AND p.post_id=b.post_id
LEFT JOIN media_post_submissions s ON s.submission_id=p.submission_id
LEFT JOIN media_video_song_references r ON r.submission_id=s.submission_id AND r.post_id=b.post_id
LEFT JOIN retained_post_rating_base_v1 parent ON parent.community_id=r.song_community_id AND parent.post_id=r.song_post_id;

CREATE VIEW retained_comment_rating_base_v1 AS
SELECT c.community_id,c.comment_id,c.post_id,c.parent_comment_id,c.depth,
  CASE WHEN count(s.source_id)<>1 OR bool_or(s.outcome='held') THEN 'held'
    WHEN c.content_rating='adult_18' OR c.author_declared_rating='adult_18' OR bool_or(s.outcome='adult_18') THEN 'adult_18'
    ELSE 'general' END AS outcome,
  encode(sha256(convert_to(jsonb_build_array(c.post_id,c.parent_comment_id,c.author_declared_rating,
    jsonb_agg(jsonb_build_array(s.source_id,s.source_hash,s.outcome) ORDER BY s.source_id))::text,'UTF8')),'hex') AS source_hash
FROM comments c LEFT JOIN retained_content_rating_sources_v1 s
  ON s.community_id=c.community_id AND s.comment_id=c.comment_id
GROUP BY c.community_id,c.comment_id;

CREATE VIEW retained_comment_rating_assessment_v1 AS
WITH RECURSIVE ancestry AS (
  SELECT b.community_id,b.comment_id,b.depth,
    CASE WHEN b.outcome='held' OR p.outcome IS NULL OR p.outcome='held' THEN 'held'
      WHEN b.outcome='adult_18' OR p.outcome='adult_18' THEN 'adult_18' ELSE 'general' END AS outcome,
    encode(sha256(convert_to(jsonb_build_array(b.source_hash,b.outcome,p.source_hash,p.outcome)::text,'UTF8')),'hex') AS source_hash
  FROM retained_comment_rating_base_v1 b LEFT JOIN retained_post_rating_assessment_v1 p
    ON p.community_id=b.community_id AND p.post_id=b.post_id WHERE b.parent_comment_id IS NULL
  UNION ALL
  SELECT b.community_id,b.comment_id,b.depth,
    CASE WHEN b.outcome='held' OR p.outcome='held' THEN 'held'
      WHEN b.outcome='adult_18' OR p.outcome='adult_18' THEN 'adult_18' ELSE 'general' END,
    encode(sha256(convert_to(jsonb_build_array(b.source_hash,b.outcome,p.source_hash,p.outcome)::text,'UTF8')),'hex')
  FROM retained_comment_rating_base_v1 b JOIN ancestry p
    ON p.community_id=b.community_id AND p.comment_id=b.parent_comment_id
)
SELECT b.community_id,b.comment_id,b.depth,COALESCE(a.outcome,'held') AS outcome,
  COALESCE(a.source_hash,b.source_hash) AS source_hash
FROM retained_comment_rating_base_v1 b LEFT JOIN ancestry a
  ON a.community_id=b.community_id AND a.comment_id=b.comment_id;

CREATE VIEW content_rating_reconciliation_candidates_v1 AS
SELECT 'post'::text AS target_kind,a.community_id,a.post_id AS target_id,0 AS depth,a.outcome,a.source_hash
FROM retained_post_rating_assessment_v1 a JOIN posts p USING (community_id,post_id)
WHERE p.status IN ('published','hidden')
UNION ALL
SELECT 'comment',a.community_id,a.comment_id,a.depth,a.outcome,a.source_hash
FROM retained_comment_rating_assessment_v1 a JOIN comments c USING (community_id,comment_id)
WHERE c.status IN ('published','hidden')
UNION ALL
SELECT 'text_submission',s.community_id,s.source_id,0,s.outcome,s.source_hash
FROM retained_content_rating_sources_v1 s JOIN text_content_submissions t
  ON s.source_kind='text' AND t.community_id=s.community_id AND t.submission_id=s.source_id
WHERE t.status='manual_review'
UNION ALL
SELECT 'media_submission',s.community_id,s.source_id,0,s.outcome,s.source_hash
FROM retained_content_rating_sources_v1 s JOIN media_post_submissions m
  ON s.source_kind='media' AND m.community_id=s.community_id AND m.submission_id=s.source_id
WHERE m.status='manual_review' OR (m.status='processing' AND m.phase='publish');

CREATE TABLE content_rating_reconciliation_operations (
  plan_hash text PRIMARY KEY CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 100),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='array'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE content_rating_reconciliation_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  plan_hash text NOT NULL REFERENCES content_rating_reconciliation_operations(plan_hash),
  target_kind text NOT NULL CHECK (target_kind IN ('post','comment','text_submission','media_submission')),
  community_id text NOT NULL,
  target_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('held','general','adult_18')),
  prior_status text NOT NULL,
  prior_rating text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id,target_kind,community_id,target_id)
);
CREATE TABLE content_rating_reconciliation_current (
  target_kind text NOT NULL,
  community_id text NOT NULL,
  target_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (target_kind,community_id,target_id),
  FOREIGN KEY (event_id,target_kind,community_id,target_id)
    REFERENCES content_rating_reconciliation_events(event_id,target_kind,community_id,target_id)
);
CREATE FUNCTION guard_rating_reconciliation_history_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'rating reconciliation history is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER rating_reconciliation_operations_history BEFORE UPDATE OR DELETE
  ON content_rating_reconciliation_operations FOR EACH ROW EXECUTE FUNCTION guard_rating_reconciliation_history_v1();
CREATE TRIGGER rating_reconciliation_events_history BEFORE UPDATE OR DELETE
  ON content_rating_reconciliation_events FOR EACH ROW EXECUTE FUNCTION guard_rating_reconciliation_history_v1();

CREATE FUNCTION content_rating_reconciliation_plan_v1(requested_limit integer) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE items jsonb; fingerprint text;
BEGIN
  IF requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid rating reconciliation limit'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(candidate) ORDER BY candidate.target_kind,candidate.depth,candidate.community_id,candidate.target_id),'[]') INTO items
  FROM (
    SELECT c.* FROM content_rating_reconciliation_candidates_v1 c
    LEFT JOIN content_rating_reconciliation_current current USING (target_kind,community_id,target_id)
    LEFT JOIN content_rating_reconciliation_events e ON e.event_id=current.event_id
    WHERE e.source_hash IS DISTINCT FROM c.source_hash OR e.outcome IS DISTINCT FROM c.outcome
    ORDER BY c.target_kind,c.depth,c.community_id,c.target_id LIMIT requested_limit
  ) candidate;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array('content-rating-reconciliation-v1',requested_limit,items)::text,'UTF8')),'hex');
  RETURN jsonb_build_object('version','content-rating-reconciliation-v1','plan_hash',fingerprint,'limit',requested_limit,'items',items);
END;
$$;

CREATE FUNCTION guard_rating_reconciliation_current_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'rating reconciliation current authority cannot be deleted'; END IF;
  IF (SELECT count(*) FROM content_rating_reconciliation_candidates_v1 c
      JOIN content_rating_reconciliation_events e ON e.event_id=NEW.event_id
      WHERE c.target_kind=NEW.target_kind AND c.community_id=NEW.community_id AND c.target_id=NEW.target_id
        AND e.source_hash=c.source_hash AND e.outcome=c.outcome)<>1 THEN
    RAISE EXCEPTION 'rating reconciliation current authority is stale';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rating_reconciliation_current_guard BEFORE INSERT OR UPDATE OR DELETE
  ON content_rating_reconciliation_current FOR EACH ROW EXECUTE FUNCTION guard_rating_reconciliation_current_v1();

CREATE FUNCTION rating_reconciliation_held_v1(kind text, community text, target text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM content_rating_reconciliation_current c
    JOIN content_rating_reconciliation_events e USING(event_id)
    WHERE c.target_kind=kind AND c.community_id=community AND c.target_id=target AND e.outcome='held');
$$;
CREATE FUNCTION guard_unresolved_rating_hold_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target text; parent_held boolean:=false;
BEGIN
  IF NEW.status<>'published' THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'posts' THEN
      kind:='post'; target:=NEW.post_id;
      SELECT EXISTS (SELECT 1 FROM media_video_song_references r
        WHERE r.post_id=NEW.post_id AND rating_reconciliation_held_v1('post',r.song_community_id,r.song_post_id)) INTO parent_held;
    WHEN 'comments' THEN
      kind:='comment'; target:=NEW.comment_id;
      WITH RECURSIVE ancestry AS (
        SELECT c.comment_id,c.parent_comment_id FROM comments c
          WHERE c.community_id=NEW.community_id AND c.comment_id=NEW.parent_comment_id
        UNION
        SELECT c.comment_id,c.parent_comment_id FROM comments c JOIN ancestry a ON c.comment_id=a.parent_comment_id
          WHERE c.community_id=NEW.community_id
      ) SELECT rating_reconciliation_held_v1('post',NEW.community_id,NEW.post_id)
        OR EXISTS (SELECT 1 FROM ancestry a WHERE rating_reconciliation_held_v1('comment',NEW.community_id,a.comment_id)) INTO parent_held;
    WHEN 'text_content_submissions' THEN kind:='text_submission'; target:=NEW.submission_id;
    WHEN 'media_post_submissions' THEN kind:='media_submission'; target:=NEW.submission_id;
  END CASE;
  IF parent_held OR rating_reconciliation_held_v1(kind,NEW.community_id,target) THEN
    RAISE EXCEPTION 'current rating evidence is unresolved' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posts_unresolved_rating_hold BEFORE INSERT OR UPDATE OF status ON posts
  FOR EACH ROW EXECUTE FUNCTION guard_unresolved_rating_hold_v1();
CREATE TRIGGER comments_unresolved_rating_hold BEFORE INSERT OR UPDATE OF status ON comments
  FOR EACH ROW EXECUTE FUNCTION guard_unresolved_rating_hold_v1();
CREATE TRIGGER text_submissions_unresolved_rating_hold BEFORE UPDATE OF status ON text_content_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_unresolved_rating_hold_v1();
CREATE TRIGGER media_submissions_unresolved_rating_hold BEFORE UPDATE OF status ON media_post_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_unresolved_rating_hold_v1();

-- Permit the same exact current-floor-only repair for held text submissions.
CREATE FUNCTION is_current_text_rating_raise_v2(previous text_content_submissions, following text_content_submissions)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT previous.resulting_content_rating='general' AND following.resulting_content_rating='adult_18'
    AND (to_jsonb(previous)-ARRAY['resulting_content_rating','actor_account_id'])
      =(to_jsonb(following)-ARRAY['resulting_content_rating','actor_account_id']);
$$;

DO $$
DECLARE body text; boundary integer;
BEGIN
  SELECT prosrc INTO body FROM pg_proc WHERE oid='guard_text_content_submission_update()'::regprocedure AND NOT prosecdef;
  boundary:=strpos(body,E'\nBEGIN\n');
  IF body IS NULL OR boundary=0 THEN RAISE EXCEPTION 'text rating guard source is not recognized'; END IF;
  body:=overlay(body placing E'\nBEGIN\n  IF is_current_text_rating_raise_v2(OLD,NEW) THEN RETURN NEW; END IF;\n'
    from boundary for length(E'\nBEGIN\n'));
  EXECUTE format('CREATE FUNCTION guard_text_content_submission_update_rating_v2() RETURNS trigger LANGUAGE plpgsql AS %L',body);
END;
$$;
DROP TRIGGER text_content_submission_update_guard ON text_content_submissions;
CREATE TRIGGER text_content_submission_update_guard BEFORE UPDATE ON text_content_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_text_content_submission_update_rating_v2();

-- A current floor repair does not republish a resource hidden after its original
-- publication. Inserts and every actual state transition retain the old checks.
DROP TRIGGER text_content_submission_relations_guard ON text_content_submissions;
CREATE CONSTRAINT TRIGGER text_content_submission_relations_insert_guard AFTER INSERT ON text_content_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_text_content_submission_relations();
CREATE CONSTRAINT TRIGGER text_content_submission_relations_guard AFTER UPDATE ON text_content_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NOT is_current_text_rating_raise_v2(OLD,NEW))
  EXECUTE FUNCTION validate_text_content_submission_relations();

CREATE FUNCTION apply_content_rating_reconciliation_v1(expected_plan_hash text,requested_limit integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE plan jsonb; saved content_rating_reconciliation_operations%ROWTYPE; item jsonb;
  kind text; community text; target text; outcome text; prior_status text; prior_rating text;
  before_rows jsonb:='[]'; final_row record; event_key text;
BEGIN
  IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION 'rating reconciliation requires a serializable transaction'; END IF;
  IF expected_plan_hash IS NULL OR expected_plan_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid rating reconciliation plan hash'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('content-rating-reconciliation-v1',0));
  SELECT * INTO saved FROM content_rating_reconciliation_operations WHERE plan_hash=expected_plan_hash;
  IF FOUND THEN
    IF saved.batch_limit IS DISTINCT FROM requested_limit THEN RAISE EXCEPTION 'rating reconciliation replay differs'; END IF;
    RETURN jsonb_build_object('status','replayed','plan_hash',expected_plan_hash,'resources',jsonb_array_length(saved.plan));
  END IF;
  plan:=content_rating_reconciliation_plan_v1(requested_limit);
  IF plan->>'plan_hash'<>expected_plan_hash THEN RAISE EXCEPTION 'rating reconciliation plan changed'; END IF;
  INSERT INTO content_rating_reconciliation_operations(plan_hash,batch_limit,plan)
    VALUES (expected_plan_hash,requested_limit,plan->'items');
  FOR item IN SELECT value FROM jsonb_array_elements(plan->'items') LOOP
    kind:=item->>'target_kind'; community:=item->>'community_id'; target:=item->>'target_id'; outcome:=item->>'outcome';
    CASE kind
      WHEN 'post' THEN SELECT status,content_rating INTO prior_status,prior_rating FROM posts WHERE community_id=community AND post_id=target FOR UPDATE;
      WHEN 'comment' THEN SELECT status,content_rating INTO prior_status,prior_rating FROM comments WHERE community_id=community AND comment_id=target FOR UPDATE;
      WHEN 'text_submission' THEN SELECT status,resulting_content_rating INTO prior_status,prior_rating FROM text_content_submissions WHERE community_id=community AND submission_id=target FOR UPDATE;
      WHEN 'media_submission' THEN SELECT status,resulting_content_rating INTO prior_status,prior_rating FROM media_post_submissions WHERE community_id=community AND submission_id=target FOR UPDATE;
    END CASE;
    IF prior_status IS NULL THEN RAISE EXCEPTION 'rating reconciliation target disappeared'; END IF;
    before_rows:=before_rows || jsonb_build_array(item || jsonb_build_object('prior_status',prior_status,'prior_rating',prior_rating));
    IF outcome='adult_18' THEN
      CASE kind
        WHEN 'post' THEN
          UPDATE posts SET content_rating='adult_18' WHERE community_id=community AND post_id=target AND content_rating IS DISTINCT FROM 'adult_18';
          UPDATE text_content_submissions SET resulting_content_rating='adult_18' WHERE community_id=community AND published_post_id=target AND resulting_content_rating='general';
          -- Also repair old adult parents whose children predate the new cascade.
          UPDATE comments SET content_rating='adult_18' WHERE community_id=community AND post_id=target AND content_rating<>'adult_18';
          UPDATE posts child SET content_rating='adult_18' FROM media_video_song_references r
            JOIN media_post_submissions s ON s.submission_id=r.submission_id
            WHERE r.song_community_id=community AND r.song_post_id=target
              AND child.community_id=s.community_id AND child.post_id=r.post_id AND child.content_rating<>'adult_18';
        WHEN 'comment' THEN
          UPDATE comments SET content_rating='adult_18' WHERE community_id=community AND comment_id=target AND content_rating<>'adult_18';
          UPDATE text_content_submissions SET resulting_content_rating='adult_18' WHERE community_id=community AND published_comment_id=target AND resulting_content_rating='general';
        WHEN 'text_submission' THEN UPDATE text_content_submissions SET resulting_content_rating='adult_18' WHERE community_id=community AND submission_id=target AND resulting_content_rating='general';
        WHEN 'media_submission' THEN UPDATE media_post_submissions SET resulting_content_rating='adult_18' WHERE community_id=community AND submission_id=target AND resulting_content_rating='general';
      END CASE;
    ELSIF outcome='held' THEN
      IF kind='post' THEN
        UPDATE posts SET status='hidden' WHERE community_id=community AND post_id=target AND status='published';
        UPDATE posts child SET status='hidden' FROM media_video_song_references r JOIN media_post_submissions s ON s.submission_id=r.submission_id
          WHERE r.song_community_id=community AND r.song_post_id=target AND child.community_id=s.community_id AND child.post_id=r.post_id AND child.status='published';
        UPDATE comments c SET status='hidden' WHERE c.status='published' AND ((c.community_id=community AND c.post_id=target)
          OR EXISTS (SELECT 1 FROM media_video_song_references r JOIN media_post_submissions s ON s.submission_id=r.submission_id
            WHERE r.song_community_id=community AND r.song_post_id=target AND c.community_id=s.community_id AND c.post_id=r.post_id));
      ELSIF kind='comment' THEN
        WITH RECURSIVE descendants AS (
          SELECT comment_id FROM comments WHERE community_id=community AND comment_id=target
          UNION SELECT c.comment_id FROM comments c JOIN descendants d ON c.parent_comment_id=d.comment_id WHERE c.community_id=community
        ) UPDATE comments c SET status='hidden' FROM descendants d WHERE c.community_id=community AND c.comment_id=d.comment_id AND c.status='published';
      END IF;
    END IF;
  END LOOP;
  -- Resolve all fingerprints after cascades. The reviewed outcomes must stay exact.
  FOR item IN SELECT value FROM jsonb_array_elements(before_rows) LOOP
    SELECT * INTO STRICT final_row FROM content_rating_reconciliation_candidates_v1
      WHERE target_kind=item->>'target_kind' AND community_id=item->>'community_id' AND target_id=item->>'target_id';
    IF final_row.outcome<>item->>'outcome' THEN RAISE EXCEPTION 'rating reconciliation outcome changed'; END IF;
    event_key:=encode(sha256(convert_to(jsonb_build_array(expected_plan_hash,final_row.target_kind,final_row.community_id,final_row.target_id)::text,'UTF8')),'hex');
    INSERT INTO content_rating_reconciliation_events(event_id,plan_hash,target_kind,community_id,target_id,source_hash,outcome,prior_status,prior_rating)
      VALUES(event_key,expected_plan_hash,final_row.target_kind,final_row.community_id,final_row.target_id,final_row.source_hash,final_row.outcome,item->>'prior_status',item->>'prior_rating');
    INSERT INTO content_rating_reconciliation_current(target_kind,community_id,target_id,event_id)
      VALUES(final_row.target_kind,final_row.community_id,final_row.target_id,event_key)
      ON CONFLICT (target_kind,community_id,target_id) DO UPDATE SET event_id=EXCLUDED.event_id;
  END LOOP;
  RETURN jsonb_build_object('status','applied','plan_hash',expected_plan_hash,'resources',jsonb_array_length(plan->'items'));
END;
$$;
