/** SQL prerequisites stop at a funded leg; admission and policy-freezing triggers stay enabled. */
import type { Client } from "pg";

const address = (byte: string): string => `0x${byte.repeat(40)}`;
export const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;
export const hash = (byte: string): string => byte.repeat(64);
type SeedIdentity = Readonly<{
  accountId: string;
  communityId: string;
  personaId: string;
  postId: string;
}>;

export async function seedMegapotAuthority(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO reward_asset_whitelist (
       chain_id, token_address, decimals, symbol, asset_kind, environment,
       status, policy_version, activated_at, plain_erc20_verified_at
     ) VALUES (84532, $1, 6, 'USDC', 'settlement_usdc', 'staging',
       'active', 'base-sepolia-usdc-v1', statement_timestamp(), statement_timestamp())`,
    [address("1")],
  );
  await admin.query(
    `INSERT INTO megapot_deployment_attestations (
       attestation_id, environment, chain_id, jackpot_address, usdc_address,
       ticket_nft_address, custody_address, referrer_address, source_tag,
       jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
       attestation_block_number, attestation_block_hash, abi_version, status, verified_at
     ) VALUES (
       'megapot-base-sepolia-v2', 'staging', 84532, $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 100, $10, 'megapot_v2', 'active', clock_timestamp()
     )`,
    [
      address("2"),
      address("1"),
      address("3"),
      address("4"),
      address("5"),
      bytes32("6"),
      bytes32("7"),
      bytes32("8"),
      bytes32("9"),
      bytes32("a"),
    ],
  );
}

export async function seedActivePoolLeg(
  admin: Client,
  identity: SeedIdentity,
  input: Readonly<{
    fallback: boolean;
    suffix: string;
    expired?: boolean;
    endsInMinutes?: number;
  }> = {
    fallback: false,
    suffix: "pool",
  },
): Promise<Readonly<{ legId: string; offerId: string }>> {
  const offerId = `offer-${input.suffix}`;
  const legId = `leg-${input.suffix}`;
  const rewardPolicyVersionId = `reward-policy-${input.suffix}`;
  await admin.query(
    `INSERT INTO reward_activity_availability_observations (
       availability_observation_id, community_id, post_id, audio_revision,
       activity_key, producer_id, producer_revision, state, study_item_count,
       evidence, evidence_hash, observed_at, expires_at
     ) VALUES ($1, $2, $3, 1, 'study', 'study-item-source', 'v1',
       'available', 4, '{"kind":"typed_study_items","item_count":4}'::jsonb,
       $4, clock_timestamp(), clock_timestamp() + interval '2 hours')`,
    [`availability-${input.suffix}`, identity.communityId, identity.postId, hash("b")],
  );
  await admin.query(
    `INSERT INTO reward_uniqueness_authorities (
       campaign_id, issuer, method, scope_kind, issuer_rp_scope
     ) VALUES ($1, 'https://verify.very.org', 'palm_web', 'issuer_rp_scope', 'pirate-social')`,
    [offerId],
  );
  await admin.query(
    `INSERT INTO policy_versions (
       policy_version_id, community_id, policy_key, revision, policy_hash,
       policy, compiled_plan, compiler_version, uniqueness_model,
       created_by_user_id, published_at, policy_purpose, uniqueness_authority_id
     ) VALUES ($1,$2,$3,1,$4,'{"version":"scarce_reward_v1"}'::jsonb,
       '{"evaluator":"scarce_reward_eligibility_v1"}'::jsonb,
       'scarce_reward_policy_v1',$5::jsonb,$6,clock_timestamp(),'reward',$7)`,
    [
      rewardPolicyVersionId,
      identity.communityId,
      `song_reward_offer:${offerId}`,
      hash("e"),
      JSON.stringify({ kind: "single_authority", authority_id: offerId }),
      identity.accountId,
      offerId,
    ],
  );
  await admin.query(
    `INSERT INTO song_reward_offers (
       offer_id, community_id, post_id, audio_revision, created_by_account_id,
       status, starts_at, ends_at, owner_policy_snapshot, terms_hash,
       reward_policy_version_id
     ) VALUES ($1, $2, $3, 1, $4, 'draft', clock_timestamp() - interval '1 day',
       clock_timestamp() + CASE WHEN $7::boolean THEN interval '-1 hour'
         ELSE make_interval(mins => COALESCE($8::integer, 14400)) END,
       '{"third_party_legs":"allowed"}'::jsonb, $5, $6)`,
    [
      offerId,
      identity.communityId,
      identity.postId,
      identity.accountId,
      hash("c"),
      rewardPolicyVersionId,
      input.expired ?? false,
      input.endsInMinutes ?? null,
    ],
  );
  await admin.query(
    `UPDATE song_reward_offers
        SET status='active', activated_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE offer_id=$1`,
    [offerId],
  );
  await admin.query(
    `INSERT INTO song_reward_offer_legs (
       leg_id, offer_id, kind, status, funder_account_id, refund_policy,
       leg_terms_hash, participation_starts_at, chain_id, token_address,
       token_decimals, tickets_per_drawing, max_ticket_price_atomic,
       entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
       attestation_id, participation_starts_drawing_id, eligible_activities,
       min_score_bps, empty_pool_policy, funding_source,
       fallback_beneficiary_account_id, fallback_payout_persona_id,
       referral_allocation_version, referral_policy_hash, referral_disclosed_at,
       funded_atomic
     ) VALUES (
       $1, $2, 'megapot_pool', 'draft', $3, 'refund_to_funders_pro_rata',
       $4, clock_timestamp() - interval '1 day', 84532, $5, 6, 1, 10000, 300,
       'equal_v1', 'keccak_packed_v1', 'megapot-base-sepolia-v2', 100,
       ARRAY['study','karaoke'], 7000, $6, 'leg_budget', $7, $8, $9, $10, $11, 100000
     )`,
    [
      legId,
      offerId,
      identity.accountId,
      bytes32("b"),
      address("1"),
      input.fallback ? "funder_fallback" : "no_purchase",
      input.fallback ? identity.accountId : null,
      input.fallback ? identity.personaId : null,
      input.fallback ? "referral-test-v1" : null,
      input.fallback ? hash("d") : null,
      input.fallback ? new Date().toISOString() : null,
    ],
  );
  await admin.query(
    `UPDATE song_reward_offer_legs
        SET status='active', activated_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE leg_id=$1`,
    [legId],
  );
  return { legId, offerId };
}
