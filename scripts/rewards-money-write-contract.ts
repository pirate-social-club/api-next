/** Reviewed destructive-write boundary; legitimate runtime deletes live outside this inventory. */
/**
 * Money tables created after migration 0232, which revoked destructive
 * privileges from every table that existed then. Each of these has its
 * inherited privileges removed by the migration that creates it instead.
 */
export const REWARDS_MONEY_TABLES_AFTER_0232: Readonly<Record<string, readonly string[]>> = {
  "0242_reward_operations_run_lease.sql": [
    "reward_operations_run_lease",
    "reward_operations_run_lease_events",
  ],
  "0277_reward_wallet_nonce_authority_v2.sql": ["reward_wallet_nonce_leases"],
  "0278_song_megapot_contributions_v2.sql": [
    "reward_funding_profiles_v2",
    "reward_funding_schedule_witnesses_v2",
    "reward_song_slots_v2",
    "reward_funding_leg_snapshots_v2",
    "song_megapot_contributions_v2",
    "song_megapot_contribution_commands_v2",
    "reward_funding_submission_claims_v2",
    "reward_contribution_reservations_v2",
    "reward_funding_account_counters_v2",
    "reward_funding_work_envelopes_v2",
    "reward_funding_scan_checkpoints_v2",
    "reward_incoming_receipts_v2",
  ],
  "0279_reward_principal_seals_v2.sql": [
    "reward_pool_cohort_seals_v2",
    "reward_pool_cohort_members_v2",
    "reward_late_principal_liabilities_v2",
  ],
  "0284_shared_song_megapot_production.sql": [
    "reward_shared_song_templates_v2",
    "reward_shared_song_template_admissions_v2",
    "reward_song_context_work_v2",
    "reward_context_work_counters_v2",
  ],
  "0285_shared_song_qualification_consumers.sql": ["reward_activity_objective_captures_v2"],
  "0321_song_funding_cancellation_recovery.sql": ["reward_funding_cancellation_proofs_v2"],
  "0324_reward_safe_receipt_refunds.sql": [
    "reward_safe_refunds_v1",
    "reward_safe_refund_attempts_v1",
    "reward_safe_refund_completions_v1",
  ],
  "0326_reward_joint_cycle_fairness.sql": ["reward_joint_cycle_turn_v1"],
  "0312_reward_safe_execution_scans.sql": [
    "reward_safe_execution_cursors",
    "reward_safe_unbound_executions",
  ],
};

export const REWARDS_MONEY_TABLES = [
  "reward_joint_cycle_turn_v1",
  "custody_solvency_observations",
  "megapot_allocation_batches",
  "megapot_allocations",
  "megapot_claim_effects",
  "megapot_claim_receipt_evidence",
  "megapot_deployment_attestations",
  "megapot_drawing_observations",
  "megapot_drawing_sweeps",
  "megapot_fallback_cutoff_activity_evidence",
  "megapot_fallback_cutoff_evidence",
  "megapot_participant_claim_guards",
  "megapot_participant_claims",
  "megapot_pool_beneficiary_snapshots",
  "megapot_pool_commitment_effects",
  "megapot_pool_drawing_transitions",
  "megapot_pool_drawings",
  "megapot_pool_shares",
  "megapot_pool_snapshot_private_leaves",
  "megapot_purchase_receipt_evidence",
  "megapot_sweep_ticket_evidence",
  "megapot_ticket_inventory",
  "megapot_ticket_purchase_effects",
  "megapot_ticket_review_evidence",
  "megapot_usdc_approval_effects",
  "megapot_usdc_approval_receipt_evidence",
  "platform_referral_revenue_ledger",
  "platform_sponsorship_budget_entries",
  "platform_sponsorship_budgets",
  "reward_activity_objective_captures_v2",
  "reward_activity_availability_observations",
  "reward_asset_whitelist",
  "reward_chain_effect_transitions",
  "reward_chain_effects",
  "reward_contribution_reservations_v2",
  "reward_context_work_counters_v2",
  "reward_eligibility_decisions",
  "reward_erc20_transfer_receipt_evidence",
  "reward_funding_account_counters_v2",
  "reward_funding_cancellation_proofs_v2",
  "reward_funding_leg_snapshots_v2",
  "reward_funding_profiles_v2",
  "reward_funding_scan_checkpoints_v2",
  "reward_funding_schedule_witnesses_v2",
  "reward_funding_submission_claims_v2",
  "reward_funding_work_envelopes_v2",
  "reward_gas_topup_daily_budgets",
  "reward_gas_topup_wallets",
  "reward_gas_topups",
  "reward_incoming_receipts_v2",
  "reward_late_principal_liabilities_v2",
  "reward_ledger_credits",
  "reward_native_transfer_receipt_evidence",
  "reward_operations_control",
  "reward_operations_control_events",
  "reward_operations_run_lease",
  "reward_operations_run_lease_events",
  "reward_payout_effects",
  "reward_pool_cohort_members_v2",
  "reward_pool_cohort_seals_v2",
  "reward_refund_effects",
  "reward_safe_execution_cursors",
  "reward_safe_refunds_v1",
  "reward_safe_refund_attempts_v1",
  "reward_safe_refund_completions_v1",
  "reward_safe_unbound_executions",
  "reward_signer_nonces",
  "reward_shared_song_template_admissions_v2",
  "reward_shared_song_templates_v2",
  "reward_song_context_work_v2",
  "reward_song_slots_v2",
  "reward_subject_consumptions",
  "reward_uniqueness_authorities",
  "reward_wallet_nonce_leases",
  "reward_winner_send_attempts",
  "reward_winner_send_outcomes",
  "reward_winner_send_transactions",
  "reward_winner_sends",
  "song_megapot_contribution_commands_v2",
  "song_megapot_contributions_v2",
  "song_reward_bundle_claim_legs",
  "song_reward_bundle_claims",
  "song_reward_leg_funding_effects",
  "song_reward_offer_actions",
  "song_reward_offer_legs",
  "song_reward_offers",
  "sponsor_daily_ticket_totals",
  "sponsor_withdrawal_effects",
  "wallet_sponsored_sends",
] as const;

/** A new matching table requires explicit review and a forward denial migration. */
export const REWARDS_MONEY_TABLE_PATTERN =
  "(reward|megapot|sponsor|custody|winner|payout|refund)|^platform_referral_revenue_ledger$";

export function moneyTableInventoryViolations(actual: readonly string[]): string[] {
  const reviewed = new Set<string>(REWARDS_MONEY_TABLES);
  const found = new Set(actual);
  return [
    ...REWARDS_MONEY_TABLES.filter((table) => !found.has(table)).map(
      (table) => `${table}: money table missing`,
    ),
    ...[...found]
      .filter((table) => !reviewed.has(table))
      .sort()
      .map((table) => `${table}: money table unreviewed`),
  ];
}
