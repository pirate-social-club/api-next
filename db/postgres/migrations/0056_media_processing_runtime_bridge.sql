-- Lyrics are optional. Language and explicitness classification consumes only
-- the current author-submitted lyrics revision. The retained transcript
-- columns and tables are historical storage and are no longer writable by the
-- application runtime.

ALTER TABLE media_submission_events
  DROP CONSTRAINT media_submission_events_event_kind_check,
  ADD CONSTRAINT media_submission_events_event_kind_check CHECK (event_kind IN (
    'submission_reserved', 'text_input_bound', 'media_reservation_issued', 'finalize_requested',
    'author_cancelled', 'reservation_expired', 'upload_finalized',
    'upload_expectation_mismatch_recorded', 'upload_source_precondition_failed',
    'seal_conflict_recorded', 'song_terms_bound', 'song_lyrics_bound',
    'blocking_analysis_completed', 'review_exhaustion_recorded',
    'provider_unavailable_review_recorded', 'media_failure_recorded',
    'publication_allowed', 'reference_required', 'review_required', 'policy_blocked',
    'reference_bound', 'action_deadline_elapsed', 'moderator_approved', 'moderator_blocked',
    'publication_committed', 'technical_exhaustion_recorded', 'retry_authorized',
    'workflow_replaced'
  ));

ALTER TABLE media_processing_attempts
  DROP CONSTRAINT media_processing_attempts_stage_check,
  ADD CONSTRAINT media_processing_attempts_stage_check CHECK (stage IN (
    'probe', 'sample_primary', 'sample_alternate', 'acr_primary', 'acr_alternate',
    'metadata', 'classifier', 'publication', 'alignment'
  )),
  DROP CONSTRAINT media_processing_attempts_state_check,
  ADD CONSTRAINT media_processing_attempts_state_check CHECK (state IN (
    'pending', 'running', 'retry_wait', 'poll_wait', 'failed', 'succeeded', 'exhausted'
  )),
  DROP CONSTRAINT media_processing_attempt_state_shape,
  ADD CONSTRAINT media_processing_attempt_state_shape CHECK (
    (state = 'pending' AND claim_owner IS NULL AND claim_fence = 0
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND retryable IS NULL AND failure_code IS NULL AND evidence_ref IS NULL AND result IS NULL)
    OR (state = 'running' AND claim_owner IS NOT NULL AND claim_fence > 0
      AND lease_expires_at IS NOT NULL AND next_eligible_at IS NULL
      AND retryable IS NULL AND failure_code IS NULL
      AND ((evidence_ref IS NULL AND result IS NULL)
        OR (evidence_ref IS NOT NULL AND result IS NOT NULL)))
    OR (state = 'retry_wait' AND claim_owner IS NULL AND claim_fence > 0
      AND lease_expires_at IS NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL
      AND failure_code IS NOT NULL AND evidence_ref IS NULL AND result IS NULL)
    OR (state = 'poll_wait' AND claim_owner IS NULL AND claim_fence > 0
      AND lease_expires_at IS NULL AND retryable IS NULL AND next_eligible_at IS NOT NULL
      AND failure_code IS NULL AND evidence_ref IS NOT NULL AND result IS NOT NULL)
    OR (state = 'failed' AND claim_owner IS NULL AND claim_fence > 0
      AND lease_expires_at IS NULL AND retryable = TRUE AND next_eligible_at IS NOT NULL
      AND failure_code IS NOT NULL
      AND (result IS NULL OR evidence_ref IS NOT NULL))
    OR (state = 'succeeded' AND claim_owner IS NULL AND claim_fence > 0
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND retryable IS NULL AND failure_code IS NULL AND evidence_ref IS NOT NULL AND result IS NOT NULL)
    OR (state = 'exhausted' AND claim_owner IS NULL AND claim_fence > 0
      AND lease_expires_at IS NULL AND next_eligible_at IS NULL
      AND retryable = FALSE AND failure_code IS NOT NULL
      AND (result IS NULL OR evidence_ref IS NOT NULL))
  );

DROP INDEX media_processing_attempts_claim_idx;
CREATE INDEX media_processing_attempts_claim_idx
  ON media_processing_attempts (state, next_eligible_at, lease_expires_at, attempt_id)
  WHERE state IN ('pending', 'running', 'retry_wait', 'poll_wait');

CREATE OR REPLACE FUNCTION guard_media_processing_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.submission_id, NEW.community_id, NEW.actor_user_id,
      NEW.operation_id, NEW.audio_revision, NEW.analysis_revision, NEW.stage,
      NEW.attempt_number, NEW.input_hash, NEW.provider_idempotency_key, NEW.input_kind,
      NEW.input_revision, NEW.policy_revision, NEW.adapter_revision, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.attempt_id, OLD.submission_id, OLD.community_id, OLD.actor_user_id,
      OLD.operation_id, OLD.audio_revision, OLD.analysis_revision, OLD.stage,
      OLD.attempt_number, OLD.input_hash, OLD.provider_idempotency_key, OLD.input_kind,
      OLD.input_revision, OLD.policy_revision, OLD.adapter_revision, OLD.created_at) THEN
    RAISE EXCEPTION 'media processing attempt identity is immutable';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'media processing attempt timestamp must advance';
  END IF;
  IF NEW.state = 'retry_wait' AND NEW.attempt_number >= 3 THEN
    RAISE EXCEPTION 'media processing attempt retry bound is exhausted';
  END IF;
  IF OLD.state IN ('retry_wait', 'poll_wait') AND
      (OLD.next_eligible_at IS NULL OR OLD.next_eligible_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'media processing attempt retry is not yet eligible';
  END IF;
  IF OLD.state IN ('pending', 'retry_wait', 'poll_wait') AND
      (NEW.state <> 'running' OR NEW.claim_fence <> OLD.claim_fence + 1
       OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'media processing attempt claim is not allowed';
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'running' AND
      (OLD.lease_expires_at > clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence + 1
       OR NEW.claim_owner IS NULL OR NEW.lease_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'media processing attempt reclaim is not allowed';
  END IF;
  IF OLD.state = 'running' AND NEW.state IN ('succeeded', 'retry_wait', 'poll_wait', 'failed', 'exhausted') AND
      (OLD.lease_expires_at <= clock_timestamp() OR NEW.claim_fence <> OLD.claim_fence
       OR NEW.claim_owner IS NOT NULL) THEN
    RAISE EXCEPTION 'media processing attempt completion is not allowed';
  END IF;
  IF OLD.state NOT IN ('pending', 'retry_wait', 'poll_wait', 'running') THEN
    RAISE EXCEPTION 'media processing attempt is terminal';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE media_analysis_evidence
  DROP CONSTRAINT media_analysis_evidence_speech_status_check,
  ADD CONSTRAINT media_analysis_evidence_speech_status_check
    CHECK (speech_status IN ('ready', 'not_applicable', 'unavailable')),
  ALTER COLUMN explicitness DROP NOT NULL,
  DROP CONSTRAINT media_analysis_evidence_explicitness_check,
  ADD CONSTRAINT media_analysis_evidence_explicitness_check
    CHECK (explicitness IS NULL OR explicitness IN ('not_explicit', 'explicit', 'uncertain')),
  ALTER COLUMN speech_evidence_ref DROP NOT NULL,
  ALTER COLUMN speech_policy_revision DROP NOT NULL,
  ALTER COLUMN speech_adapter_revision DROP NOT NULL,
  DROP CONSTRAINT media_analysis_evidence_media_safety_check,
  ADD CONSTRAINT media_analysis_evidence_media_safety_check
    CHECK (media_safety IN ('not_applicable', 'allow', 'draft', 'review_required', 'blocked')),
  DROP CONSTRAINT media_analysis_evidence_lyrics_safety_check,
  ADD CONSTRAINT media_analysis_evidence_lyrics_safety_check
    CHECK (lyrics_safety IN ('not_applicable', 'allow', 'review_required', 'blocked')),
  DROP CONSTRAINT media_analysis_speech_shape,
  ADD CONSTRAINT media_analysis_speech_shape CHECK (
    (speech_status = 'ready'
      AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL
      AND transcript_revision IS NULL AND lyrics_revision > 0
      AND material_disagreement = FALSE
      AND explicitness IN ('not_explicit', 'explicit', 'uncertain')
      AND primary_language_bcp47 IS NOT NULL
      AND char_length(primary_language_bcp47) <= 35
      AND primary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
      AND (secondary_language_bcp47 IS NULL OR (
        char_length(secondary_language_bcp47) <= 35
        AND secondary_language_bcp47 ~ '^(?:[a-z]{2,3})(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-[a-z0-9]{5,8}|-[0-9][a-z0-9]{3})*$'
        AND secondary_language_bcp47 IS DISTINCT FROM primary_language_bcp47
      ))
      AND speech_evidence_ref IS NOT NULL
      AND speech_policy_revision IS NOT NULL
      AND speech_adapter_revision IS NOT NULL
      AND lyrics_safety IN ('allow', 'review_required', 'blocked'))
    OR (speech_status = 'not_applicable'
      AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL
      AND transcript_revision IS NULL AND lyrics_revision IS NULL
      AND material_disagreement = FALSE
      AND explicitness IS NULL
      AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL
      AND speech_evidence_ref IS NULL AND speech_policy_revision IS NULL
      AND speech_adapter_revision IS NULL
      AND lyrics_safety = 'not_applicable')
    OR (speech_status = 'unavailable'
      AND transcript_artifact_ref IS NULL AND transcript_sha256 IS NULL
      AND transcript_revision IS NULL AND lyrics_revision > 0
      AND material_disagreement = FALSE
      AND explicitness = 'uncertain'
      AND primary_language_bcp47 IS NULL AND secondary_language_bcp47 IS NULL
      AND speech_evidence_ref IS NOT NULL
      AND speech_policy_revision IS NOT NULL
      AND speech_adapter_revision IS NOT NULL
      AND lyrics_safety = 'review_required')
  );

ALTER TABLE media_publication_projections
  DROP CONSTRAINT media_publication_projections_language_status_check,
  ADD CONSTRAINT media_publication_projections_language_status_check
    CHECK (language_status IN ('ready', 'not_applicable', 'unavailable')),
  DROP CONSTRAINT media_publication_projections_lyrics_explicitness_check,
  ADD CONSTRAINT media_publication_projections_lyrics_explicitness_check
    CHECK (lyrics_explicitness IN (
      'not_explicit', 'explicit', 'not_applicable', 'uncertain', 'unavailable'
    )),
  DROP CONSTRAINT media_publication_projections_alignment_check,
  ADD CONSTRAINT media_publication_projections_alignment_check
    CHECK (alignment IN ('not_applicable', 'pending', 'ready', 'unavailable'));

ALTER TABLE media_song_lyrics_revisions
  DROP CONSTRAINT media_song_lyrics_provenance_shape,
  ADD CONSTRAINT media_song_lyrics_provenance_shape CHECK (
    (base_transcript_revision IS NULL AND provenance IN ('pasted', 'corrected'))
    OR (base_transcript_revision IS NOT NULL AND provenance IN ('asr_accepted', 'corrected'))
  );

-- New lyrics revisions can only be author-pasted or corrections of an earlier
-- author revision. Historical transcript-linked rows remain readable.
CREATE OR REPLACE FUNCTION validate_media_lyrics_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF submission_record.submission_id IS NULL
     OR NEW.author_persona_id IS DISTINCT FROM submission_record.author_persona_id
     OR NEW.lyrics_revision IS DISTINCT FROM submission_record.lyrics_revision + 1
     OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision + 1
     OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision
     OR NEW.base_transcript_revision IS NOT NULL
     OR NEW.provenance NOT IN ('pasted', 'corrected')
     OR NEW.provenance IS DISTINCT FROM
        (CASE WHEN submission_record.current_lyrics_revision IS NULL THEN 'pasted' ELSE 'corrected' END) THEN
    RAISE EXCEPTION 'lyrics revision is not current author input';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER media_analysis_snapshot_guard ON media_analysis_evidence;
CREATE FUNCTION validate_media_analysis_snapshot_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lyrics_analysis JSONB; expected_keys TEXT[];
BEGIN
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot) AS key)
       IS DISTINCT FROM ARRAY['acr','analysisRevision','audioRevision','boundReference',
         'canonicalAudioSha256','embeddedMetadata','finalizedAudioRef','lyricsAnalysis',
         'lyricsSafety','mediaSafety','operationId','probeEvidenceRef','version']::TEXT[] THEN
    RAISE EXCEPTION 'analysis snapshot keys are not exact';
  END IF;
  lyrics_analysis := NEW.analysis_snapshot->'lyricsAnalysis';
  IF jsonb_typeof(lyrics_analysis) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lyrics analysis snapshot is not an object';
  END IF;
  expected_keys := CASE NEW.speech_status
    WHEN 'ready' THEN ARRAY['adapterRevision','evidenceRef','explicitness','policyRevision',
      'primaryLanguageBcp47','secondaryLanguageBcp47','status']::TEXT[]
    WHEN 'unavailable' THEN ARRAY['adapterRevision','evidenceRef','explicitness',
      'policyRevision','status']::TEXT[]
    ELSE ARRAY['status']::TEXT[]
  END;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lyrics_analysis) AS key)
       IS DISTINCT FROM expected_keys
     OR lyrics_analysis->>'status' IS DISTINCT FROM NEW.speech_status
     OR NEW.analysis_snapshot->>'version' IS DISTINCT FROM NEW.analysis_version
     OR NEW.analysis_snapshot->>'operationId' IS DISTINCT FROM NEW.operation_id
     OR (NEW.analysis_snapshot->>'analysisRevision')::numeric IS DISTINCT FROM NEW.analysis_revision
     OR (NEW.analysis_snapshot->>'audioRevision')::numeric IS DISTINCT FROM NEW.audio_revision
     OR NEW.analysis_snapshot->>'canonicalAudioSha256' IS DISTINCT FROM NEW.canonical_audio_sha256
     OR NEW.analysis_snapshot->>'finalizedAudioRef' IS DISTINCT FROM NEW.finalized_audio_ref
     OR NEW.analysis_snapshot->>'probeEvidenceRef' IS DISTINCT FROM NEW.probe_evidence_ref
     OR NEW.analysis_snapshot->>'lyricsSafety' IS DISTINCT FROM NEW.lyrics_safety
     OR NEW.analysis_snapshot->>'mediaSafety' IS DISTINCT FROM NEW.media_safety
     OR lyrics_analysis->>'explicitness' IS DISTINCT FROM NEW.explicitness
     OR lyrics_analysis->>'primaryLanguageBcp47' IS DISTINCT FROM NEW.primary_language_bcp47
     OR lyrics_analysis->>'secondaryLanguageBcp47' IS DISTINCT FROM NEW.secondary_language_bcp47
     OR lyrics_analysis->>'evidenceRef' IS DISTINCT FROM NEW.speech_evidence_ref
     OR lyrics_analysis->>'policyRevision' IS DISTINCT FROM NEW.speech_policy_revision
     OR lyrics_analysis->>'adapterRevision' IS DISTINCT FROM NEW.speech_adapter_revision
     OR NEW.analysis_snapshot->'embeddedMetadata'->>'evidenceRef'
          IS DISTINCT FROM NEW.embedded_metadata_evidence_ref
     OR NEW.analysis_snapshot->'embeddedMetadata'->>'adapterRevision'
          IS DISTINCT FROM NEW.embedded_metadata_adapter_revision
     OR NEW.analysis_snapshot->'embeddedMetadata'->>'trackTitle' IS DISTINCT FROM NEW.embedded_title
     OR NEW.analysis_snapshot->'embeddedMetadata'->'cover' IS DISTINCT FROM NEW.cover_facts
     OR NEW.analysis_snapshot->'acr'->>'decision' IS DISTINCT FROM NEW.acr_decision
     OR NEW.analysis_snapshot->'acr'->>'evidenceRef' IS DISTINCT FROM NEW.acr_evidence_ref
     OR NEW.analysis_snapshot->'acr'->>'policyRevision' IS DISTINCT FROM NEW.acr_policy_revision
     OR NEW.analysis_snapshot->'acr'->>'adapterRevision' IS DISTINCT FROM NEW.acr_adapter_revision THEN
    RAISE EXCEPTION 'analysis snapshot scalars do not match columns';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_analysis_snapshot_guard BEFORE INSERT ON media_analysis_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_media_analysis_snapshot_v2();

CREATE OR REPLACE FUNCTION validate_media_lyrics_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
        publication_record media_publication_projections%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  IF TG_TABLE_NAME = 'media_analysis_evidence' THEN
    IF (NEW.speech_status IN ('ready','unavailable')
          AND NEW.lyrics_revision IS DISTINCT FROM submission_record.current_lyrics_revision)
       OR (NEW.speech_status = 'not_applicable'
          AND submission_record.current_lyrics_revision IS NOT NULL)
       OR (NEW.speech_status = 'not_applicable' AND NEW.lyrics_safety <> 'not_applicable')
       OR (NEW.speech_status = 'unavailable' AND NEW.lyrics_safety <> 'review_required') THEN
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
          )))
       OR (NEW.language_status = 'not_applicable' AND (
          NEW.lyrics_status <> 'no_lyrics' OR NEW.lyrics_revision IS NOT NULL
          OR NEW.lyrics_text IS NOT NULL OR NEW.alignment <> 'not_applicable'))
       OR NEW.language_status = 'unavailable' THEN
      RAISE EXCEPTION 'published lyrics projection is not exact';
    END IF;
  ELSIF TG_TABLE_NAME = 'media_alignment_projections' THEN
    SELECT * INTO publication_record FROM media_publication_projections
      WHERE submission_id=NEW.submission_id AND post_id=NEW.post_id FOR SHARE;
    IF publication_record.submission_id IS NULL
       OR publication_record.lyrics_status <> 'ready'
       OR NEW.lyrics_revision IS DISTINCT FROM publication_record.lyrics_revision THEN
      RAISE EXCEPTION 'alignment lyrics revision is not the published revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER media_publication_projection_insert_guard ON media_publication_projections;
CREATE FUNCTION validate_media_publication_projection_insert_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission_record media_post_submissions%ROWTYPE;
        post_record posts%ROWTYPE;
        audio_record media_audio_revisions%ROWTYPE;
        analysis_record media_analysis_evidence%ROWTYPE;
        decision_record media_publication_decisions%ROWTYPE;
BEGIN
  SELECT * INTO submission_record FROM media_post_submissions
    WHERE community_id=NEW.community_id AND actor_user_id=NEW.actor_user_id
      AND submission_id=NEW.submission_id AND operation_id=NEW.operation_id FOR SHARE;
  SELECT * INTO post_record FROM posts
    WHERE community_id=NEW.community_id AND post_id=NEW.post_id FOR SHARE;
  SELECT * INTO audio_record FROM media_audio_revisions
    WHERE submission_id=NEW.submission_id AND audio_revision=NEW.audio_revision FOR SHARE;
  SELECT * INTO analysis_record FROM media_analysis_evidence
    WHERE submission_id=NEW.submission_id AND analysis_revision=NEW.analysis_revision FOR SHARE;
  SELECT * INTO decision_record FROM media_publication_decisions
    WHERE submission_id=NEW.submission_id AND decision_revision=NEW.decision_revision FOR SHARE;
  IF submission_record.status <> 'published'
     OR submission_record.post_id IS DISTINCT FROM NEW.post_id
     OR post_record.author_user_id IS DISTINCT FROM NEW.actor_user_id
     OR post_record.post_type <> 'song' OR post_record.status <> 'published'
     OR post_record.visibility <> 'public' OR post_record.title IS DISTINCT FROM NEW.title
     OR NEW.creation_revision IS DISTINCT FROM submission_record.creation_revision
     OR NEW.audio_revision IS DISTINCT FROM submission_record.audio_revision
     OR NEW.analysis_revision IS DISTINCT FROM submission_record.analysis_revision
     OR NEW.decision_revision IS DISTINCT FROM submission_record.decision_revision
     OR decision_record.outcome <> 'allow'
     OR NEW.canonical_audio_sha256 IS DISTINCT FROM audio_record.canonical_sha256
     OR NEW.audio_asset_ref IS DISTINCT FROM audio_record.immutable_ref
     OR NEW.cover_artifact_ref IS DISTINCT FROM
        (CASE WHEN analysis_record.cover_status='ready' THEN analysis_record.cover_artifact_ref ELSE NULL END)
     OR NEW.language_status IS DISTINCT FROM analysis_record.speech_status
     OR NEW.primary_language_bcp47 IS DISTINCT FROM analysis_record.primary_language_bcp47
     OR NEW.secondary_language_bcp47 IS DISTINCT FROM analysis_record.secondary_language_bcp47
     OR NEW.lyrics_explicitness IS DISTINCT FROM
        (CASE WHEN analysis_record.speech_status='not_applicable'
          THEN 'not_applicable' ELSE analysis_record.explicitness END)
     OR NEW.alignment IS DISTINCT FROM
        (CASE WHEN submission_record.current_lyrics_revision IS NULL
          THEN 'not_applicable' ELSE 'pending' END)
     OR NEW.analysis_badges IS DISTINCT FROM
        (CASE WHEN submission_record.bound_reference_asset_id IS NULL
          THEN '[]'::jsonb ELSE '["reference_bound"]'::jsonb END) THEN
    RAISE EXCEPTION 'media publication projection is not owned by its operation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER media_publication_projection_insert_guard
  BEFORE INSERT ON media_publication_projections FOR EACH ROW
  EXECUTE FUNCTION validate_media_publication_projection_insert_v2();

CREATE OR REPLACE FUNCTION validate_media_publication_lyrics_pair() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR (NEW.current_lyrics_revision IS NULL AND (
       EXISTS (SELECT 1 FROM media_alignment_projections alignment
         WHERE alignment.submission_id=NEW.submission_id)
       OR EXISTS (SELECT 1 FROM media_submission_outbox outbox
         WHERE outbox.submission_id=NEW.submission_id AND outbox.event_type='alignment')
     ))
     OR (NEW.current_lyrics_revision IS NOT NULL AND (
       NOT EXISTS (
         SELECT 1 FROM media_alignment_projections alignment
         WHERE alignment.submission_id=NEW.submission_id
           AND alignment.post_id=NEW.post_id
           AND alignment.audio_revision=NEW.audio_revision
           AND alignment.analysis_revision=NEW.analysis_revision
           AND alignment.lyrics_revision=NEW.current_lyrics_revision
           AND alignment.status='pending'
       )
       OR NOT EXISTS (
         SELECT 1 FROM media_submission_outbox outbox
         WHERE outbox.submission_id=NEW.submission_id
           AND outbox.event_type='alignment'
           AND outbox.workflow_revision=NEW.workflow_revision
           AND outbox.lyrics_revision=NEW.current_lyrics_revision
       )
     )) THEN
    RAISE EXCEPTION 'publication commit is missing its exact projection or optional alignment';
  END IF;
  RETURN NEW;
END;
$$;

-- Retain the established state transition function and amend only its
-- publication predicate for the new closed statuses.
DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_media_submission_update()'::regprocedure) INTO definition;
  patched := replace(definition,
    'analysis_record.media_safety <> ''allow''',
    'analysis_record.media_safety NOT IN (''allow'', ''not_applicable'')');
  patched := replace(patched,
    'OR (OLD.status = ''processing'' AND OLD.phase = ''analysis'' AND NEW.status = ''manual_review'' AND NEW.phase IS NULL
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision',
    'OR (OLD.status = ''processing'' AND (OLD.phase = ''analysis'' OR (OLD.phase = ''decision'' AND NEW.review_reason_code = ''moderation_unavailable'' AND NEW.review_exhaustion_code IS NULL AND NEW.review_exhaustion_attempt_id IS NULL)) AND NEW.status = ''manual_review'' AND NEW.phase IS NULL
      AND NEW.decision_revision = 0 AND NEW.current_decision_revision IS NULL AND NEW.creation_revision = OLD.creation_revision AND NEW.audio_revision = OLD.audio_revision');
  patched := replace(patched,
    'analysis_record.lyrics_safety NOT IN (''skipped'', ''allow'')',
    'analysis_record.lyrics_safety NOT IN (''not_applicable'', ''allow'')');
  patched := replace(patched,
    'analysis_record.explicitness NOT IN (''not_explicit'', ''explicit'', ''no_lyrics'')',
    'COALESCE(analysis_record.explicitness, ''not_applicable'') NOT IN (''not_explicit'', ''explicit'', ''not_applicable'')');
  patched := replace(patched,
    'AND NEW.analysis_revision = OLD.analysis_revision AND NEW.review_ref IS NOT NULL AND NEW.review_exhaustion_code = ''acr_exhausted'' AND NEW.review_exhaustion_attempt_id IS NOT NULL
      AND NEW.held_revision = OLD.creation_revision AND NEW.post_id IS NULL)',
    'AND NEW.analysis_revision = OLD.analysis_revision AND NEW.review_ref IS NOT NULL
      AND ((NEW.review_reason_code = ''review_required'' AND NEW.review_exhaustion_code = ''acr_exhausted'' AND NEW.review_exhaustion_attempt_id IS NOT NULL)
        OR (NEW.review_reason_code = ''moderation_unavailable'' AND NEW.review_exhaustion_code IS NULL AND NEW.review_exhaustion_attempt_id IS NULL))
      AND NEW.held_revision = OLD.creation_revision AND NEW.post_id IS NULL)');
  patched := replace(patched,
    'ELSIF OLD.status = ''processing'' AND OLD.phase = ''analysis'' AND NEW.status = ''manual_review'' AND NEW.decision_revision = 0 AND NEW.review_exhaustion_code = ''acr_exhausted'' THEN',
    'ELSIF OLD.status = ''processing'' AND OLD.phase IN (''analysis'', ''decision'') AND NEW.status = ''manual_review'' AND NEW.decision_revision = 0 AND NEW.review_reason_code = ''moderation_unavailable'' AND NEW.review_exhaustion_code IS NULL THEN
    IF NEW.creation_revision IS DISTINCT FROM OLD.creation_revision
       OR NEW.audio_revision IS DISTINCT FROM OLD.audio_revision
       OR NEW.analysis_revision IS DISTINCT FROM OLD.analysis_revision
       OR NEW.current_immutable_ref IS DISTINCT FROM OLD.current_immutable_ref
       OR NEW.current_analysis_revision IS DISTINCT FROM OLD.current_analysis_revision
       OR NEW.current_terms_revision IS DISTINCT FROM OLD.current_terms_revision
       OR NEW.current_decision_revision IS NOT NULL
       OR ROW(NEW.bound_reference_asset_id,NEW.bound_reference_evidence_ref,NEW.bound_reference_audio_revision,NEW.bound_reference_analysis_revision,NEW.bound_reference_audio_sha256,NEW.bound_reference_upstream_share_bps) IS DISTINCT FROM ROW(OLD.bound_reference_asset_id,OLD.bound_reference_evidence_ref,OLD.bound_reference_audio_revision,OLD.bound_reference_analysis_revision,OLD.bound_reference_audio_sha256,OLD.bound_reference_upstream_share_bps)
       OR NEW.workflow_revision IS DISTINCT FROM OLD.workflow_revision
       OR NEW.retry_count IS DISTINCT FROM OLD.retry_count
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_retry_count IS DISTINCT FROM OLD.failure_retry_count
       OR NEW.retryable IS DISTINCT FROM OLD.retryable
       OR NEW.last_safe_phase IS DISTINCT FROM OLD.last_safe_phase
       OR NEW.abandonment_reason IS DISTINCT FROM OLD.abandonment_reason
       OR NEW.retention_disposition IS DISTINCT FROM OLD.retention_disposition
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.review_ref IS NULL
       OR NEW.review_exhaustion_attempt_id IS NOT NULL
       OR NEW.held_revision IS DISTINCT FROM OLD.creation_revision
       OR NEW.action_kind IS NOT NULL
       OR NEW.action_reference_request_ref IS NOT NULL
       OR NEW.action_expires_at IS NOT NULL
       OR NEW.moderator_action_id IS NOT NULL
       OR NEW.moderator_actor_id IS NOT NULL
       OR NEW.moderator_evidence_ref IS NOT NULL
       OR NEW.moderator_approval_kind IS NOT NULL
       OR NEW.moderator_reason_code IS NOT NULL THEN
      RAISE EXCEPTION ''provider-unavailable review evidence is not exact'';
    END IF;
  ELSIF OLD.status = ''processing'' AND OLD.phase = ''analysis'' AND NEW.status = ''manual_review'' AND NEW.decision_revision = 0 AND NEW.review_exhaustion_code = ''acr_exhausted'' THEN');
  patched := replace(patched,
    'a.stage=''acr''',
    'a.stage IN (''acr_primary'',''acr_alternate'')');
  patched := replace(patched,
    'later.stage=''acr''',
    'later.stage=a.stage');
  IF patched IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION '0056 could not patch the publication predicate';
  END IF;
  EXECUTE patched;
END;
$migration$;

DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef('validate_media_submission_event_pair()'::regprocedure)
    INTO definition;
  patched := replace(definition,
    'ELSIF OLD.status = ''processing'' AND OLD.phase = ''analysis'' AND NEW.review_exhaustion_code = ''acr_exhausted'' THEN expected_event := ''review_exhaustion_recorded'';',
    'ELSIF OLD.status = ''processing'' AND OLD.phase IN (''analysis'', ''decision'') AND NEW.status = ''manual_review'' AND NEW.review_reason_code = ''moderation_unavailable'' THEN expected_event := ''provider_unavailable_review_recorded'';
  ELSIF OLD.status = ''processing'' AND OLD.phase = ''analysis'' AND NEW.review_exhaustion_code = ''acr_exhausted'' THEN expected_event := ''review_exhaustion_recorded'';');
  IF patched IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION '0056 could not patch the provider-unavailable review event';
  END IF;
  EXECUTE patched;
END;
$migration$;
