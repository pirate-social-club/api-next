import {
  DANCE_SERVING_FUNCTION_DENIALS,
  DANCE_SERVING_FUNCTION_GROUPS,
} from "./dance-serving-permission-contract.ts";

/** Full direct-call closure: transactions/advisory locks use pg_catalog; all
 * application authority is confined to these owner-defined entry points. */
export const SONG_FUNDING_FUNCTIONS = {
  http: [
    "bind_initial_shared_song_pot_v2(jsonb,text,jsonb)",
    "create_song_contribution_v2(jsonb,jsonb,text)",
    "enqueue_song_contribution_reconciliation_v2(jsonb,jsonb,jsonb)",
    "instantiate_shared_song_reward_policy_v2(jsonb,text,text,text,jsonb,text)",
    "load_owned_song_contribution_v2(jsonb)",
    "load_reward_funding_wallet_nonce_owner_v2(jsonb)",
    "load_shared_song_reward_template_v2(text,text)",
    "load_song_contribution_command_v2(text,text,text)",
    "load_song_contribution_recovery_v2(jsonb)",
    "lock_reward_wallet_nonce_sender_v2(bigint,text)",
    "lock_song_contribution_context_v2(jsonb,text)",
    "read_owned_song_contribution_current_v2(jsonb)",
    "read_shared_song_megapot_summary_v2(text,text,text)",
    "read_song_contribution_command_v2(jsonb,text,text)",
    "read_song_contribution_context_v2(jsonb,text)",
    "record_song_contribution_refusal_v2(jsonb,text,text)",
    "reserve_reward_funding_wallet_nonce_v2(jsonb)",
    "reward_wallet_nonce_context_v2(bigint,text,text)",
    "update_song_contribution_command_v2(jsonb,jsonb,jsonb,jsonb)",
  ],
  jobs: [
    "accept_reward_funding_principal_v2(jsonb)",
    "claim_next_shared_song_context_v2(text)",
    "claim_song_funding_work_v2(text,text)",
    "finish_shared_song_context_failure_v2(text,text,text)",
    "finish_song_funding_work_v2(text,text,jsonb)",
    "invalidate_song_recovery_evidence_v2(text,text,text)",
    "list_song_funding_work_v2(integer)",
    "load_owned_song_contribution_v2(jsonb)",
    "persist_shared_song_context_v2(text,text,jsonb,jsonb,jsonb,boolean)",
    "record_song_recovery_evidence_v2(text,text,jsonb)",
    "require_song_funding_work_lease_v2(text,text)",
    "require_reward_run_authority_v1()",
  ],
} as const;
export type SongFundingPurpose = keyof typeof SONG_FUNDING_FUNCTIONS;

export function songFundingRequirements(purpose: SongFundingPurpose) {
  const positive = new Set<string>(SONG_FUNDING_FUNCTIONS[purpose]);
  const all = new Set<string>([
    ...SONG_FUNDING_FUNCTIONS.http,
    ...SONG_FUNDING_FUNCTIONS.jobs,
    ...DANCE_SERVING_FUNCTION_DENIALS,
    ...Object.values(DANCE_SERVING_FUNCTION_GROUPS).flat(),
    "bind_reward_contribution_purpose_v2(text,text)",
    "grant_shared_song_funding_runtime_v2(text,text)",
    "acquire_reward_run_lease_v1(text,integer,integer)",
    "renew_reward_run_lease_v1(text,bigint,integer)",
    "release_reward_run_lease_v1(text,bigint)",
    "recover_song_funding_cancellation_v2(jsonb,bigint,bigint)",
  ]);
  return [...all].sort().map((name) => ({ name, execute: positive.has(name) }));
}
