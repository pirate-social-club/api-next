-- Spec 013 section 5A. A sealed object's recorded identity has to say how it is
-- validated downstream. An ordinary upload is identified by the store's upload
-- version; a rendered master is identified by its normalized content ETag,
-- because the Workers binding and the S3 endpoint expose different version
-- fields for it. The source gateway and every later consumer read this kind
-- rather than inferring it from a reference's shape.
ALTER TABLE media_immutable_objects
  ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'upload_version' CHECK (
    identity_kind IN ('upload_version', 'content_etag')
  );

ALTER TABLE media_video_source_grants
  ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'upload_version' CHECK (
    identity_kind IN ('upload_version', 'content_etag')
  );

-- The object guard now pins each branch to its identity semantics: a
-- reservation-backed upload is version-identified, an accepted master is
-- content-identified.
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
       OR NEW.identity_kind <> 'content_etag'
       OR submission_record.submission_id IS NULL
       OR submission_record.author_persona_id <> NEW.author_persona_id
    THEN
      RAISE EXCEPTION 'sealed master facts do not match the accepted master';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO reservation_record FROM media_upload_reservations WHERE community_id = NEW.community_id AND actor_user_id = NEW.actor_user_id AND reservation_id = NEW.reservation_id FOR UPDATE;
  IF reservation_record.reservation_id IS NULL OR reservation_record.submission_id <> NEW.submission_id OR reservation_record.operation_id <> NEW.operation_id OR reservation_record.state <> 'claimed' OR reservation_record.expires_at <= clock_timestamp() OR reservation_record.expected_content_type <> NEW.content_type OR reservation_record.expected_size_bytes <> NEW.size_bytes OR (reservation_record.expected_sha256 IS NOT NULL AND reservation_record.expected_sha256 <> NEW.canonical_sha256) OR NEW.identity_kind <> 'upload_version' THEN RAISE EXCEPTION 'sealed media facts do not match reservation expectations'; END IF;
  RETURN NEW;
END;
$$;
