-- Alignment terminal alerts reserve one bounded page per tick, independently
-- of the media recovery sweep. The identifier stores the two-part keyset as
-- JSON; last_updated_at is unused because this scan orders by stable identity.
INSERT INTO recovery_inspection_cursors (cursor_key,last_updated_at,last_identifier) VALUES
  ('media-alignment-alerts','epoch','{"operation_id":"","workflow_instance_id":""}');
