-- Persist the ratings-era moderation result inside the closed trusted-analysis
-- snapshot. The runtime has supplied this object since 0066, while the exact
-- snapshot validator still accepted only the pre-rating key set.

CREATE OR REPLACE FUNCTION validate_media_analysis_snapshot_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lyrics_analysis JSONB;
  content_moderation JSONB;
  provider_evidence JSONB;
  expected_keys TEXT[];
BEGIN
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.analysis_snapshot) AS key)
       IS DISTINCT FROM ARRAY['acr','analysisRevision','audioRevision','boundReference',
         'canonicalAudioSha256','contentModeration','coverModeration','embeddedMetadata',
         'finalizedAudioRef','lyricsAnalysis','lyricsSafety','mediaSafety','operationId',
         'probeEvidenceRef','version']::TEXT[] THEN
    RAISE EXCEPTION 'analysis snapshot keys are not exact';
  END IF;

  lyrics_analysis := NEW.analysis_snapshot->'lyricsAnalysis';
  content_moderation := NEW.analysis_snapshot->'contentModeration';
  provider_evidence := content_moderation->'providerEvidence';
  IF jsonb_typeof(lyrics_analysis) IS DISTINCT FROM 'object'
     OR jsonb_typeof(content_moderation) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'analysis snapshot nested facts are not objects';
  END IF;

  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(content_moderation) AS key)
       IS DISTINCT FROM ARRAY['communityPolicyRevision','decision','evidenceRef','inputSha256',
         'matchedCategories','platformPolicyRevision','policyRevision','providerEvidence',
         'resultingContentRating']::TEXT[]
     OR content_moderation->>'decision' NOT IN ('allow','manual_review','blocked')
     OR content_moderation->>'resultingContentRating' NOT IN ('general','adult_18')
     OR COALESCE(btrim(content_moderation->>'inputSha256'), '') = ''
     OR jsonb_typeof(content_moderation->'matchedCategories') IS DISTINCT FROM 'array'
     OR COALESCE(btrim(content_moderation->>'policyRevision'), '') = ''
     OR COALESCE(btrim(content_moderation->>'platformPolicyRevision'), '') = ''
     OR COALESCE(btrim(content_moderation->>'communityPolicyRevision'), '') = ''
     OR (content_moderation->'evidenceRef' IS DISTINCT FROM 'null'::jsonb
       AND jsonb_typeof(content_moderation->'evidenceRef') IS DISTINCT FROM 'string')
     OR (provider_evidence IS DISTINCT FROM 'null'::jsonb
       AND jsonb_typeof(provider_evidence) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'content moderation snapshot shape is invalid';
  END IF;

  IF provider_evidence IS DISTINCT FROM 'null'::jsonb
     AND ((SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(provider_evidence) AS key)
            IS DISTINCT FROM ARRAY['inputs','providerId','requestedModel','returnedModel']::TEXT[]
       OR provider_evidence->>'providerId' IS DISTINCT FROM 'openai'
       OR COALESCE(btrim(provider_evidence->>'requestedModel'), '') = ''
       OR COALESCE(btrim(provider_evidence->>'returnedModel'), '') = ''
       OR jsonb_typeof(provider_evidence->'inputs') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'content moderation provider evidence shape is invalid';
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
     OR NEW.analysis_snapshot->'coverModeration'->>'decision' IS DISTINCT FROM NEW.cover_moderation_decision
     OR NEW.analysis_snapshot->'coverModeration'->>'reason' IS DISTINCT FROM NEW.cover_moderation_reason
     OR NEW.analysis_snapshot->'coverModeration'->>'providerId' IS DISTINCT FROM NEW.cover_moderation_provider_id
     OR NEW.analysis_snapshot->'coverModeration'->>'requestedModel' IS DISTINCT FROM NEW.cover_moderation_requested_model
     OR NEW.analysis_snapshot->'coverModeration'->>'returnedModel' IS DISTINCT FROM NEW.cover_moderation_returned_model
     OR NEW.analysis_snapshot->'coverModeration'->>'inputSha256' IS DISTINCT FROM NEW.cover_moderation_input_sha256
     OR NEW.analysis_snapshot->'coverModeration'->'matchedCategories' IS DISTINCT FROM NEW.cover_moderation_matched_categories
     OR NEW.analysis_snapshot->'coverModeration'->>'evidenceRef' IS DISTINCT FROM NEW.cover_moderation_evidence_ref
     OR NEW.analysis_snapshot->'coverModeration'->'evidence' IS DISTINCT FROM COALESCE(NEW.cover_moderation_evidence, 'null'::jsonb)
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
