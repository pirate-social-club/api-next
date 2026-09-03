CREATE FUNCTION song_owner_policy_hash_v1(
  input_community_id TEXT,
  input_post_id TEXT,
  input_audio_revision BIGINT,
  input_owner_account_id TEXT,
  input_policy_revision BIGINT,
  input_third_party_reward_legs TEXT,
  input_pool_leg TEXT,
  input_derivative_video TEXT
) RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'audio_revision', input_audio_revision,
          'community_id', input_community_id,
          'derivative_video', input_derivative_video,
          'owner_account_id', input_owner_account_id,
          'policy_revision', input_policy_revision,
          'pool_leg', input_pool_leg,
          'post_id', input_post_id,
          'third_party_reward_legs', input_third_party_reward_legs,
          'version', 'song-owner-policy-v1'
        )::TEXT,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

CREATE TABLE song_owner_policy_revisions (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (
    audio_revision BETWEEN 1 AND 9007199254740991
  ),
  owner_account_id TEXT NOT NULL REFERENCES users (user_id),
  policy_revision BIGINT NOT NULL CHECK (
    policy_revision BETWEEN 1 AND 9007199254740991
  ),
  third_party_reward_legs TEXT NOT NULL CHECK (
    third_party_reward_legs IN ('allowed', 'owner_only')
  ),
  pool_leg TEXT NOT NULL CHECK (pool_leg IN ('allowed', 'declined')),
  derivative_video TEXT NOT NULL CHECK (
    derivative_video IN ('allowed', 'owner_only', 'blocked')
  ),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, post_id, policy_revision),
  UNIQUE (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    policy_revision,
    policy_hash
  ),
  UNIQUE (
    community_id,
    post_id,
    audio_revision,
    policy_revision,
    policy_hash
  ),
  FOREIGN KEY (community_id, post_id) REFERENCES posts (community_id, post_id),
  CONSTRAINT song_owner_policy_revision_hash_exact CHECK (
    policy_hash = song_owner_policy_hash_v1(
      community_id,
      post_id,
      audio_revision,
      owner_account_id,
      policy_revision,
      third_party_reward_legs,
      pool_leg,
      derivative_video
    )
  )
);

CREATE TABLE song_owner_policies (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (
    audio_revision BETWEEN 1 AND 9007199254740991
  ),
  owner_account_id TEXT NOT NULL REFERENCES users (user_id),
  current_policy_revision BIGINT NOT NULL CHECK (
    current_policy_revision BETWEEN 1 AND 9007199254740991
  ),
  current_policy_hash TEXT NOT NULL CHECK (
    current_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, post_id),
  UNIQUE (post_id),
  UNIQUE (community_id, post_id, audio_revision),
  FOREIGN KEY (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    current_policy_revision,
    current_policy_hash
  ) REFERENCES song_owner_policy_revisions (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    policy_revision,
    policy_hash
  )
);

CREATE FUNCTION guard_song_owner_policy_revisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'song owner policy revisions are append-only';
END;
$$;

CREATE TRIGGER song_owner_policy_revisions_append_only
BEFORE UPDATE OR DELETE ON song_owner_policy_revisions
FOR EACH ROW EXECUTE FUNCTION guard_song_owner_policy_revisions_append_only();

CREATE FUNCTION validate_song_owner_policy_head_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'song owner policy heads are retained';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.community_id IS DISTINCT FROM OLD.community_id
    OR NEW.post_id IS DISTINCT FROM OLD.post_id
    OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision
    OR NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.current_policy_revision <> OLD.current_policy_revision + 1
    OR NEW.current_policy_hash IS NOT DISTINCT FROM OLD.current_policy_hash
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION 'song owner policy head must advance by one immutable revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER song_owner_policy_head_change_guard
BEFORE UPDATE OR DELETE ON song_owner_policies
FOR EACH ROW EXECUTE FUNCTION validate_song_owner_policy_head_change();

CREATE FUNCTION initialize_song_owner_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  publication_post posts%ROWTYPE;
  song_terms media_submission_terms%ROWTYPE;
  initial_derivative_video TEXT;
  initial_hash TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO publication_post
    FROM posts
   WHERE community_id = NEW.community_id
     AND post_id = NEW.post_id
   FOR SHARE;
  IF publication_post.post_id IS NULL THEN
    RAISE EXCEPTION 'song owner policy requires a canonical Post';
  END IF;
  IF publication_post.post_type <> 'song' THEN
    RETURN NEW;
  END IF;
  IF publication_post.status <> 'published'
    OR publication_post.author_user_id IS DISTINCT FROM NEW.actor_account_id
  THEN
    RAISE EXCEPTION 'song owner policy requires the canonical published song owner';
  END IF;

  SELECT * INTO song_terms
    FROM media_submission_terms
   WHERE submission_id = NEW.submission_id
     AND community_id = NEW.community_id
     AND actor_user_id = NEW.actor_account_id
     AND operation_id = NEW.operation_id
     AND creation_revision = NEW.creation_revision
   FOR SHARE;
  IF song_terms.submission_id IS NULL THEN
    RAISE EXCEPTION 'song owner policy requires immutable publication terms';
  END IF;

  initial_derivative_video := CASE song_terms.license_preset
    WHEN 'commercial-remix' THEN 'allowed'
    WHEN 'non-commercial' THEN 'allowed'
    WHEN 'commercial-use' THEN 'owner_only'
    ELSE NULL
  END;
  IF initial_derivative_video IS NULL THEN
    RAISE EXCEPTION 'song owner policy license preset is unsupported';
  END IF;

  initial_hash := song_owner_policy_hash_v1(
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    'allowed',
    'allowed',
    initial_derivative_video
  );

  INSERT INTO song_owner_policy_revisions (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    policy_revision,
    third_party_reward_legs,
    pool_leg,
    derivative_video,
    policy_hash,
    effective_at
  ) VALUES (
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    'allowed',
    'allowed',
    initial_derivative_video,
    initial_hash,
    database_now
  );

  INSERT INTO song_owner_policies (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    current_policy_revision,
    current_policy_hash,
    created_at,
    updated_at
  ) VALUES (
    NEW.community_id,
    NEW.post_id,
    NEW.audio_revision,
    NEW.actor_account_id,
    1,
    initial_hash,
    database_now,
    database_now
  );
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM media_publication_projections AS publication
      JOIN posts AS post
        ON post.community_id = publication.community_id
       AND post.post_id = publication.post_id
      LEFT JOIN media_submission_terms AS terms
        ON terms.submission_id = publication.submission_id
       AND terms.community_id = publication.community_id
       AND terms.actor_user_id = publication.actor_account_id
       AND terms.operation_id = publication.operation_id
       AND terms.creation_revision = publication.creation_revision
     WHERE post.post_type = 'song'
       AND (
         post.status <> 'published'
         OR post.author_user_id IS DISTINCT FROM publication.actor_account_id
         OR terms.submission_id IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'existing song publication cannot be assigned an exact owner policy';
  END IF;
END;
$$;

INSERT INTO song_owner_policy_revisions (
  community_id,
  post_id,
  audio_revision,
  owner_account_id,
  policy_revision,
  third_party_reward_legs,
  pool_leg,
  derivative_video,
  policy_hash,
  effective_at
)
SELECT
  publication.community_id,
  publication.post_id,
  publication.audio_revision,
  publication.actor_account_id,
  1,
  'allowed',
  'allowed',
  CASE terms.license_preset
    WHEN 'commercial-remix' THEN 'allowed'
    WHEN 'non-commercial' THEN 'allowed'
    WHEN 'commercial-use' THEN 'owner_only'
  END,
  song_owner_policy_hash_v1(
    publication.community_id,
    publication.post_id,
    publication.audio_revision,
    publication.actor_account_id,
    1,
    'allowed',
    'allowed',
    CASE terms.license_preset
      WHEN 'commercial-remix' THEN 'allowed'
      WHEN 'non-commercial' THEN 'allowed'
      WHEN 'commercial-use' THEN 'owner_only'
    END
  ),
  publication.projected_at
FROM media_publication_projections AS publication
JOIN posts AS post
  ON post.community_id = publication.community_id
 AND post.post_id = publication.post_id
JOIN media_submission_terms AS terms
  ON terms.submission_id = publication.submission_id
 AND terms.community_id = publication.community_id
 AND terms.actor_user_id = publication.actor_account_id
 AND terms.operation_id = publication.operation_id
 AND terms.creation_revision = publication.creation_revision
WHERE post.post_type = 'song';

INSERT INTO song_owner_policies (
  community_id,
  post_id,
  audio_revision,
  owner_account_id,
  current_policy_revision,
  current_policy_hash,
  created_at,
  updated_at
)
SELECT
  revision.community_id,
  revision.post_id,
  revision.audio_revision,
  revision.owner_account_id,
  revision.policy_revision,
  revision.policy_hash,
  revision.effective_at,
  revision.effective_at
FROM song_owner_policy_revisions AS revision
WHERE revision.policy_revision = 1;

CREATE TRIGGER media_publication_song_owner_policy_initialize
AFTER INSERT ON media_publication_projections
FOR EACH ROW EXECUTE FUNCTION initialize_song_owner_policy_v1();

CREATE FUNCTION append_song_owner_policy_revision_v1(
  input_community_id TEXT,
  input_post_id TEXT,
  input_actor_account_id TEXT,
  input_expected_policy_revision BIGINT,
  input_third_party_reward_legs TEXT,
  input_pool_leg TEXT,
  input_derivative_video TEXT
) RETURNS SETOF song_owner_policy_revisions
LANGUAGE plpgsql
STRICT
AS $$
DECLARE
  policy_head song_owner_policies%ROWTYPE;
  next_revision BIGINT;
  next_hash TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_third_party_reward_legs NOT IN ('allowed', 'owner_only')
    OR input_pool_leg NOT IN ('allowed', 'declined')
    OR input_derivative_video NOT IN ('allowed', 'owner_only', 'blocked')
  THEN
    RAISE EXCEPTION 'invalid song owner policy values';
  END IF;

  SELECT * INTO policy_head
    FROM song_owner_policies
   WHERE community_id = input_community_id
     AND post_id = input_post_id
   FOR UPDATE;
  IF policy_head.post_id IS NULL THEN
    RAISE EXCEPTION 'song owner policy not found';
  END IF;
  IF policy_head.owner_account_id <> input_actor_account_id THEN
    RAISE EXCEPTION 'song owner policy actor is not the owner account';
  END IF;
  IF policy_head.current_policy_revision <> input_expected_policy_revision THEN
    RAISE EXCEPTION 'song owner policy revision conflict';
  END IF;
  IF policy_head.current_policy_revision = 9007199254740991 THEN
    RAISE EXCEPTION 'song owner policy revision exhausted';
  END IF;

  next_revision := policy_head.current_policy_revision + 1;
  next_hash := song_owner_policy_hash_v1(
    policy_head.community_id,
    policy_head.post_id,
    policy_head.audio_revision,
    policy_head.owner_account_id,
    next_revision,
    input_third_party_reward_legs,
    input_pool_leg,
    input_derivative_video
  );

  INSERT INTO song_owner_policy_revisions (
    community_id,
    post_id,
    audio_revision,
    owner_account_id,
    policy_revision,
    third_party_reward_legs,
    pool_leg,
    derivative_video,
    policy_hash,
    effective_at
  ) VALUES (
    policy_head.community_id,
    policy_head.post_id,
    policy_head.audio_revision,
    policy_head.owner_account_id,
    next_revision,
    input_third_party_reward_legs,
    input_pool_leg,
    input_derivative_video,
    next_hash,
    database_now
  );

  UPDATE song_owner_policies
     SET current_policy_revision = next_revision,
         current_policy_hash = next_hash,
         updated_at = database_now
   WHERE community_id = policy_head.community_id
     AND post_id = policy_head.post_id;

  RETURN QUERY
  SELECT revision.*
    FROM song_owner_policy_revisions AS revision
   WHERE revision.community_id = policy_head.community_id
     AND revision.post_id = policy_head.post_id
     AND revision.policy_revision = next_revision;
END;
$$;

CREATE TABLE song_derivative_video_policy_observations (
  operation_id TEXT NOT NULL CHECK (
    btrim(operation_id) <> ''
    AND operation_id = btrim(operation_id)
    AND octet_length(operation_id) <= 128
    AND operation_id !~ '[[:cntrl:]]'
  ),
  observed_at_transition TEXT NOT NULL CHECK (
    observed_at_transition IN (
      'media_reservation_issued',
      'publication_allowed',
      'publication_committed'
    )
  ),
  creation_revision BIGINT NOT NULL CHECK (
    creation_revision BETWEEN 1 AND 9007199254740991
  ),
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  audio_revision BIGINT NOT NULL CHECK (
    audio_revision BETWEEN 1 AND 9007199254740991
  ),
  actor_account_id TEXT NOT NULL REFERENCES users (user_id),
  owner_policy_revision BIGINT NOT NULL CHECK (
    owner_policy_revision BETWEEN 1 AND 9007199254740991
  ),
  owner_policy_hash TEXT NOT NULL CHECK (
    owner_policy_hash ~ '^[0-9a-f]{64}$'
  ),
  derivative_video TEXT NOT NULL CHECK (
    derivative_video IN ('allowed', 'owner_only', 'blocked')
  ),
  permitted BOOLEAN NOT NULL,
  denial_reason TEXT CHECK (
    denial_reason IS NULL
    OR denial_reason IN ('derivative_video_blocked', 'derivative_video_owner_only')
  ),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, observed_at_transition, creation_revision),
  FOREIGN KEY (
    community_id,
    post_id,
    audio_revision,
    owner_policy_revision,
    owner_policy_hash
  ) REFERENCES song_owner_policy_revisions (
    community_id,
    post_id,
    audio_revision,
    policy_revision,
    policy_hash
  ),
  CONSTRAINT song_derivative_video_policy_observation_outcome CHECK (
    (permitted AND denial_reason IS NULL)
    OR (
      NOT permitted
      AND denial_reason = CASE derivative_video
        WHEN 'blocked' THEN 'derivative_video_blocked'
        WHEN 'owner_only' THEN 'derivative_video_owner_only'
        ELSE NULL
      END
    )
  )
);

CREATE FUNCTION guard_song_derivative_video_policy_observations_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'song derivative video policy observations are append-only';
END;
$$;

CREATE TRIGGER song_derivative_video_policy_observations_append_only
BEFORE UPDATE OR DELETE ON song_derivative_video_policy_observations
FOR EACH ROW EXECUTE FUNCTION guard_song_derivative_video_policy_observations_append_only();

CREATE FUNCTION observe_song_derivative_video_policy_v1(
  input_operation_id TEXT,
  input_transition TEXT,
  input_creation_revision BIGINT,
  input_community_id TEXT,
  input_post_id TEXT,
  input_audio_revision BIGINT,
  input_actor_account_id TEXT
) RETURNS SETOF song_derivative_video_policy_observations
LANGUAGE plpgsql
STRICT
AS $$
DECLARE
  policy_head song_owner_policies%ROWTYPE;
  policy_record song_owner_policy_revisions%ROWTYPE;
  existing_observation song_derivative_video_policy_observations%ROWTYPE;
  is_permitted BOOLEAN;
  reason TEXT;
BEGIN
  IF input_transition NOT IN (
    'media_reservation_issued',
    'publication_allowed',
    'publication_committed'
  ) THEN
    RAISE EXCEPTION 'invalid song derivative video policy transition';
  END IF;

  SELECT * INTO existing_observation
    FROM song_derivative_video_policy_observations
   WHERE operation_id = input_operation_id
     AND observed_at_transition = input_transition
     AND creation_revision = input_creation_revision;
  IF existing_observation.operation_id IS NOT NULL THEN
    IF existing_observation.community_id <> input_community_id
      OR existing_observation.post_id <> input_post_id
      OR existing_observation.audio_revision <> input_audio_revision
      OR existing_observation.actor_account_id <> input_actor_account_id
    THEN
      RAISE EXCEPTION 'song derivative video policy observation replay conflict';
    END IF;
    RETURN NEXT existing_observation;
    RETURN;
  END IF;

  SELECT * INTO policy_head
    FROM song_owner_policies
   WHERE community_id = input_community_id
     AND post_id = input_post_id
   FOR SHARE;
  IF policy_head.post_id IS NULL
    OR policy_head.audio_revision <> input_audio_revision
  THEN
    RAISE EXCEPTION 'song reference is not policy-addressable';
  END IF;

  SELECT revision.* INTO policy_record
    FROM song_owner_policy_revisions AS revision
   WHERE revision.community_id = policy_head.community_id
     AND revision.post_id = policy_head.post_id
     AND revision.policy_revision = policy_head.current_policy_revision;
  IF policy_record.post_id IS NULL
    OR policy_record.policy_hash <> policy_head.current_policy_hash
  THEN
    RAISE EXCEPTION 'song owner policy head is invalid';
  END IF;

  is_permitted := policy_record.derivative_video = 'allowed'
    OR (
      policy_record.derivative_video = 'owner_only'
      AND policy_head.owner_account_id = input_actor_account_id
    );
  reason := CASE
    WHEN is_permitted THEN NULL
    WHEN policy_record.derivative_video = 'blocked' THEN 'derivative_video_blocked'
    ELSE 'derivative_video_owner_only'
  END;

  INSERT INTO song_derivative_video_policy_observations (
    operation_id,
    observed_at_transition,
    creation_revision,
    community_id,
    post_id,
    audio_revision,
    actor_account_id,
    owner_policy_revision,
    owner_policy_hash,
    derivative_video,
    permitted,
    denial_reason
  ) VALUES (
    input_operation_id,
    input_transition,
    input_creation_revision,
    policy_head.community_id,
    policy_head.post_id,
    policy_head.audio_revision,
    input_actor_account_id,
    policy_record.policy_revision,
    policy_record.policy_hash,
    policy_record.derivative_video,
    is_permitted,
    reason
  )
  ON CONFLICT (operation_id, observed_at_transition, creation_revision) DO NOTHING;

  SELECT * INTO existing_observation
    FROM song_derivative_video_policy_observations
   WHERE operation_id = input_operation_id
     AND observed_at_transition = input_transition
     AND creation_revision = input_creation_revision;
  IF existing_observation.operation_id IS NULL
    OR existing_observation.community_id <> input_community_id
    OR existing_observation.post_id <> input_post_id
    OR existing_observation.audio_revision <> input_audio_revision
    OR existing_observation.actor_account_id <> input_actor_account_id
  THEN
    RAISE EXCEPTION 'song derivative video policy observation replay conflict';
  END IF;
  RETURN NEXT existing_observation;
END;
$$;

ALTER FUNCTION append_song_owner_policy_revision_v1(
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) SECURITY DEFINER;
ALTER FUNCTION observe_song_derivative_video_policy_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT
) SECURITY DEFINER;

DO $$
DECLARE
  installed_schema TEXT := current_schema();
  function_signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'song owner policy migration requires a current schema';
  END IF;
  FOREACH function_signature IN ARRAY ARRAY[
    'initialize_song_owner_policy_v1()',
    'append_song_owner_policy_revision_v1(text,text,text,bigint,text,text,text)',
    'observe_song_derivative_video_policy_v1(text,text,bigint,text,text,bigint,text)'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp',
      installed_schema,
      function_signature,
      installed_schema
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION append_song_owner_policy_revision_v1(
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION observe_song_derivative_video_policy_v1(
  TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT
) FROM PUBLIC;
