/** Source-declared capabilities, not grants inferred from a live database. */
export const DANCE_SERVING_FUNCTION_GROUPS = {
  account: [
    "lock_moderated_dance_intake_command_v1(text,jsonb)",
    "load_moderated_dance_creation_facts_v1(text,jsonb)",
    "apply_moderated_dance_intake_v1(text,jsonb,text,text,jsonb,text,text)",
    "read_owned_moderated_dance_session_v1(text,text,text,text,text)",
    "read_moderated_dance_capture_options_v1(text,text,text,text)",
    "create_moderated_dance_reference_v1(text,jsonb,text,text,text)",
    "read_owned_moderated_dance_reference_v1(text,text,text,text)",
    "issue_moderated_dance_media_lease_v1(text,text,text,bigint,text,text)",
    "resolve_moderated_dance_media_lease_v1(text,text,text,text,boolean)",
    "lock_moderated_dance_review_v1(jsonb)",
    "read_moderated_dance_receipt_v1(jsonb)",
    "moderated_dance_review_facts_v1(text,jsonb,text,bigint)",
    "commit_moderated_dance_review_v1(jsonb)",
    "read_owned_moderated_dance_review_v1(text,text,text)",
    "read_owned_moderated_dance_publication_v1(text,text,text)",
    "latest_owned_moderated_dance_review_v1(text,text,text,text,bigint)",
    "owner_moderated_dance_queue_v1(text,text,text)",
    "owner_moderated_dance_detail_v1(text,text,text)",
    "read_owned_moderated_dance_capture_context_v1(text,text,text)",
    "read_moderated_dance_owner_rubric_v1(text,text,text)",
  ],
  worker: [
    "next_moderated_dance_review_task_v1()",
    "lock_moderated_dance_review_v1(jsonb)",
    "read_moderated_dance_receipt_v1(jsonb)",
    "moderated_dance_review_facts_v1(text,jsonb,text,bigint)",
    "commit_moderated_dance_review_v1(jsonb)",
  ],
  media: [
    "announce_moderated_dance_processor_v1(text,text,jsonb)",
    "claim_moderated_dance_media_v1(text,text,text,jsonb)",
    "persist_moderated_dance_seal_v1(text,text,jsonb)",
    "mark_moderated_dance_media_unknown_v1(text,text,text)",
    "attach_moderated_dance_provider_v1(text,text,text,text)",
    "issue_moderated_dance_source_v1(text,text,text,bigint)",
    "claim_moderated_dance_probe_v1(text,text)",
    "persist_moderated_dance_probe_v1(text,text,jsonb)",
    "claim_moderated_dance_normalization_v1(text,text)",
    "persist_moderated_dance_normalization_v1(text,text,jsonb,jsonb)",
    "moderated_dance_safety_protocol_v1(text,text,text,jsonb)",
    "load_moderated_dance_sealed_capture_v1(text,text)",
    "initialize_moderated_dance_review_v1(text,text,jsonb)",
    "claim_moderated_dance_reference_media_v1(text,text,jsonb)",
    "persist_moderated_dance_reference_segment_v1(text,text,jsonb)",
    "record_moderated_dance_reference_provider_v1(text,text,jsonb)",
    "claim_moderated_dance_reference_normalization_v1(text,text)",
    "attach_moderated_dance_reference_provider_v1(text,text,text,text)",
    "issue_moderated_dance_reference_source_v1(text,text,text)",
    "publish_moderated_dance_reference_v1(text,text,jsonb,jsonb)",
    "claim_moderated_dance_owned_cleanup_v1(text)",
    "finish_moderated_dance_owned_cleanup_v1(text,text,text,jsonb)",
    "record_moderated_dance_maintenance_v1()",
    "claim_moderated_dance_provider_cleanup_v1(text)",
    "identify_moderated_dance_provider_cleanup_v1(text,text,text,text)",
    "finish_moderated_dance_provider_cleanup_v1(text,text,jsonb)",
    "drain_moderated_dance_replay_v1()",
    "bind_moderated_dance_replay_keys_v1(jsonb)",
    "claim_moderated_dance_public_reindex_v1(text,jsonb)",
    "finish_moderated_dance_public_reindex_v1(text,bigint,text,text,jsonb)",
    "drain_moderated_dance_compatible_replay_v1()",
    "moderated_dance_publication_input_v1(text,text,jsonb)",
    "claim_moderated_dance_publication_cleanup_v1(text)",
    "finish_moderated_dance_publication_cleanup_v1(text,text,jsonb)",
    "claim_moderated_dance_publication_v1(text,text,boolean)",
    "drain_moderated_dance_publication_intents_v1()",
    "moderated_dance_publication_provider_v1(text,text,jsonb)",
  ],
  source_gateway: [
    "resolve_moderated_dance_source_v1(text)",
    "resolve_moderated_dance_reference_source_v1(text)",
    "resolve_moderated_dance_publication_source_v1(text)",
  ],
  notification_read: ["readable_recipient_notification_v2(text,text,text)"],
  notification_delivery: [
    "pending_recipient_notifications_v2()",
    "deliver_recipient_notification_v2(text)",
  ],
  song_summary: ["read_shared_song_megapot_summary_v2(text,text,text)"],
  wallet_lock: ["lock_wallet_send_palm_assertions_v1(text,text)"],
} as const;

export const DANCE_SERVING_FUNCTION_DENIALS = [
  "authorize_moderated_dance_intake_v1(text,text,text,boolean)",
  "begin_moderated_dance_account_erasure_v1(text)",
  "bind_moderated_dance_post_credit_v1()",
  "can_owner_read_moderated_dance_v1(text,text)",
  "capture_moderated_dance_attempt_provider_effects_v1()",
  "capture_moderated_dance_reference_provider_effect_v1()",
  "charge_moderated_dance_intake_v1(text,jsonb,boolean,boolean)",
  "create_song_contribution_v2(jsonb,jsonb,text)",
  "dance_review_worker_authorized_v1()",
  "fence_moderated_dance_account_delete_v1()",
  "grant_moderated_dance_runtime_v1(text,text)",
  "guard_moderated_dance_intake_usage_v1()",
  "guard_moderated_dance_provider_usage_v1()",
  "guard_moderated_dance_replay_epoch_v1()",
  "guard_moderated_dance_replay_retirement_v1()",
  "guard_moderated_dance_safety_call_v1()",
  "lock_moderated_dance_processing_authority_v1(text)",
  "moderated_dance_account_runtime_v1()",
  "moderated_dance_media_runtime_v1()",
  "moderated_dance_public_replay_ready_v1(text,text,text)",
  "moderated_dance_public_replay_requirements_v1()",
  "moderated_dance_publication_song_v1(jsonb)",
  "moderated_dance_replay_producer_profiles_v1()",
  "moderated_dance_safety_contract_v1()",
  "project_moderated_dance_owner_rubric_v1(text,text,text)",
  "project_moderated_dance_session_v1(text)",
  "project_owned_moderated_dance_capture_context_v1(text,text,text)",
  "publish_moderated_dance_policy_v1(jsonb)",
  "register_moderated_dance_provider_effect_v1(text,text,text,text,text,text,text,timestamp with time zone,jsonb,jsonb)",
  "reserve_moderated_dance_provider_work_v1(text,jsonb)",
  "reserve_reward_funding_wallet_nonce_v2(jsonb)",
  "retire_moderated_dance_replay_epoch_v1(text,text)",
] as const;

export const DANCE_SERVING_PRIVATE_TABLES = [
  "dance_moderated_active_slots_v1",
  "dance_moderated_choice_changes_v1",
  "dance_moderated_command_receipts_v1",
  "dance_moderated_consents_v1",
  "dance_moderated_erasure_queue_v1",
  "dance_moderated_frame_artifacts_v1",
  "dance_moderated_intake_commands_v1",
  "dance_moderated_intake_usage_v1",
  "dance_moderated_maintenance_readiness_v1",
  "dance_moderated_media_dispositions_v1",
  "dance_moderated_media_leases_v1",
  "dance_moderated_policy_disclosures_v1",
  "dance_moderated_processing_v1",
  "dance_moderated_processor_readiness_v1",
  "dance_moderated_provider_calls_v1",
  "dance_moderated_provider_effects_v1",
  "dance_moderated_provider_usage_v1",
  "dance_moderated_public_replay_indexes_v1",
  "dance_moderated_public_replay_v1",
  "dance_moderated_publication_cleanup_v1",
  "dance_moderated_publication_inputs_v1",
  "dance_moderated_publication_jobs_v1",
  "dance_moderated_publication_sources_v1",
  "dance_moderated_reference_commands_v1",
  "dance_moderated_reference_receipts_v1",
  "dance_moderated_reference_sources_v1",
  "dance_moderated_replay_claims_v1",
  "dance_moderated_replay_epoch_retirements_v1",
  "dance_moderated_replay_epochs_v1",
  "dance_moderated_replay_retirements_v1",
  "dance_moderated_result_events_v1",
  "dance_moderated_review_evidence_v1",
  "dance_moderated_review_intents_v1",
  "dance_moderated_reviews_v1",
  "dance_moderated_runtime_roles_v1",
  "dance_moderated_safety_evidence_v1",
  "dance_moderated_sessions_v1",
  "dance_moderated_source_grants_v1",
  "dance_moderated_uploads_v1",
  "dance_moderated_verdict_audits_v1",
  "dance_moderator_reference_cutoffs_v1",
  "dance_moderator_reference_revisions_v1",
  "dance_review_account_fences_v1",
  "dance_review_policy_admissions_v1",
  "dance_review_policy_versions_v1",
  "dance_review_result_deliveries_v1",
] as const;

type Group = keyof typeof DANCE_SERVING_FUNCTION_GROUPS;
export const DANCE_SERVING_CONSUMERS = {
  "apps/http-worker/wrangler.jsonc": [
    "account",
    "notification_read",
    "song_summary",
    "wallet_lock",
  ],
  "apps/jobs-worker/wrangler.jsonc": ["notification_delivery"],
  "apps/media-processor-worker/wrangler.jsonc": ["worker", "media"],
  "apps/video-source-gateway/wrangler.jsonc": ["source_gateway"],
} as const satisfies Readonly<Record<string, readonly Group[]>>;
export type DanceServingConsumer = keyof typeof DANCE_SERVING_CONSUMERS;
export const DANCE_SOURCE_GATEWAY_READ_TABLES = [
  "media_video_source_grants",
  "media_song_video_excerpt_grants",
  "media_song_video_render_attempts",
  "media_song_video_pcm_source_grants",
  "media_song_video_pcm_admissions",
  "media_publication_projections",
] as const;
export type DanceServingRequirement = Readonly<{
  name: string;
  boundary: "function" | "table" | "read_table";
  execute: boolean;
  path: "schema_first" | "wallet_lock";
  stable: boolean;
}>;
export function danceServingRequirements(
  config: DanceServingConsumer,
): readonly DanceServingRequirement[] {
  const grants = new Set<string>(
    DANCE_SERVING_CONSUMERS[config].flatMap((group) => [...DANCE_SERVING_FUNCTION_GROUPS[group]]),
  );
  return [
    ...(config === "apps/video-source-gateway/wrangler.jsonc"
      ? DANCE_SOURCE_GATEWAY_READ_TABLES.map((name) => ({
          name,
          boundary: "read_table" as const,
          execute: false,
          path: "schema_first" as const,
          stable: false,
        }))
      : []),
    ...[...grants].map((name) => ({
      name,
      boundary: "function" as const,
      execute: true,
      stable: (DANCE_SERVING_FUNCTION_GROUPS.source_gateway as readonly string[]).includes(name),
      path: name.startsWith("lock_wallet_send_palm_assertions_v1(")
        ? ("wallet_lock" as const)
        : ("schema_first" as const),
    })),
    ...DANCE_SERVING_FUNCTION_DENIALS.map((name) => ({
      name,
      boundary: "function" as const,
      execute: false,
      path: "schema_first" as const,
      stable: false,
    })),
    ...DANCE_SERVING_PRIVATE_TABLES.map((name) => ({
      name,
      boundary: "table" as const,
      execute: false,
      path: "schema_first" as const,
      stable: false,
    })),
  ];
}
export function danceServingPrivilegeParameters(schema: string, config: DanceServingConsumer) {
  const required = danceServingRequirements(config);
  return [
    schema,
    required.map((r) => r.name),
    required.map((r) => r.boundary),
    required.map((r) => r.execute),
    required.map((r) => r.path),
    required.map((r) => r.stable),
  ] as const;
}
