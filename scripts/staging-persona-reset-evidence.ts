import { Schema } from "effect";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u));
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Snapshot = Schema.Struct({
  ledger: Digest,
  catalog: Digest,
  data: Digest,
  grants: Digest,
  extensions: Digest,
});

/** These are claims to compare, not a serializable capability to delete data. */
const Evidence = Schema.Struct({
  version: Schema.Literal(1),
  disposition: Schema.Literal("owner_authorized_disposable_staging"),
  source_sha: Schema.String,
  manifest_sha256: Digest,
  target: Schema.Struct({
    environment: Schema.Literal("staging"),
    provider: Schema.Literal("planetscale"),
    database_name: Schema.Literal("pirate-staging"),
    project_id: Identifier,
    database_id: Identifier,
    branch_id: Identifier,
    sql_database: Schema.Literal("postgres"),
    schema: Schema.Literal("api_next"),
    hyperdrive_id: Schema.Literal("8cb7658a0f7143359c1becfec6a15c23"),
    connection_fingerprint: Digest,
    admin_role_fingerprint: Digest,
    runtime_role_fingerprints: Schema.Array(Digest),
  }),
  fence: Schema.Struct({
    generation: Identifier,
    started_at: NonNegativeInteger,
    observed_at: NonNegativeInteger,
    valid_until: NonNegativeInteger,
    active_transactions: NonNegativeInteger,
    active_runtime_sessions: NonNegativeInteger,
    effective_runtime_denial: Schema.Boolean,
    cross_schema_dependencies: NonNegativeInteger,
    unresolved_dependencies: NonNegativeInteger,
    workers: Schema.Array(Identifier),
  }),
  source: Schema.Struct({
    fence_generation: Identifier,
    observed_at: NonNegativeInteger,
    snapshot: Snapshot,
    identity_row_count: NonNegativeInteger,
  }),
  recovery: Schema.Struct({
    fence_generation: Identifier,
    source_branch_id: Identifier,
    project_id: Identifier,
    database_id: Identifier,
    branch_id: Identifier,
    capture_id: Identifier,
    restore_point_id: Identifier,
    captured_at: NonNegativeInteger,
    verified_at: NonNegativeInteger,
    retained: Schema.Boolean,
    snapshot: Snapshot,
    identity_row_count: NonNegativeInteger,
  }),
  rehearsal: Schema.Struct({
    recovery_branch_id: Identifier,
    project_id: Identifier,
    capture_id: Identifier,
    restore_point_id: Identifier,
    database_id: Identifier,
    branch_id: Identifier,
    completed_at: NonNegativeInteger,
    connection_switch_verified: Schema.Boolean,
    representative_invariants_verified: Schema.Boolean,
    snapshot: Snapshot,
    identity_row_count: NonNegativeInteger,
  }),
});

const expectedWorkers = [
  "pirate-http-worker-staging",
  "pirate-jobs-worker-staging",
  "pirate-media-processor-worker-staging",
  "pirate-data-registration-worker-staging",
].sort();
const observationWindowMs = 5 * 60_000;

/**
 * Offline consistency check only. A future live preflight must independently
 * collect and bind these facts again inside the maintained writer fence.
 * No caller may treat this result or supplied JSON as reset authorization.
 * nowMs must come from the trusted caller clock, never from submitted evidence.
 */
export function validateResetEvidenceConsistency(input: unknown, nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid_clock");
  let evidence: typeof Evidence.Type;
  try {
    evidence = Schema.decodeUnknownSync(Evidence, { onExcessProperty: "error" })(input);
  } catch {
    // Schema issues contain submitted values; do not attach or log them.
    throw new Error("invalid_evidence");
  }
  const { target, fence, source, recovery, rehearsal } = evidence;
  if (
    target.runtime_role_fingerprints.length === 0 ||
    new Set(target.runtime_role_fingerprints).size !== target.runtime_role_fingerprints.length ||
    target.runtime_role_fingerprints.includes(target.admin_role_fingerprint)
  ) {
    throw new Error("runtime_roles");
  }
  if (
    evidence.source_sha !== STAGING_RESET_RELEASE.sourceSha ||
    evidence.manifest_sha256 !== STAGING_RESET_RELEASE.manifestSha256
  ) {
    throw new Error("release_mismatch");
  }
  if ([...fence.workers].sort().join("\n") !== expectedWorkers.join("\n")) {
    throw new Error("writer_closure");
  }
  if (
    !fence.effective_runtime_denial ||
    fence.active_transactions !== 0 ||
    fence.active_runtime_sessions !== 0 ||
    fence.cross_schema_dependencies !== 0 ||
    fence.unresolved_dependencies !== 0
  ) {
    throw new Error("unsafe_fence");
  }
  if (
    fence.observed_at > nowMs ||
    fence.valid_until <= nowMs ||
    nowMs - fence.observed_at > observationWindowMs ||
    fence.valid_until - fence.observed_at > observationWindowMs
  ) {
    throw new Error("stale_fence");
  }
  if (
    source.fence_generation !== fence.generation ||
    recovery.fence_generation !== fence.generation
  ) {
    throw new Error("fence_generation");
  }
  if (
    !(
      fence.started_at <= recovery.captured_at &&
      recovery.captured_at <= recovery.verified_at &&
      recovery.verified_at <= rehearsal.completed_at &&
      rehearsal.completed_at <= fence.observed_at &&
      fence.observed_at <= source.observed_at &&
      source.observed_at <= nowMs
    )
  ) {
    throw new Error("evidence_order");
  }
  if (
    recovery.project_id !== target.project_id ||
    rehearsal.project_id !== target.project_id ||
    recovery.database_id !== target.database_id ||
    rehearsal.database_id !== target.database_id ||
    recovery.source_branch_id !== target.branch_id ||
    rehearsal.recovery_branch_id !== recovery.branch_id ||
    rehearsal.capture_id !== recovery.capture_id ||
    rehearsal.restore_point_id !== recovery.restore_point_id ||
    new Set([target.branch_id, recovery.branch_id, rehearsal.branch_id]).size !== 3
  ) {
    throw new Error("recovery_identity");
  }
  if (
    !recovery.retained ||
    !rehearsal.connection_switch_verified ||
    !rehearsal.representative_invariants_verified ||
    source.identity_row_count === 0 ||
    source.identity_row_count !== recovery.identity_row_count ||
    source.identity_row_count !== rehearsal.identity_row_count
  ) {
    throw new Error("recovery_unproven");
  }
  for (const key of ["ledger", "catalog", "data", "grants", "extensions"] as const) {
    if (
      source.snapshot[key] !== recovery.snapshot[key] ||
      source.snapshot[key] !== rehearsal.snapshot[key]
    ) {
      throw new Error("snapshot_mismatch");
    }
  }
  return Object.freeze({
    consistency: "passed" as const,
    live_recheck_required: true as const,
    execution_authorized: false as const,
  });
}
