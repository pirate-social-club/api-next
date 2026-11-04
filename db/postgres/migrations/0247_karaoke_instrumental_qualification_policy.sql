-- Only new sessions and newly frozen reward legs use the instrumental policy.
-- Applying this transition requires the coordinated instrumental producer release.
DO $$
BEGIN
  PERFORM 1
    FROM activity_registry registry
    JOIN qualification_policy_versions policy
      ON policy.qualification_policy_version_id = registry.current_policy_version_id
     AND policy.activity_key = registry.activity_key
   WHERE registry.activity_key = 'karaoke'
     AND registry.status = 'active'
     AND registry.producer_version = 'karaoke_postgres_v2'
     AND registry.current_policy_version_id = 'karaoke_qualification_v2@1'
     AND policy.policy_kind = 'karaoke_qualification_v2'
     AND policy.policy_document = '{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000,"eligible_playback_kinds":["full_mix"]}'::jsonb
   FOR UPDATE OF registry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Karaoke instrumental policy requires the exact active v2@1 predecessor';
  END IF;

  INSERT INTO qualification_policy_versions (
    qualification_policy_version_id, activity_key, policy_kind, policy_document
  ) VALUES (
    'karaoke_qualification_v2@2', 'karaoke', 'karaoke_qualification_v2',
    '{"minimum_scored_line_count":5,"minimum_coverage_bps":8500,"minimum_final_score_bps":7000,"eligible_playback_kinds":["instrumental"]}'::jsonb
  );

  UPDATE activity_registry
     SET current_policy_version_id = 'karaoke_qualification_v2@2',
         updated_at = clock_timestamp()
   WHERE activity_key = 'karaoke';
END
$$;
