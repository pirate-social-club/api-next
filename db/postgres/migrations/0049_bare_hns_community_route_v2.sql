-- Separate the public HNS community path from the retained v1 authority key.
--
-- Existing path_segment and href columns remain immutable authority evidence:
-- HNS continues to retain app.<root> and /c/app.<root> there. Public routing
-- uses the separately generated v2 columns below.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM community_canonical_route_bindings
     WHERE family = 'hns'
       AND (
         root_label = 'pirate'
         OR root_label ~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
  ) THEN
    RAISE EXCEPTION 'reserved HNS root requires explicit historical disposition before route-v2';
  END IF;
END;
$$;

ALTER TABLE community_canonical_route_bindings
  ADD COLUMN public_path_segment_v2 TEXT GENERATED ALWAYS AS (
    CASE family
      WHEN 'hns' THEN root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  ADD COLUMN public_href_v2 TEXT GENERATED ALWAYS AS (
    '/c/' || CASE family
      WHEN 'hns' THEN root_label
      WHEN 'spaces' THEN '@' || root_label
    END
  ) STORED,
  ADD CONSTRAINT community_canonical_route_bindings_public_v2_eligibility CHECK (
    family <> 'hns'
    OR (
      root_label <> 'pirate'
      AND root_label !~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  ),
  ADD CONSTRAINT community_canonical_route_bindings_public_path_v2_unique
    UNIQUE (public_path_segment_v2);

CREATE FUNCTION effective_public_community_route_v2(
  expected_community_id TEXT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE(
  community_id TEXT,
  route_binding_id TEXT,
  family TEXT,
  root_label TEXT,
  root_label_display TEXT,
  authority_route_key_v1 TEXT,
  public_path_segment TEXT,
  public_href TEXT,
  route_authority_kind TEXT,
  authority_reference TEXT,
  authority_generation BIGINT,
  verified_evidence_ref TEXT,
  binding_generation BIGINT,
  evidence_expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT route.community_id,
         route.route_binding_id,
         route.family,
         route.root_label,
         route.root_label_display,
         route.path_segment,
         binding.public_path_segment_v2,
         binding.public_href_v2,
         route.route_authority_kind,
         route.authority_reference,
         route.authority_generation,
         route.verified_evidence_ref,
         route.binding_generation,
         route.evidence_expires_at
    FROM effective_route_authority_v2(expected_community_id, database_now) AS route
    JOIN community_canonical_route_bindings AS binding
      ON binding.route_binding_id = route.route_binding_id
     AND binding.community_id = route.community_id
     AND binding.family = route.family
     AND binding.root_label = route.root_label
     AND binding.path_segment = route.path_segment
   WHERE route.family <> 'hns'
      OR (
        route.root_label <> 'pirate'
        AND route.root_label !~ '^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
$$;

COMMENT ON COLUMN community_canonical_route_bindings.path_segment IS
  'Immutable authority_route_key_v1; HNS retains app.<root> and must not expose this as the v2 public path.';

COMMENT ON COLUMN community_canonical_route_bindings.public_path_segment_v2 IS
  'Server-derived public route segment: bare HNS root or @-prefixed Spaces root.';

COMMENT ON FUNCTION effective_public_community_route_v2(TEXT, TIMESTAMPTZ) IS
  'Current effective route authority projected onto canonical community route v2 without rewriting retained v1 evidence bytes.';
