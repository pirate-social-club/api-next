-- Scope canonical policy identities by community and complete immutable creation bindings.

ALTER TABLE communities
  ADD COLUMN description TEXT;

ALTER TABLE communities
  ADD CONSTRAINT communities_route_slug_length_check
  CHECK (route_slug IS NULL OR char_length(route_slug) <= 256);

ALTER TABLE policy_versions
  DROP CONSTRAINT policy_versions_pkey;

ALTER TABLE policy_versions
  DROP CONSTRAINT policy_versions_community_version_unique;

ALTER TABLE policy_versions
  ADD CONSTRAINT policy_versions_pkey PRIMARY KEY (community_id, policy_version_id);

ALTER TABLE community_policy_provider_bindings
  DROP CONSTRAINT community_policy_provider_bindings_pkey;

ALTER TABLE community_policy_provider_bindings
  ADD CONSTRAINT community_policy_provider_bindings_pkey
  PRIMARY KEY (community_id, policy_key, policy_version_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM community_policy_provider_bindings) THEN
    RAISE EXCEPTION
      'community policy provider bindings require an explicit complete-binding backfill';
  END IF;
END;
$$;

ALTER TABLE community_policy_provider_bindings
  ADD COLUMN issuer TEXT NOT NULL,
  ADD COLUMN scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('none', 'issuer_rp_scope', 'issuer_rp_action_scope')),
  ADD COLUMN issuer_rp_scope TEXT,
  ADD COLUMN issuer_rp_action_scope TEXT,
  ADD COLUMN request_mode TEXT NOT NULL
    CHECK (request_mode IN ('curated', 'dynamic')),
  ADD COLUMN evaluator_id TEXT NOT NULL,
  ADD CONSTRAINT community_policy_provider_bindings_resolution_not_blank CHECK (
    btrim(issuer) <> ''
    AND issuer = btrim(issuer)
    AND btrim(evaluator_id) <> ''
    AND evaluator_id = btrim(evaluator_id)
    AND (
      issuer_rp_scope IS NULL
      OR (btrim(issuer_rp_scope) <> '' AND issuer_rp_scope = btrim(issuer_rp_scope))
    )
    AND (
      issuer_rp_action_scope IS NULL
      OR (
        btrim(issuer_rp_action_scope) <> ''
        AND issuer_rp_action_scope = btrim(issuer_rp_action_scope)
      )
    )
  ),
  ADD CONSTRAINT community_policy_provider_bindings_scope_shape CHECK (
    (scope_kind = 'none' AND issuer_rp_scope IS NULL AND issuer_rp_action_scope IS NULL)
    OR (
      scope_kind = 'issuer_rp_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NULL
    )
    OR (
      scope_kind = 'issuer_rp_action_scope'
      AND issuer_rp_scope IS NOT NULL
      AND issuer_rp_action_scope IS NOT NULL
    )
  ),
  ADD CONSTRAINT community_policy_provider_bindings_request_shape CHECK (
    (request_mode = 'curated' AND provider_configuration_kind = 'managed')
    OR (request_mode = 'dynamic' AND provider_configuration_kind = 'dynamic')
  );
