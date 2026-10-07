-- Durable delivery is distinct from ownership. The trigger shares the claim
-- transaction; only the authority provisioner performs network work afterward.
CREATE TABLE hns_member_host_publications (
  grant_id TEXT PRIMARY KEY REFERENCES handle_grants(grant_id),
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing','ready','withdrawn')),
  due_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sale_generation BIGINT,
  dns_generation BIGINT,
  configuration_sha256 TEXT,
  checked_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  safe_reason TEXT CHECK (safe_reason IS NULL OR safe_reason IN ('publication_pending','authority_unavailable','provider_unavailable')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hns_member_host_publications_due ON hns_member_host_publications(due_at,grant_id);

CREATE FUNCTION enqueue_hns_member_host_publication_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.family='hns' AND NEW.fulfillment_kind='hosted_persona_v1' THEN
    INSERT INTO hns_member_host_publications(grant_id) VALUES (NEW.grant_id)
    ON CONFLICT (grant_id) DO UPDATE SET state='preparing',due_at=clock_timestamp(),
      valid_until=NULL,updated_at=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hns_member_host_publication_enqueue
AFTER INSERT OR UPDATE ON handle_grants
FOR EACH ROW EXECUTE FUNCTION enqueue_hns_member_host_publication_v1();

-- The same queue reconciles existing claims, configuration changes and withdrawals.
INSERT INTO hns_member_host_publications(grant_id)
SELECT grant_id FROM handle_grants WHERE family='hns' AND fulfillment_kind='hosted_persona_v1';

CREATE FUNCTION hns_member_host_authorized_v1(input_grant_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
 SELECT EXISTS (
   SELECT 1 FROM handle_grants AS g
   JOIN personas AS p ON p.persona_id=g.owner_persona_id AND p.status='active'
   JOIN communities AS c ON c.community_id=g.community_id AND c.status='active'
   JOIN community_handle_sale_namespace_activation_revisions AS original
     ON original.sale_namespace_activation_id=g.sale_namespace_activation_id
    AND original.sale_namespace_activation_generation=g.sale_namespace_activation_generation
   JOIN community_handle_sale_namespace_activation_current AS head
     ON head.sale_namespace_activation_id=g.sale_namespace_activation_id
   JOIN community_handle_sale_namespace_activation_revisions AS a
     ON a.sale_namespace_activation_id=head.sale_namespace_activation_id
    AND a.sale_namespace_activation_generation=head.current_generation
   JOIN LATERAL current_hns_sale_namespace_dependency_v1(a.community_id,
     a.namespace_authority_reference,a.namespace_authority_generation,
     a.dns_zone_activation_id,a.dns_zone_activation_generation,statement_timestamp()) AS dependency ON TRUE
   WHERE g.grant_id=input_grant_id AND g.family='hns' AND g.fulfillment_kind='hosted_persona_v1'
     AND g.status='active' AND original.status='active' AND a.status='active'
     AND original.community_id=g.community_id AND a.community_id=g.community_id
     AND original.family='hns' AND a.family='hns'
     AND original.canonical_root=g.namespace_root AND a.canonical_root=g.namespace_root
     AND head.current_generation >= g.sale_namespace_activation_generation
     AND dependency.namespace_authority_current
 );
$$;

-- Called inside one bounded executor transaction. Holding these locks across
-- the provider call serializes root mutations and fences mutable authority.
-- No network call runs inside the member's claim transaction.
CREATE FUNCTION prepare_hns_member_host_publication_v1() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  job hns_member_host_publications%ROWTYPE;
  g handle_grants%ROWTYPE;
  a community_handle_sale_namespace_activation_revisions%ROWTYPE;
  dns hns_dns_zone_activation_revisions%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  operation hns_root_import_activation_operations%ROWTYPE;
BEGIN
  SELECT * INTO job FROM hns_member_host_publications
    WHERE due_at<=clock_timestamp() ORDER BY due_at,grant_id
    LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- NOWAIT avoids the grant-update/queue-trigger lock order inversion.
  SELECT * INTO g FROM handle_grants WHERE grant_id=job.grant_id FOR SHARE NOWAIT;
  PERFORM 1 FROM personas WHERE persona_id=g.owner_persona_id FOR SHARE NOWAIT;
  PERFORM 1 FROM communities WHERE community_id=g.community_id FOR SHARE NOWAIT;
  PERFORM 1 FROM community_handle_sale_namespace_activation_current
    WHERE sale_namespace_activation_id=g.sale_namespace_activation_id FOR SHARE NOWAIT;
  SELECT revision.* INTO a FROM community_handle_sale_namespace_activation_current AS head
    JOIN community_handle_sale_namespace_activation_revisions AS revision
      ON revision.sale_namespace_activation_id=head.sale_namespace_activation_id
     AND revision.sale_namespace_activation_generation=head.current_generation
    WHERE head.sale_namespace_activation_id=g.sale_namespace_activation_id;
  PERFORM 1 FROM community_route_ownership_evidence
    WHERE evidence_ref=a.namespace_authority_reference FOR SHARE NOWAIT;
  PERFORM 1 FROM community_canonical_route_bindings
    WHERE verified_evidence_ref=a.namespace_authority_reference FOR SHARE NOWAIT;
  PERFORM 1 FROM hns_dns_zone_activation_current
    WHERE dns_zone_activation_id=a.dns_zone_activation_id FOR SHARE NOWAIT;
  SELECT revision.* INTO dns FROM hns_dns_zone_activation_current AS head
    JOIN hns_dns_zone_activation_revisions AS revision
      ON revision.dns_zone_activation_id=head.dns_zone_activation_id
     AND revision.dns_zone_activation_generation=head.current_generation
    WHERE head.dns_zone_activation_id=a.dns_zone_activation_id;
  BEGIN
    SELECT * INTO STRICT operation FROM hns_root_import_activation_operations
      WHERE sale_namespace_activation_id=g.sale_namespace_activation_id
        AND community_id=g.community_id AND dns_zone_activation_id=a.dns_zone_activation_id;
  EXCEPTION WHEN NO_DATA_FOUND THEN NULL;
  END;
  -- Refuse ambiguous or detached provenance rather than choosing a session by root alone.
  IF operation.root_import_session_id IS NOT NULL THEN
    SELECT * INTO session FROM hns_root_import_sessions
      WHERE root_import_session_id=operation.root_import_session_id
        AND root_label=g.namespace_root FOR UPDATE NOWAIT;
  END IF;
  RETURN jsonb_build_object('grant_id',g.grant_id,'root_label',g.namespace_root,
    'handle_label',g.handle_label,'authorized',hns_member_host_authorized_v1(g.grant_id),
    'sale_generation',a.sale_namespace_activation_generation,
    'dns_generation',dns.dns_zone_activation_generation,
    'dns_active',dns.status='active' AND dns.dns_zone_activation_generation=a.dns_zone_activation_generation,
    'zone_bytes',convert_from(dns.zone_bytes,'UTF8'),'zone_bytes_digest',dns.zone_bytes_digest,
    'gateway_deployment_reference',dns.gateway_deployment_reference,
    'gateway_certificate_spki_sha256',dns.gateway_certificate_spki_sha256,
    'challenge_txt_value',session.challenge_txt_value,
    'root_import_session_id',session.root_import_session_id);
END;
$$;

CREATE FUNCTION hns_member_host_ready_v1(input_grant_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM hns_member_host_publications AS job
   JOIN handle_grants AS g ON g.grant_id=job.grant_id
   JOIN community_handle_sale_namespace_activation_current AS head
     ON head.sale_namespace_activation_id=g.sale_namespace_activation_id
   JOIN community_handle_sale_namespace_activation_revisions AS a
     ON a.sale_namespace_activation_id=head.sale_namespace_activation_id
    AND a.sale_namespace_activation_generation=head.current_generation
   JOIN hns_dns_zone_activation_current AS dns ON dns.dns_zone_activation_id=a.dns_zone_activation_id
   JOIN hns_dns_zone_activation_revisions AS config
     ON config.dns_zone_activation_id=dns.dns_zone_activation_id
    AND config.dns_zone_activation_generation=dns.current_generation
   WHERE job.grant_id=input_grant_id AND job.state='ready'
     AND job.valid_until>statement_timestamp() AND job.sale_generation=head.current_generation
     AND job.dns_generation=dns.current_generation
     AND job.configuration_sha256=config.zone_bytes_digest
     AND hns_member_host_authorized_v1(input_grant_id)
     AND EXISTS (SELECT 1 FROM effective_community_handle_sale_namespace_v1(
       g.sale_namespace_activation_id,statement_timestamp()))
 );
$$;

DO $pin$
DECLARE installed_schema TEXT := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION enqueue_hns_member_host_publication_v1() SET search_path TO %I, pg_temp',installed_schema);
  EXECUTE format('ALTER FUNCTION hns_member_host_authorized_v1(TEXT) SET search_path TO %I, pg_temp',installed_schema);
  EXECUTE format('ALTER FUNCTION prepare_hns_member_host_publication_v1() SET search_path TO %I, pg_temp',installed_schema);
END;
$pin$;
REVOKE ALL ON FUNCTION enqueue_hns_member_host_publication_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION hns_member_host_authorized_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_hns_member_host_publication_v1() FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='api_next_app') THEN
    GRANT SELECT,INSERT,UPDATE ON hns_member_host_publications TO api_next_app;
    REVOKE DELETE,TRUNCATE ON hns_member_host_publications FROM api_next_app;
    GRANT EXECUTE ON FUNCTION prepare_hns_member_host_publication_v1() TO api_next_app;
    GRANT EXECUTE ON FUNCTION hns_member_host_authorized_v1(TEXT) TO api_next_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hns_root_import_executor_login_v1') THEN
    GRANT SELECT,UPDATE ON hns_member_host_publications TO hns_root_import_executor_login_v1;
    REVOKE INSERT,DELETE,TRUNCATE ON hns_member_host_publications FROM hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION prepare_hns_member_host_publication_v1() TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION hns_member_host_authorized_v1(TEXT) TO hns_root_import_executor_login_v1;
  END IF;
END;
$runtime_grants$;
