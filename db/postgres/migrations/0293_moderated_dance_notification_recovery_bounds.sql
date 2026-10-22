-- Both fact families retain the global oldest-first fifty-locator batch.
-- Each indexed branch contributes at most fifty candidates; delivered Dance
-- history is excluded by the partial index rather than revisited every run.
CREATE INDEX dance_result_outstanding_order_v1_idx
  ON dance_moderated_result_events_v1(occurred_at,event_id)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION pending_recipient_notifications_v2()
RETURNS TABLE(outbox_event_id TEXT) LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT pending.event_id FROM (
  (SELECT fact.outbox_event_id AS event_id,fact.created_at FROM content_publication_outbox fact
   WHERE fact.event_type='comment_notification' AND NOT fact.inbox_delivery_recorded
   ORDER BY fact.created_at,fact.outbox_event_id LIMIT 50)
  UNION ALL
  (SELECT result.event_id,result.occurred_at FROM dance_moderated_result_events_v1 result
   WHERE result.delivered_at IS NULL
   ORDER BY result.occurred_at,result.event_id LIMIT 50)
 ) pending ORDER BY pending.created_at,pending.event_id LIMIT 50
$$;

-- CREATE OR REPLACE retains existing purpose grants. Bind the same exact
-- trusted-schema execution context without exposing private tables to callers.
DO $path$
BEGIN
 EXECUTE format('ALTER FUNCTION %s SET search_path TO %I,pg_catalog,pg_temp',
   'pending_recipient_notifications_v2()'::regprocedure,current_schema());
END $path$;
