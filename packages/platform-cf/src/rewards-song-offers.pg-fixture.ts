import type { Client } from "pg";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";

const address = (byte: string) => `0x${byte.repeat(40)}`;
const bytes32 = (byte: string) => `0x${byte.repeat(64)}`;
const hash = (byte: string) => byte.repeat(64);

import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";

export type SeedIdentity = Readonly<{
  accountId: string;
  communityId: string;
  personaId: string;
  postId: string;
}>;

export async function seedSong(
  admin: Client,
  suffix: string,
  walletAddress?: string,
  thirdPartyRewardLegs: "allowed" | "owner_only" = "allowed",
): Promise<SeedIdentity> {
  const accountId = `account-${suffix}`;
  const communityId = `community-${suffix}`;
  const postId = `post-${suffix}`;
  await admin.query(
    `INSERT INTO users (user_id, status, account, created_at)
     VALUES ($1, 'active', '{}'::jsonb, clock_timestamp() - interval '30 days')`,
    [accountId],
  );
  await activatePendingPersonaFixtures(admin, undefined, walletAddress);
  const personas = await admin.query<{ readonly persona_id: string }>(
    `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
    [accountId],
  );
  const personaId = personas.rows[0]?.persona_id;
  if (personaId === undefined) throw new Error("first persona was not provisioned");
  await admin.query(
    `INSERT INTO communities (
       community_id, display_name, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, 'active', $3, clock_timestamp() - interval '20 days',
       clock_timestamp() - interval '20 days')`,
    [communityId, `Community ${suffix}`, accountId],
  );
  await insertActiveCommunityMembershipFixture(admin, {
    communityId,
    membershipId: `membership-${suffix}`,
    userId: accountId,
    joinedAt: "2026-08-03T00:00:00.000Z",
  });
  await admin.query(
    `INSERT INTO posts (
       community_id, post_id, author_user_id, author_persona_id, post_type,
       status, visibility, title, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'song', 'published', 'public', $5,
       clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days')`,
    [communityId, postId, accountId, personaId, `Song ${suffix}`],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO media_publication_projections (
         submission_id, community_id, actor_user_id, operation_id, post_id,
         creation_revision, audio_revision, analysis_revision, decision_revision,
         canonical_audio_sha256, title, audio_asset_ref, language_status,
         lyrics_explicitness, alignment, data_registration, locked_delivery,
         projected_at, author_persona_id, lyrics_status, lyrics_revision, lyrics_text
       ) VALUES (
         $1, $2, $3, $4, $5, 1, 3, 1, 1, $6, $7, $8, 'ready',
         'not_explicit', 'ready', 'registered', 'not_required', clock_timestamp(),
         $9, 'ready', 1, 'Raise the sails'
       )`,
      [
        `submission-${suffix}`,
        communityId,
        accountId,
        `operation-${suffix}`,
        postId,
        hash("a"),
        `Song ${suffix}`,
        `r2://audio-${suffix}`,
        personaId,
      ],
    );
    // Publication normally initializes the Spec 013 owner policy through a
    // trigger this fixture suppresses, so create the same head and revision
    // explicitly. Every published song carries one in production.
    await admin.query(
      `INSERT INTO song_owner_policy_revisions (
         community_id, post_id, audio_revision, owner_account_id, policy_revision,
         third_party_reward_legs, pool_leg, derivative_video, policy_hash
       ) VALUES ($1, $2, 3, $3, 1, $4, 'allowed', 'allowed',
         song_owner_policy_hash_v1($1, $2, 3, $3, 1, $4, 'allowed', 'allowed'))`,
      [communityId, postId, accountId, thirdPartyRewardLegs],
    );
    await admin.query(
      `INSERT INTO song_owner_policies (
         community_id, post_id, audio_revision, owner_account_id,
         current_policy_revision, current_policy_hash
       ) VALUES ($1, $2, 3, $3, 1,
         song_owner_policy_hash_v1($1, $2, 3, $3, 1, $4, 'allowed', 'allowed'))`,
      [communityId, postId, accountId, thirdPartyRewardLegs],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
  return { accountId, communityId, personaId, postId };
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
     ) VALUES ($1, $2, $3, 3, 'study', 'study-item-source', 'v1',
       'available', 3, '{"kind":"typed_study_items","item_count":3}'::jsonb,
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
     ) VALUES ($1, $2, $3, 3, $4, 'draft', clock_timestamp() - interval '1 day',
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
       ARRAY['study'], 7000, $6, 'leg_budget', $7, $8, $9, $10, $11, 100000
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
