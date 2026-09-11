-- Fair recovery scans resume after the last inspected candidate instead of
-- restarting from the oldest row every tick. Each subsystem keeps one cursor
-- ordered by its own candidate keyset; a tick that finds no rows past the
-- cursor wraps to the beginning, so waiting, ceiling-reached and failed-lookup
-- candidates cannot starve later rows.

CREATE TABLE recovery_inspection_cursors (
  cursor_key TEXT PRIMARY KEY CHECK (btrim(cursor_key) <> ''),
  last_updated_at TIMESTAMPTZ NOT NULL,
  last_identifier TEXT NOT NULL CHECK (btrim(last_identifier) <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
