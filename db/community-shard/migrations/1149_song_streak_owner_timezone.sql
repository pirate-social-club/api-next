ALTER TABLE song_streaks ADD COLUMN timezone TEXT;
ALTER TABLE song_streaks ADD COLUMN timezone_updated_at TEXT;
ALTER TABLE song_streaks ADD COLUMN active_until_at TEXT;

-- Backfill: legacy rows have no pinned owner timezone, so their grace window is
-- computed against UTC (the previous fallback clock). active_until_at is the UTC
-- instant of midnight starting (last_qualified_date + 2 days): a streak is alive
-- while now < active_until_at (today + yesterday grace in the owner's timezone).
UPDATE song_streaks
SET active_until_at = replace(datetime(last_qualified_date, '+2 days'), ' ', 'T') || '.000Z'
WHERE active_until_at IS NULL;

CREATE INDEX idx_song_streaks_active ON song_streaks(post_id, active_until_at);
