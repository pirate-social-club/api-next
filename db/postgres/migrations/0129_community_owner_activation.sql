-- Keep creation private until its named owner has an active wallet.
-- Public names are display text, not handle or namespace reservations.
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
      AND (draft - 'persona' - 'name' - 'description' - 'policy' - 'public_name') = '{}'
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
      AND NOT (draft ? 'slug')
      AND NOT (draft ? 'route_request')
    )
  );

-- Pending personas are account-private setup, never a public role identity.
CREATE OR REPLACE FUNCTION require_active_role_persona() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT active_owned_persona(NEW.account_id, NEW.persona_id) THEN
    RAISE EXCEPTION 'active owned persona required';
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
    'display_name', profile.display_name,
    'avatar_ref', profile.avatar_ref,
    'primary_public_handle', handle.label_display
  )
    FROM personas AS persona
    LEFT JOIN persona_profiles AS profile ON profile.persona_id = persona.persona_id
    LEFT JOIN LATERAL (
      SELECT candidate.label_display
        FROM public_handle_index AS candidate
       WHERE candidate.owner_persona_id = persona.persona_id
         AND candidate.status = 'active'
       ORDER BY candidate.updated_at DESC, candidate.handle_id
       LIMIT 1
    ) AS handle ON true
   WHERE persona.persona_id = expected_persona_id
     AND persona.status = 'active'
$$;
