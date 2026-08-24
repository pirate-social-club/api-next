-- Specs 013 and 014: separate the private authenticated account from public
-- personas. This migration is forward-only and treats every pre-0046 user
-- author column as private account identity while adding explicit persona
-- lineage. Existing rows are assigned one idempotently-created first persona.

CREATE TABLE personas (
  persona_id TEXT PRIMARY KEY CHECK (
    btrim(persona_id) <> '' AND persona_id = btrim(persona_id)
    AND octet_length(persona_id) <= 128
  ),
  account_id TEXT NOT NULL REFERENCES users (user_id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'retired')),
  is_first_persona BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT personas_account_identity_unique UNIQUE (account_id, persona_id),
  CONSTRAINT personas_retirement_shape CHECK (
    (status = 'retired' AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  )
);
CREATE UNIQUE INDEX personas_one_first_per_account_uidx
  ON personas (account_id) WHERE is_first_persona;
CREATE INDEX personas_account_status_idx
  ON personas (account_id, status, created_at, persona_id);

CREATE TABLE persona_profiles (
  persona_id TEXT PRIMARY KEY REFERENCES personas (persona_id),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) <= 80),
  avatar_ref TEXT CHECK (avatar_ref IS NULL OR char_length(avatar_ref) <= 2048),
  cover_ref TEXT CHECK (cover_ref IS NULL OR char_length(cover_ref) <= 2048),
  bio TEXT CHECK (bio IS NULL OR char_length(bio) <= 2000),
  preferred_locale TEXT CHECK (
    preferred_locale IS NULL OR char_length(preferred_locale) <= 64
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT persona_profiles_time_order CHECK (updated_at >= created_at)
);

CREATE TABLE persona_create_actions (
  account_id TEXT NOT NULL REFERENCES users (user_id),
  endpoint_template TEXT NOT NULL DEFAULT '/personas'
    CHECK (endpoint_template = '/personas'),
  idempotency_key TEXT NOT NULL CHECK (
    btrim(idempotency_key) <> '' AND idempotency_key = btrim(idempotency_key)
    AND octet_length(idempotency_key) <= 128
  ),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  persona_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, endpoint_template, idempotency_key),
  FOREIGN KEY (account_id, persona_id)
    REFERENCES personas (account_id, persona_id),
  UNIQUE (account_id, persona_id)
);

CREATE TABLE persona_wallet_assignments (
  assignment_id TEXT PRIMARY KEY CHECK (
    btrim(assignment_id) <> '' AND assignment_id = btrim(assignment_id)
    AND octet_length(assignment_id) <= 128
  ),
  persona_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chain_account_kind TEXT NOT NULL CHECK (chain_account_kind = 'evm'),
  privy_wallet_id TEXT CHECK (
    privy_wallet_id IS NULL OR (
      btrim(privy_wallet_id) <> '' AND privy_wallet_id = btrim(privy_wallet_id)
      AND octet_length(privy_wallet_id) <= 256
    )
  ),
  hd_wallet_index BIGINT NOT NULL CHECK (
    hd_wallet_index >= 0 AND hd_wallet_index <= 9007199254740991
  ),
  address TEXT CHECK (address IS NULL OR address ~ '^0x[0-9a-f]{40}$'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'tombstoned')),
  reservation_idempotency_key TEXT NOT NULL CHECK (
    btrim(reservation_idempotency_key) <> ''
    AND reservation_idempotency_key = btrim(reservation_idempotency_key)
    AND octet_length(reservation_idempotency_key) <= 128
  ),
  assigned_at TIMESTAMPTZ,
  tombstoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, persona_id)
    REFERENCES personas (account_id, persona_id),
  CONSTRAINT persona_wallet_assignments_state_shape CHECK (
    (status = 'pending' AND address IS NULL AND assigned_at IS NULL AND tombstoned_at IS NULL)
    OR (status = 'active' AND address IS NOT NULL AND assigned_at IS NOT NULL AND tombstoned_at IS NULL)
    OR (status = 'tombstoned' AND tombstoned_at IS NOT NULL)
  ),
  CONSTRAINT persona_wallet_assignments_time_order CHECK (
    updated_at >= created_at
    AND (assigned_at IS NULL OR assigned_at >= created_at)
    AND (tombstoned_at IS NULL OR tombstoned_at >= created_at)
  ),
  CONSTRAINT persona_wallet_assignments_index_ledger_unique
    UNIQUE (account_id, chain_account_kind, hd_wallet_index),
  CONSTRAINT persona_wallet_assignments_reservation_replay_unique
    UNIQUE (account_id, persona_id, chain_account_kind, reservation_idempotency_key)
);
CREATE UNIQUE INDEX persona_wallet_assignments_one_live_kind_uidx
  ON persona_wallet_assignments (persona_id, chain_account_kind)
  WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX persona_wallet_assignments_address_uidx
  ON persona_wallet_assignments (address) WHERE address IS NOT NULL;

CREATE TABLE persona_role_presentations (
  community_id TEXT NOT NULL REFERENCES communities (community_id),
  account_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (community_id, account_id),
  FOREIGN KEY (community_id, account_id)
    REFERENCES community_memberships (community_id, user_id),
  FOREIGN KEY (account_id, persona_id)
    REFERENCES personas (account_id, persona_id),
  CONSTRAINT persona_role_presentations_time_order CHECK (updated_at >= created_at)
);

CREATE FUNCTION prevent_persona_identity_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.persona_id IS DISTINCT FROM OLD.persona_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.is_first_persona IS DISTINCT FROM OLD.is_first_persona THEN
    RAISE EXCEPTION 'persona identity is immutable';
  END IF;
  IF OLD.status = 'retired' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'retired persona is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER personas_identity_immutable
BEFORE UPDATE ON personas
FOR EACH ROW EXECUTE FUNCTION prevent_persona_identity_rewrite();

-- The first-persona insert is idempotent by account and intentionally uses a
-- random public id: no public identifier is derived from the private account.
INSERT INTO personas (
  persona_id, account_id, status, is_first_persona, created_at, retired_at
)
SELECT 'persona_' || replace(gen_random_uuid()::text, '-', ''),
       account.user_id,
       CASE WHEN account.status = 'active' THEN 'active' ELSE 'retired' END,
       true,
       account.created_at,
       CASE WHEN account.status = 'active' THEN NULL ELSE clock_timestamp() END
  FROM users AS account
 WHERE NOT EXISTS (
   SELECT 1 FROM personas AS existing
    WHERE existing.account_id = account.user_id
      AND existing.is_first_persona
 );

INSERT INTO persona_profiles (
  persona_id, revision, display_name, avatar_ref, cover_ref, bio,
  preferred_locale, created_at, updated_at
)
SELECT persona.persona_id,
       1,
       account.account #>> '{profile,display_name}',
       account.account #>> '{profile,avatar_ref}',
       account.account #>> '{profile,cover_ref}',
       account.account #>> '{profile,bio}',
       account.account #>> '{profile,preferred_locale}',
       account.created_at,
       account.created_at
  FROM personas AS persona
  JOIN users AS account ON account.user_id = persona.account_id
 WHERE persona.is_first_persona
ON CONFLICT (persona_id) DO NOTHING;

ALTER TABLE public_handle_index ADD COLUMN owner_persona_id TEXT;
UPDATE public_handle_index AS handle
   SET owner_persona_id = persona.persona_id
  FROM personas AS persona
 WHERE persona.account_id = handle.owner_user_id
   AND persona.is_first_persona;
ALTER TABLE public_handle_index ALTER COLUMN owner_persona_id SET NOT NULL;
ALTER TABLE public_handle_index
  ADD CONSTRAINT public_handle_index_owner_persona_fk
  FOREIGN KEY (owner_user_id, owner_persona_id)
  REFERENCES personas (account_id, persona_id);
DROP INDEX public_handle_index_one_active_owner_uidx;
CREATE INDEX public_handle_index_persona_status_idx
  ON public_handle_index (owner_persona_id, status, updated_at DESC);

CREATE FUNCTION default_public_handle_persona() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_persona_id IS NULL THEN
    SELECT persona.persona_id
      INTO NEW.owner_persona_id
      FROM personas AS persona
     WHERE persona.account_id = NEW.owner_user_id
       AND persona.is_first_persona;
  END IF;
  IF NEW.owner_persona_id IS NULL THEN
    RAISE EXCEPTION 'public handle requires an owned persona';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER public_handle_index_default_persona
BEFORE INSERT OR UPDATE OF owner_user_id, owner_persona_id
ON public_handle_index
FOR EACH ROW EXECUTE FUNCTION default_public_handle_persona();

CREATE OR REPLACE FUNCTION public_handle_index_validate_redirects()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'redirect' AND NOT EXISTS (
    SELECT 1
      FROM public_handle_index AS target
     WHERE target.handle_id = NEW.redirect_target_handle_id
       AND target.status = 'active'
       AND target.owner_persona_id = NEW.owner_persona_id
       AND target.handle_id <> NEW.handle_id
  ) THEN
    RAISE EXCEPTION 'public handle redirect target is not an active handle owned by the same persona'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
     WHERE source.status = 'redirect'
       AND source.redirect_target_handle_id = NEW.handle_id
       AND NOT EXISTS (
         SELECT 1
           FROM public_handle_index AS target
          WHERE target.handle_id = source.redirect_target_handle_id
            AND target.status = 'active'
            AND target.owner_persona_id = source.owner_persona_id
            AND target.handle_id <> source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'public handle redirect source points at an invalid target'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER public_handle_index_redirect_integrity ON public_handle_index;
CREATE CONSTRAINT TRIGGER public_handle_index_redirect_integrity
AFTER INSERT OR UPDATE OF status, owner_user_id, owner_persona_id, redirect_target_handle_id
ON public_handle_index
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public_handle_index_validate_redirects();

-- The present identity document has no provider HD-index field. Its primary
-- embedded EVM wallet is the default index-zero assignment; provider wallet id
-- stays nullable and address+account+index remain authoritative.
INSERT INTO persona_wallet_assignments (
  assignment_id, persona_id, account_id, chain_account_kind,
  privy_wallet_id, hd_wallet_index, address, status,
  reservation_idempotency_key, assigned_at, tombstoned_at, created_at, updated_at
)
SELECT 'persona_wallet_' || replace(gen_random_uuid()::text, '-', ''),
       persona.persona_id,
       persona.account_id,
       'evm',
       NULL,
       0,
       lower(wallet.value ->> 'wallet_address_display'),
       CASE WHEN persona.status = 'active' THEN 'active' ELSE 'tombstoned' END,
       'first-persona-wallet-backfill',
       persona.created_at,
       CASE WHEN persona.status = 'retired' THEN clock_timestamp() ELSE NULL END,
       persona.created_at,
       persona.created_at
  FROM personas AS persona
  JOIN users AS account ON account.user_id = persona.account_id
  CROSS JOIN LATERAL (
    SELECT attachment AS value
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(account.account -> 'wallet_attachments') = 'array'
            THEN account.account -> 'wallet_attachments'
          ELSE '[]'::jsonb
        END
      ) AS attachment
     WHERE attachment ->> 'is_primary' = '1'
       AND lower(attachment ->> 'wallet_address_display') ~ '^0x[0-9a-f]{40}$'
     ORDER BY attachment ->> 'wallet_attachment_id'
     LIMIT 1
  ) AS wallet
 WHERE persona.is_first_persona
ON CONFLICT DO NOTHING;

CREATE FUNCTION provision_first_persona_for_new_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  first_persona_id TEXT := 'persona_' || replace(gen_random_uuid()::text, '-', '');
  primary_wallet JSONB;
BEGIN
  INSERT INTO personas (
    persona_id, account_id, status, is_first_persona, created_at, retired_at
  ) VALUES (
    first_persona_id,
    NEW.user_id,
    CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'retired' END,
    true,
    NEW.created_at,
    CASE WHEN NEW.status = 'active' THEN NULL ELSE clock_timestamp() END
  );

  INSERT INTO persona_profiles (
    persona_id, revision, display_name, avatar_ref, cover_ref, bio,
    preferred_locale, created_at, updated_at
  ) VALUES (
    first_persona_id,
    1,
    NEW.account #>> '{profile,display_name}',
    NEW.account #>> '{profile,avatar_ref}',
    NEW.account #>> '{profile,cover_ref}',
    NEW.account #>> '{profile,bio}',
    NEW.account #>> '{profile,preferred_locale}',
    NEW.created_at,
    NEW.created_at
  );

  SELECT attachment
    INTO primary_wallet
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(NEW.account -> 'wallet_attachments') = 'array'
          THEN NEW.account -> 'wallet_attachments'
        ELSE '[]'::jsonb
      END
    ) AS attachment
   WHERE attachment ->> 'is_primary' = '1'
     AND lower(attachment ->> 'wallet_address_display') ~ '^0x[0-9a-f]{40}$'
   ORDER BY attachment ->> 'wallet_attachment_id'
   LIMIT 1;

  IF primary_wallet IS NOT NULL THEN
    INSERT INTO persona_wallet_assignments (
      assignment_id, persona_id, account_id, chain_account_kind,
      privy_wallet_id, hd_wallet_index, address, status,
      reservation_idempotency_key, assigned_at, tombstoned_at,
      created_at, updated_at
    ) VALUES (
      'persona_wallet_' || replace(gen_random_uuid()::text, '-', ''),
      first_persona_id,
      NEW.user_id,
      'evm',
      NULL,
      0,
      lower(primary_wallet ->> 'wallet_address_display'),
      CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'tombstoned' END,
      'first-persona-wallet-onboarding',
      NEW.created_at,
      CASE WHEN NEW.status = 'active' THEN NULL ELSE clock_timestamp() END,
      NEW.created_at,
      NEW.created_at
    );
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_provision_first_persona
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION provision_first_persona_for_new_account();

CREATE FUNCTION active_owned_persona(
  expected_account_id TEXT,
  expected_persona_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM personas
     WHERE account_id = expected_account_id
       AND persona_id = expected_persona_id
       AND status = 'active'
  )
$$;

CREATE FUNCTION public_persona_projection(expected_persona_id TEXT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'persona_id', persona.persona_id,
    'object', 'persona',
    'display_name', profile.display_name,
    'avatar_ref', profile.avatar_ref,
    'primary_public_handle', handle.label_display
  )
    FROM personas AS persona
    JOIN persona_profiles AS profile ON profile.persona_id = persona.persona_id
    LEFT JOIN LATERAL (
      SELECT candidate.label_display
        FROM public_handle_index AS candidate
       WHERE candidate.owner_persona_id = persona.persona_id
         AND candidate.status = 'active'
       ORDER BY candidate.updated_at DESC, candidate.handle_id
       LIMIT 1
    ) AS handle ON true
   WHERE persona.persona_id = expected_persona_id
$$;

-- Existing author columns are retained for compatibility but are explicitly
-- projected as private account identity in durable storage.
ALTER TABLE media_upload_reservations
  ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED,
  ADD COLUMN actor_persona_id TEXT;
ALTER TABLE media_upload_reservations DISABLE TRIGGER USER;
UPDATE media_upload_reservations AS reservation
   SET actor_persona_id = persona.persona_id
  FROM personas AS persona
 WHERE persona.account_id = reservation.actor_user_id
   AND persona.is_first_persona;
ALTER TABLE media_upload_reservations
  ALTER COLUMN actor_account_id SET NOT NULL,
  ALTER COLUMN actor_persona_id SET NOT NULL,
  ADD CONSTRAINT media_upload_reservations_actor_persona_fk
    FOREIGN KEY (actor_account_id, actor_persona_id)
    REFERENCES personas (account_id, persona_id),
  ADD CONSTRAINT media_upload_reservations_persona_identity_unique
    UNIQUE (community_id, actor_user_id, actor_persona_id, reservation_id);
ALTER TABLE media_upload_reservations ENABLE TRIGGER USER;

ALTER TABLE media_post_submissions
  ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED,
  ADD COLUMN author_persona_id TEXT;
ALTER TABLE media_post_submissions DISABLE TRIGGER USER;
UPDATE media_post_submissions AS submission
   SET author_persona_id = reservation.actor_persona_id
  FROM media_upload_reservations AS reservation
 WHERE reservation.community_id = submission.community_id
   AND reservation.actor_user_id = submission.actor_user_id
   AND reservation.reservation_id = submission.audio_reservation_id;
ALTER TABLE media_post_submissions
  ALTER COLUMN actor_account_id SET NOT NULL,
  ALTER COLUMN author_persona_id SET NOT NULL,
  ADD CONSTRAINT media_post_submissions_author_persona_fk
    FOREIGN KEY (actor_account_id, author_persona_id)
    REFERENCES personas (account_id, persona_id),
  ADD CONSTRAINT media_post_submissions_persona_reservation_fk
    FOREIGN KEY (community_id, actor_user_id, author_persona_id, audio_reservation_id)
    REFERENCES media_upload_reservations (
      community_id, actor_user_id, actor_persona_id, reservation_id
    ),
  ADD CONSTRAINT media_post_submissions_persona_lineage_unique
    UNIQUE (community_id, actor_user_id, author_persona_id, submission_id, operation_id);
ALTER TABLE media_post_submissions ENABLE TRIGGER USER;

DO $$
DECLARE
  related_table TEXT;
BEGIN
  FOREACH related_table IN ARRAY ARRAY[
    'media_submission_terms',
    'media_immutable_objects',
    'media_audio_revisions',
    'media_reference_evidence',
    'media_transcript_artifacts',
    'media_analysis_evidence',
    'media_publication_decisions',
    'media_submission_events',
    'media_processing_attempts',
    'media_moderation_projections',
    'media_moderation_actions',
    'media_publication_projections',
    'media_timed_lyrics_artifacts',
    'media_alignment_projections',
    'media_submission_outbox'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED, ADD COLUMN author_persona_id TEXT',
      related_table
    );
    -- These tables are append-only after 0043.  Adding the durable persona
    -- lineage is a one-time schema backfill, so bypass their historical
    -- update guards only for the rewrite and restore them before continuing.
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', related_table);
    EXECUTE format(
      'UPDATE %1$I AS related SET author_persona_id = submission.author_persona_id FROM media_post_submissions AS submission WHERE submission.community_id = related.community_id AND submission.actor_user_id = related.actor_user_id AND submission.submission_id = related.submission_id AND submission.operation_id = related.operation_id',
      related_table
    );
    EXECUTE format(
      'ALTER TABLE %1$I ALTER COLUMN actor_account_id SET NOT NULL, ALTER COLUMN author_persona_id SET NOT NULL, ADD CONSTRAINT %2$I FOREIGN KEY (actor_account_id, author_persona_id) REFERENCES personas (account_id, persona_id), ADD CONSTRAINT %3$I FOREIGN KEY (community_id, actor_user_id, author_persona_id, submission_id, operation_id) REFERENCES media_post_submissions (community_id, actor_user_id, author_persona_id, submission_id, operation_id)',
      related_table,
      related_table || '_author_persona_fk',
      related_table || '_persona_submission_fk'
    );
    EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', related_table);
  END LOOP;
END
$$;

ALTER TABLE media_submission_command_replays
  ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED,
  ADD COLUMN actor_persona_id TEXT,
  ADD COLUMN submission_author_persona_id TEXT;
ALTER TABLE media_submission_command_replays DISABLE TRIGGER USER;
UPDATE media_submission_command_replays AS replay
   SET actor_persona_id = CASE
         WHEN replay.actor_user_id = submission.actor_user_id
           THEN submission.author_persona_id
         ELSE NULL
       END,
       submission_author_persona_id = submission.author_persona_id
  FROM media_post_submissions AS submission
 WHERE submission.community_id = replay.community_id
   AND submission.actor_user_id = replay.submission_actor_user_id
   AND submission.submission_id = replay.submission_id
   AND submission.operation_id = replay.operation_id;
ALTER TABLE media_submission_command_replays
  ALTER COLUMN actor_account_id SET NOT NULL,
  ALTER COLUMN submission_author_persona_id SET NOT NULL,
  ADD CONSTRAINT media_submission_command_replays_actor_persona_fk
    FOREIGN KEY (actor_account_id, actor_persona_id)
    REFERENCES personas (account_id, persona_id),
  ADD CONSTRAINT media_submission_command_replays_persona_submission_fk
    FOREIGN KEY (
      community_id, submission_actor_user_id, submission_author_persona_id,
      submission_id, operation_id
    ) REFERENCES media_post_submissions (
      community_id, actor_user_id, author_persona_id, submission_id, operation_id
    ),
  ADD CONSTRAINT media_submission_command_replays_persona_match CHECK (
    actor_persona_id IS NULL
    OR actor_persona_id = submission_author_persona_id
  );
ALTER TABLE media_submission_command_replays ENABLE TRIGGER USER;

-- Re-key author-side replay by the exact private account, public persona,
-- endpoint template, and key tuple. Account-authorized commands such as
-- moderation retain a separate account-scoped replay key.
ALTER TABLE media_upload_reservations
  DROP CONSTRAINT media_upload_reservations_replay_unique,
  ADD CONSTRAINT media_upload_reservations_persona_replay_unique
  UNIQUE (
    actor_account_id, actor_persona_id, endpoint_template, idempotency_key
  );
ALTER TABLE media_post_submissions
  DROP CONSTRAINT media_post_submissions_replay_unique,
  ADD CONSTRAINT media_post_submissions_persona_replay_unique
  UNIQUE (
    actor_account_id, author_persona_id, endpoint_template, idempotency_key
  );
ALTER TABLE media_submission_command_replays
  DROP CONSTRAINT media_submission_command_replays_pkey;
CREATE UNIQUE INDEX media_submission_command_replays_persona_replay_uidx
  ON media_submission_command_replays (
    actor_account_id, actor_persona_id, endpoint_template, idempotency_key
  ) WHERE actor_persona_id IS NOT NULL;
CREATE UNIQUE INDEX media_submission_command_replays_account_replay_uidx
  ON media_submission_command_replays (
    actor_account_id, endpoint_template, idempotency_key
  ) WHERE actor_persona_id IS NULL;

-- Rewrite replay snapshots into the current public-persona wire contract. A
-- malformed historical snapshot fails the migration instead of being guessed.
-- The old guards are disabled only for this additive lineage rewrite; the
-- immutable identity and response digest are restored in the same statement.
ALTER TABLE media_post_submissions DISABLE TRIGGER USER;
UPDATE media_post_submissions AS submission
   SET start_input = submission.start_input
                     || jsonb_build_object('persona_id', submission.author_persona_id),
       response_snapshot_bytes = convert_to(
         (
           convert_from(submission.response_snapshot_bytes, 'UTF8')::jsonb
           || jsonb_build_object(
             'author_persona', public_persona_projection(submission.author_persona_id)
           )
         )::text,
         'UTF8'
       ),
       response_snapshot_sha256 = encode(
         sha256(convert_to(
           (
             convert_from(submission.response_snapshot_bytes, 'UTF8')::jsonb
             || jsonb_build_object(
               'author_persona', public_persona_projection(submission.author_persona_id)
             )
           )::text,
           'UTF8'
         )),
         'hex'
       );
ALTER TABLE media_post_submissions ENABLE TRIGGER USER;

ALTER TABLE media_submission_command_replays DISABLE TRIGGER USER;
UPDATE media_submission_command_replays AS replay
   SET response_snapshot_bytes = convert_to(
         (
           convert_from(replay.response_snapshot_bytes, 'UTF8')::jsonb
           || jsonb_build_object(
             'author_persona', public_persona_projection(replay.submission_author_persona_id)
           )
         )::text,
         'UTF8'
       ),
       response_snapshot_sha256 = encode(
         sha256(convert_to(
           (
             convert_from(replay.response_snapshot_bytes, 'UTF8')::jsonb
             || jsonb_build_object(
               'author_persona', public_persona_projection(replay.submission_author_persona_id)
             )
           )::text,
           'UTF8'
         )),
         'hex'
       );
ALTER TABLE media_submission_command_replays ENABLE TRIGGER USER;

-- Durable child snapshots carry the same author persona as their parent
-- submission. The closed outbox payload remains identifier-only; its
-- author_persona_id column carries the private lineage separately.
ALTER TABLE media_submission_terms DISABLE TRIGGER USER;
UPDATE media_submission_terms
   SET terms_snapshot = terms_snapshot
                        || jsonb_build_object('persona_id', author_persona_id);
ALTER TABLE media_submission_terms ENABLE TRIGGER USER;
ALTER TABLE media_submission_events DISABLE TRIGGER USER;
UPDATE media_submission_events
   SET evidence = evidence
                  || jsonb_build_object('author_persona_id', author_persona_id);
ALTER TABLE media_submission_events ENABLE TRIGGER USER;

ALTER TABLE posts
  ADD COLUMN author_persona_id TEXT;
ALTER TABLE posts DISABLE TRIGGER USER;
UPDATE posts AS post
   SET author_persona_id = persona.persona_id
  FROM personas AS persona
 WHERE persona.account_id = post.author_user_id
   AND persona.is_first_persona;
ALTER TABLE posts
  ADD CONSTRAINT posts_author_persona_shape CHECK (
    (author_user_id IS NULL AND author_persona_id IS NULL)
    OR (author_user_id IS NOT NULL AND author_persona_id IS NOT NULL)
  ),
  ADD CONSTRAINT posts_author_persona_fk
    FOREIGN KEY (author_user_id, author_persona_id)
    REFERENCES personas (account_id, persona_id);
CREATE INDEX posts_persona_created_idx
  ON posts (community_id, author_persona_id, created_at DESC, post_id);
DROP INDEX posts_author_idempotency_unique;
CREATE UNIQUE INDEX posts_author_persona_idempotency_uidx
  ON posts (author_user_id, author_persona_id, idempotency_key)
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';
ALTER TABLE posts ENABLE TRIGGER USER;

ALTER TABLE comments ADD COLUMN author_persona_id TEXT;
ALTER TABLE comments DISABLE TRIGGER USER;
UPDATE comments AS comment
   SET author_persona_id = persona.persona_id
  FROM personas AS persona
 WHERE persona.account_id = comment.author_user_id
   AND persona.is_first_persona;
ALTER TABLE comments
  ADD CONSTRAINT comments_author_persona_shape CHECK (
    (author_user_id IS NULL AND author_persona_id IS NULL)
    OR (author_user_id IS NOT NULL AND author_persona_id IS NOT NULL)
  ),
  ADD CONSTRAINT comments_author_persona_fk
    FOREIGN KEY (author_user_id, author_persona_id)
    REFERENCES personas (account_id, persona_id);
CREATE INDEX comments_persona_created_idx
  ON comments (community_id, author_persona_id, created_at DESC, comment_id);
DROP INDEX comments_author_endpoint_idempotency_unique;
CREATE UNIQUE INDEX comments_author_persona_endpoint_idempotency_uidx
  ON comments (
    author_user_id,
    author_persona_id,
    (CASE WHEN parent_comment_id IS NULL THEN 'comment' ELSE 'reply' END),
    idempotency_key
  )
  WHERE author_user_id IS NOT NULL AND idempotency_key <> '';
ALTER TABLE comments ENABLE TRIGGER USER;

ALTER TABLE comment_publication_projection
  ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (author_user_id) STORED,
  ADD COLUMN author_persona_id TEXT;
ALTER TABLE comment_publication_projection DISABLE TRIGGER USER;
UPDATE comment_publication_projection AS projection
   SET author_persona_id = comment.author_persona_id
  FROM comments AS comment
 WHERE comment.community_id = projection.community_id
   AND comment.comment_id = projection.comment_id;
ALTER TABLE comment_publication_projection
  ALTER COLUMN actor_account_id SET NOT NULL,
  ALTER COLUMN author_persona_id SET NOT NULL,
  ADD CONSTRAINT comment_publication_projection_author_persona_fk
    FOREIGN KEY (actor_account_id, author_persona_id)
    REFERENCES personas (account_id, persona_id);
ALTER TABLE comment_publication_projection ENABLE TRIGGER USER;

ALTER TABLE text_content_submissions
  ADD COLUMN actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED,
  ADD COLUMN author_persona_id TEXT;
ALTER TABLE text_content_submissions DISABLE TRIGGER USER;
UPDATE text_content_submissions AS submission
   SET author_persona_id = persona.persona_id
  FROM personas AS persona
 WHERE persona.account_id = submission.actor_user_id
   AND persona.is_first_persona;
ALTER TABLE text_content_submissions
  ALTER COLUMN actor_account_id SET NOT NULL,
  ALTER COLUMN author_persona_id SET NOT NULL,
  ADD CONSTRAINT text_content_submissions_author_persona_fk
    FOREIGN KEY (actor_account_id, author_persona_id)
    REFERENCES personas (account_id, persona_id);
DROP INDEX text_content_submissions_text_post_actor_key_unique;
DROP INDEX text_content_submissions_comment_reply_actor_key_unique;
CREATE UNIQUE INDEX text_content_submissions_persona_replay_uidx
  ON text_content_submissions (
    actor_account_id, author_persona_id, surface, idempotency_key
  );
ALTER TABLE text_content_submissions ENABLE TRIGGER USER;

CREATE FUNCTION require_active_author_persona() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected_account_id TEXT;
  expected_persona_id TEXT;
BEGIN
  IF TG_TABLE_NAME IN ('posts', 'comments') THEN
    expected_account_id := NEW.author_user_id;
    expected_persona_id := NEW.author_persona_id;
  ELSIF TG_TABLE_NAME = 'media_upload_reservations' THEN
    expected_account_id := NEW.actor_user_id;
    expected_persona_id := NEW.actor_persona_id;
  ELSE
    expected_account_id := NEW.actor_user_id;
    expected_persona_id := NEW.author_persona_id;
  END IF;
  IF expected_account_id IS NOT NULL
     AND NOT active_owned_persona(expected_account_id, expected_persona_id) THEN
    RAISE EXCEPTION 'active owned persona required';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER media_upload_reservations_active_persona
BEFORE INSERT ON media_upload_reservations
FOR EACH ROW EXECUTE FUNCTION require_active_author_persona();
CREATE TRIGGER media_post_submissions_active_persona
BEFORE INSERT ON media_post_submissions
FOR EACH ROW EXECUTE FUNCTION require_active_author_persona();
CREATE TRIGGER text_content_submissions_active_persona
BEFORE INSERT ON text_content_submissions
FOR EACH ROW EXECUTE FUNCTION require_active_author_persona();
CREATE TRIGGER posts_active_persona
BEFORE INSERT ON posts
FOR EACH ROW EXECUTE FUNCTION require_active_author_persona();
CREATE TRIGGER comments_active_persona
BEFORE INSERT ON comments
FOR EACH ROW EXECUTE FUNCTION require_active_author_persona();

-- Keep pre-0046 repository call sites source-compatible while they adopt
-- persona-aware inputs. Missing lineage is resolved to the account's
-- deterministic first persona before the active-persona guards run. Explicit
-- persona values remain subject to the composite ownership foreign keys.
CREATE FUNCTION populate_media_persona_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'media_upload_reservations' THEN
    IF NEW.actor_persona_id IS NULL THEN
      SELECT persona_id INTO NEW.actor_persona_id
        FROM personas
       WHERE account_id = NEW.actor_user_id
         AND is_first_persona
       LIMIT 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'media_post_submissions' THEN
    IF NEW.author_persona_id IS NULL THEN
      SELECT reservation.actor_persona_id INTO NEW.author_persona_id
        FROM media_upload_reservations AS reservation
       WHERE reservation.community_id = NEW.community_id
         AND reservation.actor_user_id = NEW.actor_user_id
         AND reservation.reservation_id = NEW.audio_reservation_id;
      IF NEW.author_persona_id IS NULL THEN
        SELECT persona_id INTO NEW.author_persona_id
          FROM personas
         WHERE account_id = NEW.actor_user_id
           AND is_first_persona
         LIMIT 1;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'media_submission_command_replays' THEN
    IF NEW.actor_persona_id IS NULL
       AND NEW.actor_user_id = NEW.submission_actor_user_id THEN
      SELECT persona_id INTO NEW.actor_persona_id
        FROM personas
       WHERE account_id = NEW.actor_user_id
         AND is_first_persona
       LIMIT 1;
    END IF;
    IF NEW.submission_author_persona_id IS NULL THEN
      SELECT submission.author_persona_id INTO NEW.submission_author_persona_id
        FROM media_post_submissions AS submission
       WHERE submission.community_id = NEW.community_id
         AND submission.actor_user_id = NEW.submission_actor_user_id
         AND submission.submission_id = NEW.submission_id
         AND submission.operation_id = NEW.operation_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('posts', 'comments') THEN
    IF NEW.author_persona_id IS NULL AND NEW.author_user_id IS NOT NULL THEN
      SELECT persona_id INTO NEW.author_persona_id
        FROM personas
       WHERE account_id = NEW.author_user_id
         AND is_first_persona
       LIMIT 1;
    END IF;
  ELSE
    IF NEW.author_persona_id IS NULL AND NEW.actor_user_id IS NOT NULL THEN
      SELECT persona_id INTO NEW.author_persona_id
        FROM personas
       WHERE account_id = NEW.actor_user_id
         AND is_first_persona
       LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  lineage_table TEXT;
BEGIN
  FOREACH lineage_table IN ARRAY ARRAY[
    'media_upload_reservations',
    'media_post_submissions',
    'media_submission_command_replays',
    'media_submission_terms',
    'media_immutable_objects',
    'media_audio_revisions',
    'media_reference_evidence',
    'media_transcript_artifacts',
    'media_analysis_evidence',
    'media_publication_decisions',
    'media_submission_events',
    'media_processing_attempts',
    'media_moderation_projections',
    'media_moderation_actions',
    'media_publication_projections',
    'media_timed_lyrics_artifacts',
    'media_alignment_projections',
    'media_submission_outbox',
    'text_content_submissions',
    'posts',
    'comments'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER media_persona_lineage_fill BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION populate_media_persona_lineage()',
      lineage_table
    );
  END LOOP;
END
$$;
