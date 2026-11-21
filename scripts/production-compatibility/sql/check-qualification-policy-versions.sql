-- qualification_policy_versions: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.* FROM api_next.qualification_policy_versions original)
SELECT 'qualification_policy_versions' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0282:qualification_policy_kind_shape',count(*) FILTER(WHERE (
  (activity_key='study' AND policy_kind='study_session_first_pass_v2') OR
  (activity_key='karaoke' AND policy_kind IN('karaoke_qualification_v1','karaoke_qualification_v2')) OR
  (activity_key='dance' AND policy_kind='dance_owner_verdict_v1')) IS FALSE),
 '0282:qualification_policy_document_shape',count(*) FILTER(WHERE ((
  (policy_kind='study_session_first_pass_v2' AND policy_document='{"required_correct_bps":7000}'::JSONB) OR
  (policy_kind='karaoke_qualification_v1' AND policy_document='{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000}'::JSONB) OR
  (policy_kind='karaoke_qualification_v2' AND policy_document-'eligible_playback_kinds'='{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000}'::JSONB
    AND policy_document->'eligible_playback_kinds' IN('["full_mix"]'::JSONB,'["instrumental"]'::JSONB,'["full_mix","instrumental"]'::JSONB,'["instrumental","full_mix"]'::JSONB)) OR
  (policy_kind='dance_owner_verdict_v1' AND policy_document->>'grading_mode'='moderator_verdict'
    AND policy_document->>'verdict'='passed' AND jsonb_typeof(policy_document->'score_bps')='null'
    AND jsonb_typeof(policy_document->'calibration')='null' AND jsonb_typeof(policy_document->'numeric_floor_bps')='null'
    AND policy_document->>'policy_hash' ~ '^[a-f0-9]{64}$'
    AND is_dance_identifier(policy_document->>'producer_id'))
 ) IS TRUE) IS FALSE)
 ) AS check_false_counts
FROM projected;
