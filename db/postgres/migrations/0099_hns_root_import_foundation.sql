-- Minimal self-service HNS root-import sessions and the pull-based authority
-- provisioning queue. The first operation is provision_root_v1 only.

CREATE TABLE hns_root_import_sessions (
  root_import_session_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  creation_intent_id TEXT NOT NULL,
  ceremony_intent_id TEXT NOT NULL,
  namespace_session_id TEXT NOT NULL UNIQUE,
  ownership_generation BIGINT NOT NULL,
  ownership_expected_revision BIGINT NOT NULL,
  root_label TEXT NOT NULL,
  challenge_txt_value TEXT NOT NULL,
  status TEXT NOT NULL,
  revision BIGINT NOT NULL,
  start_idempotency_key TEXT NOT NULL,
  start_request_sha256 TEXT NOT NULL,
  provision_job_id TEXT NOT NULL UNIQUE,
  provision_idempotency_key TEXT,
  provision_poll_request_sha256 TEXT,
  publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT,
  ownership_result_sha256 TEXT,
  observation_job_id TEXT UNIQUE,
  observation_idempotency_key TEXT,
  observation_request_sha256 TEXT,
  readiness_result_bytes BYTEA,
  readiness_result_sha256 TEXT,
  activated_community_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hns_root_import_sessions_actor_intent_fk
    FOREIGN KEY (actor_id, creation_intent_id)
    REFERENCES community_creation_intents(actor_id, intent_id),
  CONSTRAINT hns_root_import_sessions_namespace_actor_fk
    FOREIGN KEY (namespace_session_id, actor_id)
    REFERENCES namespace_ownership_sessions(namespace_session_id, actor_id),
  CONSTRAINT hns_root_import_sessions_activated_community_fk
    FOREIGN KEY (activated_community_id)
    REFERENCES communities(community_id),
  CONSTRAINT hns_root_import_sessions_identity_check CHECK (
    btrim(root_import_session_id) = root_import_session_id
    AND octet_length(root_import_session_id) BETWEEN 1 AND 256
    AND root_import_session_id !~ '[[:cntrl:]]'
    AND btrim(actor_id) = actor_id
    AND octet_length(actor_id) BETWEEN 1 AND 256
    AND btrim(creation_intent_id) = creation_intent_id
    AND octet_length(creation_intent_id) BETWEEN 1 AND 256
    AND btrim(ceremony_intent_id) = ceremony_intent_id
    AND octet_length(ceremony_intent_id) BETWEEN 1 AND 256
    AND btrim(namespace_session_id) = namespace_session_id
    AND octet_length(namespace_session_id) BETWEEN 1 AND 256
    AND is_community_route_root_label('hns', root_label) IS TRUE
    AND challenge_txt_value LIKE 'pirate-verification=%'
    AND octet_length(challenge_txt_value) BETWEEN 21 AND 16448
    AND challenge_txt_value !~ '[[:cntrl:]]'
    AND btrim(start_idempotency_key) = start_idempotency_key
    AND octet_length(start_idempotency_key) BETWEEN 1 AND 256
    AND btrim(provision_job_id) = provision_job_id
    AND octet_length(provision_job_id) BETWEEN 1 AND 256
    AND (
      provision_idempotency_key IS NULL
      OR (
        btrim(provision_idempotency_key) = provision_idempotency_key
        AND octet_length(provision_idempotency_key) BETWEEN 1 AND 256
      )
    )
    AND (
      observation_job_id IS NULL
      OR (
        btrim(observation_job_id) = observation_job_id
        AND octet_length(observation_job_id) BETWEEN 1 AND 256
      )
    )
    AND (
      observation_idempotency_key IS NULL
      OR (
        btrim(observation_idempotency_key) = observation_idempotency_key
        AND octet_length(observation_idempotency_key) BETWEEN 1 AND 256
      )
    )
  ),
  CONSTRAINT hns_root_import_sessions_generation_check CHECK (
    (ownership_generation >= 1 AND ownership_generation <= 9007199254740991)
    AND (
      ownership_expected_revision >= 1
      AND ownership_expected_revision <= 9007199254740991
    )
    AND (revision >= 1 AND revision <= 9007199254740991)
  ),
  CONSTRAINT hns_root_import_sessions_hash_check CHECK (
    start_request_sha256 ~ '^[0-9a-f]{64}$'
    AND (
      provision_poll_request_sha256 IS NULL
      OR provision_poll_request_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (ownership_result_sha256 IS NULL OR ownership_result_sha256 ~ '^[0-9a-f]{64}$')
    AND (
      observation_request_sha256 IS NULL
      OR observation_request_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (publish_plan_sha256 IS NULL OR publish_plan_sha256 ~ '^[0-9a-f]{64}$')
    AND (
      readiness_result_sha256 IS NULL
      OR readiness_result_sha256 ~ '^[0-9a-f]{64}$'
    )
    AND (
      publish_plan_bytes IS NULL
      OR (
        (
          octet_length(publish_plan_bytes) >= 1
          AND octet_length(publish_plan_bytes) <= 1048576
        )
        AND encode(sha256(publish_plan_bytes), 'hex') = publish_plan_sha256
      )
    )
    AND (
      readiness_result_bytes IS NULL
      OR (
        (
          octet_length(readiness_result_bytes) >= 1
          AND octet_length(readiness_result_bytes) <= 1048576
        )
        AND encode(sha256(readiness_result_bytes), 'hex') = readiness_result_sha256
      )
    )
  ),
  CONSTRAINT hns_root_import_sessions_status_check CHECK (
    status IN (
      'awaiting_ownership', 'provisioning', 'awaiting_owner_update', 'observing',
      'ready', 'activated', 'failed', 'expired'
    )
  ),
  CONSTRAINT hns_root_import_sessions_state_shape CHECK (
    (
      status = 'awaiting_ownership'
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND ownership_result_sha256 IS NULL
      AND provision_idempotency_key IS NULL
      AND provision_poll_request_sha256 IS NULL
      AND observation_job_id IS NULL
      AND observation_idempotency_key IS NULL
      AND observation_request_sha256 IS NULL
      AND activated_community_id IS NULL
    )
    OR (
      status = 'provisioning'
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND ownership_result_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NULL
      AND observation_idempotency_key IS NULL
      AND observation_request_sha256 IS NULL
      AND activated_community_id IS NULL
    )
    OR (
      status = 'awaiting_owner_update'
      AND publish_plan_bytes IS NOT NULL
      AND publish_plan_sha256 IS NOT NULL
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND ownership_result_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NULL
      AND observation_idempotency_key IS NULL
      AND observation_request_sha256 IS NULL
      AND activated_community_id IS NULL
    )
    OR (
      status = 'observing'
      AND publish_plan_bytes IS NOT NULL
      AND publish_plan_sha256 IS NOT NULL
      AND readiness_result_bytes IS NULL
      AND readiness_result_sha256 IS NULL
      AND ownership_result_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NOT NULL
      AND observation_idempotency_key IS NOT NULL
      AND observation_request_sha256 IS NOT NULL
      AND activated_community_id IS NULL
    )
    OR (
      status = 'ready'
      AND publish_plan_bytes IS NOT NULL
      AND publish_plan_sha256 IS NOT NULL
      AND readiness_result_bytes IS NOT NULL
      AND readiness_result_sha256 IS NOT NULL
      AND ownership_result_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NOT NULL
      AND observation_idempotency_key IS NOT NULL
      AND observation_request_sha256 IS NOT NULL
      AND activated_community_id IS NULL
    )
    OR (
      status = 'activated'
      AND publish_plan_bytes IS NOT NULL
      AND publish_plan_sha256 IS NOT NULL
      AND readiness_result_bytes IS NOT NULL
      AND readiness_result_sha256 IS NOT NULL
      AND ownership_result_sha256 IS NOT NULL
      AND provision_idempotency_key IS NOT NULL
      AND provision_poll_request_sha256 IS NOT NULL
      AND observation_job_id IS NOT NULL
      AND observation_idempotency_key IS NOT NULL
      AND observation_request_sha256 IS NOT NULL
      AND activated_community_id IS NOT NULL
    )
    OR (
      status IN ('failed', 'expired')
      AND activated_community_id IS NULL
    )
  ),
  CONSTRAINT hns_root_import_sessions_time_check CHECK (
    expires_at > created_at
    AND updated_at >= created_at
  ),
  UNIQUE (actor_id, creation_intent_id, start_idempotency_key),
  UNIQUE (actor_id, creation_intent_id, root_import_session_id)
);

CREATE UNIQUE INDEX hns_root_import_sessions_active_root_unique
  ON hns_root_import_sessions(root_label)
  WHERE status IN (
    'provisioning', 'awaiting_owner_update', 'observing', 'ready', 'activated'
  );

CREATE TABLE hns_authority_provision_jobs (
  provision_job_id TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL,
  request_bytes BYTEA NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT,
  result_bytes BYTEA,
  result_sha256 TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT hns_authority_provision_jobs_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_authority_provision_jobs_identity_check CHECK (
    btrim(provision_job_id) = provision_job_id
    AND octet_length(provision_job_id) BETWEEN 1 AND 256
    AND provision_job_id !~ '[[:cntrl:]]'
    AND operation_kind = 'provision_root_v1'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND octet_length(request_bytes) BETWEEN 1 AND 65536
    AND encode(sha256(request_bytes), 'hex') = request_sha256
    AND attempt_count BETWEEN 0 AND 5
    AND lease_fence BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT hns_authority_provision_jobs_state_check CHECK (
    state IN ('queued', 'leased', 'completed', 'failed')
  ),
  CONSTRAINT hns_authority_provision_jobs_state_shape CHECK (
    (
      state = 'queued'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND (
        failure_code IS NULL
        OR (
          btrim(failure_code) = failure_code
          AND octet_length(failure_code) BETWEEN 1 AND 128
          AND failure_code !~ '[[:cntrl:]]'
        )
      )
      AND completed_at IS NULL
    )
    OR (
      state = 'leased'
      AND btrim(leased_by) = leased_by
      AND octet_length(leased_by) BETWEEN 1 AND 256
      AND lease_expires_at IS NOT NULL
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND failure_code IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'completed'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND octet_length(publish_plan_bytes) BETWEEN 1 AND 1048576
      AND publish_plan_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(publish_plan_bytes), 'hex') = publish_plan_sha256
      AND octet_length(result_bytes) BETWEEN 1 AND 1048576
      AND result_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(result_bytes), 'hex') = result_sha256
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      state = 'failed'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND publish_plan_bytes IS NULL
      AND publish_plan_sha256 IS NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND btrim(failure_code) = failure_code
      AND octet_length(failure_code) BETWEEN 1 AND 128
      AND failure_code !~ '[[:cntrl:]]'
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT hns_authority_provision_jobs_time_check CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE INDEX hns_authority_provision_jobs_claim_idx
  ON hns_authority_provision_jobs(state, created_at, provision_job_id);

CREATE TABLE hns_root_import_observation_jobs (
  observation_job_id TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL,
  request_bytes BYTEA NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  result_bytes BYTEA,
  result_sha256 TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT hns_root_import_observation_jobs_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_root_import_observation_jobs_identity_check CHECK (
    btrim(observation_job_id) = observation_job_id
    AND octet_length(observation_job_id) BETWEEN 1 AND 256
    AND observation_job_id !~ '[[:cntrl:]]'
    AND operation_kind = 'observe_root_v1'
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND octet_length(request_bytes) BETWEEN 1 AND 65536
    AND encode(sha256(request_bytes), 'hex') = request_sha256
    AND attempt_count >= 0
    AND lease_fence BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT hns_root_import_observation_jobs_state_check CHECK (
    state IN ('queued', 'leased', 'completed', 'failed')
  ),
  CONSTRAINT hns_root_import_observation_jobs_state_shape CHECK (
    (
      state = 'queued'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'leased'
      AND btrim(leased_by) = leased_by
      AND octet_length(leased_by) BETWEEN 1 AND 256
      AND lease_expires_at IS NOT NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'completed'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND octet_length(result_bytes) BETWEEN 1 AND 1048576
      AND result_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(result_bytes), 'hex') = result_sha256
      AND failure_code IS NULL
      AND completed_at IS NOT NULL
    )
    OR (
      state = 'failed'
      AND leased_by IS NULL
      AND lease_expires_at IS NULL
      AND result_bytes IS NULL
      AND result_sha256 IS NULL
      AND btrim(failure_code) = failure_code
      AND octet_length(failure_code) BETWEEN 1 AND 128
      AND failure_code !~ '[[:cntrl:]]'
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT hns_root_import_observation_jobs_time_check CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE INDEX hns_root_import_observation_jobs_claim_idx
  ON hns_root_import_observation_jobs(state, created_at, observation_job_id);

CREATE TABLE hns_root_import_activation_operations (
  operation_id TEXT PRIMARY KEY,
  root_import_session_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  creation_intent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  expected_session_revision BIGINT NOT NULL,
  community_id TEXT NOT NULL,
  dns_zone_activation_id TEXT NOT NULL,
  app_host_activation_id TEXT NOT NULL,
  sale_namespace_activation_id TEXT NOT NULL,
  sale_namespace_activation_sha256 TEXT NOT NULL,
  result_session_revision BIGINT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT hns_root_import_activation_operations_session_fk
    FOREIGN KEY (root_import_session_id)
    REFERENCES hns_root_import_sessions(root_import_session_id),
  CONSTRAINT hns_root_import_activation_operations_community_fk
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
  CONSTRAINT hns_root_import_activation_operations_dns_fk
    FOREIGN KEY (dns_zone_activation_id)
    REFERENCES hns_dns_zone_activation_current(dns_zone_activation_id),
  CONSTRAINT hns_root_import_activation_operations_app_fk
    FOREIGN KEY (app_host_activation_id)
    REFERENCES hns_community_app_host_activation_current(app_host_activation_id),
  CONSTRAINT hns_root_import_activation_operations_sale_fk
    FOREIGN KEY (sale_namespace_activation_id)
    REFERENCES community_handle_sale_namespace_activation_current(sale_namespace_activation_id),
  CONSTRAINT hns_root_import_activation_operations_identity_check CHECK (
    is_hns_host_persistence_identity(operation_id, 256)
    AND is_hns_host_persistence_identity(root_import_session_id, 256)
    AND is_hns_host_persistence_identity(actor_id, 256)
    AND is_hns_host_persistence_identity(creation_intent_id, 256)
    AND is_hns_host_persistence_identity(idempotency_key, 256)
    AND request_sha256 ~ '^[0-9a-f]{64}$'
    AND is_hns_host_persistence_identity(dns_zone_activation_id, 256)
    AND is_hns_host_persistence_identity(app_host_activation_id, 256)
    AND is_handle_sales_identifier_v1(sale_namespace_activation_id, 128)
    AND sale_namespace_activation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT hns_root_import_activation_operations_generation_check CHECK (
    (
      expected_session_revision >= 1
      AND expected_session_revision <= 9007199254740990
    )
    AND result_session_revision = expected_session_revision + 1
  ),
  UNIQUE (actor_id, root_import_session_id, idempotency_key)
);

CREATE FUNCTION begin_hns_root_import_provision_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_poll_request_sha256 TEXT,
  input_ownership_result_sha256 TEXT,
  input_provision_job_id TEXT,
  input_provision_request_bytes BYTEA,
  input_provision_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  job hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.status = 'provisioning' THEN
    SELECT * INTO job
      FROM hns_authority_provision_jobs
     WHERE provision_job_id = session.provision_job_id
     FOR SHARE;
    IF session.provision_idempotency_key = input_idempotency_key
      AND session.provision_poll_request_sha256 = input_poll_request_sha256
      AND session.ownership_result_sha256 = input_ownership_result_sha256
      AND session.provision_job_id = input_provision_job_id
      AND job.request_bytes = input_provision_request_bytes
      AND job.request_sha256 = input_provision_request_sha256
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_ownership'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR session.provision_job_id IS DISTINCT FROM input_provision_job_id
    OR input_poll_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_provision_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_provision_request_bytes), 'hex')
       <> input_provision_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  SELECT * INTO ownership_result
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = session.ceremony_intent_id
     AND namespace_session_id = session.namespace_session_id
   FOR SHARE;
  IF NOT FOUND
    OR ownership_result.outcome_status <> 'satisfied'
    OR ownership_result.result_hash <> input_ownership_result_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  -- Unverified sessions deliberately do not reserve a root. Serialize the
  -- proof-to-provision transition so only a verified owner can claim it.
  PERFORM pg_advisory_xact_lock(hashtextextended('hns-root-import:' || session.root_label, 0));
  UPDATE hns_authority_provision_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'provisioning'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_observation_jobs AS stale_job
     SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
         failure_code = 'session_expired', completed_at = database_now,
         updated_at = database_now
    FROM hns_root_import_sessions AS stale_session
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.status = 'observing'
     AND stale_session.expires_at <= database_now
     AND stale_job.root_import_session_id = stale_session.root_import_session_id
     AND (
       stale_job.state = 'queued'
       OR (stale_job.state = 'leased' AND stale_job.lease_expires_at <= database_now)
     );
  UPDATE hns_root_import_sessions AS stale_session
     SET status = 'expired', revision = stale_session.revision + 1,
         updated_at = database_now
   WHERE stale_session.root_label = session.root_label
     AND stale_session.root_import_session_id <> session.root_import_session_id
     AND stale_session.expires_at <= database_now
     AND (
       stale_session.status IN ('awaiting_owner_update', 'ready')
       OR (
         stale_session.status = 'provisioning'
         AND EXISTS (
           SELECT 1 FROM hns_authority_provision_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
       OR (
         stale_session.status = 'observing'
         AND EXISTS (
           SELECT 1 FROM hns_root_import_observation_jobs AS stale_job
            WHERE stale_job.root_import_session_id = stale_session.root_import_session_id
              AND stale_job.state = 'failed'
              AND stale_job.failure_code = 'session_expired'
         )
       )
     );
  IF EXISTS (
       SELECT 1
         FROM hns_root_import_sessions AS other
        WHERE other.root_label = session.root_label
          AND other.root_import_session_id <> session.root_import_session_id
          AND other.status IN (
            'provisioning', 'awaiting_owner_update', 'observing', 'ready', 'activated'
          )
     )
    OR EXISTS (
       SELECT 1 FROM hns_dns_zone_activation_current
        WHERE canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1 FROM community_canonical_route_bindings
        WHERE family = 'hns' AND root_label = session.root_label
          AND route_lifecycle_status = 'active'
     )
    OR EXISTS (
       SELECT 1 FROM community_handle_sale_namespace_activation_current
        WHERE family = 'hns' AND canonical_root = session.root_label
     )
    OR EXISTS (
       SELECT 1
         FROM operator_managed_root_registry_current AS current_registry
        WHERE operator_managed_registry_has_active_root(
          current_registry.registry_reference,
          current_registry.registry_version,
          current_registry.registry_digest,
          session.root_label
        )
     )
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  INSERT INTO hns_authority_provision_jobs (
    provision_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_provision_job_id, session.root_import_session_id, 'provision_root_v1',
    input_provision_request_bytes, input_provision_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'provisioning', revision = session.revision + 1,
         provision_idempotency_key = input_idempotency_key,
         provision_poll_request_sha256 = input_poll_request_sha256,
         ownership_result_sha256 = input_ownership_result_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'provisioning'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE FUNCTION begin_hns_root_import_observation_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_idempotency_key TEXT,
  input_request_sha256 TEXT,
  input_ownership_result_sha256 TEXT,
  input_observation_job_id TEXT,
  input_observation_request_bytes BYTEA,
  input_observation_request_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.observation_idempotency_key IS NOT NULL THEN
    IF session.observation_idempotency_key = input_idempotency_key
      AND session.observation_request_sha256 = input_request_sha256
      AND session.ownership_result_sha256 = input_ownership_result_sha256
      AND session.observation_job_id = input_observation_job_id
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF session.status <> 'awaiting_owner_update'
    OR session.revision <> input_expected_revision
    OR session.expires_at <= database_now
    OR session.ownership_result_sha256 IS DISTINCT FROM input_ownership_result_sha256
    OR input_request_sha256 !~ '^[0-9a-f]{64}$'
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
    OR input_observation_request_sha256 !~ '^[0-9a-f]{64}$'
    OR encode(sha256(input_observation_request_bytes), 'hex')
       <> input_observation_request_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  SELECT * INTO ownership_result
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = session.ceremony_intent_id
     AND namespace_session_id = session.namespace_session_id
   FOR SHARE;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id
   FOR SHARE;
  IF ownership_result.ceremony_intent_id IS NULL
    OR provision.provision_job_id IS NULL
    OR ownership_result.outcome_status <> 'satisfied'
    OR ownership_result.result_hash <> input_ownership_result_sha256
    OR provision.state <> 'completed'
    OR provision.publish_plan_sha256 <> session.publish_plan_sha256
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  INSERT INTO hns_root_import_observation_jobs (
    observation_job_id, root_import_session_id, operation_kind,
    request_bytes, request_sha256, state
  ) VALUES (
    input_observation_job_id, session.root_import_session_id, 'observe_root_v1',
    input_observation_request_bytes, input_observation_request_sha256, 'queued'
  );
  UPDATE hns_root_import_sessions
     SET status = 'observing', revision = session.revision + 1,
         ownership_result_sha256 = input_ownership_result_sha256,
         observation_job_id = input_observation_job_id,
         observation_idempotency_key = input_idempotency_key,
         observation_request_sha256 = input_request_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT 'observing'::TEXT, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE FUNCTION claim_hns_root_import_observation_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  observation_job_id TEXT,
  root_import_session_id TEXT,
  operation_kind TEXT,
  request_bytes BYTEA,
  request_sha256 TEXT,
  publish_plan_bytes BYTEA,
  publish_plan_sha256 TEXT,
  provision_result_bytes BYTEA,
  provision_result_sha256 TEXT,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate hns_root_import_observation_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  provision hns_authority_provision_jobs%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS root observation claim';
  END IF;
  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS expired_session
      ON expired_session.root_import_session_id = job.root_import_session_id
   WHERE (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND expired_session.status = 'observing'
     AND expired_session.expires_at <= database_now
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO session
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id
     FOR UPDATE;
    UPDATE hns_root_import_observation_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'session_expired', completed_at = database_now,
           updated_at = database_now
     WHERE job.observation_job_id = candidate.observation_job_id;
    UPDATE hns_root_import_sessions AS expired_session
       SET status = 'expired', revision = session.revision + 1,
           updated_at = database_now
     WHERE expired_session.root_import_session_id = session.root_import_session_id;
  END IF;
  SELECT job.* INTO candidate
    FROM hns_root_import_observation_jobs AS job
    JOIN hns_root_import_sessions AS selected_session
      ON selected_session.root_import_session_id = job.root_import_session_id
   WHERE (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND selected_session.status = 'observing'
     AND selected_session.expires_at > database_now
   ORDER BY job.created_at, job.observation_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id;
  SELECT * INTO provision
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = session.provision_job_id;
  IF provision.state <> 'completed' THEN
    RAISE EXCEPTION 'HNS root observation provision authority is unavailable';
  END IF;
  UPDATE hns_root_import_observation_jobs AS job
     SET state = 'leased', attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + input_lease_seconds * interval '1 second',
         failure_code = NULL, updated_at = database_now
   WHERE job.observation_job_id = candidate.observation_job_id;
  RETURN QUERY SELECT
    candidate.observation_job_id, candidate.root_import_session_id,
    candidate.operation_kind, candidate.request_bytes, candidate.request_sha256,
    provision.publish_plan_bytes, provision.publish_plan_sha256,
    provision.result_bytes, provision.result_sha256,
    candidate.lease_fence + 1,
    database_now + input_lease_seconds * interval '1 second';
END;
$$;

CREATE FUNCTION finalize_hns_root_import_ownership_v1(
  input_actor_id TEXT,
  input_creation_intent_id TEXT,
  input_root_import_session_id TEXT,
  input_expected_revision BIGINT,
  input_ownership_status TEXT,
  input_ownership_result_sha256 TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  session hns_root_import_sessions%ROWTYPE;
  ownership_result community_creation_ceremony_results%ROWTYPE;
  target_status TEXT;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_ownership_status NOT IN ('rejected', 'expired')
    OR input_ownership_result_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid HNS root-import ownership finalization';
  END IF;
  target_status := CASE input_ownership_status WHEN 'expired' THEN 'expired' ELSE 'failed' END;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE actor_id = input_actor_id
     AND creation_intent_id = input_creation_intent_id
     AND hns_root_import_sessions.root_import_session_id = input_root_import_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  IF session.status IN ('failed', 'expired') THEN
    IF session.status = target_status
      AND session.ownership_result_sha256 = input_ownership_result_sha256
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  SELECT * INTO ownership_result
    FROM community_creation_ceremony_results
   WHERE ceremony_intent_id = session.ceremony_intent_id
     AND namespace_session_id = session.namespace_session_id
   FOR SHARE;
  IF session.status <> 'awaiting_ownership'
    OR session.revision <> input_expected_revision
    OR ownership_result.result_hash <> input_ownership_result_sha256
    OR ownership_result.outcome_status <> target_status
  THEN
    RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  UPDATE hns_root_import_sessions
     SET status = target_status, revision = session.revision + 1,
         ownership_result_sha256 = input_ownership_result_sha256,
         updated_at = database_now
   WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
  RETURN QUERY SELECT target_status, session.root_import_session_id, session.revision + 1;
END;
$$;

CREATE FUNCTION finalize_hns_root_import_observation_job_v1(
  input_observation_job_id TEXT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_request_sha256 TEXT,
  input_outcome TEXT,
  input_result_bytes BYTEA,
  input_result_sha256 TEXT,
  input_failure_code TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  job hns_root_import_observation_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF input_outcome NOT IN ('ready', 'retry', 'failed') THEN
    RAISE EXCEPTION 'invalid HNS root observation finalization';
  END IF;
  SELECT * INTO job
    FROM hns_root_import_observation_jobs
   WHERE observation_job_id = input_observation_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = job.root_import_session_id
   FOR UPDATE;
  IF job.state IN ('completed', 'failed') THEN
    IF job.state = 'completed'
      AND input_outcome = 'ready'
      AND job.request_sha256 = input_request_sha256
      AND job.result_bytes = input_result_bytes
      AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased'
    OR job.leased_by <> input_executor_id
    OR job.lease_fence <> input_lease_fence
    OR job.lease_expires_at <= database_now
    OR job.request_sha256 <> input_request_sha256
    OR session.status <> 'observing'
    OR session.expires_at <= database_now
  THEN
    RETURN QUERY SELECT 'lost'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;
  IF input_outcome = 'ready' THEN
    IF input_result_bytes IS NULL
      OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid ready HNS root observation result';
    END IF;
    UPDATE hns_root_import_observation_jobs
       SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
           result_bytes = input_result_bytes, result_sha256 = input_result_sha256,
           failure_code = NULL, completed_at = database_now, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'ready', revision = session.revision + 1,
           readiness_result_bytes = input_result_bytes,
           readiness_result_sha256 = input_result_sha256,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY SELECT 'ready'::TEXT, session.root_import_session_id, session.revision + 1;
    RETURN;
  END IF;
  IF input_result_bytes IS NOT NULL OR input_result_sha256 IS NOT NULL
    OR input_failure_code IS NULL
    OR btrim(input_failure_code) <> input_failure_code
    OR octet_length(input_failure_code) NOT BETWEEN 1 AND 128
    OR input_failure_code ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid failed HNS root observation result';
  END IF;
  IF input_outcome = 'failed' THEN
    UPDATE hns_root_import_observation_jobs
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = input_failure_code,
           completed_at = database_now, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY SELECT 'failed'::TEXT, session.root_import_session_id, session.revision + 1;
  ELSE
    UPDATE hns_root_import_observation_jobs
       SET state = 'queued', leased_by = NULL, lease_expires_at = NULL,
           failure_code = input_failure_code, updated_at = database_now
     WHERE observation_job_id = input_observation_job_id;
    RETURN QUERY SELECT 'retry'::TEXT, session.root_import_session_id, session.revision;
  END IF;
END;
$$;

CREATE FUNCTION guard_hns_root_import_session_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HNS root-import sessions are retained';
  END IF;
  IF NEW.root_import_session_id <> OLD.root_import_session_id
    OR NEW.actor_id <> OLD.actor_id
    OR NEW.creation_intent_id <> OLD.creation_intent_id
    OR NEW.ceremony_intent_id <> OLD.ceremony_intent_id
    OR NEW.namespace_session_id <> OLD.namespace_session_id
    OR NEW.ownership_generation <> OLD.ownership_generation
    OR NEW.ownership_expected_revision <> OLD.ownership_expected_revision
    OR NEW.root_label <> OLD.root_label
    OR NEW.challenge_txt_value <> OLD.challenge_txt_value
    OR NEW.start_idempotency_key <> OLD.start_idempotency_key
    OR NEW.start_request_sha256 <> OLD.start_request_sha256
    OR NEW.provision_job_id <> OLD.provision_job_id
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.created_at <> OLD.created_at
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'HNS root-import session identity or revision changed';
  END IF;
  IF (
      OLD.ownership_result_sha256 IS NOT NULL
      AND NEW.ownership_result_sha256 IS DISTINCT FROM OLD.ownership_result_sha256
    )
    OR (
      OLD.provision_idempotency_key IS NOT NULL
      AND NEW.provision_idempotency_key IS DISTINCT FROM OLD.provision_idempotency_key
    )
    OR (
      OLD.provision_poll_request_sha256 IS NOT NULL
      AND NEW.provision_poll_request_sha256 IS DISTINCT FROM OLD.provision_poll_request_sha256
    )
    OR (
      OLD.observation_job_id IS NOT NULL
      AND NEW.observation_job_id IS DISTINCT FROM OLD.observation_job_id
    )
    OR (
      OLD.observation_idempotency_key IS NOT NULL
      AND NEW.observation_idempotency_key IS DISTINCT FROM OLD.observation_idempotency_key
    )
    OR (
      OLD.observation_request_sha256 IS NOT NULL
      AND NEW.observation_request_sha256 IS DISTINCT FROM OLD.observation_request_sha256
    )
    OR (
      OLD.readiness_result_bytes IS NOT NULL
      AND NEW.readiness_result_bytes IS DISTINCT FROM OLD.readiness_result_bytes
    )
    OR (
      OLD.readiness_result_sha256 IS NOT NULL
      AND NEW.readiness_result_sha256 IS DISTINCT FROM OLD.readiness_result_sha256
    )
  THEN
    RAISE EXCEPTION 'HNS root-import retained evidence changed';
  END IF;
  IF NOT (
    (
      OLD.status = 'awaiting_ownership'
      AND NEW.status IN ('provisioning', 'failed', 'expired')
    )
    OR (OLD.status = 'provisioning' AND NEW.status IN ('awaiting_owner_update', 'failed', 'expired'))
    OR (
      OLD.status IN ('awaiting_owner_update', 'observing')
      AND NEW.status IN ('observing', 'ready', 'failed', 'expired')
    )
    OR (OLD.status = 'ready' AND NEW.status IN ('activated', 'expired'))
  ) THEN
    RAISE EXCEPTION 'HNS root-import session transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_sessions_change_guard
BEFORE UPDATE OR DELETE ON hns_root_import_sessions
FOR EACH ROW
EXECUTE FUNCTION guard_hns_root_import_session_change();

CREATE FUNCTION guard_hns_root_import_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ownership namespace_ownership_sessions%ROWTYPE;
BEGIN
  SELECT * INTO ownership
    FROM namespace_ownership_sessions
   WHERE namespace_session_id = NEW.namespace_session_id
   FOR SHARE;
  IF NOT FOUND
    OR ownership.actor_id <> NEW.actor_id
    OR ownership.creation_intent_id <> NEW.creation_intent_id
    OR ownership.ceremony_intent_id <> NEW.ceremony_intent_id
    OR ownership.requirement_kind <> 'namespace_ownership'
    OR ownership.generation <> NEW.ownership_generation
    OR ownership.expected_revision <> NEW.ownership_expected_revision
    OR ownership.route_family <> 'hns'
    OR ownership.route_root_label <> NEW.root_label
    OR ownership.status <> 'pending'
    OR ownership.expires_at <> NEW.expires_at
    OR NEW.status <> 'awaiting_ownership'
    OR NEW.revision <> 1
  THEN
    RAISE EXCEPTION 'HNS root-import session does not match ownership authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hns_root_import_sessions_insert_guard
BEFORE INSERT ON hns_root_import_sessions
FOR EACH ROW
EXECUTE FUNCTION guard_hns_root_import_session_insert();

CREATE FUNCTION reject_hns_authority_provision_job_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HNS authority provision jobs are retained';
END;
$$;

CREATE TRIGGER hns_authority_provision_jobs_retain
BEFORE DELETE ON hns_authority_provision_jobs
FOR EACH ROW
EXECUTE FUNCTION reject_hns_authority_provision_job_delete();

CREATE TRIGGER hns_root_import_observation_jobs_retain
BEFORE DELETE ON hns_root_import_observation_jobs
FOR EACH ROW
EXECUTE FUNCTION reject_hns_authority_provision_job_delete();

CREATE TRIGGER hns_root_import_activation_operations_retain
BEFORE UPDATE OR DELETE ON hns_root_import_activation_operations
FOR EACH ROW
EXECUTE FUNCTION reject_hns_authority_provision_job_delete();

CREATE FUNCTION claim_hns_authority_provision_job_v1(
  input_executor_id TEXT,
  input_lease_seconds INTEGER
)
RETURNS TABLE (
  provision_job_id TEXT,
  root_import_session_id TEXT,
  operation_kind TEXT,
  request_bytes BYTEA,
  request_sha256 TEXT,
  lease_fence BIGINT,
  lease_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  candidate hns_authority_provision_jobs%ROWTYPE;
  expired_session_record hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF btrim(input_executor_id) <> input_executor_id
    OR octet_length(input_executor_id) NOT BETWEEN 1 AND 256
    OR input_executor_id ~ '[[:cntrl:]]'
    OR input_lease_seconds NOT BETWEEN 4 AND 60
  THEN
    RAISE EXCEPTION 'invalid HNS authority provision claim';
  END IF;

  SELECT job.* INTO candidate
    FROM hns_authority_provision_jobs AS job
    JOIN hns_root_import_sessions AS expired_session
      ON expired_session.root_import_session_id = job.root_import_session_id
   WHERE (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND expired_session.status = 'provisioning'
     AND expired_session.expires_at <= database_now
   ORDER BY job.created_at, job.provision_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF FOUND THEN
    SELECT * INTO expired_session_record
      FROM hns_root_import_sessions
     WHERE hns_root_import_sessions.root_import_session_id = candidate.root_import_session_id
     FOR UPDATE;
    UPDATE hns_authority_provision_jobs AS job
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = 'session_expired', completed_at = database_now,
           updated_at = database_now
     WHERE job.provision_job_id = candidate.provision_job_id;
    UPDATE hns_root_import_sessions AS expired_session
       SET status = 'expired', revision = expired_session_record.revision + 1,
           updated_at = database_now
     WHERE expired_session.root_import_session_id = expired_session_record.root_import_session_id;
  END IF;

  SELECT job.* INTO candidate
    FROM hns_authority_provision_jobs AS job
    JOIN hns_root_import_sessions AS session
      ON session.root_import_session_id = job.root_import_session_id
    JOIN community_creation_ceremony_results AS ownership_result
      ON ownership_result.ceremony_intent_id = session.ceremony_intent_id
     AND ownership_result.namespace_session_id = session.namespace_session_id
   WHERE job.attempt_count < 5
     AND (
       job.state = 'queued'
       OR (job.state = 'leased' AND job.lease_expires_at <= database_now)
     )
     AND session.status = 'provisioning'
     AND session.expires_at > database_now
     AND session.ownership_result_sha256 = ownership_result.result_hash
     AND ownership_result.outcome_status = 'satisfied'
   ORDER BY job.created_at, job.provision_job_id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE hns_authority_provision_jobs AS job
     SET state = 'leased',
         attempt_count = candidate.attempt_count + 1,
         lease_fence = candidate.lease_fence + 1,
         leased_by = input_executor_id,
         lease_expires_at = database_now + (input_lease_seconds * interval '1 second'),
         failure_code = NULL,
         updated_at = database_now
   WHERE job.provision_job_id = candidate.provision_job_id
  RETURNING job.provision_job_id, job.root_import_session_id,
            job.operation_kind, job.request_bytes, job.request_sha256,
            job.lease_fence, job.lease_expires_at
       INTO provision_job_id, root_import_session_id, operation_kind,
            request_bytes, request_sha256, lease_fence, lease_expires_at;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION finalize_hns_authority_provision_job_v1(
  input_provision_job_id TEXT,
  input_executor_id TEXT,
  input_lease_fence BIGINT,
  input_request_sha256 TEXT,
  input_outcome TEXT,
  input_publish_plan_bytes BYTEA,
  input_publish_plan_sha256 TEXT,
  input_result_bytes BYTEA,
  input_result_sha256 TEXT,
  input_failure_code TEXT
)
RETURNS TABLE (
  outcome TEXT,
  root_import_session_id TEXT,
  session_revision BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  job hns_authority_provision_jobs%ROWTYPE;
  session hns_root_import_sessions%ROWTYPE;
  database_now TIMESTAMPTZ := clock_timestamp();
  terminal_failure BOOLEAN;
BEGIN
  IF input_outcome NOT IN ('completed', 'retry', 'failed')
    OR input_request_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid HNS authority provision finalization';
  END IF;
  SELECT * INTO job
    FROM hns_authority_provision_jobs
   WHERE provision_job_id = input_provision_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;
  SELECT * INTO session
    FROM hns_root_import_sessions
   WHERE hns_root_import_sessions.root_import_session_id = job.root_import_session_id
   FOR UPDATE;
  IF job.state IN ('completed', 'failed') THEN
    IF (
      job.state = 'completed'
      AND input_outcome = 'completed'
      AND job.request_sha256 = input_request_sha256
      AND job.publish_plan_bytes = input_publish_plan_bytes
      AND job.publish_plan_sha256 = input_publish_plan_sha256
      AND job.result_bytes = input_result_bytes
      AND job.result_sha256 = input_result_sha256
      AND input_failure_code IS NULL
    ) OR (
      job.state = 'failed'
      AND input_outcome = 'failed'
      AND job.request_sha256 = input_request_sha256
      AND input_publish_plan_bytes IS NULL
      AND input_publish_plan_sha256 IS NULL
      AND input_result_bytes IS NULL
      AND input_result_sha256 IS NULL
      AND job.failure_code = input_failure_code
    ) THEN
      RETURN QUERY SELECT 'replayed'::TEXT, session.root_import_session_id, session.revision;
    ELSE
      RETURN QUERY SELECT 'conflict'::TEXT, session.root_import_session_id, session.revision;
    END IF;
    RETURN;
  END IF;
  IF job.state <> 'leased'
    OR job.leased_by <> input_executor_id
    OR job.lease_fence <> input_lease_fence
    OR job.lease_expires_at <= database_now
    OR job.request_sha256 <> input_request_sha256
    OR session.status <> 'provisioning'
    OR session.expires_at <= database_now
  THEN
    RETURN QUERY SELECT 'lost'::TEXT, session.root_import_session_id, session.revision;
    RETURN;
  END IF;

  IF input_outcome = 'completed' THEN
    IF input_publish_plan_bytes IS NULL
      OR input_publish_plan_sha256 IS NULL
      OR input_result_bytes IS NULL
      OR input_result_sha256 IS NULL
      OR octet_length(input_publish_plan_bytes) NOT BETWEEN 1 AND 1048576
      OR input_publish_plan_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_publish_plan_bytes), 'hex') <> input_publish_plan_sha256
      OR octet_length(input_result_bytes) NOT BETWEEN 1 AND 1048576
      OR input_result_sha256 !~ '^[0-9a-f]{64}$'
      OR encode(sha256(input_result_bytes), 'hex') <> input_result_sha256
      OR input_failure_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'invalid completed HNS authority provision result';
    END IF;
    UPDATE hns_authority_provision_jobs
       SET state = 'completed', leased_by = NULL, lease_expires_at = NULL,
           publish_plan_bytes = input_publish_plan_bytes,
           publish_plan_sha256 = input_publish_plan_sha256,
           result_bytes = input_result_bytes, result_sha256 = input_result_sha256,
           completed_at = database_now, updated_at = database_now
     WHERE hns_authority_provision_jobs.provision_job_id = input_provision_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'awaiting_owner_update', revision = session.revision + 1,
           publish_plan_bytes = input_publish_plan_bytes,
           publish_plan_sha256 = input_publish_plan_sha256,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY
      SELECT 'completed'::TEXT, session.root_import_session_id, session.revision + 1;
    RETURN;
  END IF;
  IF input_publish_plan_bytes IS NOT NULL
    OR input_publish_plan_sha256 IS NOT NULL
    OR input_result_bytes IS NOT NULL
    OR input_result_sha256 IS NOT NULL
    OR input_failure_code IS NULL
    OR btrim(input_failure_code) <> input_failure_code
    OR octet_length(input_failure_code) NOT BETWEEN 1 AND 128
    OR input_failure_code ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'invalid failed HNS authority provision result';
  END IF;
  terminal_failure := input_outcome = 'failed' OR job.attempt_count >= 5;
  IF terminal_failure THEN
    UPDATE hns_authority_provision_jobs
       SET state = 'failed', leased_by = NULL, lease_expires_at = NULL,
           failure_code = input_failure_code,
           completed_at = database_now, updated_at = database_now
     WHERE hns_authority_provision_jobs.provision_job_id = input_provision_job_id;
    UPDATE hns_root_import_sessions
       SET status = 'failed', revision = session.revision + 1,
           updated_at = database_now
     WHERE hns_root_import_sessions.root_import_session_id = session.root_import_session_id;
    RETURN QUERY
      SELECT 'failed'::TEXT, session.root_import_session_id, session.revision + 1;
  ELSE
    UPDATE hns_authority_provision_jobs
       SET state = 'queued', leased_by = NULL, lease_expires_at = NULL,
           failure_code = input_failure_code, updated_at = database_now
     WHERE hns_authority_provision_jobs.provision_job_id = input_provision_job_id;
    RETURN QUERY SELECT 'retry'::TEXT, session.root_import_session_id, session.revision;
  END IF;
END;
$$;

-- Bind security-invoker functions to the schema where this migration is
-- installed. A literal CURRENT here would capture a schema named "current".
DO $$
DECLARE
  installed_schema TEXT := current_schema();
  function_signature TEXT;
BEGIN
  IF installed_schema IS NULL THEN
    RAISE EXCEPTION 'HNS root-import migration requires a current schema';
  END IF;
  FOREACH function_signature IN ARRAY ARRAY[
    'guard_hns_root_import_session_change()',
    'guard_hns_root_import_session_insert()',
    'reject_hns_authority_provision_job_delete()',
    'begin_hns_root_import_provision_v1(text,text,text,bigint,text,text,text,text,bytea,text)',
    'begin_hns_root_import_observation_v1(text,text,text,bigint,text,text,text,text,bytea,text)',
    'claim_hns_root_import_observation_job_v1(text,integer)',
    'finalize_hns_root_import_ownership_v1(text,text,text,bigint,text,text)',
    'finalize_hns_root_import_observation_job_v1(text,text,bigint,text,text,bytea,text,text)',
    'claim_hns_authority_provision_job_v1(text,integer)',
    'finalize_hns_authority_provision_job_v1(text,text,bigint,text,text,bytea,text,bytea,text,text)'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path TO %I, pg_temp',
      installed_schema,
      function_signature,
      installed_schema
    );
  END LOOP;
END;
$$;
