import {
  FIXED_BONUS_BASE_USDC,
  type FixedUsdcBonusBudgetCommand,
  type FixedUsdcBonusCustodyPolicy,
  type FixedUsdcBonusSolvencyObservation,
} from "../../application/src/rewards/fixed-usdc-bonus-funding.ts";

/** Synthetic bookkeeping inputs, never chain observations or admission. */
export function fixedUsdcBonusFundingFixture(nowMs: number) {
  const policy = {
    version: "fixed-usdc-bonus-custody-v1",
    custody_id: "test-bonus-custody",
    chain_id: 8453,
    token_address: FIXED_BONUS_BASE_USDC,
    token_decimals: 6,
    asset_policy_version: "base-native-usdc-fixed-bonus-v1",
    safe_address: `0x${"1".repeat(40)}`,
    safe_binding_hash: "a".repeat(64),
    funded_cap_atomic: "10000000",
    maximum_budget_count: 4,
    minimum_confirmations: 2,
    maximum_observation_age_ms: 120000,
    valid_from_ms: nowMs - 60000,
    valid_until_ms: nowMs + 3600000,
    accepted_by: "test-operator",
    acceptance_ref: "isolated-test-only",
    acceptance_hash: "b".repeat(64),
  } satisfies FixedUsdcBonusCustodyPolicy;
  const observation = {
    version: "fixed-usdc-bonus-solvency-v1",
    observation_id: "test-bonus-observation",
    custody_id: policy.custody_id,
    chain_id: 8453,
    token_address: FIXED_BONUS_BASE_USDC,
    token_decimals: 6,
    safe_address: policy.safe_address,
    safe_binding_hash: policy.safe_binding_hash,
    block_number: "100",
    head_block_number: "101",
    block_hash: `0x${"c".repeat(64)}`,
    block_timestamp_ms: nowMs - 1000,
    observed_at_ms: nowMs - 100,
    balance_atomic: "10000000",
  } satisfies FixedUsdcBonusSolvencyObservation;
  const command = {
    version: "fixed-usdc-bonus-budget-v1",
    idempotency_key: "test-budget-command",
    budget_id: "test-song-budget",
    custody_id: policy.custody_id,
    community_id: "video-community",
    song_post_id: "test-bonus-song",
    audio_revision: 1,
    amount_per_account_atomic: "2000000",
    maximum_accounts: 2,
    starts_at_ms: nowMs + 1000,
    ends_at_ms: nowMs + 600000,
  } satisfies FixedUsdcBonusBudgetCommand;
  return { policy, observation, command };
}
