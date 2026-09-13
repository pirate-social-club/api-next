-- HNS single-owner readiness cutover preflight.
--
-- Ratified specification: spec 012 section "HNS single-owner readiness
-- cutover - 2026-09-11" (anchor hns-single-owner-readiness-cutover-v1).
--
-- This migration runs before the removal migration and is committed
-- independently of it. It inspects sessions directly, not observation jobs,
-- so a session whose observation work is absent or already completed is
-- still classified. Every session that has no lifecycle row cannot be given
-- a deterministic migration-matrix target by the removal migration, so its
-- `readiness_single_owner_cutover_unresolved` disposition is persisted here:
-- session identity, observed blocker, the fresh evidence required to resolve
-- it, and the operator-authorized recovery and adoption owner.
--
-- The removal migration refuses by identity while an open disposition
-- exists. If it refuses, its transaction rolls back, but these durable
-- diagnostic rows remain because they were committed here. Resolution
-- converts the session to a migration-matrix target or retires it under the
-- retention rules before removal is retried.

CREATE TABLE hns_readiness_single_owner_cutover_unresolved (
    unresolved_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    root_import_session_id text NOT NULL,
    blocker text NOT NULL,
    required_evidence jsonb NOT NULL,
    recovery_owner text NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    resolved_at timestamp with time zone,
    resolution text,
    CONSTRAINT hns_readiness_cutover_unresolved_identity_shape CHECK (
      btrim(root_import_session_id) = root_import_session_id
      AND octet_length(root_import_session_id) BETWEEN 1 AND 256
      AND root_import_session_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT hns_readiness_cutover_unresolved_blocker_check CHECK (
      blocker = 'missing_lifecycle_row'
    ),
    CONSTRAINT hns_readiness_cutover_unresolved_evidence_shape CHECK (
      jsonb_typeof(required_evidence) = 'array'
      AND jsonb_array_length(required_evidence) > 0
    ),
    CONSTRAINT hns_readiness_cutover_unresolved_owner_check CHECK (
      recovery_owner = 'operator_authorized_recovery_adoption'
    ),
    CONSTRAINT hns_readiness_cutover_unresolved_resolution_shape CHECK (
      (resolved_at IS NULL) = (resolution IS NULL)
      AND (resolved_at IS NULL OR resolved_at >= observed_at)
      AND (resolution IS NULL OR (
        btrim(resolution) = resolution
        AND octet_length(resolution) BETWEEN 1 AND 128
        AND resolution !~ '[[:cntrl:]]'
      ))
    )
);

-- One open disposition per session; resolved history is retained.
CREATE UNIQUE INDEX hns_readiness_cutover_unresolved_open_key
    ON hns_readiness_single_owner_cutover_unresolved (root_import_session_id)
    WHERE resolved_at IS NULL;

-- The scanner is session-based on purpose: an operation whose observation
-- job is absent, completed, or failed still reaches the removal migration
-- through its session row. The evidence list is the recovery path's input:
-- a fresh qualifying current read, a fresh safe read, and the session/plan
-- binding that ties the new evidence to the published plan.
INSERT INTO hns_readiness_single_owner_cutover_unresolved (
  root_import_session_id, blocker, required_evidence, recovery_owner
)
SELECT session.root_import_session_id,
       'missing_lifecycle_row',
       jsonb_build_array(
         jsonb_build_object(
           'kind', 'current_view_read',
           'fresh', true,
           'purpose', 'qualifying current observation of the published plan'
         ),
         jsonb_build_object(
           'kind', 'safe_view_read',
           'fresh', true,
           'purpose', 'safe commitment evidence in the current generation'
         ),
         jsonb_build_object(
           'kind', 'session_plan_binding',
           'purpose', 'bind the fresh evidence to the session and its published plan'
         )
       ),
       'operator_authorized_recovery_adoption'
  FROM hns_root_import_sessions AS session
 WHERE NOT EXISTS (
   SELECT 1
     FROM hns_root_import_lifecycle AS lifecycle
    WHERE lifecycle.root_import_session_id = session.root_import_session_id
 )
ON CONFLICT (root_import_session_id) WHERE resolved_at IS NULL DO NOTHING;

REVOKE ALL ON TABLE hns_readiness_single_owner_cutover_unresolved FROM PUBLIC;
