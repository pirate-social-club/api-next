-- Persist only the current canonical community route slug. Historical aliases
-- and display-name-derived backfills are intentionally outside this migration.

ALTER TABLE communities
  ADD COLUMN route_slug TEXT;

ALTER TABLE communities
  ADD CONSTRAINT communities_route_slug_format_check
  CHECK (
    route_slug IS NULL
    OR route_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
  );

CREATE UNIQUE INDEX communities_route_slug_uidx
  ON communities (route_slug)
  WHERE route_slug IS NOT NULL;
