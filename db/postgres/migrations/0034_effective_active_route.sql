-- Freeze the single database-time canonical-route predicate used by public
-- resolution and every route-sensitive privileged write.

CREATE OR REPLACE FUNCTION effective_active_route(
  expected_community_id TEXT,
  database_now TIMESTAMPTZ
)
RETURNS TABLE (
  community_id TEXT,
  route_binding_id TEXT,
  family TEXT,
  root_label TEXT,
  root_label_display TEXT,
  path_segment TEXT,
  href TEXT,
  verified_evidence_ref TEXT,
  binding_generation BIGINT,
  evidence_expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT community.community_id,
         binding.route_binding_id,
         binding.family,
         binding.root_label,
         binding.root_label_display,
         binding.path_segment,
         binding.href,
         binding.verified_evidence_ref,
         binding.binding_generation,
         evidence.expires_at
    FROM communities AS community
    JOIN community_canonical_route_bindings AS binding
      ON community.canonical_route_binding_id = binding.route_binding_id
     AND community.community_id = binding.community_id
    JOIN community_route_ownership_evidence AS evidence
      ON evidence.evidence_ref = binding.verified_evidence_ref
   WHERE (expected_community_id IS NULL OR community.community_id = expected_community_id)
     AND database_now IS NOT NULL
     AND community.status = 'active'
     AND binding.route_lifecycle_status = 'active'
     AND binding.ownership_status = 'verified'
     AND binding.verified_evidence_ref IS NOT NULL
     AND evidence.family = binding.family
     AND evidence.root_label = binding.root_label
     AND evidence.root_label_display = binding.root_label_display
     AND evidence.path_segment = binding.path_segment
     AND evidence.binding_generation = binding.binding_generation
     AND evidence.expires_at IS NOT NULL
     AND evidence.expires_at > database_now
$$;

COMMENT ON FUNCTION effective_active_route(TEXT, TIMESTAMPTZ) IS
  'The spec-012 database-time predicate for canonical public resolution and route-sensitive privileged effects. NULL community id enumerates effective routes for exact path lookup.';
