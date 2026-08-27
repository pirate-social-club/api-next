-- General-audience song covers. OpenAI-cleared normalized artwork may enter the
-- public projection; every other cover is retained as restricted evidence and
-- omitted without blocking the song.

ALTER TABLE media_analysis_evidence
  ADD COLUMN cover_moderation_decision TEXT,
  ADD COLUMN cover_moderation_reason TEXT,
  ADD COLUMN cover_moderation_provider_id TEXT,
  ADD COLUMN cover_moderation_requested_model TEXT,
  ADD COLUMN cover_moderation_returned_model TEXT,
  ADD COLUMN cover_moderation_input_sha256 TEXT,
  ADD COLUMN cover_moderation_matched_categories JSONB,
  ADD COLUMN cover_moderation_evidence_ref TEXT,
  ADD COLUMN cover_moderation_evidence JSONB;

UPDATE media_analysis_evidence
   SET cover_moderation_decision = CASE
         WHEN cover_status = 'absent' THEN 'not_applicable'
         ELSE 'withheld'
       END,
       cover_moderation_reason = CASE
         WHEN cover_status = 'absent' THEN 'not_embedded'
         WHEN cover_status = 'rejected' THEN
           CASE WHEN cover_facts->>'reasonCode' = 'limits_exceeded'
             THEN 'limits_exceeded' ELSE 'invalid_image' END
         ELSE 'provider_unavailable'
       END,
       cover_moderation_input_sha256 = cover_artifact_sha256,
       cover_moderation_matched_categories = '[]'::jsonb,
       cover_moderation_evidence_ref = embedded_metadata_evidence_ref;

ALTER TABLE media_analysis_evidence
  ALTER COLUMN cover_moderation_decision SET NOT NULL,
  ALTER COLUMN cover_moderation_reason SET NOT NULL,
  ALTER COLUMN cover_moderation_matched_categories SET NOT NULL,
  ADD CONSTRAINT media_analysis_cover_moderation_decision_check CHECK (
    cover_moderation_decision IN ('not_applicable', 'allow', 'withheld')
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_reason_check CHECK (
    cover_moderation_reason IN (
      'not_embedded', 'clean', 'matched_category', 'provider_unavailable',
      'invalid_image', 'limits_exceeded'
    )
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_provider_check CHECK (
    cover_moderation_provider_id IS NULL OR cover_moderation_provider_id = 'openai'
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_model_check CHECK (
    (cover_moderation_provider_id IS NULL
      AND cover_moderation_requested_model IS NULL
      AND cover_moderation_returned_model IS NULL)
    OR (cover_moderation_provider_id = 'openai'
      AND cover_moderation_requested_model = 'omni-moderation-2024-09-26'
      AND (cover_moderation_returned_model IS NULL
        OR cover_moderation_returned_model = cover_moderation_requested_model))
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_hash_check CHECK (
    cover_moderation_input_sha256 IS NULL
    OR cover_moderation_input_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_categories_check CHECK (
    jsonb_typeof(cover_moderation_matched_categories) = 'array'
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_evidence_check CHECK (
    cover_moderation_evidence IS NULL
    OR jsonb_typeof(cover_moderation_evidence) = 'object'
  ),
  ADD CONSTRAINT media_analysis_cover_moderation_shape CHECK (
    (cover_moderation_decision = 'not_applicable'
      AND cover_moderation_reason = 'not_embedded'
      AND cover_status = 'absent')
    OR (cover_moderation_decision = 'allow'
      AND cover_moderation_reason = 'clean'
      AND cover_status = 'ready'
      AND media_safety = 'allow'
      AND cover_moderation_provider_id = 'openai'
      AND cover_moderation_returned_model = cover_moderation_requested_model
      AND cover_moderation_input_sha256 = cover_artifact_sha256
      AND cover_moderation_matched_categories = '[]'::jsonb
      AND cover_moderation_evidence_ref IS NOT NULL
      AND cover_moderation_evidence IS NOT NULL)
    OR (cover_moderation_decision = 'withheld'
      AND cover_status <> 'absent')
  );

ALTER TABLE media_analysis_evidence
  DROP CONSTRAINT media_analysis_evidence_media_safety_check,
  ADD CONSTRAINT media_analysis_evidence_media_safety_check CHECK (
    media_safety IN (
      'not_applicable', 'allow', 'cover_withheld',
      'visual_provider_unavailable', 'draft', 'review_required', 'blocked'
    )
  );

DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'validate_media_analysis_snapshot_v2()'::regprocedure
  ) INTO definition;
  patched := replace(
    definition,
    '''canonicalAudioSha256'',''embeddedMetadata''',
    '''canonicalAudioSha256'',''coverModeration'',''embeddedMetadata'''
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'analysis snapshot key seam was not found';
  END IF;
  definition := patched;
  patched := replace(
    definition,
    'OR NEW.analysis_snapshot->''embeddedMetadata''->>''evidenceRef''',
    'OR NEW.analysis_snapshot->''coverModeration''->>''decision'' IS DISTINCT FROM NEW.cover_moderation_decision
     OR NEW.analysis_snapshot->''coverModeration''->>''reason'' IS DISTINCT FROM NEW.cover_moderation_reason
     OR NEW.analysis_snapshot->''coverModeration''->>''providerId'' IS DISTINCT FROM NEW.cover_moderation_provider_id
     OR NEW.analysis_snapshot->''coverModeration''->>''requestedModel'' IS DISTINCT FROM NEW.cover_moderation_requested_model
     OR NEW.analysis_snapshot->''coverModeration''->>''returnedModel'' IS DISTINCT FROM NEW.cover_moderation_returned_model
     OR NEW.analysis_snapshot->''coverModeration''->>''inputSha256'' IS DISTINCT FROM NEW.cover_moderation_input_sha256
     OR NEW.analysis_snapshot->''coverModeration''->''matchedCategories'' IS DISTINCT FROM NEW.cover_moderation_matched_categories
     OR NEW.analysis_snapshot->''coverModeration''->>''evidenceRef'' IS DISTINCT FROM NEW.cover_moderation_evidence_ref
     OR NEW.analysis_snapshot->''coverModeration''->''evidence'' IS DISTINCT FROM COALESCE(NEW.cover_moderation_evidence, ''null''::jsonb)
     OR NEW.analysis_snapshot->''embeddedMetadata''->>''evidenceRef'''
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'analysis snapshot cover-moderation scalar seam was not found';
  END IF;
  EXECUTE patched;
END;
$migration$;

DO $migration$
DECLARE definition TEXT; patched TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_media_submission_update()'::regprocedure) INTO definition;
  patched := replace(
    definition,
    'analysis_record.media_safety NOT IN (''allow'', ''not_applicable'', ''visual_provider_unavailable'')',
    'analysis_record.media_safety NOT IN (''allow'', ''not_applicable'', ''cover_withheld'', ''visual_provider_unavailable'')'
  );
  patched := replace(
    patched,
    'analysis_record.media_safety NOT IN (''allow'', ''visual_provider_unavailable'')',
    'analysis_record.media_safety NOT IN (''allow'', ''cover_withheld'', ''visual_provider_unavailable'')'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'guard_media_submission_update media-safety predicate was not found';
  END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef('validate_media_snapshot_insert()'::regprocedure) INTO definition;
  patched := replace(
    definition,
    'ARRAY[''acr'',''analysisRevision'',''audioRevision'',''boundReference'',''canonicalAudioSha256'',''embeddedMetadata'',''finalizedAudioRef'',''lyricsSafety'',''mediaSafety'',''operationId'',''probeEvidenceRef'',''speechLyrics'',''version'']::TEXT[]',
    'ARRAY[''acr'',''analysisRevision'',''audioRevision'',''boundReference'',''canonicalAudioSha256'',''coverModeration'',''embeddedMetadata'',''finalizedAudioRef'',''lyricsSafety'',''mediaSafety'',''operationId'',''probeEvidenceRef'',''speechLyrics'',''version'']::TEXT[]'
  );
  patched := replace(
    patched,
    'OR jsonb_typeof(NEW.analysis_snapshot->''embeddedMetadata'') IS DISTINCT FROM ''object''',
    'OR jsonb_typeof(NEW.analysis_snapshot->''coverModeration'') IS DISTINCT FROM ''object''
       OR jsonb_typeof(NEW.analysis_snapshot->''embeddedMetadata'') IS DISTINCT FROM ''object'''
  );
  patched := replace(
    patched,
    'OR NEW.analysis_snapshot->>''mediaSafety'' IS DISTINCT FROM NEW.media_safety THEN',
    'OR NEW.analysis_snapshot->>''mediaSafety'' IS DISTINCT FROM NEW.media_safety
       OR NEW.analysis_snapshot->''coverModeration''->>''decision'' IS DISTINCT FROM NEW.cover_moderation_decision
       OR NEW.analysis_snapshot->''coverModeration''->>''reason'' IS DISTINCT FROM NEW.cover_moderation_reason
       OR NEW.analysis_snapshot->''coverModeration''->>''providerId'' IS DISTINCT FROM NEW.cover_moderation_provider_id
       OR NEW.analysis_snapshot->''coverModeration''->>''requestedModel'' IS DISTINCT FROM NEW.cover_moderation_requested_model
       OR NEW.analysis_snapshot->''coverModeration''->>''returnedModel'' IS DISTINCT FROM NEW.cover_moderation_returned_model
       OR NEW.analysis_snapshot->''coverModeration''->>''inputSha256'' IS DISTINCT FROM NEW.cover_moderation_input_sha256
       OR NEW.analysis_snapshot->''coverModeration''->''matchedCategories'' IS DISTINCT FROM NEW.cover_moderation_matched_categories
       OR NEW.analysis_snapshot->''coverModeration''->>''evidenceRef'' IS DISTINCT FROM NEW.cover_moderation_evidence_ref
       OR NEW.analysis_snapshot->''coverModeration''->''evidence'' IS DISTINCT FROM COALESCE(NEW.cover_moderation_evidence, ''null''::jsonb) THEN'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'validate_media_snapshot_insert cover-moderation seam was not found';
  END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef(
    'validate_media_publication_projection_insert_v2()'::regprocedure
  ) INTO definition;
  patched := replace(
    definition,
    '(CASE WHEN analysis_record.cover_status=''ready'' AND analysis_record.media_safety=''allow'' THEN analysis_record.cover_artifact_ref ELSE NULL END)',
    '(CASE WHEN analysis_record.cover_status=''ready'' AND analysis_record.media_safety=''allow'' AND analysis_record.cover_moderation_decision=''allow'' THEN analysis_record.cover_artifact_ref ELSE NULL END)'
  );
  IF patched = definition THEN
    RAISE EXCEPTION 'publication projection cover-moderation predicate was not found';
  END IF;
  EXECUTE patched;
END;
$migration$;
