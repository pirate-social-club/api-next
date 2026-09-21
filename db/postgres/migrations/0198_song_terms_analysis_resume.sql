-- Resume completed analysis when terms arrive, preserving every other guard.
DO $migration$
DECLARE
  body text;
  previous text := 'NEW.phase = CASE WHEN OLD.audio_revision = 0 THEN ''awaiting_upload'' ELSE ''analysis'' END';
  following text := 'NEW.phase = CASE WHEN OLD.audio_revision = 0 THEN ''awaiting_upload'' WHEN OLD.current_analysis_revision IS NULL THEN ''analysis'' ELSE ''decision'' END';
BEGIN
  SELECT prosrc INTO body FROM pg_proc
    WHERE oid='guard_media_submission_update_rating_v2()'::regprocedure
      AND NOT prosecdef;
  IF body IS NULL OR
     (length(body)-length(replace(body,previous,''))) <> length(previous) THEN
    RAISE EXCEPTION 'song terms guard source is not recognized exactly once';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION guard_media_submission_update_rating_v2() RETURNS trigger LANGUAGE plpgsql AS %L',
    replace(body,previous,following)
  );
END;
$migration$;
