/**
 * Function EXECUTE the ordinary serving role needs after migrations 0247-0268
 * and the separately classified browser-session migration0330.
 *
 * Those migrations make every function they define owner-only and infer no
 * role grant. Ordinary account code calls the functions below directly, so the
 * serving role needs EXECUTE on exactly these. Every other function those
 * migrations define stays private to the schema owner: generic upload helpers,
 * operator and legacy settlement, and every guest-study authority, which the
 * separate guest-role ceremony binds. `db/postgres/roles.sql.example` carries
 * the matching grant block, and a test keeps the two equal.
 */
export const SERVING_FUNCTION_EXECUTE_GRANTS = [
  { signature: "create_browser_session_v1(jsonb)", purpose: "owned browser sign-in" },
  { signature: "read_browser_session_access_v1(text,text,text)", purpose: "owned browser access" },
  {
    signature: "read_browser_session_renewal_v1(text,text,text,text)",
    purpose: "owned browser renewal",
  },
  { signature: "renew_browser_session_v1(text,text,text,text)", purpose: "owned browser renewal" },
  {
    signature: "revoke_browser_session_v1(text,text,text,text,text)",
    purpose: "owned browser logout",
  },
  {
    signature: "settle_account_spoken_provider_refusal_private_v1(jsonb,integer)",
    purpose: "account spoken Study recovery",
  },
  {
    signature: "read_account_study_spoken_block_private_v1(text,text,text)",
    purpose: "account spoken Study recovery",
  },
  {
    signature: "require_account_study_spoken_available_private_v1(text,text,text)",
    purpose: "account spoken Study recovery",
  },

  {
    signature: "provision_account_participation_owner_v1(text)",
    purpose: "registration and Telegram learner birth",
  },
  {
    signature: "lock_original_account_audio_source_private_v1(text)",
    purpose: "account Study and Karaoke capture",
  },
  {
    signature: "capture_account_study_audio_private_v1(text,text,text,text)",
    purpose: "account Study capture",
  },
  {
    signature: "require_account_spoken_success_private_v1(text,jsonb)",
    purpose: "account spoken Study",
  },
  {
    signature: "require_account_spoken_archive_private_v1(text,text,text)",
    purpose: "account spoken Study",
  },
  {
    signature:
      "find_account_spoken_success_private_v1(text,text,text,integer,text,text,text,bigint,integer)",
    purpose: "account spoken Study",
  },
  { signature: "begin_account_spoken_provider_private_v1(text)", purpose: "account spoken Study" },
  {
    signature: "mark_account_spoken_provider_unknown_private_v1(text)",
    purpose: "account spoken Study",
  },
  {
    signature: "persist_account_spoken_success_private_v1(text,jsonb)",
    purpose: "account spoken Study",
  },
  { signature: "load_account_spoken_success_private_v1(text)", purpose: "account spoken Study" },
  {
    signature: "list_closed_account_spoken_checkpoints_private_v1(integer)",
    purpose: "account spoken recovery",
  },
  { signature: "claim_captured_learner_audio_private_v1(jsonb)", purpose: "learner audio archive" },
  {
    signature: "require_captured_learner_audio_private_v1(jsonb)",
    purpose: "learner audio archive",
  },
  {
    signature: "settle_learner_audio_terminal_fact_private_v1(text,text,boolean,text,jsonb)",
    purpose: "learner audio archive",
  },
  {
    signature: "continue_captured_learner_audio_private_v1(jsonb)",
    purpose: "Karaoke multipart archive",
  },
  {
    signature: "note_learner_audio_multipart_id_private_v1(text,text)",
    purpose: "Karaoke multipart archive",
  },
  {
    signature: "prepare_account_audio_delete_private_v1(text,integer)",
    purpose: "account audio deletion",
  },
  {
    signature: "fail_account_audio_delete_private_v1(text,bigint)",
    purpose: "account audio deletion",
  },
  {
    signature: "confirm_account_audio_delete_private_v1(text,bigint,timestamp with time zone)",
    purpose: "account audio deletion",
  },
  {
    signature: "capture_account_karaoke_audio_private_v1(text,text,text)",
    purpose: "Karaoke capture",
  },
  {
    signature: "require_captured_karaoke_recording_result_private_v1(text,text,text,text,jsonb)",
    purpose: "Karaoke result",
  },
  {
    signature: "read_account_karaoke_audio_capture_private_v1(text,text,text,text)",
    purpose: "Karaoke attempt host",
  },
  {
    signature: "cancel_unclaimed_account_karaoke_audio_private_v1(text,text,text,text,jsonb)",
    purpose: "Karaoke attempt host",
  },
] as const satisfies readonly { signature: string; purpose: string }[];

/** Owner-only functions from migrations 0247-0268 the serving role must not execute. */
export const SERVING_FUNCTION_EXECUTE_DENIALS = [
  "guard_browser_session_v1()",
  "browser_session_packet_v1(browser_sessions)",
  "browser_session_account_matches_v1(text,text)",
  "initialize_song_owner_policy_v1()",
  // The attempt host exposes this deletion stop, but nothing calls it yet.
  "require_captured_audio_deletion_stop_private_v1(jsonb)",
  "acknowledge_guest_rotation_v1(text,text[],text,text,text)",
  "acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)",
  "apply_guest_json_item_mutation_v1(jsonb,jsonb,jsonb,jsonb,text,text)",
  "apply_guest_lesson_transition_private_v1(text,text,integer,text,integer,text,timestamp with time zone)",
  "apply_guest_spoken_item_mutation_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb)",
  "can_guest_access_activity_song_v1(text,text)",
  "capture_guest_audio_retention_private_v1()",
  "capture_guest_spoken_dispatch_private_v1(text,jsonb,text,text,text,text,text,bigint,boolean)",
  "claim_guest_audio_io_private_v1(jsonb)",
  "claim_learner_audio_upload_private_v1(text)",
  "cleanup_guest_authority_v1(text,text[],text[],text,text[],text[])",
  "close_unclaimed_learner_audio_private_v1(text)",
  "commit_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text,text,boolean)",
  "complete_guest_provider_call_v1(text,jsonb,text,text,text,text,text)",
  "confirm_captured_audio_cleanup_private_v1(text,text,text,timestamp with time zone)",
  "confirm_guest_ephemeral_audio_cleanup_private_v1(text,text,text,timestamp with time zone)",
  "confirm_guest_owner_audio_delete_v1(jsonb,text,timestamp with time zone)",
  "confirm_guest_pending_v1(text,text[],text,text)",
  "confirm_learner_audio_delete_private_v1(text,bigint,text,timestamp with time zone)",
  "converge_proved_empty_guest_sources_v1(text,text[])",
  "create_guest_attachment_intent_v1(text,text[],text,text,text[],text,text,text,text,text)",
  "discover_guest_authority_v1(text,text[],text,text,text)",
  "fail_guest_owner_audio_delete_v1(jsonb,text)",
  "fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)",
  "fail_learner_audio_delete_private_v1(text,text)",
  "find_guest_owner_audio_delete_v1(jsonb,text,text)",
  "find_guest_study_start_operation_v1(jsonb,text,text,text,text)",
  "find_owner_guest_spoken_success_for_audio_v1(jsonb,text,text,text,text,integer,text,text,integer,integer)",
  "finish_guest_json_answer_v1(jsonb,text,jsonb,jsonb)",
  "finish_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb,jsonb)",
  "guard_account_audio_provider_call_private_v1()",
  "guard_captured_audio_cleanup_private_v1()",
  "guard_controlled_guest_study_session_v1()",
  "guard_guest_credential_insert_v1()",
  "guard_guest_credential_v1()",
  "guard_guest_empty_alias_v1()",
  "guard_guest_intent_v1()",
  "guard_guest_issuance_lineage_v1()",
  "guard_guest_operation_v1()",
  "guard_guest_resource_provider_call_v1()",
  "guard_guest_resource_session_v1()",
  "guard_karaoke_recording()",
  "guard_learner_audio_control_state_private_v1()",
  "guard_learner_audio_legacy_settlement_private_v1()",
  "guard_participation_owner_v1()",
  "guest_attachment_operation_identity_v1(text)",
  "guest_authority_component_is_empty_v1(text)",
  "guest_authority_issue_operation_v1(text)",
  "guest_authority_metadata_v1(text,text[],text)",
  "guest_ephemeral_object_closed_private_v1(text)",
  "guest_ephemeral_owner_delete_witness_private_v1(text)",
  "guest_ephemeral_pending_cleanup_ready_private_v1(text)",
  "guest_ephemeral_upload_ready_private_v1(text)",
  "guest_owner_audio_delete_projection_private_v1(text)",
  "guest_resource_component_has_history_v1(text[])",
  "guest_resource_usage_v1(text[],timestamp with time zone)",
  "guest_spoken_component_has_history_private_v1(text[])",
  "guest_study_answer_resource_scope_v1(text,text,text,integer,text)",
  "guest_study_prepared_rows_v1(text,text)",
  "guest_study_start_resource_scope_v1(text,text)",
  "issue_guest_pending_v1(text,text[],text,text,text,text,text,text,text)",
  "issue_guest_rotation_v1(text,text[],text,text,text,text,text,text,text)",
  "karaoke_audio_target_can_tombstone_private_v1(text,text,text)",
  "learner_audio_component_has_history_private_v1(text[])",
  "learner_audio_producer_component_has_history_private_v1(text[])",
  "learner_audio_source_component_private_v1(text[])",
  "list_guest_practice_participations_v1(jsonb,text,integer)",
  "list_guest_spoken_closed_recovery_v1(integer)",
  "load_guest_spoken_success_private_v1(text,jsonb,text,text)",
  "lock_account_audio_group_private_v1(text)",
  "lock_guest_authority_sources_v1(text,text[])",
  "lock_guest_cleanup_components_v1(text,text[],text[])",
  "lock_guest_resource_budget_v1(text,text)",
  "lock_learner_audio_sources_private_v1(text[])",
  "map_controlled_guest_learning_source_v1()",
  "map_existing_account_learning_source_v1()",
  "persist_guest_spoken_success_private_v1(text,jsonb,text,text,jsonb,jsonb)",
  "persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)",
  "prepare_captured_audio_cleanup_private_v1(jsonb)",
  "prepare_guest_attachment_target_v1(text,text[],text,text,text[],text,text,text)",
  "prepare_guest_captured_audio_cleanup_private_v1(jsonb)",
  "prepare_guest_json_answer_v1(jsonb,jsonb,text,text,text,integer,jsonb)",
  "prepare_guest_owner_audio_delete_v1(jsonb,jsonb,integer)",
  "prepare_guest_spoken_finalization_v1(text,jsonb,text)",
  "prepare_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb)",
  "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
  "prepare_next_guest_ephemeral_audio_cleanup_private_v1()",
  "preserve_learning_source_identity_v1()",
  "project_owner_study_session_private_v1(text,text,text)",
  "read_captured_learner_audio_private_v1(text)",
  "read_guest_audio_io_capture_private_v1(text)",
  "read_guest_browser_proof_snapshot_v1(text,jsonb,jsonb,boolean)",
  "read_guest_credential_proof_matches_v1(text,jsonb,boolean)",
  "read_guest_learning_lease_observation_v1(text,text,text)",
  "read_guest_owner_audio_delete_batch_private_v1(text)",
  "read_guest_spoken_capture_private_v1(text,jsonb,text,text)",
  "read_guest_spoken_closed_recovery_v1(text)",
  "read_guest_spoken_context_v1(jsonb,text,text,text,text)",
  "read_guest_study_session_snapshot_v1(jsonb,text,text)",
  "read_learner_audio_upload_status_private_v1(text)",
  "read_original_account_study_answer_receipt_v1(jsonb,text,text,text,text,text)",
  "read_original_account_study_source_v1(jsonb,text,text,text)",
  "read_owner_guest_answer_operation_v1(jsonb,text,jsonb,text,text,text,integer)",
  "read_owner_guest_answer_source_v1(jsonb,text,text,text)",
  "read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)",
  "read_owner_guest_spoken_dispatch_context_v1(jsonb,text,text,text,text)",
  "read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)",
  "read_owner_study_session_snapshot_v1(jsonb,text,text)",
  "register_learner_audio_upload_private_v1(text,text,text,text,text,text,text,text,bigint)",
  "reject_guest_copresent_established_conflict_v1(text,text[],text)",
  "reject_guest_immutable_mutation_v1()",
  "release_guest_resource_session_v1(text,jsonb,text,text,text)",
  "release_next_guest_study_resource_remainder_v1()",
  "renew_guest_authority_v1(text,text[],text,text)",
  "require_existing_account_participation_owner_v1(text)",
  "require_guest_answer_operation_private_v1(text,jsonb,text,text,text,text,integer,text)",
  "require_guest_audio_io_capture_private_v1(jsonb)",
  "require_guest_audio_recovery_access_private_v1(jsonb,text)",
  "require_guest_learning_runtime_role_v1(regrole)",
  "require_guest_practice_only_schema_phase_v1()",
  "require_guest_resource_success_checkpoint_v1(text,text,text,text,numeric)",
  "require_guest_review_schedule_private_v1(jsonb,timestamp with time zone)",
  "require_guest_spoken_resource_plan_v1(text,text,text,boolean)",
  "require_guest_study_composition_v1()",
  "require_guest_study_learning_access_v1(jsonb,text)",
  "require_owner_guest_source_private_v1(jsonb)",
  "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)",
  "reserve_guest_provider_call_v1(text,jsonb,text,text,integer,text,text)",
  "reserve_guest_resource_session_v1(text,jsonb,text,integer,text,text,jsonb)",
  "reserve_guest_spoken_answer_v1(jsonb,jsonb,text,jsonb,text,bigint,jsonb,text,boolean,text,text,text)",
  "resolve_guest_audio_io_capture_private_v1(jsonb,jsonb,text,text,bigint,text)",
  "resolve_guest_empty_owner_root_v1(text)",
  "retain_learner_audio_immutable_private_v1()",
  "select_guest_study_start_plan_v1(text,text,text,text,text)",
  "set_guest_learning_retention_v1(jsonb,jsonb,text)",
  "settle_guest_audio_io_private_v1(jsonb,text,boolean)",
  "settle_learner_audio_upload_private_v1(text,text,boolean,text)",
  "settle_legacy_learner_audio_upload_private_v1(text,text,jsonb)",
  "transition_guest_json_answer_v1(jsonb,text,jsonb,jsonb,jsonb)",
  "transition_guest_spoken_answer_v1(text,jsonb,text,jsonb,jsonb,jsonb)",
  "validate_guest_alias_state_v1()",
  "validate_guest_recovery_operation_private_v1(jsonb,text)",
  "validate_guest_resource_operation_v1(text,jsonb,text)",
  "validate_guest_resource_policy_v1(jsonb)",
  "validate_study_attempt_audio_source_v1()",
  "validate_study_command_audio_source_v1()",
] as const;

/** First and last migrations whose private functions these lists classify. */
export const SERVING_FUNCTION_PRIVILEGE_MIGRATIONS = {
  first: 247,
  last: 268,
  additional: [330],
} as const;

/**
 * SELECT-only facts from the executing connection, including inherited access.
 * $1 is the schema, $2 the signatures and $3 whether each must be executable.
 */
export const SERVING_FUNCTION_PRIVILEGES_SQL = `SELECT
  current_user::text AS runtime_role, required.signature, required.expected_execute,
  COALESCE(has_schema_privilege(current_user, n.oid, 'USAGE'), FALSE) AS schema_usage,
  p.oid IS NOT NULL AS function_exists,
  COALESCE(p.pronamespace = anchor.relnamespace AND p.proowner = anchor.relowner, FALSE) AS anchored_owner,
  COALESCE(p.prosecdef, FALSE) AS security_definer,
  COALESCE(p.proconfig = ARRAY['search_path=pg_catalog, ' || quote_ident(n.nspname) || ', pg_temp'], FALSE) AS pinned_search_path,
  -- MEMBER covers direct and indirect membership whatever its INHERIT or SET
  -- option: a role that can SET ROLE to the owner executes every denial.
  COALESCE(pg_has_role(current_user, p.proowner, 'MEMBER'), FALSE) AS owner_equivalent,
  COALESCE(has_function_privilege(current_user, p.oid, 'EXECUTE'), FALSE) AS can_execute
FROM unnest($2::text[], $3::boolean[]) AS required(signature, expected_execute)
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = $1
LEFT JOIN pg_catalog.pg_class anchor ON anchor.relnamespace = n.oid AND anchor.relname = 'participation_owners'
LEFT JOIN pg_catalog.pg_proc p
  ON p.oid = pg_catalog.to_regprocedure(quote_ident(n.nspname) || '.' || required.signature)`;

export function servingFunctionPrivilegeParameters(schema: string) {
  const grants = SERVING_FUNCTION_EXECUTE_GRANTS.map((grant) => grant.signature);
  return [
    schema,
    [...grants, ...SERVING_FUNCTION_EXECUTE_DENIALS],
    [...grants.map(() => true), ...SERVING_FUNCTION_EXECUTE_DENIALS.map(() => false)],
  ] as const;
}

export class ServingFunctionPrivilegesRefused extends Error {
  constructor(readonly failures: readonly string[]) {
    super("Serving-role function privileges refused");
  }
}

/** Returns the serving role; failures name signatures and facts, never values. */
export function assertServingFunctionPrivileges(rows: readonly Record<string, unknown>[]): string {
  const expected = SERVING_FUNCTION_EXECUTE_GRANTS.length + SERVING_FUNCTION_EXECUTE_DENIALS.length;
  const role = rows[0]?.runtime_role;
  if (rows.length !== expected || typeof role !== "string" || role.length === 0)
    throw new ServingFunctionPrivilegesRefused(["privilege facts incomplete"]);
  const failures: string[] = [];
  const seen = new Set<unknown>();
  for (const row of rows) {
    const signature = String(row.signature);
    if (row.runtime_role !== role || seen.has(row.signature))
      failures.push(`${signature}: facts differ`);
    seen.add(row.signature);
    if (row.schema_usage !== true) failures.push(`${signature}: schema usage missing`);
    if (row.function_exists !== true) failures.push(`${signature}: function missing`);
    if (row.anchored_owner !== true) failures.push(`${signature}: schema or owner differs`);
    // A granted entry point runs as the owner with a fixed search_path. Denied
    // helpers and triggers keep whatever shape their migration gave them.
    if (row.expected_execute === true && row.security_definer !== true)
      failures.push(`${signature}: not security definer`);
    if (row.expected_execute === true && row.pinned_search_path !== true)
      failures.push(`${signature}: search_path not pinned`);
    if (row.owner_equivalent !== false)
      failures.push(`${signature}: serving role is owner-equivalent`);
    if (row.can_execute !== row.expected_execute)
      failures.push(
        `${signature}: ${row.expected_execute === true ? "EXECUTE missing" : "EXECUTE must be denied"}`,
      );
  }
  if (failures.length > 0) throw new ServingFunctionPrivilegesRefused(failures);
  return role;
}
