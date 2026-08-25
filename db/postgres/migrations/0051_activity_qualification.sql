-- Spec 015 slice 2: server-authoritative Study and Karaoke qualification,
-- account-pinned streak clocks, day ledgers, projections, and persona-only
-- presentation. This slice deliberately creates no money or chain tables.

CREATE TABLE activity_registry (
  activity_key TEXT PRIMARY KEY CHECK (
    btrim(activity_key) <> '' AND activity_key = btrim(activity_key)
    AND octet_length(activity_key) <= 128
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'reserved')),
  producer_version TEXT CHECK (
    producer_version IS NULL OR (
      btrim(producer_version) <> '' AND producer_version = btrim(producer_version)
      AND octet_length(producer_version) <= 128
    )
  ),
  current_policy_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT activity_registry_state_shape CHECK (
    (status = 'active' AND producer_version IS NOT NULL AND current_policy_version_id IS NOT NULL)
    OR (status = 'reserved' AND producer_version IS NULL AND current_policy_version_id IS NULL)
  ),
  CONSTRAINT activity_registry_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE qualification_policy_versions (
  qualification_policy_version_id TEXT PRIMARY KEY CHECK (
    btrim(qualification_policy_version_id) <> ''
    AND qualification_policy_version_id = btrim(qualification_policy_version_id)
    AND octet_length(qualification_policy_version_id) <= 128
  ),
  activity_key TEXT NOT NULL REFERENCES activity_registry (activity_key),
  policy_kind TEXT NOT NULL,
  policy_document JSONB NOT NULL CHECK (jsonb_typeof(policy_document) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (qualification_policy_version_id, activity_key),
  CONSTRAINT qualification_policy_kind_shape CHECK (
    (activity_key = 'study' AND policy_kind = 'study_session_first_pass_v2')
    OR (activity_key = 'karaoke' AND policy_kind = 'karaoke_qualification_v1')
  ),
  CONSTRAINT qualification_policy_document_shape CHECK (
    (policy_kind = 'study_session_first_pass_v2'
      AND policy_document = '{"required_correct_bps": 7000}'::jsonb)
    OR (policy_kind = 'karaoke_qualification_v1'
      AND policy_document = '{"minimum_scored_line_count": 5, "minimum_coverage_bps": 8500, "minimum_final_score_bps": 7000}'::jsonb)
  )
);

INSERT INTO activity_registry (
  activity_key, status, producer_version, current_policy_version_id
) VALUES
  ('study', 'active', 'study_session_v1', 'study_session_first_pass_v2@1'),
  ('karaoke', 'active', 'karaoke_postgres_v1', 'karaoke_qualification_v1@1'),
  ('dance', 'reserved', NULL, NULL);

INSERT INTO qualification_policy_versions (
  qualification_policy_version_id, activity_key, policy_kind, policy_document
) VALUES
  (
    'study_session_first_pass_v2@1',
    'study',
    'study_session_first_pass_v2',
    '{"required_correct_bps": 7000}'::jsonb
  ),
  (
    'karaoke_qualification_v1@1',
    'karaoke',
    'karaoke_qualification_v1',
    '{"minimum_scored_line_count": 5, "minimum_coverage_bps": 8500, "minimum_final_score_bps": 7000}'::jsonb
  );

ALTER TABLE activity_registry
  ADD CONSTRAINT activity_registry_current_policy_fk
  FOREIGN KEY (current_policy_version_id, activity_key)
  REFERENCES qualification_policy_versions (qualification_policy_version_id, activity_key);

CREATE FUNCTION reject_qualification_policy_version_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'qualification policy versions are append-only';
END
$$;
CREATE TRIGGER qualification_policy_versions_append_only
BEFORE UPDATE OR DELETE ON qualification_policy_versions
FOR EACH ROW EXECUTE FUNCTION reject_qualification_policy_version_change();

CREATE FUNCTION guard_activity_registry_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'activity registry entries cannot be deleted';
  END IF;
  IF NEW.activity_key IS DISTINCT FROM OLD.activity_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'activity registry identity is immutable';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'activity registry time cannot move backward';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER activity_registry_change_guard
BEFORE UPDATE OR DELETE ON activity_registry
FOR EACH ROW EXECUTE FUNCTION guard_activity_registry_change();

CREATE TABLE account_streak_clocks (
  account_id TEXT PRIMARY KEY REFERENCES users (user_id),
  timezone TEXT NOT NULL CHECK (
    btrim(timezone) <> '' AND timezone = btrim(timezone)
    AND octet_length(timezone) <= 128
  ),
  timezone_updated_at TIMESTAMPTZ NOT NULL,
  next_change_allowed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_streak_clock_window CHECK (
    next_change_allowed_at = timezone_updated_at + INTERVAL '7 days'
  )
);

CREATE FUNCTION guard_account_streak_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account streak clocks cannot be deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'account streak timezone is unknown';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'account streak clock identity is immutable';
    END IF;
    IF NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
      RAISE EXCEPTION 'account streak timezone updates must change the timezone';
    END IF;
    IF NEW.timezone_updated_at < OLD.next_change_allowed_at
       OR NEW.timezone_updated_at > clock_timestamp() THEN
      RAISE EXCEPTION 'account streak timezone change is outside its prospective window';
    END IF;
  ELSIF NEW.timezone_updated_at > clock_timestamp() THEN
    RAISE EXCEPTION 'account streak timezone pin cannot begin in the future';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_streak_clocks_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON account_streak_clocks
FOR EACH ROW EXECUTE FUNCTION guard_account_streak_clock();

CREATE TABLE study_sessions (
  session_id TEXT PRIMARY KEY CHECK (
    btrim(session_id) <> '' AND session_id = btrim(session_id)
    AND octet_length(session_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  source_producer_id TEXT NOT NULL CHECK (
    btrim(source_producer_id) <> '' AND source_producer_id = btrim(source_producer_id)
    AND octet_length(source_producer_id) <= 128
  ),
  source_producer_revision TEXT NOT NULL CHECK (
    btrim(source_producer_revision) <> ''
    AND source_producer_revision = btrim(source_producer_revision)
    AND octet_length(source_producer_revision) <= 128
  ),
  source_snapshot_hash TEXT NOT NULL CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  activity_key TEXT GENERATED ALWAYS AS ('study'::text) STORED,
  qualification_policy_version_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/posts/:postId/study/sessions'
    CHECK (endpoint_template = '/communities/:communityId/posts/:postId/study/sessions'),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  timezone TEXT NOT NULL CHECK (
    btrim(timezone) <> '' AND timezone = btrim(timezone)
    AND octet_length(timezone) <= 128
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  qualifying_exercise_count INTEGER NOT NULL CHECK (
    qualifying_exercise_count BETWEEN 1 AND 64
  ),
  answered_exercise_count INTEGER NOT NULL DEFAULT 0 CHECK (
    answered_exercise_count BETWEEN 0 AND qualifying_exercise_count
  ),
  first_pass_correct INTEGER NOT NULL DEFAULT 0 CHECK (
    first_pass_correct BETWEEN 0 AND answered_exercise_count
  ),
  required_correct INTEGER NOT NULL CHECK (
    required_correct = greatest(1, ceil(0.70 * qualifying_exercise_count)::integer)
  ),
  score_bps INTEGER CHECK (score_bps BETWEEN 0 AND 10000),
  streak_day DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (qualification_policy_version_id, activity_key)
    REFERENCES qualification_policy_versions (qualification_policy_version_id, activity_key),
  CONSTRAINT study_sessions_replay_unique UNIQUE (
    account_id, persona_id, endpoint_template, idempotency_key
  ),
  CONSTRAINT study_sessions_terminal_shape CHECK (
    (status = 'active' AND score_bps IS NULL AND streak_day IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND answered_exercise_count = qualifying_exercise_count
      AND score_bps = floor(10000.0 * first_pass_correct / qualifying_exercise_count)::integer
      AND streak_day IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= created_at)
  )
);

CREATE TABLE study_session_items (
  session_id TEXT NOT NULL REFERENCES study_sessions (session_id),
  session_item_id TEXT NOT NULL CHECK (
    btrim(session_item_id) <> '' AND session_item_id = btrim(session_item_id)
    AND octet_length(session_item_id) <= 128
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  source_item_key TEXT NOT NULL CHECK (
    btrim(source_item_key) <> '' AND source_item_key = btrim(source_item_key)
    AND octet_length(source_item_key) <= 128
  ),
  prompt JSONB NOT NULL CHECK (jsonb_typeof(prompt) = 'object'),
  answer_key JSONB NOT NULL CHECK (jsonb_typeof(answer_key) = 'object'),
  presentation_count INTEGER NOT NULL DEFAULT 1 CHECK (presentation_count > 0),
  answer_count INTEGER NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
  first_pass_outcome TEXT CHECK (first_pass_outcome IN ('correct', 'incorrect')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, session_item_id),
  UNIQUE (session_id, ordinal),
  UNIQUE (session_id, source_item_key),
  CONSTRAINT study_session_item_answer_shape CHECK (
    (answer_count = 0 AND first_pass_outcome IS NULL)
    OR (answer_count > 0 AND first_pass_outcome IS NOT NULL)
  )
);

CREATE FUNCTION valid_study_item_v1(candidate_prompt JSONB, candidate_answer_key JSONB)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  choice JSONB;
  accepted JSONB;
BEGIN
  IF jsonb_typeof(candidate_prompt) IS DISTINCT FROM 'object'
     OR jsonb_typeof(candidate_answer_key) IS DISTINCT FROM 'object'
     OR jsonb_typeof(candidate_prompt->'kind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(candidate_prompt->'text') IS DISTINCT FROM 'string'
     OR btrim(candidate_prompt->>'text') = ''
     OR char_length(candidate_prompt->>'text') > 4096
     OR candidate_prompt->>'kind' IS DISTINCT FROM candidate_answer_key->>'kind' THEN
    RETURN false;
  END IF;

  IF candidate_prompt->>'kind' = 'text_response' THEN
    IF candidate_prompt - 'kind' - 'text' <> '{}'::jsonb
       OR candidate_answer_key - 'kind' - 'comparison' - 'accepted_answers' <> '{}'::jsonb
       OR candidate_answer_key->>'comparison' <> 'unicode_casefold_whitespace_v1'
       OR jsonb_typeof(candidate_answer_key->'accepted_answers') IS DISTINCT FROM 'array'
       OR jsonb_array_length(candidate_answer_key->'accepted_answers') NOT BETWEEN 1 AND 12 THEN
      RETURN false;
    END IF;
    FOR accepted IN SELECT value FROM jsonb_array_elements(candidate_answer_key->'accepted_answers')
    LOOP
      IF jsonb_typeof(accepted) IS DISTINCT FROM 'string'
         OR btrim(accepted #>> '{}') = ''
         OR char_length(accepted #>> '{}') > 4096 THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;

  IF candidate_prompt->>'kind' <> 'single_select'
     OR candidate_prompt - 'kind' - 'text' - 'choices' <> '{}'::jsonb
     OR candidate_answer_key - 'kind' - 'correct_choice_key' <> '{}'::jsonb
     OR jsonb_typeof(candidate_prompt->'choices') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate_prompt->'choices') NOT BETWEEN 2 AND 12
     OR jsonb_typeof(candidate_answer_key->'correct_choice_key') IS DISTINCT FROM 'string'
     OR btrim(candidate_answer_key->>'correct_choice_key') = '' THEN
    RETURN false;
  END IF;
  FOR choice IN SELECT value FROM jsonb_array_elements(candidate_prompt->'choices')
  LOOP
    IF jsonb_typeof(choice) IS DISTINCT FROM 'object'
       OR choice - 'choice_key' - 'text' <> '{}'::jsonb
       OR jsonb_typeof(choice->'choice_key') IS DISTINCT FROM 'string'
       OR jsonb_typeof(choice->'text') IS DISTINCT FROM 'string'
       OR btrim(choice->>'choice_key') = ''
       OR btrim(choice->>'text') = ''
       OR octet_length(choice->>'choice_key') > 128
       OR char_length(choice->>'text') > 4096 THEN
      RETURN false;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(candidate_prompt->'choices'))
     <> (SELECT count(DISTINCT value->>'choice_key')
           FROM jsonb_array_elements(candidate_prompt->'choices')) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM jsonb_array_elements(candidate_prompt->'choices')
     WHERE value->>'choice_key' = candidate_answer_key->>'correct_choice_key'
  );
END
$$;

CREATE FUNCTION valid_study_answer_v1(candidate_answer JSONB, expected_kind TEXT)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE expected_kind
    WHEN 'text_response' THEN
      jsonb_typeof(candidate_answer) = 'object'
      AND candidate_answer - 'kind' - 'text' = '{}'::jsonb
      AND candidate_answer->>'kind' = 'text_response'
      AND jsonb_typeof(candidate_answer->'text') = 'string'
      AND btrim(candidate_answer->>'text') <> ''
      AND char_length(candidate_answer->>'text') <= 4096
    WHEN 'single_select' THEN
      jsonb_typeof(candidate_answer) = 'object'
      AND candidate_answer - 'kind' - 'choice_key' = '{}'::jsonb
      AND candidate_answer->>'kind' = 'single_select'
      AND jsonb_typeof(candidate_answer->'choice_key') = 'string'
      AND btrim(candidate_answer->>'choice_key') <> ''
      AND octet_length(candidate_answer->>'choice_key') <= 128
    ELSE false
  END
$$;

CREATE FUNCTION grade_study_answer_v1(candidate_answer JSONB, stored_answer_key JSONB)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stored_answer_key->>'kind'
    WHEN 'single_select' THEN
      candidate_answer->>'choice_key' = stored_answer_key->>'correct_choice_key'
    WHEN 'text_response' THEN EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(stored_answer_key->'accepted_answers') AS accepted(value)
       WHERE regexp_replace(lower(btrim(candidate_answer->>'text')), '\s+', ' ', 'g')
           = regexp_replace(lower(btrim(accepted.value)), '\s+', ' ', 'g')
    )
    ELSE false
  END
$$;

CREATE FUNCTION guard_study_session_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_record study_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Study session items cannot be deleted';
  END IF;
  SELECT * INTO session_record FROM study_sessions WHERE session_id = NEW.session_id FOR SHARE;
  IF session_record.session_id IS NULL OR session_record.status <> 'active' THEN
    RAISE EXCEPTION 'Study items require an active session';
  END IF;
  IF NOT valid_study_item_v1(NEW.prompt, NEW.answer_key) THEN
    RAISE EXCEPTION 'Study item prompt and answer key are invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.session_item_id IS DISTINCT FROM OLD.session_item_id
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
    OR NEW.source_item_key IS DISTINCT FROM OLD.source_item_key
    OR NEW.prompt IS DISTINCT FROM OLD.prompt
    OR NEW.answer_key IS DISTINCT FROM OLD.answer_key
    OR NEW.presentation_count IS DISTINCT FROM OLD.presentation_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.answer_count < OLD.answer_count
    OR (OLD.first_pass_outcome IS NOT NULL
      AND NEW.first_pass_outcome IS DISTINCT FROM OLD.first_pass_outcome)
  ) THEN
    RAISE EXCEPTION 'Study session item evidence is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER study_session_items_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON study_session_items
FOR EACH ROW EXECUTE FUNCTION guard_study_session_item();

CREATE TABLE study_session_answers (
  session_id TEXT NOT NULL,
  session_item_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  answer JSONB NOT NULL CHECK (jsonb_typeof(answer) = 'object'),
  outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
  first_pass BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, session_item_id, attempt_number),
  FOREIGN KEY (session_id, session_item_id)
    REFERENCES study_session_items (session_id, session_item_id),
  UNIQUE (session_id, idempotency_key)
);

CREATE FUNCTION guard_study_session_answer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item_record study_session_items%ROWTYPE;
  session_record study_sessions%ROWTYPE;
  expected_outcome TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Study answers are append-only';
  END IF;
  SELECT * INTO session_record FROM study_sessions WHERE session_id = NEW.session_id FOR SHARE;
  SELECT * INTO item_record FROM study_session_items
   WHERE session_id = NEW.session_id AND session_item_id = NEW.session_item_id FOR SHARE;
  IF session_record.status <> 'active' OR item_record.session_item_id IS NULL THEN
    RAISE EXCEPTION 'Study answers require an active bound item';
  END IF;
  IF NEW.attempt_number <> item_record.answer_count + 1
     OR NEW.first_pass IS DISTINCT FROM (NEW.attempt_number = 1)
     OR NOT valid_study_answer_v1(NEW.answer, item_record.prompt->>'kind') THEN
    RAISE EXCEPTION 'Study answer sequence or shape is invalid';
  END IF;
  expected_outcome := CASE
    WHEN grade_study_answer_v1(NEW.answer, item_record.answer_key) THEN 'correct'
    ELSE 'incorrect'
  END;
  IF NEW.outcome <> expected_outcome THEN
    RAISE EXCEPTION 'Study answer outcome is not server-derived';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER study_session_answers_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON study_session_answers
FOR EACH ROW EXECUTE FUNCTION guard_study_session_answer();

CREATE FUNCTION guard_study_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item_count INTEGER;
  answered_count INTEGER;
  correct_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Study sessions cannot be deleted';
  END IF;
  IF NOT active_owned_persona(NEW.account_id, NEW.persona_id)
     OR NOT active_community_effect(NEW.community_id, NEW.account_id)
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone)
     OR NOT EXISTS (
       SELECT 1 FROM account_streak_clocks
        WHERE account_id = NEW.account_id AND timezone = NEW.timezone
     ) THEN
    RAISE EXCEPTION 'Study session account, persona, community, or timezone is ineligible';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM posts
     WHERE community_id = NEW.community_id AND post_id = NEW.post_id
       AND post_type = 'song' AND status = 'published' AND visibility = 'public'
  ) THEN
    RAISE EXCEPTION 'Study sessions require a public published song';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.session_id, NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
      NEW.audio_revision, NEW.lyrics_revision, NEW.source_revision,
      NEW.source_producer_id, NEW.source_producer_revision, NEW.source_snapshot_hash,
      NEW.qualification_policy_version_id, NEW.endpoint_template,
      NEW.idempotency_key, NEW.request_hash, NEW.timezone,
      NEW.qualifying_exercise_count, NEW.required_correct, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.session_id, OLD.account_id, OLD.persona_id, OLD.community_id, OLD.post_id,
      OLD.audio_revision, OLD.lyrics_revision, OLD.source_revision,
      OLD.source_producer_id, OLD.source_producer_revision, OLD.source_snapshot_hash,
      OLD.qualification_policy_version_id, OLD.endpoint_template,
      OLD.idempotency_key, OLD.request_hash, OLD.timezone,
      OLD.qualifying_exercise_count, OLD.required_correct, OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Study session authority is immutable';
    END IF;
    IF OLD.status = 'completed' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'completed Study sessions are immutable';
    END IF;
    IF OLD.status = 'active' AND NEW.status = 'completed' THEN
      SELECT count(*),
             count(*) FILTER (WHERE answer_count > 0),
             count(*) FILTER (WHERE first_pass_outcome = 'correct')
        INTO item_count, answered_count, correct_count
        FROM study_session_items WHERE session_id = NEW.session_id;
      IF item_count <> NEW.qualifying_exercise_count
         OR answered_count <> NEW.answered_exercise_count
         OR correct_count <> NEW.first_pass_correct
         OR NEW.streak_day <> (NEW.completed_at AT TIME ZONE NEW.timezone)::date THEN
        RAISE EXCEPTION 'Study completion is not derived from frozen item evidence';
      END IF;
    ELSIF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'invalid Study session transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER study_sessions_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON study_sessions
FOR EACH ROW EXECUTE FUNCTION guard_study_session();

CREATE TABLE karaoke_sessions (
  session_id TEXT PRIMARY KEY CHECK (
    btrim(session_id) <> '' AND session_id = btrim(session_id)
    AND octet_length(session_id) <= 128
  ),
  attempt_id TEXT NOT NULL UNIQUE CHECK (
    btrim(attempt_id) <> '' AND attempt_id = btrim(attempt_id)
    AND octet_length(attempt_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  karaoke_revision_id TEXT NOT NULL CHECK (
    btrim(karaoke_revision_id) <> '' AND karaoke_revision_id = btrim(karaoke_revision_id)
    AND octet_length(karaoke_revision_id) <= 128
  ),
  activity_key TEXT GENERATED ALWAYS AS ('karaoke'::text) STORED,
  qualification_policy_version_id TEXT NOT NULL,
  endpoint_template TEXT NOT NULL DEFAULT '/communities/:communityId/posts/:postId/karaoke/attempts'
    CHECK (endpoint_template = '/communities/:communityId/posts/:postId/karaoke/attempts'),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  timezone TEXT NOT NULL CHECK (
    btrim(timezone) <> '' AND timezone = btrim(timezone)
    AND octet_length(timezone) <= 128
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (qualification_policy_version_id, activity_key)
    REFERENCES qualification_policy_versions (qualification_policy_version_id, activity_key),
  CONSTRAINT karaoke_sessions_replay_unique UNIQUE (
    account_id, persona_id, endpoint_template, idempotency_key
  ),
  CONSTRAINT karaoke_sessions_attempt_binding_unique UNIQUE (session_id, attempt_id),
  CONSTRAINT karaoke_sessions_time_shape CHECK (
    expires_at > created_at
    AND ((status = 'active' AND completed_at IS NULL)
      OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= created_at))
  )
);

CREATE TABLE karaoke_attempts (
  attempt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  completion_reason TEXT NOT NULL CHECK (
    completion_reason IN ('completed', 'session_error', 'provider_unavailable', 'abandoned')
  ),
  scoring_version INTEGER NOT NULL CHECK (scoring_version > 0),
  scoring_provider TEXT NOT NULL CHECK (
    btrim(scoring_provider) <> '' AND scoring_provider = btrim(scoring_provider)
    AND octet_length(scoring_provider) <= 128
  ),
  scoring_model TEXT NOT NULL CHECK (
    btrim(scoring_model) <> '' AND scoring_model = btrim(scoring_model)
    AND octet_length(scoring_model) <= 256
  ),
  final_score_bps INTEGER NOT NULL CHECK (final_score_bps BETWEEN 0 AND 10000),
  scored_line_count INTEGER NOT NULL CHECK (scored_line_count >= 0),
  line_count INTEGER NOT NULL CHECK (line_count > 0 AND scored_line_count <= line_count),
  coverage_bps INTEGER GENERATED ALWAYS AS (
    floor(10000.0 * scored_line_count / line_count)::integer
  ) STORED,
  evidence_summary JSONB NOT NULL CHECK (jsonb_typeof(evidence_summary) = 'object'),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (session_id, attempt_id) REFERENCES karaoke_sessions (session_id, attempt_id),
  CONSTRAINT karaoke_attempt_terminal_shape CHECK (
    completed_at >= created_at
    AND ((completion_reason = 'completed')
      OR (final_score_bps = 0 AND scored_line_count = 0))
  )
);

CREATE FUNCTION guard_karaoke_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_record karaoke_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Karaoke sessions cannot be deleted';
  END IF;
  IF NOT active_owned_persona(NEW.account_id, NEW.persona_id)
     OR NOT active_community_effect(NEW.community_id, NEW.account_id)
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone)
     OR NOT EXISTS (
       SELECT 1 FROM account_streak_clocks
        WHERE account_id = NEW.account_id AND timezone = NEW.timezone
     ) THEN
    RAISE EXCEPTION 'Karaoke session account, persona, community, or timezone is ineligible';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM posts
     WHERE community_id = NEW.community_id AND post_id = NEW.post_id
       AND post_type = 'song' AND status = 'published' AND visibility = 'public'
  ) THEN
    RAISE EXCEPTION 'Karaoke sessions require a public published song';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.session_id, NEW.attempt_id, NEW.account_id, NEW.persona_id,
      NEW.community_id, NEW.post_id, NEW.audio_revision, NEW.karaoke_revision_id,
      NEW.qualification_policy_version_id, NEW.endpoint_template,
      NEW.idempotency_key, NEW.request_hash, NEW.timezone, NEW.created_at, NEW.expires_at
    ) IS DISTINCT FROM ROW(
      OLD.session_id, OLD.attempt_id, OLD.account_id, OLD.persona_id,
      OLD.community_id, OLD.post_id, OLD.audio_revision, OLD.karaoke_revision_id,
      OLD.qualification_policy_version_id, OLD.endpoint_template,
      OLD.idempotency_key, OLD.request_hash, OLD.timezone, OLD.created_at, OLD.expires_at
    ) THEN
      RAISE EXCEPTION 'Karaoke session authority is immutable';
    END IF;
    IF OLD.status = 'completed' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'completed Karaoke sessions are immutable';
    END IF;
    IF OLD.status = 'active' AND NEW.status = 'completed' THEN
      SELECT * INTO attempt_record FROM karaoke_attempts
       WHERE session_id = NEW.session_id AND attempt_id = NEW.attempt_id;
      IF attempt_record.attempt_id IS NULL
         OR NEW.completed_at IS DISTINCT FROM attempt_record.completed_at THEN
        RAISE EXCEPTION 'Karaoke completion requires exact terminal attempt evidence';
      END IF;
    ELSIF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'invalid Karaoke session transition';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER karaoke_sessions_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON karaoke_sessions
FOR EACH ROW EXECUTE FUNCTION guard_karaoke_session();

CREATE FUNCTION guard_karaoke_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  session_record karaoke_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Karaoke attempts are append-only';
  END IF;
  SELECT * INTO session_record FROM karaoke_sessions
   WHERE session_id = NEW.session_id AND attempt_id = NEW.attempt_id FOR SHARE;
  IF session_record.session_id IS NULL OR session_record.status <> 'active'
     OR NEW.created_at IS DISTINCT FROM session_record.created_at
     OR NEW.completed_at < session_record.created_at THEN
    RAISE EXCEPTION 'Karaoke attempt is not bound to its active session';
  END IF;
  IF NEW.evidence_summary <> jsonb_build_object(
    'kind', 'karaoke_qualification_v1',
    'scored_line_count', NEW.scored_line_count,
    'line_count', NEW.line_count,
    'coverage_bps', floor(10000.0 * NEW.scored_line_count / NEW.line_count)::integer,
    'final_score_bps', NEW.final_score_bps,
    'scoring_version', NEW.scoring_version,
    'scoring_provider', NEW.scoring_provider,
    'karaoke_revision_id', session_record.karaoke_revision_id
  ) THEN
    RAISE EXCEPTION 'Karaoke attempt evidence summary is not exact';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER karaoke_attempts_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON karaoke_attempts
FOR EACH ROW EXECUTE FUNCTION guard_karaoke_attempt();

CREATE TABLE activity_qualifications (
  qualification_id TEXT PRIMARY KEY CHECK (
    btrim(qualification_id) <> '' AND qualification_id = btrim(qualification_id)
    AND octet_length(qualification_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  persona_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  activity_key TEXT NOT NULL REFERENCES activity_registry (activity_key),
  study_session_id TEXT,
  karaoke_session_id TEXT,
  karaoke_attempt_id TEXT,
  score_bps INTEGER NOT NULL CHECK (score_bps BETWEEN 0 AND 10000),
  qualification_policy_version_id TEXT NOT NULL,
  qualified_at TIMESTAMPTZ NOT NULL,
  reward_period_key DATE GENERATED ALWAYS AS ((qualified_at AT TIME ZONE 'UTC')::date) STORED,
  streak_day DATE NOT NULL,
  evidence_summary JSONB NOT NULL CHECK (jsonb_typeof(evidence_summary) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, persona_id) REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  FOREIGN KEY (qualification_policy_version_id, activity_key)
    REFERENCES qualification_policy_versions (qualification_policy_version_id, activity_key),
  CONSTRAINT activity_qualification_attempt_shape CHECK (
    (activity_key = 'study' AND study_session_id IS NOT NULL
      AND karaoke_session_id IS NULL AND karaoke_attempt_id IS NULL)
    OR (activity_key = 'karaoke' AND study_session_id IS NULL
      AND karaoke_session_id IS NOT NULL AND karaoke_attempt_id IS NOT NULL)
  ),
  CONSTRAINT activity_qualification_commit_time CHECK (created_at >= qualified_at)
);
CREATE UNIQUE INDEX activity_qualifications_study_attempt_uidx
  ON activity_qualifications (account_id, post_id, activity_key, study_session_id)
  WHERE activity_key = 'study';
CREATE UNIQUE INDEX activity_qualifications_karaoke_attempt_uidx
  ON activity_qualifications (
    account_id, post_id, activity_key, karaoke_session_id, karaoke_attempt_id
  ) WHERE activity_key = 'karaoke';
CREATE INDEX activity_qualifications_song_period_idx
  ON activity_qualifications (
    community_id, post_id, reward_period_key, activity_key, qualified_at, qualification_id
  );
CREATE INDEX activity_qualifications_account_time_idx
  ON activity_qualifications (account_id, qualified_at DESC, qualification_id);

CREATE FUNCTION guard_activity_qualification() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  study_record study_sessions%ROWTYPE;
  karaoke_session_record karaoke_sessions%ROWTYPE;
  karaoke_attempt_record karaoke_attempts%ROWTYPE;
  expected_evidence JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'activity qualifications are append-only';
  END IF;
  IF NEW.activity_key = 'study' THEN
    SELECT * INTO study_record FROM study_sessions
     WHERE session_id = NEW.study_session_id FOR SHARE;
    expected_evidence := jsonb_build_object(
      'kind', 'study_session_first_pass_v2',
      'qualifying_exercise_count', study_record.qualifying_exercise_count,
      'first_pass_correct', study_record.first_pass_correct,
      'required_correct', study_record.required_correct
    );
    IF study_record.session_id IS NULL OR study_record.status <> 'completed'
       OR study_record.first_pass_correct < study_record.required_correct
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         study_record.account_id, study_record.persona_id,
         study_record.community_id, study_record.post_id,
         study_record.audio_revision, study_record.qualification_policy_version_id,
         study_record.score_bps, study_record.completed_at,
         study_record.streak_day, expected_evidence
       ) THEN
      RAISE EXCEPTION 'Study qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.activity_key = 'karaoke' THEN
    SELECT * INTO karaoke_session_record FROM karaoke_sessions
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    SELECT * INTO karaoke_attempt_record FROM karaoke_attempts
     WHERE session_id = NEW.karaoke_session_id
       AND attempt_id = NEW.karaoke_attempt_id FOR SHARE;
    IF karaoke_session_record.session_id IS NULL
       OR karaoke_session_record.status <> 'completed'
       OR karaoke_attempt_record.completion_reason <> 'completed'
       OR karaoke_attempt_record.scored_line_count < 5
       OR karaoke_attempt_record.coverage_bps < 8500
       OR karaoke_attempt_record.final_score_bps < 7000
       OR ROW(
         NEW.account_id, NEW.persona_id, NEW.community_id, NEW.post_id,
         NEW.audio_revision, NEW.qualification_policy_version_id,
         NEW.score_bps, NEW.qualified_at, NEW.streak_day, NEW.evidence_summary
       ) IS DISTINCT FROM ROW(
         karaoke_session_record.account_id, karaoke_session_record.persona_id,
         karaoke_session_record.community_id, karaoke_session_record.post_id,
         karaoke_session_record.audio_revision,
         karaoke_session_record.qualification_policy_version_id,
         karaoke_attempt_record.final_score_bps, karaoke_attempt_record.completed_at,
         (karaoke_attempt_record.completed_at AT TIME ZONE karaoke_session_record.timezone)::date,
         karaoke_attempt_record.evidence_summary
       ) THEN
      RAISE EXCEPTION 'Karaoke qualification is not exact reducer output';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reserved activities cannot produce qualifications';
END
$$;
CREATE TRIGGER activity_qualifications_change_guard
BEFORE INSERT OR UPDATE OR DELETE ON activity_qualifications
FOR EACH ROW EXECUTE FUNCTION guard_activity_qualification();

CREATE TABLE song_streak_days (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  streak_day DATE NOT NULL,
  first_qualification_id TEXT NOT NULL REFERENCES activity_qualifications (qualification_id),
  earned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, post_id, streak_day),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id)
);

CREATE TABLE song_streak_day_activities (
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  streak_day DATE NOT NULL,
  activity_key TEXT NOT NULL REFERENCES activity_registry (activity_key),
  qualification_count INTEGER NOT NULL DEFAULT 1 CHECK (qualification_count > 0),
  first_qualified_at TIMESTAMPTZ NOT NULL,
  last_qualified_at TIMESTAMPTZ NOT NULL,
  last_qualification_id TEXT NOT NULL REFERENCES activity_qualifications (qualification_id),
  PRIMARY KEY (account_id, post_id, streak_day, activity_key),
  FOREIGN KEY (account_id, post_id, streak_day)
    REFERENCES song_streak_days (account_id, post_id, streak_day),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT song_streak_day_activity_time_order CHECK (
    last_qualified_at >= first_qualified_at
  )
);

CREATE TABLE community_streak_days (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  streak_day DATE NOT NULL,
  first_qualification_id TEXT NOT NULL REFERENCES activity_qualifications (qualification_id),
  earned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, community_id, streak_day)
);

CREATE TABLE song_streaks (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  current_count INTEGER NOT NULL CHECK (current_count > 0),
  best_count INTEGER NOT NULL CHECK (best_count >= current_count),
  started_day DATE NOT NULL,
  last_day DATE NOT NULL,
  total_days INTEGER NOT NULL CHECK (total_days >= best_count),
  active_until_at TIMESTAMPTZ NOT NULL,
  recomputed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, post_id),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT song_streaks_day_order CHECK (last_day >= started_day)
);
CREATE INDEX song_streaks_live_leaderboard_idx
  ON song_streaks (
    community_id, post_id, current_count DESC, best_count DESC,
    started_day, account_id, active_until_at
  );

CREATE TABLE community_streaks (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  current_count INTEGER NOT NULL CHECK (current_count > 0),
  best_count INTEGER NOT NULL CHECK (best_count >= current_count),
  started_day DATE NOT NULL,
  last_day DATE NOT NULL,
  total_days INTEGER NOT NULL CHECK (total_days >= best_count),
  active_until_at TIMESTAMPTZ NOT NULL,
  recomputed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, community_id),
  CONSTRAINT community_streaks_day_order CHECK (last_day >= started_day)
);
CREATE INDEX community_streaks_live_leaderboard_idx
  ON community_streaks (
    community_id, current_count DESC, best_count DESC,
    started_day, account_id, active_until_at
  );

CREATE TABLE persona_activity_presentations (
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, account_id),
  FOREIGN KEY (community_id, account_id)
    REFERENCES community_memberships (community_id, user_id),
  FOREIGN KEY (account_id, persona_id)
    REFERENCES personas (account_id, persona_id),
  CONSTRAINT persona_activity_presentations_time_order CHECK (updated_at >= created_at)
);
CREATE TRIGGER persona_activity_presentations_active_persona
BEFORE INSERT OR UPDATE OF account_id, persona_id ON persona_activity_presentations
FOR EACH ROW EXECUTE FUNCTION require_active_role_persona();

CREATE FUNCTION guard_reward_day_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reward day ledgers are append-only';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_streak_days_append_only
BEFORE UPDATE OR DELETE ON song_streak_days
FOR EACH ROW EXECUTE FUNCTION guard_reward_day_ledger();
CREATE TRIGGER community_streak_days_append_only
BEFORE UPDATE OR DELETE ON community_streak_days
FOR EACH ROW EXECUTE FUNCTION guard_reward_day_ledger();

CREATE FUNCTION guard_song_streak_day_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song streak day activity rows cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW.account_id, NEW.community_id, NEW.post_id, NEW.streak_day,
      NEW.activity_key, NEW.first_qualified_at)
    IS DISTINCT FROM
    ROW(OLD.account_id, OLD.community_id, OLD.post_id, OLD.streak_day,
      OLD.activity_key, OLD.first_qualified_at)
    OR NEW.qualification_count <> OLD.qualification_count + 1
    OR NEW.last_qualified_at < OLD.last_qualified_at
    OR NEW.last_qualification_id IS NOT DISTINCT FROM OLD.last_qualification_id
  ) THEN
    RAISE EXCEPTION 'song streak day activity updates must append one qualification';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_streak_day_activities_change_guard
BEFORE UPDATE OR DELETE ON song_streak_day_activities
FOR EACH ROW EXECUTE FUNCTION guard_song_streak_day_activity();

CREATE FUNCTION guard_streak_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'streak projections cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.recomputed_at < OLD.recomputed_at THEN
    RAISE EXCEPTION 'streak projection recompute time cannot move backward';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER song_streaks_change_guard
BEFORE UPDATE OR DELETE ON song_streaks
FOR EACH ROW EXECUTE FUNCTION guard_streak_projection();
CREATE TRIGGER community_streaks_change_guard
BEFORE UPDATE OR DELETE ON community_streaks
FOR EACH ROW EXECUTE FUNCTION guard_streak_projection();

CREATE FUNCTION guard_persona_activity_presentation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'activity presentation selection cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.community_id IS DISTINCT FROM OLD.community_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'activity presentation identity is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER persona_activity_presentations_change_guard
BEFORE UPDATE OR DELETE ON persona_activity_presentations
FOR EACH ROW EXECUTE FUNCTION guard_persona_activity_presentation();

CREATE INDEX song_streak_days_recompute_idx
  ON song_streak_days (account_id, post_id, streak_day);
CREATE INDEX community_streak_days_recompute_idx
  ON community_streak_days (account_id, community_id, streak_day);
CREATE INDEX study_sessions_account_created_idx
  ON study_sessions (account_id, created_at DESC, session_id);
CREATE INDEX karaoke_sessions_account_created_idx
  ON karaoke_sessions (account_id, created_at DESC, session_id);
