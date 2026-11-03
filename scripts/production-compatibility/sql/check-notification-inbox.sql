-- notification_inbox: exact intermediate named ADD CHECK expressions, not only final333.
WITH projected AS (SELECT original.*,NULL::text AS dance_result_event_id FROM api_next.notification_inbox original)
SELECT 'notification_inbox' AS table_name,count(*) AS inspected_rows,
 jsonb_build_object(
 '0283:notification_exact_source_v2',count(*) FILTER(WHERE ((source_event_id IS NULL) <> (dance_result_event_id IS NULL)) IS FALSE)
 ) AS check_false_counts
FROM projected;
