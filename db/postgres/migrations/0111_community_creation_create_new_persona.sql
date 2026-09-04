-- Community-creation create_new persona mint (spec 014 section 10.2).
--
-- A community-creation intent may ask the server to mint the creator
-- persona at the terminal creation commit instead of selecting an existing
-- one. A browser never invents a persona id, so the minted identifier is
-- server state: this migration adds community_creation_intents.
-- minted_persona_id, populated by the creation commit that minted the
-- persona and projected alongside the draft's explicit choice thereafter.
--
-- A minted persona follows the additional-persona lifecycle from spec 014
-- section 3: it is born pending_wallet with its reserved HD index and
-- private profile draft and becomes an eligible public persona only on
-- wallet confirmation. The creator role presentation is still written
-- atomically with the membership, so public_persona_projection learns to
-- project a pending_wallet persona from its private profile draft. Display
-- fields are null until activation, account linkage is never exposed, and
-- suspended or retired personas still never project.

ALTER TABLE community_creation_intents
  ADD COLUMN minted_persona_id TEXT;

ALTER TABLE community_creation_intents
  ADD CONSTRAINT community_creation_intents_minted_persona_fk
  FOREIGN KEY (minted_persona_id) REFERENCES personas (persona_id);

COMMENT ON COLUMN community_creation_intents.minted_persona_id IS
  'Server-minted creator persona for a create_new creation choice, recorded by the creation commit that minted it (spec 014 section 10.2).';

-- The draft carries the closed persona choice instead of a bare persona_id.
-- An existing choice names one persona; a create_new choice carries only its
-- kind so a browser can never invent a persona id or a binding.
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
      AND (draft - 'persona' - 'name' - 'description' - 'policy') = '{}'
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
      AND NOT (draft ? 'slug')
      AND NOT (draft ? 'route_request')
    )
  );

-- A create_new creation writes the creator role presentation atomically with
-- the membership (spec 014 section 10.2), while the minted persona stays
-- pending_wallet until wallet confirmation. The presentation trigger
-- therefore also accepts the exact minted creator: a pending_wallet persona
-- owned by the presenting account and bound to this very community with the
-- community_creation source. Foreign, unbound, suspended, retired, and
-- persona_creation personas still never present.
CREATE OR REPLACE FUNCTION require_active_role_persona() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT active_owned_persona(NEW.account_id, NEW.persona_id) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM personas AS persona
        JOIN persona_community_bindings AS binding
          ON binding.persona_id = persona.persona_id
         AND binding.account_id = persona.account_id
       WHERE persona.persona_id = NEW.persona_id
         AND persona.account_id = NEW.account_id
         AND persona.status = 'pending_wallet'
         AND binding.community_id = NEW.community_id
         AND binding.binding_source = 'community_creation'
    ) THEN
      RAISE EXCEPTION 'active owned persona required';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public_persona_projection(expected_persona_id text) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'persona_id', persona.persona_id,
    'object', 'persona',
    'display_name', COALESCE(profile.display_name, pending_profile.display_name),
    'avatar_ref', COALESCE(profile.avatar_ref, pending_profile.avatar_ref),
    'primary_public_handle', handle.label_display
  )
    FROM personas AS persona
    LEFT JOIN persona_profiles AS profile ON profile.persona_id = persona.persona_id
    LEFT JOIN persona_pending_profiles AS pending_profile
      ON pending_profile.persona_id = persona.persona_id
    LEFT JOIN LATERAL (
      SELECT candidate.label_display
        FROM public_handle_index AS candidate
       WHERE candidate.owner_persona_id = persona.persona_id
         AND candidate.status = 'active'
       ORDER BY candidate.updated_at DESC, candidate.handle_id
       LIMIT 1
    ) AS handle ON true
   WHERE persona.persona_id = expected_persona_id
     AND persona.status IN ('active', 'pending_wallet')
$$;
