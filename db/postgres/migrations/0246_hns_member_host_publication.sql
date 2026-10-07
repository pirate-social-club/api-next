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

-- The same queue reconciles existing claims, configuration changes and
-- withdrawals. A grant that was never active has no record to withdraw.
INSERT INTO hns_member_host_publications(grant_id)
SELECT grant_id FROM handle_grants
 WHERE family='hns' AND fulfillment_kind='hosted_persona_v1' AND status='active';

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

-- Called inside one bounded executor transaction. Only the job row and the
-- root session stay locked across the provider call: the session lock is the
-- existing root zone mutation lock, and no row that a member-facing request
-- writes is held while the provider is slow. Authority is read again at
-- completion and on every public read, so a change during the call is caught
-- there rather than fenced here. A busy root or an unexpected failure defers
-- the job instead of leaving it at the head of the queue.
CREATE FUNCTION prepare_hns_member_host_publication_v1() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  job hns_member_host_publications%ROWTYPE;
  g handle_grants%ROWTYPE;
  a community_handle_sale_namespace_activation_revisions%ROWTYPE;
  dns hns_dns_zone_activation_revisions%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  operation hns_root_import_activation_operations%ROWTYPE;
  failure TEXT;
BEGIN
  SELECT * INTO job FROM hns_member_host_publications
    WHERE due_at<=clock_timestamp() ORDER BY due_at,grant_id
    LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  BEGIN
    SELECT * INTO g FROM handle_grants WHERE grant_id=job.grant_id;
    SELECT revision.* INTO a FROM community_handle_sale_namespace_activation_current AS head
      JOIN community_handle_sale_namespace_activation_revisions AS revision
        ON revision.sale_namespace_activation_id=head.sale_namespace_activation_id
       AND revision.sale_namespace_activation_generation=head.current_generation
      WHERE head.sale_namespace_activation_id=g.sale_namespace_activation_id;
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
      'handle_label',g.handle_label,'state',job.state,
      'authorized',hns_member_host_authorized_v1(g.grant_id),
      'sale_generation',a.sale_namespace_activation_generation,
      'dns_generation',dns.dns_zone_activation_generation,
      'dns_active',dns.status='active' AND dns.dns_zone_activation_generation=a.dns_zone_activation_generation,
      'zone_bytes',convert_from(dns.zone_bytes,'UTF8'),'zone_bytes_digest',dns.zone_bytes_digest,
      'gateway_deployment_reference',dns.gateway_deployment_reference,
      'gateway_certificate_spki_sha256',dns.gateway_certificate_spki_sha256,
      'challenge_txt_value',session.challenge_txt_value,
      'root_import_session_id',session.root_import_session_id);
  EXCEPTION
    WHEN lock_not_available THEN
      UPDATE hns_member_host_publications SET due_at=clock_timestamp()+interval '5 seconds',
        updated_at=clock_timestamp() WHERE grant_id=job.grant_id;
      RETURN jsonb_build_object('grant_id',job.grant_id,'deferred','root_busy');
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS failure = RETURNED_SQLSTATE;
      UPDATE hns_member_host_publications SET attempts=LEAST(attempts+1,30),
        due_at=clock_timestamp()+make_interval(secs=>LEAST(300,5*power(2,LEAST(attempts,6)))::double precision),
        safe_reason='authority_unavailable',updated_at=clock_timestamp()
        WHERE grant_id=job.grant_id;
      RETURN jsonb_build_object('grant_id',job.grant_id,'deferred','prepare_failed','sqlstate',failure);
  END;
END;
$$;

-- Completion is a function so the executor needs no table privilege, and the
-- job cannot be claimed by a role that is then unable to finish it. A ready
-- receipt lasts twenty minutes and is checked again every five; one failed
-- check does not withdraw a receipt that is still valid, because a provider
-- timeout says nothing about the published records.
CREATE FUNCTION complete_hns_member_host_publication_v1(
  input_grant_id TEXT,
  input_outcome TEXT,
  input_sale_generation BIGINT,
  input_dns_generation BIGINT,
  input_configuration_sha256 TEXT,
  input_reason TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  job hns_member_host_publications%ROWTYPE;
  authorized BOOLEAN;
  holds BOOLEAN;
BEGIN
  IF input_outcome NOT IN ('ready','withdrawn','retry')
     OR (input_outcome='retry'
         AND input_reason IS DISTINCT FROM 'authority_unavailable'
         AND input_reason IS DISTINCT FROM 'provider_unavailable') THEN
    RAISE EXCEPTION 'HNS member publication outcome is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM hns_member_host_publications WHERE grant_id=input_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HNS member publication job is absent' USING ERRCODE='P0002';
  END IF;
  authorized := hns_member_host_authorized_v1(input_grant_id);
  IF input_outcome='ready' AND authorized THEN
    UPDATE hns_member_host_publications SET state='ready',attempts=0,
      due_at=clock_timestamp()+interval '5 minutes',
      sale_generation=input_sale_generation,dns_generation=input_dns_generation,
      configuration_sha256=input_configuration_sha256,checked_at=clock_timestamp(),
      valid_until=clock_timestamp()+interval '20 minutes',safe_reason=NULL,
      updated_at=clock_timestamp() WHERE grant_id=input_grant_id;
  ELSIF input_outcome='withdrawn' AND NOT authorized THEN
    UPDATE hns_member_host_publications SET state='withdrawn',attempts=0,
      due_at=clock_timestamp()+interval '10 minutes',
      sale_generation=input_sale_generation,dns_generation=input_dns_generation,
      configuration_sha256=input_configuration_sha256,checked_at=clock_timestamp(),
      valid_until=NULL,safe_reason=NULL,updated_at=clock_timestamp()
      WHERE grant_id=input_grant_id;
  ELSE
    holds := input_outcome='retry' AND job.state='ready'
      AND job.valid_until IS NOT NULL AND job.valid_until>clock_timestamp();
    UPDATE hns_member_host_publications SET
      state=CASE WHEN holds THEN 'ready' ELSE 'preparing' END,
      attempts=LEAST(attempts+1,30),
      due_at=clock_timestamp()+make_interval(secs=>LEAST(300,5*power(2,LEAST(attempts,6)))::double precision),
      checked_at=clock_timestamp(),
      valid_until=CASE WHEN holds THEN valid_until ELSE NULL END,
      safe_reason=CASE WHEN input_outcome='retry' THEN input_reason ELSE 'publication_pending' END,
      updated_at=clock_timestamp() WHERE grant_id=input_grant_id;
  END IF;
  RETURN (SELECT state FROM hns_member_host_publications WHERE grant_id=input_grant_id);
END;
$$;

CREATE FUNCTION hns_member_host_ready_v1(input_grant_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
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
  EXECUTE format('ALTER FUNCTION hns_member_host_ready_v1(TEXT) SET search_path TO %I, pg_temp',installed_schema);
  EXECUTE format('ALTER FUNCTION prepare_hns_member_host_publication_v1() SET search_path TO %I, pg_temp',installed_schema);
  EXECUTE format('ALTER FUNCTION complete_hns_member_host_publication_v1(TEXT,TEXT,BIGINT,BIGINT,TEXT,TEXT) SET search_path TO %I, pg_temp',installed_schema);
END;
$pin$;

-- The two read helpers return one boolean about a grant and stay executable by
-- every service role, so a claim read needs no grant that differs between
-- environments. Only the executor may claim and complete work.
REVOKE ALL ON FUNCTION enqueue_hns_member_host_publication_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_hns_member_host_publication_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_hns_member_host_publication_v1(TEXT,TEXT,BIGINT,BIGINT,TEXT,TEXT) FROM PUBLIC;

DO $executor_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hns_root_import_executor_login_v1') THEN
    GRANT EXECUTE ON FUNCTION prepare_hns_member_host_publication_v1() TO hns_root_import_executor_login_v1;
    GRANT EXECUTE ON FUNCTION complete_hns_member_host_publication_v1(TEXT,TEXT,BIGINT,BIGINT,TEXT,TEXT) TO hns_root_import_executor_login_v1;
  END IF;
END;
$executor_grants$;
