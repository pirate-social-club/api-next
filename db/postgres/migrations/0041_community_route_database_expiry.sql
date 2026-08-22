-- Provider-independent database-time expiry for canonical route authority.
-- This transition deliberately does not reuse provider completion attempts:
-- no provider observation occurs when the database clock expires evidence.

CREATE TABLE community_route_lifecycle_transitions (
  route_lifecycle_transition_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  transition_kind TEXT NOT NULL,
  community_id TEXT NOT NULL,
  route_binding_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  family TEXT NOT NULL,
  root_label TEXT NOT NULL,
  root_label_display TEXT NOT NULL,
  path_segment TEXT NOT NULL,
  expected_binding_generation BIGINT NOT NULL,
  resulting_binding_generation BIGINT NOT NULL,
  expected_verified_evidence_ref TEXT NOT NULL,
  observed_evidence_expires_at TIMESTAMPTZ NOT NULL,
  ownership_status TEXT NOT NULL,
  route_lifecycle_status TEXT NOT NULL,
  transitioned_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT community_route_lifecycle_transition_identity_check CHECK (
    btrim(route_lifecycle_transition_id) <> ''
    AND route_lifecycle_transition_id = btrim(route_lifecycle_transition_id)
    AND octet_length(route_lifecycle_transition_id) <= 512
    AND btrim(principal_id) <> ''
    AND principal_id = btrim(principal_id)
    AND octet_length(principal_id) <= 256
  ),
  CONSTRAINT community_route_lifecycle_transition_kind_check CHECK (
    version = 'pirate-community-route-lifecycle-transition-v1'
    AND transition_kind = 'database_time_expired'
    AND principal_kind = 'system'
    AND ownership_status = 'expired'
    AND route_lifecycle_status = 'suspended'
  ),
  CONSTRAINT community_route_lifecycle_transition_generation_check CHECK (
    expected_binding_generation > 0
    AND resulting_binding_generation = expected_binding_generation + 1
  ),
  CONSTRAINT community_route_lifecycle_transition_route_check CHECK (
    is_community_route_root_label(family, root_label) IS TRUE
    AND is_community_route_root_label_display(root_label_display) IS TRUE
    AND path_segment = CASE family
      WHEN 'hns' THEN 'app.' || root_label
      WHEN 'spaces' THEN '@' || root_label
      ELSE NULL
    END
  ),
  CONSTRAINT community_route_lifecycle_transition_time_check CHECK (
    observed_evidence_expires_at <= transitioned_at
  ),
  CONSTRAINT community_route_lifecycle_transition_generation_unique UNIQUE (
    route_binding_id,
    expected_binding_generation
  ),
  CONSTRAINT community_route_lifecycle_transition_binding_fk FOREIGN KEY (
    community_id,
    route_binding_id
  ) REFERENCES community_canonical_route_bindings (
    community_id,
    route_binding_id
  ),
  CONSTRAINT community_route_lifecycle_transition_evidence_fk FOREIGN KEY (
    expected_verified_evidence_ref
  ) REFERENCES community_route_ownership_evidence (evidence_ref)
);

CREATE INDEX community_route_lifecycle_transitions_time_idx
  ON community_route_lifecycle_transitions (
    transitioned_at,
    route_binding_id,
    expected_binding_generation
  );

CREATE INDEX community_route_ownership_evidence_expiry_idx
  ON community_route_ownership_evidence (expires_at, evidence_ref)
  WHERE expires_at IS NOT NULL;

CREATE FUNCTION validate_community_route_lifecycle_transition_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  binding_record community_canonical_route_bindings%ROWTYPE;
  evidence_record community_route_ownership_evidence%ROWTYPE;
BEGIN
  IF NEW.transitioned_at > clock_timestamp() THEN
    RAISE EXCEPTION 'route lifecycle transition time is in the future';
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id;
  IF NOT FOUND
    OR community_record.status <> 'active'
    OR community_record.canonical_route_binding_id <> NEW.route_binding_id THEN
    RAISE EXCEPTION 'route lifecycle transition community authority mismatch';
  END IF;

  SELECT * INTO binding_record
    FROM community_canonical_route_bindings
   WHERE community_id = NEW.community_id
     AND route_binding_id = NEW.route_binding_id;
  IF NOT FOUND
    OR binding_record.family <> NEW.family
    OR binding_record.root_label <> NEW.root_label
    OR binding_record.root_label_display <> NEW.root_label_display
    OR binding_record.path_segment <> NEW.path_segment
    OR binding_record.binding_generation <> NEW.resulting_binding_generation
    OR binding_record.verified_evidence_ref IS NOT NULL
    OR binding_record.ownership_status <> NEW.ownership_status
    OR binding_record.route_lifecycle_status <> NEW.route_lifecycle_status
    OR binding_record.updated_at <> NEW.transitioned_at THEN
    RAISE EXCEPTION 'route lifecycle transition resulting binding mismatch';
  END IF;

  SELECT * INTO evidence_record
    FROM community_route_ownership_evidence
   WHERE evidence_ref = NEW.expected_verified_evidence_ref;
  IF NOT FOUND
    OR evidence_record.family <> NEW.family
    OR evidence_record.root_label <> NEW.root_label
    OR evidence_record.root_label_display <> NEW.root_label_display
    OR evidence_record.path_segment <> NEW.path_segment
    OR evidence_record.binding_generation <> NEW.expected_binding_generation
    OR evidence_record.expires_at IS NULL
    OR evidence_record.expires_at <> NEW.observed_evidence_expires_at
    OR evidence_record.expires_at > NEW.transitioned_at THEN
    RAISE EXCEPTION 'route lifecycle transition evidence authority mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_community_route_lifecycle_transition_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'community route lifecycle transitions are append-only';
END;
$$;

CREATE TRIGGER community_route_lifecycle_transition_insert_guard
BEFORE INSERT ON community_route_lifecycle_transitions
FOR EACH ROW EXECUTE FUNCTION validate_community_route_lifecycle_transition_insert();

CREATE TRIGGER community_route_lifecycle_transition_append_only
BEFORE UPDATE OR DELETE ON community_route_lifecycle_transitions
FOR EACH ROW EXECUTE FUNCTION reject_community_route_lifecycle_transition_change();
