-- Optional creation images have an independent, revocable lifecycle.
CREATE TABLE avatar_assets (
  asset_id TEXT PRIMARY KEY CHECK (asset_id ~ '^avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  owner_account_id TEXT NOT NULL REFERENCES users(user_id),
  purpose TEXT NOT NULL CHECK (purpose IN ('community', 'persona')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','ready','attached','deleting','removed')),
  intent_id TEXT,
  ingress_key TEXT NOT NULL UNIQUE,
  sealed_key TEXT NOT NULL UNIQUE,
  digest TEXT,
  width INTEGER,
  height INTEGER,
  normalized_bytes INTEGER,
  attached_target_id TEXT,
  moderation_status TEXT NOT NULL DEFAULT 'unscanned' CHECK (moderation_status IN ('unscanned','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  upload_expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  next_cleanup_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_account_id, idempotency_key),
  FOREIGN KEY (owner_account_id,intent_id) REFERENCES community_creation_intents(actor_id,intent_id),
  CHECK (state NOT IN ('ready','attached') OR COALESCE(digest ~ '^[0-9a-f]{64}$' AND width BETWEEN 1 AND 512 AND height BETWEEN 1 AND 512 AND normalized_bytes BETWEEN 1 AND 5242880,false)),
  CHECK (state <> 'attached' OR (intent_id IS NOT NULL AND attached_target_id IS NOT NULL))
);
CREATE INDEX avatar_assets_cleanup ON avatar_assets(next_cleanup_at) WHERE state <> 'removed';
CREATE INDEX avatar_assets_owner_created ON avatar_assets(owner_account_id, created_at);
CREATE INDEX avatar_assets_unscanned ON avatar_assets(created_at, asset_id) WHERE moderation_status='unscanned';
ALTER TABLE communities ADD COLUMN avatar_ref TEXT CHECK (avatar_ref IS NULL OR avatar_ref ~ '^/api/avatars/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE community_creation_intents ADD COLUMN avatar_outcomes JSONB;

ALTER TABLE community_creation_intents
  DROP CONSTRAINT community_creation_intents_optional_route_v2_draft_shape;

ALTER TABLE community_creation_intents
  ADD CONSTRAINT community_creation_intents_optional_route_v2_draft_shape CHECK (
    creation_contract_version <> 'optional_route_v2'
    OR (
      jsonb_typeof(draft) = 'object'
      AND draft ? 'persona'
      AND draft ? 'name'
      AND draft ? 'description'
      AND draft ? 'policy'
      AND (draft - 'persona' - 'name' - 'description' - 'policy' - 'public_name' - 'community_avatar_ref' - 'persona_avatar_ref') = '{}'
      AND jsonb_typeof(draft -> 'persona') = 'object'
      AND jsonb_typeof(draft -> 'persona' -> 'kind') = 'string'
      AND draft -> 'persona' ->> 'kind' IN ('existing', 'create_new')
      AND (
        (
          draft -> 'persona' ->> 'kind' = 'existing'
          AND ((draft -> 'persona') - 'kind' - 'persona_id') = '{}'
          AND jsonb_typeof(draft -> 'persona' -> 'persona_id') = 'string'
          AND btrim(draft -> 'persona' ->> 'persona_id') <> ''
        )
        OR (
          draft -> 'persona' ->> 'kind' = 'create_new'
          AND ((draft -> 'persona') - 'kind') = '{}'
        )
      )
      AND jsonb_typeof(draft -> 'name') = 'string'
      AND btrim(draft ->> 'name') <> ''
      AND jsonb_typeof(draft -> 'description') IN ('string', 'null')
      AND jsonb_typeof(draft -> 'policy') = 'object'
      AND (NOT (draft ? 'public_name') OR (
        jsonb_typeof(draft -> 'public_name') = 'string'
        AND length(draft ->> 'public_name') BETWEEN 1 AND 80
        AND btrim(draft ->> 'public_name') <> ''
      ))
      AND (NOT (draft ? 'community_avatar_ref') OR COALESCE(jsonb_typeof(draft->'community_avatar_ref')='string' AND (draft->>'community_avatar_ref') ~ '^avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false))
      AND (NOT (draft ? 'persona_avatar_ref') OR COALESCE(jsonb_typeof(draft->'persona_avatar_ref')='string' AND (draft->>'persona_avatar_ref') ~ '^avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false))
      AND NOT (draft ? 'slug')
      AND NOT (draft ? 'route_request')
    )
  );


ALTER TABLE community_creation_intents ADD CONSTRAINT creation_avatar_outcomes_shape CHECK (
 avatar_outcomes IS NULL OR COALESCE(
   creation_contract_version='optional_route_v2' AND status='committed'
   AND jsonb_typeof(avatar_outcomes)='object'
   AND avatar_outcomes ?& ARRAY['community','persona']
   AND avatar_outcomes - 'community' - 'persona' = '{}'
   AND avatar_outcomes->>'community' IN ('not_requested','attached','omitted_unavailable')
   AND avatar_outcomes->>'persona' IN ('not_requested','attached','omitted_unavailable','preserved_existing'),false)
);
CREATE FUNCTION guard_creation_avatar_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='committed' AND NEW.avatar_outcomes IS DISTINCT FROM OLD.avatar_outcomes THEN
    RAISE EXCEPTION 'committed avatar outcomes are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER creation_avatar_outcomes_guard BEFORE UPDATE ON community_creation_intents
FOR EACH ROW EXECUTE FUNCTION guard_creation_avatar_outcomes();
