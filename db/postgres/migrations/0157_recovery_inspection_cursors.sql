-- Fair recovery scans resume after the last inspected candidate instead of
-- restarting from the oldest row every tick. Each subsystem owns one seeded
-- cursor row, ordered by its own candidate keyset. A tick that finds no rows
-- past the cursor wraps to the beginning, so waiting, ceiling-reached and
-- failed-lookup candidates cannot starve later rows. The seeded rows are
-- locked FOR UPDATE inside each scan transaction, so overlapping runs cannot
-- select the same page or overwrite newer cursor progress.

CREATE TABLE recovery_inspection_cursors (
  cursor_key TEXT PRIMARY KEY CHECK (btrim(cursor_key) <> ''),
  last_updated_at TIMESTAMPTZ NOT NULL,
  last_identifier TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO recovery_inspection_cursors (cursor_key,last_updated_at,last_identifier) VALUES
  ('media','epoch',''),
  ('data','epoch','');
