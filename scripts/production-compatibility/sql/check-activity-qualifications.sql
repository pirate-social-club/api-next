-- activity_qualifications: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,'numeric'::text AS grading_mode,NULL::text AS dance_review_id,NULL::text AS categorical_verdict,NULL::text AS calibration_id,NULL::integer AS numeric_floor_bps FROM api_next.activity_qualifications original)
SELECT 'activity_qualifications' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0282:activity_qualification_attempt_shape',count(*) FILTER(WHERE (
  (activity_key='study' AND study_session_id IS NOT NULL AND karaoke_session_id IS NULL AND karaoke_attempt_id IS NULL AND dance_review_id IS NULL) OR
  (activity_key='karaoke' AND study_session_id IS NULL AND karaoke_session_id IS NOT NULL AND karaoke_attempt_id IS NOT NULL AND dance_review_id IS NULL) OR
  (activity_key='dance' AND study_session_id IS NULL AND karaoke_session_id IS NULL AND karaoke_attempt_id IS NULL AND dance_review_id IS NOT NULL)) IS FALSE),
 '0282:activity_qualification_grading_family',count(*) FILTER(WHERE ((
  (grading_mode='numeric' AND activity_key IN('study','karaoke') AND score_bps IS NOT NULL AND categorical_verdict IS NULL AND dance_review_id IS NULL) OR
  (grading_mode='moderator_verdict' AND activity_key='dance' AND score_bps IS NULL AND categorical_verdict='passed'
    AND calibration_id IS NULL AND numeric_floor_bps IS NULL AND dance_review_id IS NOT NULL)
 ) IS TRUE) IS FALSE)
 ) AS check_false_counts
FROM projected;
