-- Reviewed rewards money inventory. Runtime repositories perform no DELETE here.
-- Preserve all SELECT/INSERT/UPDATE and migration-owner administration.
-- Leave schema-wide defaults alone: unrelated repositories legitimately DELETE.
DO $money_permissions$
DECLARE
  table_name TEXT;
  role_name TEXT;
  table_oid OID;
  trusted_schema TEXT := current_schema();
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'custody_solvency_observations',
    'megapot_allocation_batches',
    'megapot_allocations',
    'megapot_claim_effects',
    'megapot_claim_receipt_evidence',
    'megapot_deployment_attestations',
    'megapot_drawing_observations',
    'megapot_drawing_sweeps',
    'megapot_fallback_cutoff_activity_evidence',
    'megapot_fallback_cutoff_evidence',
    'megapot_participant_claim_guards',
    'megapot_participant_claims',
    'megapot_pool_beneficiary_snapshots',
    'megapot_pool_commitment_effects',
    'megapot_pool_drawing_transitions',
    'megapot_pool_drawings',
    'megapot_pool_shares',
    'megapot_pool_snapshot_private_leaves',
    'megapot_purchase_receipt_evidence',
    'megapot_sweep_ticket_evidence',
    'megapot_ticket_inventory',
    'megapot_ticket_purchase_effects',
    'megapot_ticket_review_evidence',
    'megapot_usdc_approval_effects',
    'megapot_usdc_approval_receipt_evidence',
    'platform_referral_revenue_ledger',
    'platform_sponsorship_budget_entries',
    'platform_sponsorship_budgets',
    'reward_activity_availability_observations',
    'reward_asset_whitelist',
    'reward_chain_effect_transitions',
    'reward_chain_effects',
    'reward_eligibility_decisions',
    'reward_erc20_transfer_receipt_evidence',
    'reward_gas_topup_daily_budgets',
    'reward_gas_topup_wallets',
    'reward_gas_topups',
    'reward_ledger_credits',
    'reward_native_transfer_receipt_evidence',
    'reward_operations_control',
    'reward_operations_control_events',
    'reward_payout_effects',
    'reward_refund_effects',
    'reward_signer_nonces',
    'reward_subject_consumptions',
    'reward_uniqueness_authorities',
    'reward_winner_send_attempts',
    'reward_winner_send_outcomes',
    'reward_winner_send_transactions',
    'reward_winner_sends',
    'song_reward_bundle_claim_legs',
    'song_reward_bundle_claims',
    'song_reward_leg_funding_effects',
    'song_reward_offer_actions',
    'song_reward_offer_legs',
    'song_reward_offers',
    'sponsor_daily_ticket_totals',
    'sponsor_withdrawal_effects',
    'wallet_sponsored_sends'
  ] LOOP
    table_oid := to_regclass(format('%I.%I',trusted_schema,table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION 'reviewed money table missing: %',table_name;
    END IF;
    EXECUTE format('REVOKE DELETE,TRUNCATE ON TABLE %I.%I FROM PUBLIC CASCADE',trusted_schema,table_name);
    FOR role_name IN
      SELECT DISTINCT pg_get_userbyid(a.grantee)
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
       WHERE c.oid=table_oid AND a.grantee <> 0 AND a.grantee <> c.relowner
    LOOP
      EXECUTE format('REVOKE DELETE,TRUNCATE ON TABLE %I.%I FROM %I CASCADE',trusted_schema,table_name,role_name);
    END LOOP;
  END LOOP;
END;
$money_permissions$;
