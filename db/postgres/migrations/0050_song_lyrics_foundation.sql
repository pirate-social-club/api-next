-- Revisioned author-reviewed lyrics foundation. ASR transcripts remain immutable
-- evidence; accepted lyrics are a distinct, audio-bound author decision.

-- Pre-0050 ready speech and timed-lyrics rows have no author-accepted lyrics
-- identity. Transcript rows may also predate the classifier's strict ready
-- shape. Refuse either lossy upgrade before changing any catalog object; an
-- operator must first reconcile those rows through a separately reviewed data
-- migration. Other populated 0049 states upgrade in place below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM media_analysis_evidence WHERE speech_status = 'ready')
     OR EXISTS (SELECT 1 FROM media_timed_lyrics_artifacts)
     OR EXISTS (
       SELECT 1
       FROM media_transcript_artifacts artifact
       WHERE char_length(artifact.transcript_text) = 0
          OR jsonb_array_length(artifact.segments) = 0
          OR EXISTS (
            SELECT 1
            FROM (
              SELECT
                entry.segment->>'text' AS segment_text,
                (entry.segment->>'start_ms')::numeric AS start_ms,
                (entry.segment->>'end_ms')::numeric AS end_ms,
                lag((entry.segment->>'end_ms')::numeric)
                  OVER (ORDER BY entry.ordinality) AS previous_end_ms
              FROM jsonb_array_elements(artifact.segments)
                WITH ORDINALITY AS entry(segment, ordinality)
            ) segment
            WHERE char_length(segment.segment_text) = 0
               OR segment.end_ms <= segment.start_ms
               OR (
                 segment.previous_end_ms IS NOT NULL
                 AND segment.start_ms < segment.previous_end_ms
               )
          )
     ) THEN
    RAISE EXCEPTION '0050 requires reconciliation of pre-foundation ready speech, timed lyrics, or classifier-incompatible transcript rows';
  END IF;
END;
$$;

-- These numeric ceilings mirror the exported @pirate/contracts transcript
-- constants and are exercised against those constants by the PostgreSQL suite.
CREATE OR REPLACE FUNCTION validate_media_transcript_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment JSONB; previous_end NUMERIC := NULL; start_value NUMERIC; end_value NUMERIC; total_segment_text BIGINT := 0;
BEGIN
  IF char_length(NEW.transcript_text) < 1
     OR char_length(NEW.transcript_text) > 200000
     OR jsonb_array_length(NEW.segments) < 1
     OR encode(sha256(convert_to(NEW.transcript_text, 'UTF8')), 'hex') IS DISTINCT FROM NEW.transcript_sha256 THEN
    RAISE EXCEPTION 'transcript payload is not bounded or hashed';
  END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(NEW.segments) LOOP
    IF jsonb_typeof(segment) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(segment) AS key)
          IS DISTINCT FROM ARRAY['end_ms','start_ms','text']::TEXT[]
       OR jsonb_typeof(segment->'start_ms') IS DISTINCT FROM 'number'
       OR jsonb_typeof(segment->'end_ms') IS DISTINCT FROM 'number'
       OR jsonb_typeof(segment->'text') IS DISTINCT FROM 'string'
       OR char_length(segment->>'text') < 1
       OR char_length(segment->>'text') > 4096 THEN
      RAISE EXCEPTION 'transcript segment shape is invalid';
    END IF;
    total_segment_text := total_segment_text + char_length(segment->>'text');
    IF total_segment_text > 200000 THEN
      RAISE EXCEPTION 'transcript segment text aggregate exceeds 200000 characters';
    END IF;
    start_value := (segment->>'start_ms')::numeric;
    end_value := (segment->>'end_ms')::numeric;
    IF start_value < 0
       OR end_value <= start_value
       OR end_value > 86400000
       OR start_value <> trunc(start_value)
       OR end_value <> trunc(end_value)
       OR (previous_end IS NOT NULL AND start_value < previous_end) THEN
      RAISE EXCEPTION 'transcript segment timing is invalid';
    END IF;
    previous_end := end_value;
  END LOOP;
  RETURN NEW;
END;
$$;

ALTER TABLE media_post_submissions
  ADD COLUMN lyrics_revision BIGINT NOT NULL DEFAULT 0 CHECK (lyrics_revision >= 0),
  ADD COLUMN current_lyrics_revision BIGINT,
  ADD COLUMN workflow_replacement_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (workflow_replacement_sequence >= 0);

CREATE TABLE media_song_lyrics_revisions (
  submission_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_account_id TEXT GENERATED ALWAYS AS (actor_user_id) STORED,
  author_persona_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  lyrics_revision BIGINT NOT NULL CHECK (lyrics_revision > 0),
  creation_revision BIGINT NOT NULL CHECK (creation_revision > 1),
  audio_revision BIGINT NOT NULL CHECK (audio_revision > 0),
  canonical_audio_sha256 TEXT NOT NULL CHECK (canonical_audio_sha256 ~ '^[0-9a-f]{64}$'),
  lyrics_text TEXT NOT NULL CHECK (
    (char_length(lyrics_text) >= 1 AND char_length(lyrics_text) <= 200000)
    AND octet_length(convert_to(lyrics_text, 'UTF8')) <= 800000
  ),
  lyrics_sha256 TEXT NOT NULL CHECK (lyrics_sha256 ~ '^[0-9a-f]{64}$'),
  base_transcript_revision BIGINT CHECK (base_transcript_revision IS NULL OR base_transcript_revision > 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('asr_accepted', 'pasted', 'corrected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, lyrics_revision),
  UNIQUE (submission_id, audio_revision, lyrics_revision),
  UNIQUE (submission_id, audio_revision, lyrics_revision, canonical_audio_sha256),
  FOREIGN KEY (community_id, actor_user_id, author_persona_id, submission_id, operation_id)
    REFERENCES media_post_submissions (
      community_id, actor_user_id, author_persona_id, submission_id, operation_id
    ),
  FOREIGN KEY (actor_account_id, author_persona_id)
    REFERENCES personas (account_id, persona_id),
  FOREIGN KEY (submission_id, audio_revision, canonical_audio_sha256)
    REFERENCES media_audio_revisions (submission_id, audio_revision, canonical_sha256),
  CONSTRAINT media_song_lyrics_digest_exact CHECK (
    encode(sha256(convert_to(lyrics_text, 'UTF8')), 'hex') = lyrics_sha256
  ),
  CONSTRAINT media_song_lyrics_provenance_shape CHECK (
    (base_transcript_revision IS NULL AND provenance = 'pasted')
    OR (base_transcript_revision IS NOT NULL AND provenance IN ('asr_accepted', 'corrected'))
  )
);

CREATE UNIQUE INDEX media_transcript_revision_lineage_uidx
  ON media_transcript_artifacts (
    submission_id, audio_revision, analysis_revision, canonical_audio_sha256
  );

ALTER TABLE media_song_lyrics_revisions
  ADD CONSTRAINT media_song_lyrics_transcript_fk FOREIGN KEY (
    submission_id, audio_revision, base_transcript_revision, canonical_audio_sha256
  ) REFERENCES media_transcript_artifacts (
    submission_id, audio_revision, analysis_revision, canonical_audio_sha256
  );

ALTER TABLE media_post_submissions
  ADD CONSTRAINT media_post_submissions_current_lyrics_fk FOREIGN KEY (
    submission_id, audio_revision, current_lyrics_revision
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision
  ) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT media_post_submissions_lyrics_shape CHECK (
    (lyrics_revision = 0 AND current_lyrics_revision IS NULL)
    OR (lyrics_revision > 0 AND current_lyrics_revision = lyrics_revision)
  );

ALTER TABLE media_analysis_evidence
  ADD COLUMN transcript_revision BIGINT,
  ADD COLUMN lyrics_revision BIGINT,
  ADD COLUMN material_disagreement BOOLEAN NOT NULL DEFAULT FALSE,
  DROP CONSTRAINT media_analysis_speech_shape,
  ADD CONSTRAINT media_analysis_speech_shape CHECK (
    (speech_status = 'ready'
      AND transcript_artifact_ref IS NOT NULL
      AND transcript_sha256 IS NOT NULL
      AND transcript_revision > 0
      AND lyrics_revision > 0
      AND explicitness IN ('not_explicit', 'explicit', 'uncertain')
      AND primary_language_bcp47 IS NOT NULL
      AND char_length(primary_language_bcp47) <= 35
      AND primary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
      AND (secondary_language_bcp47 IS NULL OR (
        char_length(secondary_language_bcp47) <= 35
        AND secondary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
        AND secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47
      ))
      AND lyrics_safety IN ('skipped', 'allow', 'review_required', 'blocked'))
    OR (speech_status = 'no_speech'
      AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL
      AND transcript_revision IS NULL
      AND explicitness = 'no_lyrics'
      AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL
      AND (
        (lyrics_revision IS NULL AND material_disagreement = FALSE AND lyrics_safety = 'skipped')
        OR (lyrics_revision > 0 AND material_disagreement = TRUE AND lyrics_safety = 'review_required')
      ))
    OR (speech_status = 'unavailable'
      AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL
      AND transcript_revision IS NULL AND lyrics_revision IS NULL
      AND material_disagreement = FALSE
      AND explicitness = 'uncertain'
      AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL
      AND lyrics_safety = 'review_required')
  ),
  ADD CONSTRAINT media_analysis_lyrics_fk FOREIGN KEY (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  );

ALTER TABLE media_analysis_evidence
  DROP CONSTRAINT media_analysis_transcript_fk,
  ADD CONSTRAINT media_analysis_transcript_fk FOREIGN KEY (
    transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id,
    audio_revision, transcript_revision, canonical_audio_sha256, transcript_sha256
  ) REFERENCES media_transcript_artifacts (
    transcript_artifact_ref, community_id, actor_user_id, submission_id, operation_id,
    audio_revision, analysis_revision, canonical_audio_sha256, transcript_sha256
  );

ALTER TABLE media_publication_decisions
  ADD COLUMN lyrics_revision BIGINT,
  ADD CONSTRAINT media_decision_lyrics_fk FOREIGN KEY (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  );

ALTER TABLE media_publication_projections
  ADD COLUMN lyrics_status TEXT NOT NULL DEFAULT 'no_lyrics'
    CHECK (lyrics_status IN ('ready', 'no_lyrics')),
  ADD COLUMN lyrics_revision BIGINT,
  ADD COLUMN lyrics_text TEXT,
  ADD CONSTRAINT media_publication_lyrics_shape CHECK (
    (lyrics_status = 'ready' AND lyrics_revision > 0 AND lyrics_text IS NOT NULL)
    OR (lyrics_status = 'no_lyrics' AND lyrics_revision IS NULL AND lyrics_text IS NULL)
  ),
  ADD CONSTRAINT media_publication_lyrics_fk FOREIGN KEY (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  );

ALTER TABLE media_timed_lyrics_artifacts
  ADD COLUMN lyrics_revision BIGINT NOT NULL,
  ADD CONSTRAINT media_timed_lyrics_revision_fk FOREIGN KEY (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  );

ALTER TABLE media_alignment_projections
  ADD COLUMN lyrics_revision BIGINT,
  ADD CONSTRAINT media_alignment_lyrics_fk FOREIGN KEY (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  ) REFERENCES media_song_lyrics_revisions (
    submission_id, audio_revision, lyrics_revision, canonical_audio_sha256
  );

ALTER TABLE media_processing_attempts
  DROP CONSTRAINT media_processing_attempts_input_kind_check,
  ADD CONSTRAINT media_processing_attempts_input_kind_check CHECK (
    input_kind IN ('audio', 'analysis', 'transcript', 'lyrics', 'reference', 'publication')
  );

ALTER TABLE media_submission_events
  DROP CONSTRAINT media_submission_events_event_kind_check,
  ADD CONSTRAINT media_submission_events_event_kind_check CHECK (event_kind IN (
    'submission_reserved', 'text_input_bound', 'media_reservation_issued', 'finalize_requested',
    'author_cancelled', 'reservation_expired', 'upload_finalized',
    'upload_expectation_mismatch_recorded', 'upload_source_precondition_failed',
    'seal_conflict_recorded', 'song_terms_bound', 'song_lyrics_bound',
    'blocking_analysis_completed', 'review_exhaustion_recorded', 'media_failure_recorded',
    'publication_allowed', 'reference_required', 'review_required', 'policy_blocked',
    'reference_bound', 'action_deadline_elapsed', 'moderator_approved', 'moderator_blocked',
    'publication_committed', 'technical_exhaustion_recorded', 'retry_authorized',
    'workflow_replaced'
  ));

ALTER TABLE media_submission_outbox
  ADD COLUMN lyrics_revision BIGINT,
  DROP CONSTRAINT media_submission_outbox_event_type_check,
  ADD CONSTRAINT media_submission_outbox_event_type_check CHECK (event_type IN (
    'analysis_launch', 'decision_wakeup', 'publication', 'alignment', 'workflow_replacement'
  )),
  DROP CONSTRAINT media_submission_outbox_community_id_actor_user_id_submissi_key;

-- Rows created by 0043 used closed payloads that predated creation/lyrics
-- identity. Upgrade those immutable effects in place before installing the new
-- update guard. The row tuple remains authoritative and effect identity is
-- preserved.
DROP TRIGGER media_outbox_update_guard ON media_submission_outbox;
UPDATE media_submission_outbox
SET payload = jsonb_build_object(
  'kind', 'publication',
  'submission_id', submission_id,
  'operation_id', operation_id,
  'creation_revision', creation_revision,
  'lyrics_revision', lyrics_revision,
  'workflow_revision', workflow_revision,
  'workflow_instance_id', workflow_instance_id
)
WHERE event_type = 'publication';
UPDATE media_submission_outbox
SET payload = jsonb_build_object(
  'kind', 'alignment',
  'submission_id', submission_id,
  'operation_id', operation_id,
  'post_id', payload->>'post_id',
  'lyrics_revision', lyrics_revision,
  'workflow_revision', workflow_revision,
  'workflow_instance_id', workflow_instance_id
)
WHERE event_type = 'alignment';

ALTER TABLE media_submission_outbox
  ADD CONSTRAINT media_submission_outbox_semantic_identity_unique
  UNIQUE NULLS NOT DISTINCT (
    community_id, actor_user_id, submission_id, operation_id, event_type,
    creation_revision, audio_revision, analysis_revision, lyrics_revision,
    workflow_revision
  );

CREATE OR REPLACE FUNCTION guard_media_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.outbox_event_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id, NEW.operation_id, NEW.creation_revision, NEW.audio_revision, NEW.analysis_revision, NEW.lyrics_revision, NEW.workflow_revision, NEW.workflow_instance_id, NEW.event_type, NEW.effect_identity, NEW.payload, NEW.created_at) IS DISTINCT FROM ROW(OLD.outbox_event_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id, OLD.operation_id, OLD.creation_revision, OLD.audio_revision, OLD.analysis_revision, OLD.lyrics_revision, OLD.workflow_revision, OLD.workflow_instance_id, OLD.event_type, OLD.effect_identity, OLD.payload, OLD.created_at) THEN RAISE EXCEPTION 'media outbox effect identity is immutable'; END IF;
  IF NEW.updated_at <= OLD.updated_at OR NEW.claim_fence < OLD.claim_fence OR NEW.delivery_attempts < OLD.delivery_attempts OR NEW.delivery_attempts > 3 THEN RAISE EXCEPTION 'media outbox fence must advance'; END IF;
  IF (OLD.state = 'pending' AND (OLD.delivery_attempts >= 3 OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF (OLD.state = 'failed' AND (OLD.delivery_attempts >= 3 OR OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp() OR NEW.state <> 'running' OR NEW.delivery_attempts <> OLD.delivery_attempts + 1 OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp())) THEN RAISE EXCEPTION 'media outbox claim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND (OLD.lease_expires_at > clock_timestamp() OR NEW.delivery_attempts <> CASE WHEN OLD.delivery_attempts < 3 THEN OLD.delivery_attempts + 1 ELSE OLD.delivery_attempts END OR NEW.claim_fence <> OLD.claim_fence + 1 OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'media outbox reclaim is not allowed'; END IF;
  IF OLD.state = 'running' AND NEW.state IN ('delivered', 'failed', 'exhausted') AND (NEW.delivery_attempts <> OLD.delivery_attempts OR OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence OR NEW.claim_owner IS NOT NULL OR (NEW.state = 'exhausted' AND OLD.delivery_attempts <> 3) OR (NEW.state = 'failed' AND OLD.delivery_attempts >= 3) OR (NEW.state = 'failed' AND NEW.next_eligible_at IS NULL) OR (NEW.state = 'exhausted' AND NEW.next_eligible_at IS NOT NULL)) THEN RAISE EXCEPTION 'media outbox completion is not allowed'; END IF;
  IF OLD.state NOT IN ('pending', 'failed', 'running') THEN RAISE EXCEPTION 'media outbox is terminal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_outbox_update_guard BEFORE UPDATE ON media_submission_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_media_outbox_update();

CREATE FUNCTION validate_media_lyrics_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; publication_record media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF (NEW.speech_status = 'ready' AND (
          NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision
          OR NOT EXISTS (
            SELECT 1 FROM media_transcript_artifacts transcript
            WHERE transcript.transcript_artifact_ref=NEW.transcript_artifact_ref
              AND transcript.submission_id=NEW.submission_id
              AND transcript.audio_revision=NEW.audio_revision
              AND transcript.analysis_revision=NEW.transcript_revision
              AND transcript.canonical_audio_sha256=NEW.canonical_audio_sha256
          )
        ))
       OR (NEW.speech_status = 'no_speech' AND (
            NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision
            OR (submission_record.current_lyrics_revision IS NULL AND (
                 NEW.material_disagreement OR NEW.lyrics_safety <> 'skipped'
               ))
            OR (submission_record.current_lyrics_revision IS NOT NULL AND (
                 NOT NEW.material_disagreement OR NEW.lyrics_safety <> 'review_required'
               ))
          ))
       OR (NEW.material_disagreement AND NEW.lyrics_safety <> 'review_required') THEN
      RAISE EXCEPTION 'analysis lyrics lineage is not exact';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_decisions' THEN
    IF NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision THEN
      RAISE EXCEPTION 'decision lyrics revision is not current';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_publication_projections' THEN
    IF (NEW.language_status = 'ready' AND (
          NEW.lyrics_status <> 'ready'
          OR NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision
          OR NOT EXISTS (
            SELECT 1 FROM media_song_lyrics_revisions lyrics
            WHERE lyrics.submission_id=NEW.submission_id
              AND lyrics.lyrics_revision=NEW.lyrics_revision
              AND lyrics.lyrics_text=NEW.lyrics_text
          )
        ))
       OR (NEW.language_status = 'no_speech' AND NEW.lyrics_status <> 'no_lyrics')
       OR NEW.language_status = 'unavailable' THEN
      RAISE EXCEPTION 'published lyrics projection is not exact';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_alignment_projections' THEN
    SELECT * INTO publication_record FROM media_publication_projections
      WHERE submission_id=NEW.submission_id AND post_id=NEW.post_id FOR SHARE;
    IF publication_record.submission_id IS NULL
       OR NEW.lyrics_revision IS DISTINCT FROM publication_record.lyrics_revision THEN
      RAISE EXCEPTION 'alignment lyrics revision is not the published revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_analysis_lyrics_lineage_guard BEFORE INSERT ON media_analysis_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_media_lyrics_lineage();
CREATE TRIGGER media_decision_lyrics_lineage_guard BEFORE INSERT ON media_publication_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_media_lyrics_lineage();
CREATE TRIGGER media_publication_lyrics_lineage_guard BEFORE INSERT OR UPDATE ON media_publication_projections
  FOR EACH ROW EXECUTE FUNCTION validate_media_lyrics_lineage();
CREATE TRIGGER media_alignment_lyrics_lineage_guard BEFORE INSERT OR UPDATE ON media_alignment_projections
  FOR EACH ROW EXECUTE FUNCTION validate_media_lyrics_lineage();

-- The accepted mapping publishes explicit lyrics with a truthful label. Patch
-- the pinned 0043 transition function without copying its entire predecessor
-- definition into this forward migration.
DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_media_submission_update()'::regprocedure) INTO definition;
  patched := replace(
    definition,
    'analysis_record.explicitness NOT IN (''not_explicit'', ''no_lyrics'')',
    'analysis_record.explicitness NOT IN (''not_explicit'', ''explicit'', ''no_lyrics'')'
  );
  IF patched IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION '0049 could not patch the explicit publication predicate';
  END IF;
  EXECUTE patched;
END;
$migration$;

-- Existing transition guards do not know the two new submission mutations.
-- Keep them for every old transition and route only the new shapes to exact guards.
DROP TRIGGER media_submission_update_guard ON media_post_submissions;
CREATE TRIGGER media_submission_update_guard BEFORE UPDATE ON media_post_submissions
  FOR EACH ROW WHEN (
    NEW.current_lyrics_revision IS NOT DISTINCT FROM OLD.current_lyrics_revision
    AND NEW.workflow_replacement_sequence IS NOT DISTINCT FROM OLD.workflow_replacement_sequence
  ) EXECUTE FUNCTION guard_media_submission_update();

DROP TRIGGER media_submission_event_pair ON media_post_submissions;
CREATE CONSTRAINT TRIGGER media_submission_event_pair AFTER UPDATE ON media_post_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
    NEW.current_lyrics_revision IS NOT DISTINCT FROM OLD.current_lyrics_revision
    AND NEW.workflow_replacement_sequence IS NOT DISTINCT FROM OLD.workflow_replacement_sequence
    AND NOT (OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published')
  ) EXECUTE FUNCTION validate_media_submission_event_pair();

CREATE FUNCTION validate_media_publication_lyrics_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_record media_submission_events%ROWTYPE;
BEGIN
  SELECT * INTO event_record FROM media_submission_events
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
      AND event_sequence=NEW.event_sequence;
  IF event_record.event_kind IS DISTINCT FROM 'publication_committed'
     OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision
     OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision
     OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision
     OR NOT EXISTS (
       SELECT 1 FROM media_publication_projections publication
       WHERE publication.submission_id=NEW.submission_id
         AND publication.creation_revision=NEW.creation_revision
         AND publication.audio_revision=NEW.audio_revision
         AND publication.analysis_revision=NEW.analysis_revision
         AND publication.decision_revision=NEW.decision_revision
         AND publication.lyrics_revision IS NOT DISTINCT FROM NEW.current_lyrics_revision
     )
     OR NOT EXISTS (
       SELECT 1 FROM media_alignment_projections alignment
       WHERE alignment.submission_id=NEW.submission_id
         AND alignment.post_id=NEW.post_id
         AND alignment.audio_revision=NEW.audio_revision
         AND alignment.analysis_revision=NEW.analysis_revision
         AND alignment.lyrics_revision IS NOT DISTINCT FROM NEW.current_lyrics_revision
         AND alignment.status='pending'
     )
     OR NOT EXISTS (
       SELECT 1 FROM media_submission_outbox outbox
       WHERE outbox.submission_id=NEW.submission_id
         AND outbox.event_type='alignment'
         AND outbox.workflow_revision=NEW.workflow_revision
         AND outbox.lyrics_revision IS NOT DISTINCT FROM NEW.current_lyrics_revision
     ) THEN
    RAISE EXCEPTION 'publication commit is missing its lyrics-fenced projection, alignment, or outbox';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_publication_lyrics_pair AFTER UPDATE ON media_post_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
    OLD.status = 'processing' AND OLD.phase = 'publish' AND NEW.status = 'published'
  ) EXECUTE FUNCTION validate_media_publication_lyrics_pair();

CREATE FUNCTION guard_media_lyrics_or_workflow_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE community_active BOOLEAN; membership_active BOOLEAN;
BEGIN
  IF NEW.current_lyrics_revision IS DISTINCT FROM OLD.current_lyrics_revision THEN
    SELECT status = 'active' INTO community_active FROM communities
      WHERE community_id=NEW.community_id FOR SHARE;
    SELECT status = 'member' INTO membership_active FROM community_memberships
      WHERE community_id=NEW.community_id AND user_id=NEW.actor_user_id FOR SHARE;
    IF community_active IS DISTINCT FROM TRUE OR membership_active IS DISTINCT FROM TRUE
       OR OLD.audio_revision = 0
       OR NOT (
         (OLD.status = 'processing' AND OLD.phase IN ('analysis','decision'))
         OR (OLD.status IN ('action_required','manual_review') AND OLD.phase IS NULL)
       )
       OR NEW.lyrics_revision IS DISTINCT FROM OLD.lyrics_revision + 1
       OR NEW.current_lyrics_revision IS DISTINCT FROM NEW.lyrics_revision
       OR NEW.creation_revision IS DISTINCT FROM OLD.creation_revision + 1
       OR NEW.current_terms_revision IS DISTINCT FROM
          (CASE WHEN OLD.current_terms_revision IS NULL THEN NULL ELSE NEW.creation_revision END)
       OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision
       OR NEW.current_analysis_revision IS NOT NULL
       OR NEW.decision_revision IS DISTINCT FROM 0
       OR NEW.current_decision_revision IS NOT NULL
       OR NEW.status IS DISTINCT FROM 'processing'
       OR NEW.phase IS DISTINCT FROM 'analysis'
       OR NEW.action_kind IS NOT NULL
       OR NEW.action_reference_request_ref IS NOT NULL
       OR NEW.action_expires_at IS NOT NULL
       OR NEW.review_ref IS NOT NULL
       OR NEW.review_reason_code IS NOT NULL
       OR NEW.review_exhaustion_code IS NOT NULL
       OR NEW.review_exhaustion_attempt_id IS NOT NULL
       OR NEW.held_revision IS NOT NULL
       OR NEW.moderator_action_id IS NOT NULL
       OR NEW.moderator_actor_id IS NOT NULL
       OR NEW.moderator_evidence_ref IS NOT NULL
       OR NEW.moderator_approval_kind IS NOT NULL
       OR NEW.moderator_reason_code IS NOT NULL
       OR NEW.failure_code IS NOT NULL
       OR NEW.failure_retry_count IS NOT NULL
       OR NEW.retryable IS NOT NULL
       OR NEW.last_safe_phase IS NOT NULL
       OR NEW.abandonment_reason IS NOT NULL
       OR NEW.retention_disposition IS NOT NULL
       OR NEW.event_sequence IS DISTINCT FROM OLD.event_sequence + 1
       OR NEW.updated_at <= OLD.updated_at
       OR (to_jsonb(NEW) - ARRAY[
         'lyrics_revision','current_lyrics_revision','creation_revision','current_terms_revision','current_analysis_revision',
         'decision_revision','current_decision_revision','status','phase','event_sequence','updated_at',
         'action_kind','action_reference_request_ref','action_expires_at','review_ref',
         'review_reason_code','review_exhaustion_code','review_exhaustion_attempt_id','held_revision',
         'moderator_action_id','moderator_actor_id','moderator_evidence_ref','moderator_approval_kind',
         'moderator_reason_code','failure_code','failure_retry_count','retryable','last_safe_phase',
         'actor_account_id'
       ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
         'lyrics_revision','current_lyrics_revision','creation_revision','current_terms_revision','current_analysis_revision',
         'decision_revision','current_decision_revision','status','phase','event_sequence','updated_at',
         'action_kind','action_reference_request_ref','action_expires_at','review_ref',
         'review_reason_code','review_exhaustion_code','review_exhaustion_attempt_id','held_revision',
         'moderator_action_id','moderator_actor_id','moderator_evidence_ref','moderator_approval_kind',
         'moderator_reason_code','failure_code','failure_retry_count','retryable','last_safe_phase',
         'actor_account_id'
       ]) THEN
      RAISE EXCEPTION 'lyrics projection transition is not exact';
    END IF;
  ELSIF NEW.workflow_replacement_sequence IS DISTINCT FROM OLD.workflow_replacement_sequence THEN
    IF NEW.workflow_replacement_sequence IS DISTINCT FROM OLD.workflow_replacement_sequence + 1
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision + 1
       OR NEW.event_sequence IS DISTINCT FROM OLD.event_sequence + 1
       OR NEW.updated_at <= OLD.updated_at
       OR (to_jsonb(NEW) - ARRAY['workflow_replacement_sequence','workflow_revision','event_sequence','updated_at','actor_account_id'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['workflow_replacement_sequence','workflow_revision','event_sequence','updated_at','actor_account_id']) THEN
      RAISE EXCEPTION 'workflow replacement transition is not exact';
    END IF;
  ELSE
    RAISE EXCEPTION 'specialized media transition has no owned mutation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_lyrics_or_workflow_update_guard BEFORE UPDATE ON media_post_submissions
  FOR EACH ROW WHEN (
    NEW.current_lyrics_revision IS DISTINCT FROM OLD.current_lyrics_revision
    OR NEW.workflow_replacement_sequence IS DISTINCT FROM OLD.workflow_replacement_sequence
  ) EXECUTE FUNCTION guard_media_lyrics_or_workflow_update();

CREATE FUNCTION validate_media_lyrics_or_workflow_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_event TEXT; event_record media_submission_events%ROWTYPE;
BEGIN
  expected_event := CASE
    WHEN NEW.current_lyrics_revision IS DISTINCT FROM OLD.current_lyrics_revision
      THEN 'song_lyrics_bound'
    WHEN NEW.workflow_replacement_sequence IS DISTINCT FROM OLD.workflow_replacement_sequence
      THEN 'workflow_replaced'
    ELSE NULL
  END;
  SELECT * INTO event_record FROM media_submission_events
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
      AND event_sequence=NEW.event_sequence;
  IF expected_event IS NULL OR event_record.event_kind IS DISTINCT FROM expected_event
     OR event_record.creation_revision IS DISTINCT FROM NEW.creation_revision
     OR event_record.audio_revision IS DISTINCT FROM NEW.audio_revision
     OR event_record.analysis_revision IS DISTINCT FROM NEW.analysis_revision
     OR event_record.decision_revision IS DISTINCT FROM NEW.decision_revision
     OR event_record.workflow_revision IS DISTINCT FROM NEW.workflow_revision
     OR event_record.evidence->>'event_kind' IS DISTINCT FROM expected_event THEN
    RAISE EXCEPTION 'specialized media transition requires its exact event';
  END IF;
  IF expected_event = 'song_lyrics_bound' AND NOT EXISTS (
    SELECT 1 FROM media_song_lyrics_revisions lyrics
    WHERE lyrics.submission_id=NEW.submission_id
      AND lyrics.community_id=NEW.community_id
      AND lyrics.actor_user_id=NEW.actor_user_id
      AND lyrics.operation_id=NEW.operation_id
      AND lyrics.lyrics_revision=NEW.current_lyrics_revision
      AND lyrics.creation_revision=NEW.creation_revision
      AND lyrics.audio_revision=NEW.audio_revision
  ) THEN RAISE EXCEPTION 'lyrics transition lacks its immutable revision'; END IF;
  IF expected_event = 'song_lyrics_bound' AND NEW.current_terms_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_submission_terms terms
    WHERE terms.community_id=NEW.community_id AND terms.actor_user_id=NEW.actor_user_id
      AND terms.submission_id=NEW.submission_id AND terms.operation_id=NEW.operation_id
      AND terms.creation_revision=NEW.creation_revision
  ) THEN RAISE EXCEPTION 'lyrics transition lacks its exact creation snapshot'; END IF;
  IF expected_event = 'song_lyrics_bound' AND NEW.workflow_revision > 0 AND NOT EXISTS (
    SELECT 1 FROM media_submission_outbox outbox
    WHERE outbox.community_id=NEW.community_id AND outbox.actor_user_id=NEW.actor_user_id
      AND outbox.submission_id=NEW.submission_id AND outbox.operation_id=NEW.operation_id
      AND outbox.event_type='decision_wakeup'
      AND outbox.creation_revision=NEW.creation_revision
      AND outbox.audio_revision=NEW.audio_revision
      AND outbox.analysis_revision=NEW.analysis_revision
      AND outbox.lyrics_revision=NEW.current_lyrics_revision
      AND outbox.workflow_revision=NEW.workflow_revision
      AND outbox.payload->>'trigger'='lyrics'
  ) THEN RAISE EXCEPTION 'lyrics transition lacks its exact decision wakeup'; END IF;
  IF expected_event = 'workflow_replaced' AND NOT EXISTS (
    SELECT 1 FROM media_submission_outbox outbox
    WHERE outbox.community_id=NEW.community_id AND outbox.actor_user_id=NEW.actor_user_id
      AND outbox.submission_id=NEW.submission_id AND outbox.operation_id=NEW.operation_id
      AND outbox.event_type='workflow_replacement'
      AND outbox.workflow_revision=NEW.workflow_revision
  ) THEN RAISE EXCEPTION 'workflow replacement lacks its launch outbox'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER media_lyrics_or_workflow_pair AFTER UPDATE ON media_post_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (
    NEW.current_lyrics_revision IS DISTINCT FROM OLD.current_lyrics_revision
    OR NEW.workflow_replacement_sequence IS DISTINCT FROM OLD.workflow_replacement_sequence
  ) EXECUTE FUNCTION validate_media_lyrics_or_workflow_pair();

CREATE FUNCTION guard_media_lyrics_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'media song lyrics revisions are append-only';
END;
$$;
CREATE TRIGGER media_song_lyrics_append_only BEFORE UPDATE OR DELETE ON media_song_lyrics_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_media_lyrics_append_only();

CREATE FUNCTION validate_media_lyrics_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE; transcript_text TEXT;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL
     OR NEW.author_persona_id IS DISTINCT FROM submission_record.author_persona_id
     OR NEW.lyrics_revision IS DISTINCT FROM submission_record.lyrics_revision + 1
     OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision + 1
     OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision THEN
    RAISE EXCEPTION 'lyrics revision is not current';
  END IF;
  IF NEW.base_transcript_revision IS NOT NULL THEN
    SELECT transcript_artifact.transcript_text INTO transcript_text
      FROM media_transcript_artifacts transcript_artifact
      WHERE transcript_artifact.submission_id=NEW.submission_id
        AND transcript_artifact.audio_revision=NEW.audio_revision
        AND transcript_artifact.analysis_revision=NEW.base_transcript_revision
        AND transcript_artifact.canonical_audio_sha256=NEW.canonical_audio_sha256;
    IF transcript_text IS NULL
       OR NEW.provenance IS DISTINCT FROM
          (CASE WHEN transcript_text = NEW.lyrics_text THEN 'asr_accepted' ELSE 'corrected' END) THEN
      RAISE EXCEPTION 'lyrics transcript provenance is not exact';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_song_lyrics_insert_guard BEFORE INSERT ON media_song_lyrics_revisions
  FOR EACH ROW EXECUTE FUNCTION validate_media_lyrics_insert();

CREATE FUNCTION validate_media_timed_lyrics_publication_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication_record media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO publication_record FROM media_publication_projections
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id
      AND post_id=NEW.post_id FOR SHARE;
  IF publication_record.submission_id IS NULL
     OR NEW.lyrics_revision IS DISTINCT FROM publication_record.lyrics_revision THEN
    RAISE EXCEPTION 'timed lyrics artifact is not bound to the published lyrics revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_timed_lyrics_publication_lineage_guard
  BEFORE INSERT ON media_timed_lyrics_artifacts
  FOR EACH ROW EXECUTE FUNCTION validate_media_timed_lyrics_publication_lineage();

-- Bind the mutable alignment pointer to the lyrics revision as well as the
-- already-fenced publication/audio/analysis identity.
ALTER TABLE media_timed_lyrics_artifacts
  ADD CONSTRAINT media_timed_lyrics_artifact_pointer_lyrics_unique UNIQUE (
    artifact_ref, artifact_revision, community_id, actor_user_id, submission_id,
    operation_id, post_id, audio_revision, analysis_revision,
    canonical_audio_sha256, lyrics_revision
  );
ALTER TABLE media_alignment_projections
  DROP CONSTRAINT media_alignment_projections_current_artifact_ref_current_a_fkey,
  ADD CONSTRAINT media_alignment_current_artifact_lyrics_fk FOREIGN KEY (
    current_artifact_ref, current_artifact_revision, community_id, actor_user_id,
    submission_id, operation_id, post_id, audio_revision, analysis_revision,
    canonical_audio_sha256, lyrics_revision
  ) REFERENCES media_timed_lyrics_artifacts (
    artifact_ref, artifact_revision, community_id, actor_user_id, submission_id,
    operation_id, post_id, audio_revision, analysis_revision,
    canonical_audio_sha256, lyrics_revision
  );

CREATE FUNCTION validate_media_alignment_lyrics_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_artifact_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_timed_lyrics_artifacts artifact
    WHERE artifact.artifact_ref=NEW.current_artifact_ref
      AND artifact.artifact_revision=NEW.current_artifact_revision
      AND artifact.community_id=NEW.community_id
      AND artifact.actor_user_id=NEW.actor_user_id
      AND artifact.submission_id=NEW.submission_id
      AND artifact.operation_id=NEW.operation_id
      AND artifact.post_id=NEW.post_id
      AND artifact.audio_revision=NEW.audio_revision
      AND artifact.analysis_revision=NEW.analysis_revision
      AND artifact.canonical_audio_sha256=NEW.canonical_audio_sha256
      AND artifact.lyrics_revision=NEW.lyrics_revision
  ) THEN RAISE EXCEPTION 'alignment artifact lyrics revision is not exact'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_alignment_lyrics_pointer_guard BEFORE INSERT OR UPDATE ON media_alignment_projections
  FOR EACH ROW EXECUTE FUNCTION validate_media_alignment_lyrics_pointer();

-- Outbox payloads are closed and identifier-only. Legacy publication and
-- alignment rows were upgraded above; every row now has the v2 shape.
DROP TRIGGER media_outbox_payload_guard ON media_submission_outbox;
CREATE FUNCTION validate_media_outbox_payload_v2() RETURNS trigger LANGUAGE plpgsql AS $$
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
    NEW.payload->>'trigger' NOT IN ('terms','lyrics')
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
CREATE TRIGGER media_outbox_payload_guard BEFORE INSERT ON media_submission_outbox
  FOR EACH ROW EXECUTE FUNCTION validate_media_outbox_payload_v2();
