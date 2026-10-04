-- Fresh ownership proof may refresh an existing active capability without
-- granting the scheduler seller authority. Owner revisions retain their grant check.
CREATE FUNCTION hns_proof_backed_sale_refresh_v1(
  candidate community_handle_sale_namespace_activation_revisions,
  prior community_handle_sale_namespace_activation_revisions
) RETURNS boolean LANGUAGE sql AS $$
  SELECT candidate.family = 'hns'
    AND candidate.status = 'active' AND prior.status = 'active'
    AND candidate.sale_namespace_activation_id = prior.sale_namespace_activation_id
    AND candidate.sale_namespace_activation_generation = prior.sale_namespace_activation_generation + 1
    AND candidate.community_id = prior.community_id
    AND candidate.canonical_root = prior.canonical_root
    AND candidate.actor_account_id = prior.actor_account_id
    AND candidate.authority_grant_id = prior.authority_grant_id
    AND candidate.namespace_authority_kind = 'verified_namespace_v1'
    AND prior.namespace_authority_kind = 'verified_namespace_v1'
    AND candidate.namespace_authority_generation > prior.namespace_authority_generation
    AND candidate.dns_zone_activation_id = prior.dns_zone_activation_id
    AND candidate.dns_zone_activation_generation = prior.dns_zone_activation_generation
    AND EXISTS (
      SELECT 1 FROM communities c
      JOIN community_canonical_route_bindings b
        ON b.route_binding_id = c.canonical_route_binding_id AND b.community_id = c.community_id
      JOIN community_route_ownership_evidence e ON e.evidence_ref = b.verified_evidence_ref
      WHERE c.community_id = candidate.community_id AND c.status = 'active'
        AND b.family = 'hns' AND b.root_label = candidate.canonical_root
        AND b.ownership_status = 'verified' AND b.route_lifecycle_status = 'active'
        AND b.verified_evidence_ref = candidate.namespace_authority_reference
        AND b.binding_generation = candidate.namespace_authority_generation
        AND e.expires_at > clock_timestamp()
        AND (
          (e.origin = 'active_lease_renewal' AND EXISTS (
            SELECT 1 FROM community_route_active_lease_renewal_evidence_snapshots s
            JOIN community_route_active_lease_renewals r USING(active_lease_renewal_id)
            WHERE s.evidence_ref = e.evidence_ref AND s.community_id = c.community_id
              AND s.route_binding_id = b.route_binding_id AND s.binding_generation = b.binding_generation
              AND s.expected_binding_generation = prior.namespace_authority_generation
              AND s.expected_verified_evidence_ref = prior.namespace_authority_reference
              AND r.status = 'completed'
          )) OR
          (e.origin = 'route_revalidation' AND EXISTS (
            SELECT 1 FROM community_route_revalidation_evidence_snapshots s
            JOIN community_route_revalidation_sessions r USING(route_revalidation_id,revalidation_session_id)
            WHERE s.evidence_ref = e.evidence_ref AND s.community_id = c.community_id
              AND s.route_binding_id = b.route_binding_id AND s.binding_generation = b.binding_generation
              AND s.expected_binding_generation >= prior.namespace_authority_generation
              AND r.operation_mode = 'same_root_recovery' AND r.status = 'completed'
          ))
        )
    );
$$;

CREATE OR REPLACE FUNCTION validate_community_handle_sale_namespace_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  community_record communities%ROWTYPE;
  authority_grant community_handle_sales_authority_grants%ROWTYPE;
  dependency RECORD;
  prior community_handle_sale_namespace_activation_revisions%ROWTYPE;
BEGIN
  IF NEW.family = 'spaces' THEN
    PERFORM assert_spaces_sale_namespace_revision_insert_v1(NEW);
    RETURN NEW;
  END IF;

  SELECT * INTO community_record
    FROM communities
   WHERE community_id = NEW.community_id
   FOR SHARE;
  SELECT * INTO authority_grant
    FROM community_handle_sales_authority_grants
   WHERE grant_id = NEW.authority_grant_id
   FOR SHARE;
  IF community_record.community_id IS NULL OR community_record.status <> 'active' THEN
    RAISE EXCEPTION 'handle sale namespace requires an active community';
  END IF;
  SELECT * INTO prior
    FROM community_handle_sale_namespace_activation_revisions AS revision
   WHERE revision.sale_namespace_activation_id = NEW.sale_namespace_activation_id
   ORDER BY revision.sale_namespace_activation_generation DESC
   LIMIT 1
   FOR SHARE;
  IF (authority_grant.grant_id IS NULL
    OR authority_grant.community_id <> NEW.community_id
    OR authority_grant.principal_account_id <> NEW.actor_account_id
    OR authority_grant.authority <> 'manage_handle_sales'
    OR authority_grant.status <> 'active')
    AND hns_proof_backed_sale_refresh_v1(NEW, prior) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'handle sale namespace requires active manage_handle_sales authority';
  END IF;

  IF prior.sale_namespace_activation_id IS NULL THEN
    IF NEW.sale_namespace_activation_generation <> 1 THEN
      RAISE EXCEPTION 'handle sale namespace must begin at generation one';
    END IF;
  ELSE
    IF NEW.sale_namespace_activation_generation
         <> prior.sale_namespace_activation_generation + 1
      OR NEW.community_id <> prior.community_id
      OR NEW.family <> prior.family
      OR NEW.canonical_root <> prior.canonical_root
      OR NEW.display_root <> prior.display_root
      OR NEW.created_at <> prior.created_at THEN
      RAISE EXCEPTION 'handle sale namespace identity and generation are immutable';
    END IF;
    IF prior.status = 'revoked' THEN
      RAISE EXCEPTION 'revoked handle sale namespace is terminal';
    END IF;
    IF NEW.status = 'pending' THEN
      RAISE EXCEPTION 'handle sale namespace revision must advance state';
    END IF;
    IF NEW.status = prior.status THEN
      IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'handle sale namespace revision must advance state';
      END IF;
      IF NEW.activated_at <> prior.activated_at THEN
        RAISE EXCEPTION 'active handle sale namespace refresh must preserve activation time';
      END IF;
      IF NEW.namespace_authority_reference = prior.namespace_authority_reference
        AND NEW.namespace_authority_generation = prior.namespace_authority_generation
        AND NEW.dns_zone_activation_id = prior.dns_zone_activation_id
        AND NEW.dns_zone_activation_generation = prior.dns_zone_activation_generation THEN
        RAISE EXCEPTION 'active handle sale namespace refresh must advance authority';
      END IF;
      IF NEW.namespace_authority_reference = prior.namespace_authority_reference
        AND NEW.namespace_authority_generation < prior.namespace_authority_generation THEN
        RAISE EXCEPTION 'active handle sale namespace namespace authority cannot regress';
      END IF;
      IF NEW.dns_zone_activation_id = prior.dns_zone_activation_id
        AND NEW.dns_zone_activation_generation < prior.dns_zone_activation_generation THEN
        RAISE EXCEPTION 'active handle sale namespace DNS authority cannot regress';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'active' THEN
    SELECT * INTO dependency
      FROM current_hns_sale_namespace_dependency_v1(
        NEW.community_id,
        NEW.namespace_authority_reference,
        NEW.namespace_authority_generation,
        NEW.dns_zone_activation_id,
        NEW.dns_zone_activation_generation,
        clock_timestamp()
      );
    IF dependency.canonical_root IS NULL
      OR dependency.canonical_root <> NEW.canonical_root
      OR dependency.display_root <> NEW.display_root
      OR dependency.namespace_authority_current IS DISTINCT FROM TRUE
      OR dependency.dns_zone_current IS DISTINCT FROM TRUE
      OR dependency.dns_delegation_current IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'handle sale namespace requires current verified HNS and DNS delegation authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
