-- media_upload_reservations: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,'upload'::text AS input_source,NULL::text AS input_authority_id FROM api_next.media_upload_reservations original)
SELECT 'media_upload_reservations' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0302:media_upload_reservations_media_shape',count(*) FILTER(WHERE (
 (input_source='upload' AND input_authority_id IS NULL AND (
  (media_kind='song' AND video_intent IS NULL AND ingest_policy_revision IS NULL
   AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL AND multipart_part_count IS NULL
   AND multipart_manifest IS NULL AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
   AND upload_url IS NOT NULL AND btrim(upload_url)<>'')
  OR (media_kind='video' AND video_intent IN('original_audio','song_reference') AND ingest_policy_revision>0
   AND multipart_upload_id IS NOT NULL AND btrim(multipart_upload_id)<>'' AND multipart_part_size_bytes>0
   AND multipart_part_count>0 AND (multipart_manifest IS NULL OR jsonb_typeof(multipart_manifest)='array')
   AND NOT(multipart_completed_at IS NOT NULL AND multipart_aborted_at IS NOT NULL)
   AND upload_url IS NULL AND upload_headers='[]'::jsonb)))
 OR (input_source='dance_handoff' AND input_authority_id IS NOT NULL
  AND media_kind='video' AND video_intent='song_reference' AND ingest_policy_revision=1
  AND expected_content_type='video/mp4' AND expected_sha256 IS NOT NULL
  AND multipart_upload_id IS NULL AND multipart_part_size_bytes IS NULL AND multipart_part_count IS NULL
  AND multipart_manifest IS NULL AND multipart_completed_at IS NULL AND multipart_aborted_at IS NULL
  AND upload_url IS NULL AND upload_headers='[]'::jsonb)
) IS FALSE)
 ) AS check_false_counts
FROM projected;
