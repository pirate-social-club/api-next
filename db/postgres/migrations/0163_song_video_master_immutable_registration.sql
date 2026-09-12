-- Spec 013 section 5A. An accepted song-video master is an immutable object,
-- not a loose file handle. Registering it in the immutable-object keyspace lets
-- the existing source-grant and source-gateway path hand it to Stream and to
-- DATA by the exact version and etag sealing verified, without a second
-- addressing scheme or a mutable read.

-- Sealing already reads the object store's version; it now also keeps the etag
-- so the registered immutable identity can be re-presented exactly. The column
-- is nullable so the migration is safe on a deployment where a master row
-- exists, but no new master is ever sealed without it.
ALTER TABLE media_song_video_masters
  ADD COLUMN verified_object_etag TEXT CHECK (
    verified_object_etag IS NULL OR btrim(verified_object_etag) <> ''
  );

-- A master is not reservation-backed. Originals keep their reservation binding;
-- the insert guard below is what distinguishes the two.
ALTER TABLE media_immutable_objects
  ALTER COLUMN reservation_id DROP NOT NULL;

-- One original object per operation remains the rule. A song video's accepted
-- master is a second, derived object for the same submission and operation, so
-- the original uniqueness is retained only where a reservation is bound.
ALTER TABLE media_immutable_objects
  DROP CONSTRAINT media_immutable_objects_community_id_actor_user_id_operatio_key;
CREATE UNIQUE INDEX media_immutable_objects_reservation_operation_key
  ON media_immutable_objects (community_id, actor_user_id, operation_id)
  WHERE reservation_id IS NOT NULL;

-- An immutable object without a reservation is a sealed accepted master or
-- nothing. Every fact the row records must agree with the master the plan's
-- compare-and-set accepted, including the etag the object store reported when
-- the bytes were verified, so a grant can only ever name bytes sealing saw.
CREATE OR REPLACE FUNCTION validate_media_immutable_object_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE reservation_record media_upload_reservations%ROWTYPE;
DECLARE master_record media_song_video_masters%ROWTYPE;
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  IF NEW.reservation_id IS NULL THEN
    SELECT * INTO master_record
      FROM media_song_video_masters m
      JOIN media_song_video_accepted_masters a
        ON a.master_revision_id = m.master_revision_id AND a.plan_id = m.plan_id
     WHERE m.verified_object_key = NEW.immutable_ref
       AND m.plan_submission_id = NEW.submission_id
     FOR UPDATE OF m;
    SELECT * INTO submission_record FROM media_post_submissions
     WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id
       AND submission_id = NEW.submission_id AND operation_id = NEW.operation_id
     FOR SHARE;
    IF master_record.master_revision_id IS NULL
       OR master_record.master_sha256 <> NEW.canonical_sha256
       OR master_record.master_byte_length <> NEW.size_bytes
       OR master_record.verified_object_etag IS NULL
       OR master_record.verified_object_etag <> NEW.etag
       OR master_record.verified_object_version <> NEW.object_version
       OR NEW.content_type <> 'video/mp4'
       OR submission_record.submission_id IS NULL
       OR submission_record.author_persona_id <> NEW.author_persona_id
    THEN
      RAISE EXCEPTION 'sealed master facts do not match the accepted master';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.reservation_id FOR UPDATE;
  IF reservation_record.reservation_id IS NULL OR reservation_record.submission_id <> NEW.submission_id OR reservation_record.operation_id <> NEW.operation_id OR reservation_record.state <> 'claimed' OR reservation_record.expires_at <= clock_timestamp() OR reservation_record.expected_content_type <> NEW.content_type OR reservation_record.expected_size_bytes <> NEW.size_bytes OR (reservation_record.expected_sha256 IS NOT NULL AND reservation_record.expected_sha256 <> NEW.canonical_sha256) THEN RAISE EXCEPTION 'sealed media facts do not match reservation expectations'; END IF;
  RETURN NEW;
END;
$$;
