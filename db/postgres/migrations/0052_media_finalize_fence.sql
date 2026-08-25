-- Fence an observed upload before the first immutable-seal effect.
--
-- The original submission guard remains authoritative for every previously
-- ratified transition. Only awaiting_upload -> finalize is routed through the
-- exact guard below. Finalize also stops accepting mutable song terms, so an
-- author cancellation or terms update cannot race the seal.

CREATE FUNCTION guard_media_finalize_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected media_post_submissions%ROWTYPE;
  community_active BOOLEAN;
  membership_active BOOLEAN;
BEGIN
  IF OLD.status IS DISTINCT FROM 'processing'
     OR OLD.phase IS DISTINCT FROM 'awaiting_upload'
     OR OLD.audio_revision IS DISTINCT FROM 0
     OR OLD.current_immutable_ref IS NOT NULL
     OR NEW.status IS DISTINCT FROM 'processing'
     OR NEW.phase IS DISTINCT FROM 'finalize' THEN
    RAISE EXCEPTION 'media finalize fence transition is not allowed';
  END IF;

  expected := OLD;
  expected.phase := 'finalize';
  expected.event_sequence := OLD.event_sequence + 1;
  expected.updated_at := NEW.updated_at;
  IF (to_jsonb(NEW) - 'actor_account_id') IS DISTINCT FROM
       (to_jsonb(expected) - 'actor_account_id')
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'media finalize fence transition evidence is not exact';
  END IF;

  SELECT status = 'active'
    INTO community_active
    FROM communities
   WHERE community_id = NEW.community_id
   FOR SHARE;
  SELECT status = 'member'
    INTO membership_active
    FROM community_memberships
   WHERE community_id = NEW.community_id
     AND user_id = NEW.actor_user_id
   FOR SHARE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'media submission requires active community membership';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_finalize_fence_guard
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW
WHEN (
  OLD.status = 'processing'
  AND OLD.phase = 'awaiting_upload'
  AND NEW.status = 'processing'
  AND NEW.phase = 'finalize'
)
EXECUTE FUNCTION guard_media_finalize_fence();

CREATE FUNCTION reject_media_finalize_terms_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media terms are immutable while finalize is fenced';
END;
$$;

CREATE TRIGGER media_finalize_terms_mutation_guard
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW
WHEN (
  OLD.status = 'processing'
  AND OLD.phase = 'finalize'
  AND NEW.status = 'processing'
  AND NEW.creation_revision = OLD.creation_revision + 1
  AND NEW.current_terms_revision = NEW.creation_revision
)
EXECUTE FUNCTION reject_media_finalize_terms_mutation();

CREATE FUNCTION guard_media_finalize_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected media_post_submissions%ROWTYPE;
  audio_record media_audio_revisions%ROWTYPE;
  community_active BOOLEAN;
  membership_active BOOLEAN;
BEGIN
  IF OLD.status IS DISTINCT FROM 'processing'
     OR OLD.phase IS DISTINCT FROM 'finalize'
     OR OLD.audio_revision IS DISTINCT FROM 0
     OR OLD.current_immutable_ref IS NOT NULL
     OR NEW.status IS DISTINCT FROM 'processing'
     OR NEW.phase IS DISTINCT FROM 'analysis'
     OR NEW.audio_revision IS DISTINCT FROM 1
     OR NEW.current_immutable_ref IS NULL THEN
    RAISE EXCEPTION 'media finalized seal transition is not allowed';
  END IF;

  expected := OLD;
  expected.phase := 'analysis';
  expected.audio_revision := 1;
  expected.current_immutable_ref := NEW.current_immutable_ref;
  expected.workflow_revision := OLD.workflow_revision + 1;
  expected.event_sequence := OLD.event_sequence + 1;
  expected.updated_at := NEW.updated_at;
  IF (to_jsonb(NEW) - 'actor_account_id') IS DISTINCT FROM
       (to_jsonb(expected) - 'actor_account_id')
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'media finalized seal transition evidence is not exact';
  END IF;

  SELECT *
    INTO audio_record
    FROM media_audio_revisions
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND author_persona_id = NEW.author_persona_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
     AND audio_revision = NEW.audio_revision
   FOR SHARE;
  IF audio_record.submission_id IS NULL
     OR audio_record.immutable_ref IS DISTINCT FROM NEW.current_immutable_ref THEN
    RAISE EXCEPTION 'media finalized seal requires its exact audio revision';
  END IF;

  SELECT status = 'active'
    INTO community_active
    FROM communities
   WHERE community_id = NEW.community_id
   FOR SHARE;
  SELECT status = 'member'
    INTO membership_active
    FROM community_memberships
   WHERE community_id = NEW.community_id
     AND user_id = NEW.actor_user_id
   FOR SHARE;
  IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'media submission requires active community membership';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER media_finalize_sealed_guard
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW
WHEN (
  OLD.status = 'processing'
  AND OLD.phase = 'finalize'
  AND NEW.status = 'processing'
  AND NEW.phase = 'analysis'
  AND NEW.audio_revision = OLD.audio_revision + 1
)
EXECUTE FUNCTION guard_media_finalize_sealed();

DROP TRIGGER media_submission_update_guard ON media_post_submissions;
CREATE TRIGGER media_submission_update_guard
BEFORE UPDATE ON media_post_submissions
FOR EACH ROW
WHEN (
  NEW.current_lyrics_revision IS NOT DISTINCT FROM OLD.current_lyrics_revision
  AND NEW.workflow_replacement_sequence IS NOT DISTINCT FROM OLD.workflow_replacement_sequence
  AND NOT ((
  OLD.status = 'processing'
  AND OLD.phase = 'awaiting_upload'
  AND NEW.status = 'processing'
  AND NEW.phase = 'finalize'
)
OR (
  OLD.status = 'processing'
  AND OLD.phase = 'finalize'
  AND NEW.status = 'processing'
  AND NEW.phase = 'analysis'
  AND NEW.audio_revision = OLD.audio_revision + 1
  ))
)
EXECUTE FUNCTION guard_media_submission_update();

CREATE FUNCTION validate_media_finalize_event_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record media_submission_events%ROWTYPE;
  reservation_record media_upload_reservations%ROWTYPE;
  evidence_keys TEXT[];
BEGIN
  SELECT *
    INTO event_record
    FROM media_submission_events
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
     AND event_sequence = NEW.event_sequence;

  IF event_record.submission_id IS NULL
     OR event_record.author_persona_id IS DISTINCT FROM NEW.author_persona_id
     OR event_record.event_kind IS DISTINCT FROM 'finalize_requested'
     OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision
     OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision
     OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision THEN
    RAISE EXCEPTION 'media finalize fence requires its exact event';
  END IF;

  SELECT array_agg(key ORDER BY key)
    INTO evidence_keys
    FROM jsonb_object_keys(event_record.evidence) AS key;
  IF evidence_keys IS DISTINCT FROM ARRAY[
       'event_kind',
       'idempotency_key',
       'request_hash',
       'reservation_id'
     ]::TEXT[]
     OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'finalize_requested'
     OR event_record.evidence->>'reservation_id' IS DISTINCT FROM NEW.audio_reservation_id
     OR COALESCE(event_record.evidence->>'idempotency_key', '') = ''
     OR COALESCE(event_record.evidence->>'request_hash', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'media finalize fence event evidence is not exact';
  END IF;

  SELECT *
    INTO reservation_record
    FROM media_upload_reservations
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND actor_persona_id = NEW.author_persona_id
     AND reservation_id = NEW.audio_reservation_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
   FOR SHARE;
  IF reservation_record.reservation_id IS NULL
     OR reservation_record.state IS DISTINCT FROM 'claimed'
     OR reservation_record.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'media finalize fence requires its live claimed reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER media_finalize_event_pair
AFTER UPDATE ON media_post_submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.status = 'processing'
  AND OLD.phase = 'awaiting_upload'
  AND NEW.status = 'processing'
  AND NEW.phase = 'finalize'
)
EXECUTE FUNCTION validate_media_finalize_event_pair();

CREATE FUNCTION validate_media_finalize_sealed_event_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record media_submission_events%ROWTYPE;
  audio_record media_audio_revisions%ROWTYPE;
  reservation_record media_upload_reservations%ROWTYPE;
  evidence_keys TEXT[];
BEGIN
  SELECT *
    INTO event_record
    FROM media_submission_events
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
     AND event_sequence = NEW.event_sequence;
  SELECT *
    INTO audio_record
    FROM media_audio_revisions
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
     AND audio_revision = NEW.audio_revision
   FOR SHARE;

  IF event_record.submission_id IS NULL
     OR audio_record.submission_id IS NULL
     OR event_record.author_persona_id IS DISTINCT FROM NEW.author_persona_id
     OR audio_record.author_persona_id IS DISTINCT FROM NEW.author_persona_id
     OR event_record.event_kind IS DISTINCT FROM 'upload_finalized'
     OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision
     OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision
     OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision
     OR audio_record.immutable_ref IS DISTINCT FROM NEW.current_immutable_ref THEN
    RAISE EXCEPTION 'media finalized seal requires its exact event and audio revision';
  END IF;

  SELECT array_agg(key ORDER BY key)
    INTO evidence_keys
    FROM jsonb_object_keys(event_record.evidence) AS key;
  IF evidence_keys IS DISTINCT FROM ARRAY[
       'canonical_audio_sha256',
       'event_kind',
       'immutable_ref'
     ]::TEXT[]
     OR event_record.evidence->>'event_kind' IS DISTINCT FROM 'upload_finalized'
     OR event_record.evidence->>'immutable_ref' IS DISTINCT FROM audio_record.immutable_ref
     OR event_record.evidence->>'canonical_audio_sha256' IS DISTINCT FROM audio_record.canonical_sha256 THEN
    RAISE EXCEPTION 'media finalized seal event evidence is not exact';
  END IF;

  SELECT *
    INTO reservation_record
    FROM media_upload_reservations
   WHERE community_id = NEW.community_id
     AND actor_user_id = NEW.actor_user_id
     AND actor_persona_id = NEW.author_persona_id
     AND reservation_id = NEW.audio_reservation_id
     AND submission_id = NEW.submission_id
     AND operation_id = NEW.operation_id
   FOR SHARE;
  IF reservation_record.reservation_id IS NULL
     OR reservation_record.state IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION 'media finalized seal requires its sealed reservation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER media_finalize_sealed_event_pair
AFTER UPDATE ON media_post_submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.status = 'processing'
  AND OLD.phase = 'finalize'
  AND NEW.status = 'processing'
  AND NEW.phase = 'analysis'
  AND NEW.audio_revision = OLD.audio_revision + 1
)
EXECUTE FUNCTION validate_media_finalize_sealed_event_pair();

DROP TRIGGER media_submission_event_pair ON media_post_submissions;
CREATE CONSTRAINT TRIGGER media_submission_event_pair
AFTER UPDATE ON media_post_submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW.current_lyrics_revision IS NOT DISTINCT FROM OLD.current_lyrics_revision
  AND NEW.workflow_replacement_sequence IS NOT DISTINCT FROM OLD.workflow_replacement_sequence
  AND NOT (OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published')
  AND NOT ((
  OLD.status = 'processing'
  AND OLD.phase = 'awaiting_upload'
  AND NEW.status = 'processing'
  AND NEW.phase = 'finalize'
)
OR (
  OLD.status = 'processing'
  AND OLD.phase = 'finalize'
  AND NEW.status = 'processing'
  AND NEW.phase = 'analysis'
  AND NEW.audio_revision = OLD.audio_revision + 1
  ))
)
EXECUTE FUNCTION validate_media_submission_event_pair();
