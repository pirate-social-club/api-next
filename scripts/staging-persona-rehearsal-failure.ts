import { createHash } from "node:crypto";

/** SQLSTATE, a message fingerprint, and the reason when it is one this
 * application owns. Never emit a driver message, query, detail, connection
 * string or attached cause.
 *
 * The digest alone meant an operator could not see why a run refused without
 * reproducing the failure by hand, which is what the 2026-09-09 r8 exercise had
 * to do to learn it was `reset_forbidden_privilege_effective`.
 *
 * The boundary is an explicit allowlist, not a shape. A lowercase-identifier
 * pattern is not a redaction boundary: a token, a role name or a database
 * identifier can satisfy it, and an arbitrary colon suffix can carry a value
 * outright. So only these literals are stated, and a suffix is stated only when
 * it comes from the finite set of stages its own code can produce. Everything
 * else — including an unlisted internal literal — stays behind the digest,
 * which costs diagnosability and never costs redaction.
 */
const REASONS: ReadonlySet<string> = new Set([
  // Target binding and rehearsal admission.
  "rehearsal_target_is_live_staging",
  "rehearsal_target_identifiers_collide",
  "rehearsal_target_backup_mismatch",
  "rehearsal_target_backup_source_mismatch",
  "rehearsal_target_not_restored_from_backup",
  "rehearsal_target_branch_mismatch",
  "rehearsal_target_branch_not_ready",
  "rehearsal_target_database_mismatch",
  "rehearsal_target_source_mismatch",
  "rehearsal_target_access_mismatch",
  "rehearsal_connection_unproven",
  "rehearsal_identity_changed",
  "rehearsal_operator_changed",
  "rehearsal_provider_role_changed",
  "rehearsal_reference_changed",
  "rehearsal_hyperdrive_changed",
  "rehearsal_hyperdrive_changed_after_reset",
  "rehearsal_backup_changed",
  "rehearsal_session_headroom_insufficient",
  "rehearsal_lock_headroom_insufficient",
  "rehearsal_capture_data_changed",
  // Verified literals from the supervised child and its direct modules. The
  // r10 attempt on 2026-09-13 failed with rehearsal_hyperdrive_exclusion_unproven
  // and reported a null reason because it was not listed; recovering it needed
  // a digest match. Each entry here is an exact literal in that path.
  "rehearsal_hyperdrive_exclusion_unproven",
  "rehearsal_backup_retention_unproven",
  "rehearsal_defaults_changed",
  "rehearsal_lock_observer_failed",
  "staging_provider_backup_unproven",
  "rehearsal_capacity_or_prepared_state_changed",
  "rehearsal_owned_session_missing",
  "rehearsal_session_input_unproven",
  "rehearsal_unexpected_session",
  "rehearsal_data_classes_unproven",
  "rehearsal_data_limit",
  "rehearsal_sequence_unproven",
  // The live launch binding and the release contracts it composes. Every
  // literal here is an exact message in staging-reset-release-live*.ts,
  // staging-reset-release-runtime.ts, staging-reset-release-executor.ts or the
  // staging-karaoke-release-* surfaces the live launcher binds. Arbitrary
  // exception text stays behind the digest; a shared describer without these
  // literals would hide the launcher's own refusals instead of redacting them.
  "staging_live_database_mismatch",
  "staging_live_branch_mismatch",
  "staging_live_branch_not_ready",
  "staging_live_branch_restored",
  "staging_live_access_mismatch",
  "staging_live_connection_unproven",
  "staging_live_branch_suffix_mismatch",
  "staging_live_roles_not_distinct",
  "staging_live_operator_identity_unproven",
  "staging_live_runtime_identity_unproven",
  "staging_live_runtime_identity_changed",
  "staging_live_provider_unproven",
  "staging_live_transport_scope_denied",
  "staging_live_baseline_reference_changed",
  "staging_live_operator_target_changed",
  "staging_live_defaults_unreviewed",
  "staging_live_fence_changed_restore_required",
  "staging_live_ingress_refence_unavailable",
  "staging_live_ingress_refence_unproven",
  "staging_live_ingress_probe_timeout",
  "staging_live_ingress_worker_unproven",
  "staging_live_solid_not_serving",
  "staging_live_configuration_missing",
  "staging_live_execution_unauthorized",
  "staging_live_cloudflare_token_missing",
  "staging_live_checkout_root_unresolved",
  "staging_live_deployment_input_unreviewed",
  "staging_live_deployment_input_duplicate",
  "staging_live_deployment_version_unpinned",
  "staging_live_release_plan_changed",
  "staging_live_release_order_changed",
  "staging_live_release_grant_digest_changed",
  "staging_live_release_queue_set_changed",
  "staging_live_release_serving_set_changed",
  "staging_live_upgrade_unexpected_dry_run",
  "staging_live_acceptance_session_failed",
  "staging_live_acceptance_persona_read_failed",
  "staging_live_acceptance_persona_unbound",
  "staging_reset_release_unresolved_restore_required",
  "staging_upgrade_failed_restore_required",
  "staging_release_upgrade_not_composed",
  "staging_release_completion_reentered",
  "staging_release_versions_receipt_missing",
  "staging_release_acceptance_before_ingress",
  "staging_release_hns_reentered",
  "staging_release_hns_before_database_receipt",
  "staging_release_service_refence_unbound",
  "staging_release_failed_after_recovery",
  "release_marker_handoff_missing",
  "karaoke_release_effect_unproven",
  "karaoke_release_clock_regressed",
  "karaoke_release_confirmation_time_unproven",
  "karaoke_release_surface_mismatch",
  "karaoke_release_provider_evidence_changed",
  "karaoke_release_plan_duplicate_target",
  // A code-only entry: the suffix is a human decision label from
  // missingDecision(), not a finite stage, so only the code is ever stated.
  "karaoke_release_plan_incomplete",
  "karaoke_release_database_target_changed",
  "karaoke_release_database_identity_changed",
  "karaoke_release_database_directive_changed",
  "karaoke_release_grants_changed",
  "karaoke_release_connect_unproven",
  "karaoke_release_runtime_identity_evidence_missing",
  "karaoke_release_runtime_role_underived",
  "karaoke_release_runtime_role_mismatch",
  "karaoke_release_ingress_application_changed",
  "karaoke_release_ingress_directive_changed",
  "karaoke_release_ingress_duplicate",
  "karaoke_release_ingress_inventory_changed",
  "karaoke_release_ingress_policy_changed",
  "karaoke_release_ingress_readback_changed",
  "karaoke_release_ingress_response_unproven",
  "karaoke_release_producer_directive_changed",
  "karaoke_release_producer_pins_incomplete",
  "karaoke_release_producers_not_fenced",
  "karaoke_release_producers_not_restored",
  "karaoke_release_queue_identity_changed",
  "karaoke_release_queue_response_unproven",
  "karaoke_release_schedule_response_unproven",
  "karaoke_release_schedules_not_fenced",
  "karaoke_release_versions_not_restored",
  "karaoke_release_versions_not_serving",
  "karaoke_release_deployment_readback_changed",
  "karaoke_release_deployment_unproven",
  "karaoke_release_inventory_incomplete",
  "karaoke_release_provider_response_unproven",
  "karaoke_release_transport_path_denied",
  "karaoke_release_transport_scope_denied",
  "karaoke_release_transport_timeout",
  // The authorized diagnostic stop, so a clean window is legible in the
  // receipt instead of hidden behind the digest.
  "diagnostic_stop_before_first_apply",
  // Local reference and recovery preconditions.
  "local_recovery_test_target_required",
  "local_measure_flag_required",
  "reference_postgres17_required",
  "postgres17_required",
  // Reset admission and privilege gates.
  "reset_forbidden_privilege_effective",
  "reset_runtime_elevated",
  "reset_runtime_identity_unproven",
  "reset_runtime_identity_invalid",
  "reset_runtime_unapproved_privilege",
  "reset_runtime_required_grant_missing",
  "reset_runtime_grant_option",
  "reset_grant_policy_conflict",
  "reset_new_grant_not_reviewed",
  "reset_reviewed_grants_unfulfilled",
  "reset_approved_privilege_manifest_mismatch",
  "reset_reference_digest_invalid",
  "reset_baseline_shape_mismatch",
  "reset_identity_state_not_empty",
  "reset_namespace_not_empty",
  "reset_prepared_transactions_present",
  "reset_preparation_cleanup_unresolved",
  "reset_completion_read_pending",
  "reset_completion_release_already_attempted",
  "reset_executor_completion_not_owned",
  "reset_release_retry_forbidden_restore_required",
  "reset_marker_exists_restore_required",
  "reset_marker_verification_required",
  "reset_target_identity_mismatch",
  "session_drain_unproven",
  "not_drained",
]);

/** Suffixes come only from these finite stage sets, never from a value. */
const SUFFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "provider_rehearsal_unproven",
    new Set(["target", "access_binding", "runtime_identity", "operator_identity", "operation"]),
  ],
  [
    "staging_target_binding_unproven",
    new Set(["credentials", "provider", "roles", "admin_binding", "runtime_binding"]),
  ],
  [
    "reset_removal_refused",
    new Set([
      "execution_unauthorized",
      "backup_unlinked",
      "data_digest_mismatch",
      "operator_visibility",
    ]),
  ],
  [
    "reset_preparation_incomplete",
    new Set(["runtime_identity", "operator_visibility", "forbidden_privileges"]),
  ],
  [
    "reset_preparation_gate_failed",
    new Set([
      "setup",
      "identity",
      "compile",
      "catalog",
      "visibility",
      "classify",
      "denial",
      "reset",
    ]),
  ],
  [
    "reset_admission_unproven",
    new Set([
      "marker",
      "policy",
      "reference",
      "budget",
      "connection",
      "fence_recovery",
      "baseline",
      "schema_authority",
      "runtime_identity",
      "grants",
      "replication",
      "marker_create",
      "inventory",
      "first_batch",
      "admitted",
    ]),
  ],
  [
    "rehearsal_target_unbound",
    new Set([
      "STAGING_REHEARSAL_BRANCH_ID",
      "STAGING_REHEARSAL_BRANCH_NAME",
      "STAGING_REHEARSAL_BACKUP_ID",
      "STAGING_REHEARSAL_DATA_SHA256",
    ]),
  ],
  [
    "rehearsal_target_invalid",
    new Set([
      "STAGING_REHEARSAL_BRANCH_ID",
      "STAGING_REHEARSAL_BRANCH_NAME",
      "STAGING_REHEARSAL_BACKUP_ID",
      "STAGING_REHEARSAL_DATA_SHA256",
    ]),
  ],
  ["staging_live_checkout_missing", new Set(["api", "solid"])],
  ["staging_live_checkout_unreviewed", new Set(["api", "solid"])],
]);

/** Structured categories a failure may carry through wrappers. Only these
 * labels cross a boundary; driver messages, queries, causes and credentials
 * never do. */
export const FAILURE_CATEGORIES = [
  "connection_exception",
  "query_canceled",
  "admin_shutdown",
  "timeout",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
const categorySet: ReadonlySet<string> = new Set(FAILURE_CATEGORIES);

const SOCKET_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export function structuredSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string" && SOCKET_CODES.has(record.code)) return null;
  const value =
    typeof record.sqlstate === "string"
      ? record.sqlstate
      : typeof record.code === "string"
        ? record.code
        : typeof record.sqlState === "string"
          ? record.sqlState
          : null;
  return value !== null && /^[0-9A-Z]{5}$/u.test(value) ? value : null;
}

export function structuredFailureCategory(error: unknown): FailureCategory | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (typeof record.category === "string" && categorySet.has(record.category))
    return record.category as FailureCategory;
  const code = record.code;
  if (typeof code !== "string") return null;
  if (SOCKET_CODES.has(code)) return "connection_exception";
  if (code === "ETIMEDOUT") return "timeout";
  if (/^[0-9A-Z]{5}$/u.test(code)) {
    if (code.startsWith("08")) return "connection_exception";
    if (code === "57014") return "query_canceled";
    if (code.startsWith("57P")) return "admin_shutdown";
    return null;
  }
  return null;
}

/** A refusal that names a reason and carries only a fixed structured category.
 * The optional cause is kept in the error chain for in-process diagnosis; it
 * is never rendered, logged or hashed, and `describeRehearsalFailure` sees
 * only the message. */
export class StructuredRefusal extends Error {
  readonly category: FailureCategory | null;
  readonly sqlstate: string | null;
  constructor(
    message: string,
    options: {
      readonly category?: FailureCategory | null;
      readonly sqlstate?: string | null;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StructuredRefusal";
    this.category = options.category ?? null;
    this.sqlstate = options.sqlstate ?? null;
  }
}

/** Exported because a reason must survive more than one boundary. The rehearsal
 * operator wrapper converts whatever it catches into its own phase failure, so
 * without this a preparation refusal that already names its cause arrives as
 * `provider_rehearsal_unproven:operation` and the prerequisite that actually
 * failed is lost. Re-sanitizing at each boundary keeps the redaction rule in one
 * place rather than trusting an inner layer's output. */
export function allowlistedReason(message: string): string | null {
  if (REASONS.has(message)) return message;
  const separator = message.indexOf(":");
  if (separator < 0) return null;
  const code = message.slice(0, separator);
  const suffix = message.slice(separator + 1);
  // A known code with an unknown suffix keeps the code and drops the suffix:
  // the code is ours, the suffix may be anything.
  if (SUFFIXES.get(code)?.has(suffix)) return message;
  if (SUFFIXES.has(code) || REASONS.has(code)) return code;
  return null;
}

export function describeRehearsalFailure(error: unknown) {
  const message = error instanceof Error ? error.message : null;
  return {
    sqlstate: structuredSqlState(error),
    reason: message === null ? null : allowlistedReason(message),
    category: structuredFailureCategory(error),
    message_sha256: message === null ? null : createHash("sha256").update(message).digest("hex"),
  };
}
