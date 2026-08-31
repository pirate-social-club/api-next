-- Keep an active sale namespace attached to a newer verified root/DNS authority
-- without suspending issued handles or manufacturing a second namespace identity.

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
  IF authority_grant.grant_id IS NULL
    OR authority_grant.community_id <> NEW.community_id
    OR authority_grant.principal_account_id <> NEW.actor_account_id
    OR authority_grant.authority <> 'manage_handle_sales'
    OR authority_grant.status <> 'active' THEN
    RAISE EXCEPTION 'handle sale namespace requires active manage_handle_sales authority';
  END IF;

  SELECT * INTO prior
    FROM community_handle_sale_namespace_activation_revisions AS revision
   WHERE revision.sale_namespace_activation_id = NEW.sale_namespace_activation_id
   ORDER BY revision.sale_namespace_activation_generation DESC
   LIMIT 1
   FOR SHARE;
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

COMMENT ON FUNCTION validate_community_handle_sale_namespace_revision_insert() IS
  'Fences sale-namespace lifecycle revisions and permits active-to-active refresh only when current verified root or DNS authority advances.';
