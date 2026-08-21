-- Structural route-v1 authority without inventing ownership for retained legacy rows.
-- Legacy slug communities remain readable compatibility data but never satisfy
-- the canonical-route resolver or new privileged-write predicate.

ALTER TABLE communities
  ADD COLUMN route_authority_version TEXT NOT NULL DEFAULT 'legacy_slug_v1'
    CHECK (route_authority_version IN ('legacy_slug_v1', 'route_v1')),
  ADD CONSTRAINT communities_route_v1_binding_presence CHECK (
    route_authority_version <> 'route_v1'
    OR status <> 'active'
    OR canonical_route_binding_id IS NOT NULL
  );

COMMENT ON COLUMN communities.route_authority_version IS
  'Compatibility fence. route_v1 communities require canonical route authority; legacy_slug_v1 rows are retained without gaining route authority.';

CREATE OR REPLACE FUNCTION guard_community_route_authority_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.route_authority_version IS DISTINCT FROM OLD.route_authority_version THEN
    RAISE EXCEPTION 'community route authority version is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communities_route_authority_version_guard
BEFORE UPDATE OF route_authority_version ON communities
FOR EACH ROW EXECUTE FUNCTION guard_community_route_authority_version();

CREATE OR REPLACE FUNCTION validate_community_canonical_route_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
  community_record communities%ROWTYPE;
  binding_id TEXT;
  guard_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_TABLE_NAME = 'communities' THEN
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
    binding_id := NEW.canonical_route_binding_id;
  ELSE
    binding_id := NEW.route_binding_id;
    SELECT * INTO community_record
      FROM communities
     WHERE community_id = NEW.community_id;
  END IF;

  IF community_record.community_id IS NULL THEN
    RAISE EXCEPTION 'community canonical route owner is missing';
  END IF;

  IF community_record.route_authority_version = 'route_v1'
    AND community_record.status = 'active'
    AND binding_id IS NULL THEN
    RAISE EXCEPTION 'active route-v1 community requires a canonical route binding';
  END IF;

  IF binding_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE route_binding_id = binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community canonical route binding is missing';
  END IF;

  IF community_record.canonical_route_binding_id IS DISTINCT FROM binding_record.route_binding_id
    OR community_record.community_id IS DISTINCT FROM binding_record.community_id THEN
    RAISE EXCEPTION 'community canonical route reference is not reciprocal';
  END IF;

  IF binding_record.route_lifecycle_status = 'active' THEN
    SELECT * INTO evidence_record
      FROM community_route_ownership_evidence
     WHERE evidence_ref = binding_record.verified_evidence_ref;
    IF NOT FOUND
      OR binding_record.ownership_status <> 'verified'
      OR evidence_record.family <> binding_record.family
      OR evidence_record.root_label <> binding_record.root_label
      OR evidence_record.root_label_display <> binding_record.root_label_display
      OR evidence_record.path_segment <> binding_record.path_segment
      OR evidence_record.binding_generation <> binding_record.binding_generation
      OR (
        community_record.route_authority_version = 'route_v1'
        AND (
          evidence_record.verified_at > guard_at
          OR evidence_record.expires_at IS NULL
          OR evidence_record.expires_at <= guard_at
        )
      ) THEN
      RAISE EXCEPTION 'active community route lacks matching verified ownership evidence';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER communities_canonical_route_binding_guard ON communities;

CREATE CONSTRAINT TRIGGER communities_canonical_route_binding_guard
AFTER INSERT OR UPDATE OF status, canonical_route_binding_id, route_authority_version ON communities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_community_canonical_route_reference();

