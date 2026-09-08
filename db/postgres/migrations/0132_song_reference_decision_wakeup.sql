-- Resume processing after verified reference binding through the existing outbox.
CREATE OR REPLACE FUNCTION validate_media_outbox_payload_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keys TEXT[]; expected TEXT[]; submission_record media_post_submissions%ROWTYPE;
BEGIN
  keys := ARRAY(SELECT jsonb_object_keys(NEW.payload) ORDER BY 1);
  expected := CASE NEW.event_type
    WHEN 'analysis_launch' THEN ARRAY['analysis_revision','audio_revision','kind','operation_id','submission_id','workflow_instance_id','workflow_revision']
    WHEN 'decision_wakeup' THEN ARRAY['creation_revision','kind','lyrics_revision','operation_id','submission_id','trigger','workflow_instance_id','workflow_revision']
    WHEN 'publication' THEN ARRAY['creation_revision','kind','lyrics_revision','operation_id','submission_id','workflow_instance_id','workflow_revision']
    WHEN 'workflow_replacement' THEN ARRAY['kind','operation_id','replacement_sequence','submission_id','workflow_instance_id','workflow_revision']
    ELSE ARRAY['kind','lyrics_revision','operation_id','post_id','submission_id','workflow_instance_id','workflow_revision']
  END;
  IF keys IS DISTINCT FROM expected OR NEW.payload->>'kind' IS DISTINCT FROM NEW.event_type THEN
    RAISE EXCEPTION 'media outbox payload is not a closed identifier union';
  END IF;
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id FOR SHARE;
  IF submission_record.submission_id IS NULL
     OR NEW.operation_id IS DISTINCT FROM submission_record.operation_id
     OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision
     OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision
     OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision
     OR NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision
     OR NEW.workflow_revision IS DISTINCT FROM submission_record.workflow_revision
     OR NEW.workflow_instance_id IS DISTINCT FROM 'media-' || NEW.operation_id || '-r' || NEW.workflow_revision::text
     OR NEW.payload->>'submission_id' IS DISTINCT FROM NEW.submission_id
     OR NEW.payload->>'operation_id' IS DISTINCT FROM NEW.operation_id
     OR NEW.payload->>'workflow_instance_id' IS DISTINCT FROM NEW.workflow_instance_id
     OR NEW.payload->'workflow_revision' IS DISTINCT FROM to_jsonb(NEW.workflow_revision) THEN
    RAISE EXCEPTION 'media outbox lineage does not match submission';
  END IF;
  IF NEW.event_type = 'analysis_launch' AND (
    NEW.payload->'audio_revision' IS DISTINCT FROM to_jsonb(NEW.audio_revision)
    OR NEW.payload->'analysis_revision' IS DISTINCT FROM to_jsonb(NEW.analysis_revision)
  ) THEN RAISE EXCEPTION 'analysis launch payload is not exact'; END IF;
  IF NEW.event_type = 'decision_wakeup' AND (
    NEW.payload->>'trigger' NOT IN ('terms','lyrics','reference')
    OR NEW.payload->'creation_revision' IS DISTINCT FROM to_jsonb(NEW.creation_revision)
    OR NEW.payload->'lyrics_revision' IS DISTINCT FROM jsonb_build_object('value', NEW.lyrics_revision)->'value'
  ) THEN RAISE EXCEPTION 'decision wakeup payload is not exact'; END IF;
  IF NEW.event_type = 'publication' AND (
    NEW.payload->'creation_revision' IS DISTINCT FROM to_jsonb(NEW.creation_revision)
    OR NEW.payload->'lyrics_revision' IS DISTINCT FROM jsonb_build_object('value', NEW.lyrics_revision)->'value'
  ) THEN RAISE EXCEPTION 'publication wakeup payload is not exact'; END IF;
  IF NEW.event_type = 'alignment' AND (
    NEW.payload->>'post_id' IS DISTINCT FROM submission_record.post_id
    OR NEW.payload->'lyrics_revision' IS DISTINCT FROM jsonb_build_object('value', NEW.lyrics_revision)->'value'
  ) THEN RAISE EXCEPTION 'published effect payload is not exact'; END IF;
  IF NEW.event_type = 'workflow_replacement' AND (
    NEW.payload->'replacement_sequence' IS DISTINCT FROM to_jsonb(submission_record.workflow_replacement_sequence)
  ) THEN RAISE EXCEPTION 'replacement payload is not exact'; END IF;
  RETURN NEW;
END;
$$;
