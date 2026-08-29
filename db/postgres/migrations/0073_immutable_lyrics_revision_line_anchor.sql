-- Repair spec 017 lyric-line memberships so historical revisions are anchored
-- to immutable accepted lyrics, never to the mutable publication projection.

CREATE UNIQUE INDEX media_post_submissions_localization_identity_uidx
  ON media_post_submissions (community_id, actor_user_id, post_id, submission_id);

ALTER TABLE localization_lyrics_revision_lines
  ADD COLUMN submission_id TEXT;

UPDATE localization_lyrics_revision_lines AS line
   SET submission_id = publication.submission_id
  FROM media_publication_projections AS publication
 WHERE publication.community_id = line.community_id
   AND publication.actor_user_id = line.actor_user_id
   AND publication.post_id = line.post_id
   AND publication.lyrics_revision = line.lyrics_revision;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM localization_lyrics_revision_lines
     WHERE submission_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'historical lyric-line membership has no immutable accepted lyrics anchor';
  END IF;
END;
$$;

ALTER TABLE localization_lyrics_revision_lines
  ALTER COLUMN submission_id SET NOT NULL;

DO $$
DECLARE
  projection_fk TEXT;
BEGIN
  SELECT constraint_record.conname
    INTO projection_fk
    FROM pg_constraint AS constraint_record
   WHERE constraint_record.conrelid = 'localization_lyrics_revision_lines'::regclass
     AND constraint_record.confrelid = 'media_publication_projections'::regclass
     AND constraint_record.contype = 'f';

  IF projection_fk IS NULL THEN
    RAISE EXCEPTION 'mutable publication projection foreign key is missing';
  END IF;

  EXECUTE format(
    'ALTER TABLE localization_lyrics_revision_lines DROP CONSTRAINT %I',
    projection_fk
  );
END;
$$;

DROP INDEX media_publication_lyrics_revision_uidx;

ALTER TABLE localization_lyrics_revision_lines
  ADD CONSTRAINT localization_lyrics_revision_lines_submission_post_fk
    FOREIGN KEY (community_id, actor_user_id, post_id, submission_id)
    REFERENCES media_post_submissions (
      community_id, actor_user_id, post_id, submission_id
    ),
  ADD CONSTRAINT localization_lyrics_revision_lines_accepted_revision_fk
    FOREIGN KEY (submission_id, lyrics_revision)
    REFERENCES media_song_lyrics_revisions (submission_id, lyrics_revision);
