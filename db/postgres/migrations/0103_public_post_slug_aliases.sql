-- Immutable, globally unique logical aliases for Spec 022 public post routes.
-- Visibility, rating, moderation, and lifecycle state remain live Post facts.

CREATE OR REPLACE FUNCTION post_slug_utf16_code_units(value TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    SUM(CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END),
    0
  )::INTEGER
  FROM regexp_split_to_table(value, '') AS characters(character);
$$;

CREATE TABLE post_slug_aliases (
  slug TEXT PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE,
  slug_policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT post_slug_aliases_post_fk
    FOREIGN KEY (post_id) REFERENCES posts (post_id),
  CONSTRAINT post_slug_aliases_policy_check
    CHECK (slug_policy_version = 'post-slug-v1'),
  CONSTRAINT post_slug_aliases_slug_check
    CHECK (
      slug <> ''
      AND slug = btrim(slug)
      AND post_slug_utf16_code_units(slug) BETWEEN 1 AND 80
      AND octet_length(slug) <= 320
      AND slug !~ '[[:space:][:cntrl:]]'
      AND strpos(slug, '%') = 0
      AND strpos(slug, '/') = 0
      AND strpos(slug, E'\\') = 0
      AND slug NOT IN ('.', '..')
    )
);

CREATE INDEX post_slug_aliases_sitemap_order_idx
  ON post_slug_aliases (created_at, post_id);

CREATE OR REPLACE FUNCTION reject_post_slug_alias_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'post slug aliases are immutable';
END;
$$;

CREATE TRIGGER post_slug_aliases_immutable
  BEFORE UPDATE OR DELETE ON post_slug_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_post_slug_alias_mutation();
