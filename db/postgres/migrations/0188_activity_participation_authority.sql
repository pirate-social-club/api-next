-- Allocated ordinal for api-activity-participation-authority. Fetched
-- origin/main 3d3d8f20133ef13a3164c3e2f7c19e4d16664a05 was verified through
-- 0187_text_rating_raise_counts.sql when the workspace owner assigned this
-- migration 0188, amending the earlier C3-before-C4 numbering order. The HNS
-- capability lane's unpublished 0188 proposal is superseded and must be
-- renumbered at its own integration. This file was renamed from its original
-- 0128 through the provisional 0189 proposal to its allocated ordinal.
-- Activity authority is independent of posting membership. Money projectors,
-- role authority, historical evidence and frozen reset-runner pins are unchanged.

CREATE FUNCTION active_activity_persona(
  expected_account_id text, expected_persona_id text, expected_community_id text
) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  -- A common lock order fences status changes until the activity transaction
  -- commits. Read-only callers hold these locks only for their read transaction.
  PERFORM 1 FROM users WHERE user_id=expected_account_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM communities WHERE community_id=expected_community_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM personas WHERE persona_id=expected_persona_id
    AND account_id=expected_account_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN active_owned_community_persona(expected_account_id,expected_persona_id,expected_community_id);
END;
$$;

CREATE FUNCTION can_account_access_activity_song(
  expected_account_id text, expected_community_id text, expected_post_id text
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE song_rating text;
BEGIN
  -- All currently composed Study/Karaoke sources support public songs only.
  -- This correction does not expose membership-only or unpublished resources.
  SELECT content_rating INTO song_rating FROM posts
    WHERE community_id=expected_community_id AND post_id=expected_post_id
      AND post_type='song' AND status='published' AND visibility='public' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN can_account_view_content_rating_v1(expected_account_id,song_rating);
END;
$$;

ALTER TABLE persona_community_bindings
  DROP CONSTRAINT persona_community_bindings_source_check,
  ADD CONSTRAINT persona_community_bindings_source_check CHECK (binding_source IN (
    'first_membership','community_creation','persona_creation','activity_participation',
    'migration_single_evidence','explicit_migration_resolution'
  ));


CREATE OR REPLACE FUNCTION guard_study_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  item_count INTEGER;
  answered_count INTEGER;
  correct_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Study sessions cannot be deleted';
  END IF;
  IF NOT active_activity_persona(NEW.account_id, NEW.persona_id, NEW.community_id)
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone)
     OR NOT EXISTS (
       SELECT 1 FROM account_streak_clocks
        WHERE account_id = NEW.account_id AND timezone = NEW.timezone
     ) THEN
    RAISE EXCEPTION 'Study session account, persona, community, or timezone is ineligible';
  END IF;
  IF NOT can_account_access_activity_song(NEW.account_id, NEW.community_id, NEW.post_id) THEN
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

CREATE OR REPLACE FUNCTION guard_karaoke_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attempt_record karaoke_attempts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Karaoke sessions cannot be deleted';
  END IF;
  IF NOT active_activity_persona(NEW.account_id, NEW.persona_id, NEW.community_id)
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone)
     OR NOT EXISTS (
       SELECT 1 FROM account_streak_clocks
        WHERE account_id = NEW.account_id AND timezone = NEW.timezone
     ) THEN
    RAISE EXCEPTION 'Karaoke session account, persona, community, or timezone is ineligible';
  END IF;
  IF NOT can_account_access_activity_song(NEW.account_id, NEW.community_id, NEW.post_id) THEN
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

-- Study v2 uses a different session table from the original qualification
-- producer. Both tables enforce the same activity authority at their writes.
CREATE FUNCTION guard_study_v2_activity_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT active_activity_persona(NEW.account_id,NEW.persona_id,NEW.community_id)
     OR NOT can_account_access_activity_song(NEW.account_id,NEW.community_id,NEW.post_id) THEN
    RAISE EXCEPTION 'Study v2 activity authority is ineligible';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER study_sessions_v2_activity_authority
  BEFORE INSERT OR UPDATE ON study_sessions_v2
  FOR EACH ROW EXECUTE FUNCTION guard_study_v2_activity_authority();

-- An activity presentation already has the exact immutable community/persona
-- binding foreign key. A membership-row foreign key would still prevent first
-- participation before joining. Role presentation keeps its membership FK.
ALTER TABLE persona_activity_presentations
  DROP CONSTRAINT persona_activity_presentations_community_id_account_id_fkey;

-- Explicit activity preparation is idempotent on the exact request body. The
-- action row is written in the same transaction as the selected or minted
-- persona, the one-time activity_participation binding and the
-- presentation-if-absent write.
CREATE FUNCTION guard_persona_activity_preparation_action() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'persona activity preparation actions are append-only';
  END IF;
  RETURN NEW;
END
$$;

CREATE TABLE persona_activity_preparation_actions (
    account_id text NOT NULL,
    community_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    result_persona_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT persona_activity_preparation_actions_idempotency_key_check CHECK (
      (btrim(idempotency_key) <> ''::text)
      AND (idempotency_key = btrim(idempotency_key))
      AND (octet_length(idempotency_key) <= 128)
    ),
    CONSTRAINT persona_activity_preparation_actions_request_hash_check CHECK (
      request_hash ~ '^[0-9a-f]{64}$'::text
    )
);

ALTER TABLE ONLY persona_activity_preparation_actions
  ADD CONSTRAINT persona_activity_preparation_actions_pkey
  PRIMARY KEY (account_id, community_id, idempotency_key);

CREATE TRIGGER persona_activity_preparation_actions_append_only
  BEFORE DELETE OR UPDATE ON persona_activity_preparation_actions
  FOR EACH ROW EXECUTE FUNCTION guard_persona_activity_preparation_action();
