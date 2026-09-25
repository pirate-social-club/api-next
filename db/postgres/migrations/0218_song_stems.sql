-- Song stems amendment (Specs 013 and 019, 2026-09-24): a song may carry an
-- instrumental and an isolated vocals stem beside its primary audio. Stems
-- are reserved like the primary audio but carry a slot, are claimed under a
-- per-stem operation, and are sealed into their own append-only table. The
-- primary audio's reservation pairing, immutable-object lineage and
-- one-object-per-operation rule are unchanged.

ALTER TABLE media_upload_reservations
  ADD COLUMN slot TEXT NOT NULL DEFAULT 'primary_audio'
    CHECK (slot IN ('primary_audio', 'instrumental_audio', 'vocal_audio')),
  ADD CONSTRAINT media_upload_reservations_slot_kind CHECK (media_kind = 'song' OR slot = 'primary_audio');

CREATE FUNCTION reject_media_reservation_slot_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.slot IS DISTINCT FROM OLD.slot THEN
    RAISE EXCEPTION 'media reservation slot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_reservation_slot_immutable BEFORE UPDATE ON media_upload_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_media_reservation_slot_change();

CREATE OR REPLACE FUNCTION validate_media_reservation_claim_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; event_record media_submission_events%ROWTYPE; issued_event_record media_submission_events%ROWTYPE;
BEGIN
  -- Song stems (instrumental, vocals) are claimed under their own operation
  -- '<submission operation>-stem-<slot>', never as the submission's audio.
  IF NEW.slot <> 'primary_audio' THEN
    IF NEW.state IN ('claimed', 'sealed', 'rejected', 'expired') AND NEW.submission_id IS NOT NULL THEN
      SELECT * INTO submission_record FROM media_post_submissions
        WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
          AND submission_id=NEW.submission_id FOR SHARE;
      IF submission_record.submission_id IS NULL
         OR submission_record.media_kind IS DISTINCT FROM 'song'
         OR NEW.claim_fence <> 1
         OR NEW.operation_id IS DISTINCT FROM submission_record.operation_id || '-stem-' || NEW.slot THEN
        RAISE EXCEPTION 'media stem reservation claim is not paired with its submission';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IN ('claimed', 'sealed', 'rejected', 'expired') AND NEW.submission_id IS NOT NULL THEN
    SELECT * INTO submission_record FROM media_post_submissions
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND audio_reservation_id=NEW.reservation_id FOR SHARE;
    SELECT * INTO event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=1 FOR SHARE;
    SELECT * INTO issued_event_record FROM media_submission_events
      WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
        AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
        AND event_sequence=2 FOR SHARE;
    IF submission_record.submission_id IS NULL
       OR event_record.submission_id IS NULL
       OR NEW.claim_fence <> 1
       OR event_record.event_kind IS DISTINCT FROM 'submission_reserved'
       OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'submission_reserved'
       OR issued_event_record.submission_id IS NULL
       OR issued_event_record.event_kind IS DISTINCT FROM 'media_reservation_issued'
       OR issued_event_record.evidence->>'event_kind' IS DISTINCT FROM 'media_reservation_issued' THEN
      RAISE EXCEPTION 'media reservation claim is not paired with its exact submission';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE media_song_stems (
    submission_id text NOT NULL,
    slot text NOT NULL CHECK (slot IN ('instrumental_audio', 'vocal_audio')),
    community_id text NOT NULL,
    actor_user_id text NOT NULL,
    operation_id text NOT NULL,
    reservation_id text NOT NULL,
    immutable_ref text NOT NULL UNIQUE CHECK (btrim(immutable_ref) <> ''),
    destination_ref text NOT NULL UNIQUE CHECK (btrim(destination_ref) <> ''),
    etag text NOT NULL CHECK (btrim(etag) <> ''),
    object_version text NOT NULL CHECK (btrim(object_version) <> ''),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    content_type text NOT NULL CHECK (content_type = 'audio/mpeg'),
    canonical_sha256 text NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
    author_persona_id text NOT NULL,
    sealed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    PRIMARY KEY (submission_id, slot),
    UNIQUE (reservation_id),
    FOREIGN KEY (submission_id) REFERENCES media_post_submissions(submission_id),
    FOREIGN KEY (community_id, actor_user_id, reservation_id, submission_id, operation_id)
      REFERENCES media_upload_reservations(community_id, actor_user_id, reservation_id, submission_id, operation_id)
);

CREATE FUNCTION validate_media_song_stem_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE reservation_record media_upload_reservations%ROWTYPE;
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
      AND submission_id = NEW.submission_id FOR SHARE;
  SELECT * INTO reservation_record FROM media_upload_reservations
    WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
      AND reservation_id = NEW.reservation_id FOR UPDATE;
  IF submission_record.submission_id IS NULL
     OR submission_record.media_kind IS DISTINCT FROM 'song'
     OR submission_record.status IN ('published', 'blocked', 'abandoned')
     OR submission_record.author_persona_id IS DISTINCT FROM NEW.author_persona_id
     OR NEW.operation_id IS DISTINCT FROM submission_record.operation_id || '-stem-' || NEW.slot
     OR reservation_record.reservation_id IS NULL
     OR reservation_record.media_kind IS DISTINCT FROM 'song'
     OR reservation_record.slot IS DISTINCT FROM NEW.slot
     OR reservation_record.submission_id IS DISTINCT FROM NEW.submission_id
     OR reservation_record.operation_id IS DISTINCT FROM NEW.operation_id
     OR reservation_record.state <> 'claimed'
     OR reservation_record.expires_at <= clock_timestamp()
     OR reservation_record.expected_content_type <> NEW.content_type
     OR reservation_record.expected_size_bytes <> NEW.size_bytes
     OR (reservation_record.expected_sha256 IS NOT NULL AND reservation_record.expected_sha256 <> NEW.canonical_sha256)
  THEN
    RAISE EXCEPTION 'sealed song stem facts do not match its reservation and submission';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_song_stem_insert_guard BEFORE INSERT ON media_song_stems
  FOR EACH ROW EXECUTE FUNCTION validate_media_song_stem_insert();

CREATE TRIGGER media_song_stems_append_only BEFORE DELETE OR UPDATE ON media_song_stems
  FOR EACH ROW EXECUTE FUNCTION reject_media_append_only_change();
