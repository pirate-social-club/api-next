import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  withReusablePostgresTestSchema,
} from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeMegapotAllocationCoordinator } from "./megapot-allocation-coordinator.ts";
import { makeControlPlaneMegapotAllocationStore } from "./megapot-allocation-repository.ts";
import { makeControlPlaneMegapotApprovalStore } from "./megapot-approval-repository.ts";
import { makeControlPlaneMegapotClaimStore } from "./megapot-claim-repository.ts";
import { makeMegapotCommitmentCoordinator } from "./megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "./megapot-commitment-repository.ts";
import { makeMegapotCutoffCoordinator } from "./megapot-cutoff-coordinator.ts";
import { makeControlPlaneMegapotCutoffStore } from "./megapot-cutoff-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { encodeMegapotUsdcTransfer } from "./megapot-v2.ts";
import { makeControlPlaneMegapotWorkStore } from "./megapot-work-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import { makeControlPlaneRewardOfferTerminalStore } from "./reward-offer-terminal-repository.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";
import { makeControlPlaneRewardRefundStore } from "./reward-refund-repository.ts";
import { makeControlPlaneSongRewardOfferStore } from "./song-reward-offer-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_REWARDS_SONG_OFFERS_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-rewards-song-offers-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-rewards-song-offers-suite-complete\n";
const testCount = 16;
let completedTestCount = 0;

const address = (byte: string): string => `0x${byte.repeat(40)}`;
const bytes32 = (byte: string): string => `0x${byte.repeat(64)}`;
const hash = (byte: string): string => byte.repeat(64);

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(
  use: (admin: Client, scopedConnection: string) => Promise<A>,
): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  return withReusablePostgresTestSchema({
    baseConnectionString: connectionString,
    schemaName: "packages_platform_cf_src_rewards_song_offers_pg_test_ts",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await applyPostgresTestBaselineConnection({
        connectionString: connectionForSchema(connectionString, schema),
      });
      return await use(admin, connectionForSchema(connectionString, schema));
    },
  });
}

type SeedIdentity = Readonly<{
  accountId: string;
  communityId: string;
  personaId: string;
  postId: string;
}>;

async function seedSong(
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
  await admin.query(
    `INSERT INTO community_memberships (
       community_id, membership_id, user_id, status, joined_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'member', clock_timestamp() - interval '19 days',
       clock_timestamp() - interval '19 days', clock_timestamp() - interval '19 days')`,
    [communityId, `membership-${suffix}`, accountId],
  );
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

async function seedMegapotAuthority(admin: Client): Promise<void> {
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

async function seedActivePoolLeg(
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

async function seedTicketReviewCandidate(
  admin: Client,
  input: Readonly<{
    legId: string;
    suffix: string;
    drawingId: number;
    stage: "claim" | "sweep";
  }>,
): Promise<void> {
  const observationId = `drawing-observation-${input.suffix}`;
  const purchaseEffectId = `purchase-effect-${input.suffix}`;
  const snapshotId = `snapshot-${input.suffix}`;
  const sweepId = `sweep-${input.suffix}`;
  const ticketId = input.drawingId + 500;
  const mintedTransactionHash = `0x${input.drawingId.toString(16).padStart(64, "0")}`;
  await admin.query(
    `INSERT INTO megapot_drawing_observations (
       observation_id, attestation_id, chain_id, drawing_id,
       ticket_price_atomic, drawing_time, ball_max, bonusball_max,
       drawing_locked, referral_fee_wei, referral_win_share_wei,
       block_number, block_hash, block_timestamp, confirmations,
       observed_at, expires_at, raw_state_hash
     ) VALUES (
       $1, 'megapot-base-sepolia-v2', 84532, $2, 10000,
       clock_timestamp() - interval '1 hour', 25, 13, false,
       100000000000000000, 100000000000000000, 200, $3,
       clock_timestamp() - interval '1 hour', 3, clock_timestamp(),
       clock_timestamp() + interval '30 minutes', $4
     )`,
    [observationId, input.drawingId, bytes32("1"), hash("1")],
  );
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO megapot_pool_drawings (
         pool_leg_id, drawing_id, observation_id, status, version,
         entry_cutoff_at, ticket_price_ceiling_atomic,
         reserved_ticket_cost_atomic, actual_ticket_cost_atomic,
         gross_winnings_atomic, net_winnings_atomic, frozen_share_count,
         fallback_beneficiary, snapshot_id, commitment_effect_id,
         purchase_effect_id, cutoff_frozen_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, clock_timestamp() - interval '2 hours',
         10000, 10000, 10000, $6, $7, 1, false, $8,
         $9, $10, clock_timestamp() - interval '2 hours',
         clock_timestamp() - interval '3 hours'
       )`,
      [
        input.legId,
        input.drawingId,
        observationId,
        input.stage === "claim" ? "winnings_detected" : "tickets_confirmed",
        input.stage === "claim" ? 7 : 5,
        input.stage === "claim" ? 1_001 : 0,
        input.stage === "claim" ? 901 : 0,
        snapshotId,
        `commitment-${input.suffix}`,
        purchaseEffectId,
      ],
    );
    await admin.query(
      `INSERT INTO megapot_ticket_inventory (
         attestation_id, ticket_id, purchase_effect_id, pool_leg_id, drawing_id,
         custody_address, owner_observation_block_number,
         owner_observation_block_hash, minted_transaction_hash,
         minted_log_index, status, acquired_at
       ) VALUES (
         'megapot-base-sepolia-v2', $1, $2, $3, $4, $5, 201, $6, $7, 4,
         'custodied', clock_timestamp() - interval '1 hour'
       )`,
      [
        ticketId,
        purchaseEffectId,
        input.legId,
        input.drawingId,
        address("4"),
        bytes32("2"),
        mintedTransactionHash,
      ],
    );
    if (input.stage === "claim") {
      await admin.query(
        `INSERT INTO megapot_drawing_sweeps (
           sweep_id, pool_leg_id, attestation_id, drawing_id,
           observation_block_number, observation_block_hash, drawing_state_hash,
           ticket_count, winning_ticket_count, state, observed_at, completed_at
         ) VALUES (
           $1, $2, 'megapot-base-sepolia-v2', $3, 202, $4, $5,
           1, 1, 'complete', clock_timestamp() - interval '30 minutes',
           clock_timestamp() - interval '29 minutes'
         )`,
        [sweepId, input.legId, input.drawingId, bytes32("4"), hash("4")],
      );
      await admin.query(
        `INSERT INTO megapot_sweep_ticket_evidence (
           sweep_id, attestation_id, ticket_id, tier_id, custody_owner_address,
           gross_winnings_atomic, referral_win_share_atomic,
           referral_accrual_atomic, net_winnings_atomic
         ) VALUES (
           $1, 'megapot-base-sepolia-v2', $2, 7, $3, 1001,
           100000000000000000, 100, 901
         )`,
        [sweepId, ticketId, address("4")],
      );
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

suite("Postgres 17 Megapot rewards persistence", () => {
  test("opens an offer and one future-drawing pool leg with exact action replay", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "offer-command", address("d"));
      await seedMegapotAuthority(admin);
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-offer-command', 'megapot-base-sepolia-v2', 84532, 41,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 141, $1,
           clock_timestamp() - interval '2 minutes', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("4"), hash("4")],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const openInput = {
        actionId: "reward-action-open-command",
        offerId: "reward-offer-command",
        accountId: identity.accountId,
        personaId: identity.personaId,
        communityId: identity.communityId,
        postId: identity.postId,
        idempotencyKey: "open-command-1",
        requestHash: hash("5"),
        termsHash: hash("6"),
        rewardPolicy: {
          version: "scarce_reward_v1",
          community_id: identity.communityId,
          offer_id: "reward-offer-command",
          requirements: ["human.personhood", "credential.subject_unique"],
          uniqueness: {
            kind: "single_authority",
            authority_id: "reward-offer-command",
          },
          legal_eligibility: {
            age: null,
            geography: null,
            disclosure: null,
            environment: "test_staging_empty_v1",
          },
        },
        rewardPolicyHash: hash("a"),
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: new Date().toISOString(),
      } as const;
      const opened = await Effect.runPromise(store.openOffer(openInput));
      const openReplay = await Effect.runPromise(
        store.openOffer({
          ...openInput,
          actionId: "ignored-replay-action",
          offerId: "ignored-replay-offer",
        }),
      );
      expect(opened).toMatchObject({ replayed: false, offer: { audioRevision: 3 } });
      expect(openReplay).toEqual({ ...opened, replayed: true });

      const legInput = {
        actionId: "reward-action-leg-command",
        legId: "reward-leg-command",
        offerId: opened.offer.offerId,
        accountId: identity.accountId,
        personaId: identity.personaId,
        idempotencyKey: "leg-command-1",
        requestHash: hash("7"),
        legTermsHash: bytes32("8"),
        createdAt: new Date(Date.now() + 1).toISOString(),
        maxTicketPriceAtomic: 20_000n,
        entryCutoffSeconds: 300,
        eligibleActivities: ["study"] as const,
        minScoreBps: 7_000,
        emptyPoolPolicy: "no_purchase" as const,
        fallbackPayoutPersonaId: null,
        referralAllocationVersion: null,
        referralPolicyHash: null,
        referralDisclosedAt: null,
      };
      const added = await Effect.runPromise(store.addMegapotPoolLeg(legInput));
      const legReplay = await Effect.runPromise(
        store.addMegapotPoolLeg({
          ...legInput,
          actionId: "ignored-leg-action",
          legId: "ignored-leg-id",
        }),
      );
      expect(added).toMatchObject({
        replayed: false,
        leg: {
          status: "funding",
          chainId: 84_532,
          participationStartsDrawingId: 42n,
          custodyAddress: address("4"),
        },
      });
      expect(legReplay).toEqual({ ...added, replayed: true });
      const fundingStore = makeControlPlaneRewardFundingStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const funding = await Effect.runPromise(
        fundingStore.plan({
          fundingEffectId: "funding-offer-command",
          legId: added.leg.legId,
          funderAccountId: identity.accountId,
          senderAddress: address("d"),
          expectedAmountAtomic: 20_000n,
          requiredConfirmations: 3,
        }),
      );
      const fundingActionInput = {
        actionId: "reward-action-funding-observation",
        accountId: identity.accountId,
        personaId: identity.personaId,
        legId: added.leg.legId,
        legKind: "megapot_pool",
        fundingEffectId: funding.fundingEffectId,
        idempotencyKey: "observe-funding-command-1",
        requestHash: hash("d"),
        createdAt: new Date().toISOString(),
      } as const;
      expect(await Effect.runPromise(store.recordFundingObservation(fundingActionInput))).toEqual({
        replayed: false,
      });
      expect(
        await Effect.runPromise(
          store.recordFundingObservation({
            ...fundingActionInput,
            actionId: "ignored-observation-action",
          }),
        ),
      ).toEqual({ replayed: true });
      await Effect.runPromise(
        fundingStore.bindTransaction({
          fundingEffectId: funding.fundingEffectId,
          transactionHash: bytes32("d"),
        }),
      );
      await Effect.runPromise(
        fundingStore.confirm({
          fundingEffectId: funding.fundingEffectId,
          transactionHash: bytes32("d"),
          transferLogIndex: 1,
          amountAtomic: 20_000n,
          blockNumber: 150n,
          blockHash: bytes32("e"),
          observationHash: hash("e"),
          confirmedAt: new Date().toISOString(),
        }),
      );
      const activated = await admin.query<{
        readonly funded_atomic: string;
        readonly status: string;
      }>(`SELECT funded_atomic::text,status FROM song_reward_offer_legs WHERE leg_id=$1`, [
        added.leg.legId,
      ]);
      expect(activated.rows).toEqual([{ funded_atomic: "20000", status: "active" }]);
      const rows = await admin.query<{ readonly action_count: number }>(
        `SELECT count(*)::integer AS action_count FROM song_reward_offer_actions
          WHERE offer_id=$1`,
        [opened.offer.offerId],
      );
      expect(rows.rows).toEqual([{ action_count: 3 }]);
      await expect(
        Effect.runPromise(store.openOffer({ ...openInput, requestHash: hash("9") })),
      ).rejects.toMatchObject({ reason: "idempotency-conflict" });
    });
    completedTestCount += 1;
  });

  test("binds offer-open to the current owner policy, not the creation snapshot", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "owner-only", address("d"), "owner_only");
      const otherAccountId = "account-owner-only-member";
      await admin.query(
        `INSERT INTO users (user_id, status, account, created_at)
         VALUES ($1, 'active', '{}'::jsonb, clock_timestamp() - interval '30 days')`,
        [otherAccountId],
      );
      await activatePendingPersonaFixtures(admin, undefined, address("e"));
      const otherPersonas = await admin.query<{ readonly persona_id: string }>(
        `SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona`,
        [otherAccountId],
      );
      const otherPersonaId = otherPersonas.rows[0]?.persona_id;
      if (otherPersonaId === undefined) throw new Error("second persona was not provisioned");
      await admin.query(
        `INSERT INTO community_memberships (
           community_id, membership_id, user_id, status, joined_at, created_at, updated_at
         ) VALUES ($1, $2, $3, 'member', clock_timestamp() - interval '5 days',
           clock_timestamp() - interval '5 days', clock_timestamp() - interval '5 days')`,
        [identity.communityId, "membership-owner-only-member", otherAccountId],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const openInput = {
        actionId: "reward-action-owner-only",
        offerId: "reward-offer-owner-only",
        accountId: otherAccountId,
        personaId: otherPersonaId,
        communityId: identity.communityId,
        postId: identity.postId,
        idempotencyKey: "owner-only-1",
        requestHash: hash("5"),
        termsHash: hash("6"),
        rewardPolicy: {
          version: "scarce_reward_v1",
          community_id: identity.communityId,
          offer_id: "reward-offer-owner-only",
          requirements: ["human.personhood", "credential.subject_unique"],
          uniqueness: { kind: "single_authority", authority_id: "reward-offer-owner-only" },
          legal_eligibility: {
            age: null,
            geography: null,
            disclosure: null,
            environment: "test_staging_empty_v1",
          },
        },
        rewardPolicyHash: hash("a"),
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: new Date().toISOString(),
      } as const;

      // An ordinary member cannot open an offer the song owner restricted.
      await expect(Effect.runPromise(store.openOffer(openInput))).rejects.toMatchObject({
        _tag: "SongRewardOfferRejected",
        reason: "owner-only",
      });

      // The song owner always may, and the offer freezes the policy identity.
      const opened = await Effect.runPromise(
        store.openOffer({
          ...openInput,
          actionId: "reward-action-owner-only-owner",
          offerId: "reward-offer-owner-only-owner",
          accountId: identity.accountId,
          personaId: identity.personaId,
          idempotencyKey: "owner-only-2",
        }),
      );
      expect(opened).toMatchObject({ replayed: false });
      const snapshot = await admin.query<{ readonly owner_policy_snapshot: unknown }>(
        `SELECT owner_policy_snapshot FROM song_reward_offers WHERE offer_id=$1`,
        [opened.offer.offerId],
      );
      expect(snapshot.rows[0]?.owner_policy_snapshot).toMatchObject({
        post_id: identity.postId,
        audio_revision: 3,
        policy_revision: 1,
      });
    });
    completedTestCount += 1;
  });

  test("freezes the exact authorizing policy revision on each new leg", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "leg-freeze", address("d"));
      await seedMegapotAuthority(admin);
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-leg-freeze', 'megapot-base-sepolia-v2', 84532, 41,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 141, $1,
           clock_timestamp() - interval '2 minutes', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("4"), hash("4")],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const opened = await Effect.runPromise(
        store.openOffer({
          actionId: "reward-action-leg-freeze-open",
          offerId: "reward-offer-leg-freeze",
          accountId: identity.accountId,
          personaId: identity.personaId,
          communityId: identity.communityId,
          postId: identity.postId,
          idempotencyKey: "leg-freeze-open-1",
          requestHash: hash("5"),
          termsHash: hash("6"),
          rewardPolicy: {
            version: "scarce_reward_v1",
            community_id: identity.communityId,
            offer_id: "reward-offer-leg-freeze",
            requirements: ["human.personhood", "credential.subject_unique"],
            uniqueness: { kind: "single_authority", authority_id: "reward-offer-leg-freeze" },
            legal_eligibility: {
              age: null,
              geography: null,
              disclosure: null,
              environment: "test_staging_empty_v1",
            },
          },
          rewardPolicyHash: hash("a"),
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: new Date().toISOString(),
        }),
      );

      const legInput = (suffix: string, key: string, actionId: string, offerId: string) => ({
        actionId,
        legId: `reward-leg-freeze-${suffix}`,
        offerId,
        accountId: identity.accountId,
        personaId: identity.personaId,
        idempotencyKey: key,
        requestHash: hash("9"),
        legTermsHash: bytes32("8"),
        createdAt: new Date(Date.now() + 1).toISOString(),
        maxTicketPriceAtomic: 20_000n,
        entryCutoffSeconds: 300,
        eligibleActivities: ["study"] as const,
        minScoreBps: 7_000,
        emptyPoolPolicy: "no_purchase" as const,
        fallbackPayoutPersonaId: null,
        referralAllocationVersion: null,
        referralPolicyHash: null,
        referralDisclosedAt: null,
      });
      const first = await Effect.runPromise(
        store.addMegapotPoolLeg(
          legInput("one", "leg-freeze-1", "reward-action-leg-freeze-one", opened.offer.offerId),
        ),
      );
      expect(first.leg.ownerPolicyKind).toBe("frozen_policy");
      expect(first.leg.ownerPolicyRevision).toBe(1);
      expect(first.leg.ownerPolicyHash).toMatch(/^[0-9a-f]{64}$/u);

      // The owner narrows third-party legs; the first leg keeps its frozen
      // revision while the head advances. The post-narrowing leg freeze at
      // revision 2 is proved by the interleaving test below.
      await admin.query(
        `SELECT * FROM append_song_owner_policy_revision_v1(
           $1, $2, $3, 1, 'owner_only', 'allowed', 'allowed'
         )`,
        [identity.communityId, identity.postId, identity.accountId],
      );
      const frozen = await admin.query<{
        readonly leg_id: string;
        readonly owner_policy_kind: string;
        readonly owner_policy_revision: string | null;
        readonly owner_policy_hash: string | null;
      }>(
        `SELECT leg.leg_id, leg.owner_policy_kind, leg.owner_policy_revision::text,
                leg.owner_policy_hash
           FROM song_reward_offer_legs leg
          WHERE leg.leg_id='reward-leg-freeze-one'`,
        [],
      );
      expect(
        frozen.rows.map((row) => [
          row.leg_id,
          row.owner_policy_kind,
          row.owner_policy_revision,
          row.owner_policy_hash,
        ]),
      ).toEqual([["reward-leg-freeze-one", "frozen_policy", "1", first.leg.ownerPolicyHash]]);
      const head = await admin.query<{ readonly current_policy_revision: string }>(
        `SELECT current_policy_revision::text FROM song_owner_policies WHERE post_id=$1`,
        [identity.postId],
      );
      expect(head.rows[0]?.current_policy_revision).toBe("2");
    });
    completedTestCount += 1;
  });

  test("reads legacy pre-policy legs as legacy evidence and rejects partial freezes", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "legacy-leg", address("d"));
      await seedMegapotAuthority(admin);
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-legacy-leg', 'megapot-base-sepolia-v2', 84532, 41,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 141, $1,
           clock_timestamp() - interval '2 minutes', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("4"), hash("4")],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const opened = await Effect.runPromise(
        store.openOffer({
          actionId: "reward-action-legacy-leg-open",
          offerId: "reward-offer-legacy-leg",
          accountId: identity.accountId,
          personaId: identity.personaId,
          communityId: identity.communityId,
          postId: identity.postId,
          idempotencyKey: "legacy-leg-open-1",
          requestHash: hash("5"),
          termsHash: hash("6"),
          rewardPolicy: {
            version: "scarce_reward_v1",
            community_id: identity.communityId,
            offer_id: "reward-offer-legacy-leg",
            requirements: ["human.personhood", "credential.subject_unique"],
            uniqueness: { kind: "single_authority", authority_id: "reward-offer-legacy-leg" },
            legal_eligibility: {
              age: null,
              geography: null,
              disclosure: null,
              environment: "test_staging_empty_v1",
            },
          },
          rewardPolicyHash: hash("a"),
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: new Date().toISOString(),
        }),
      );
      const legInput = {
        actionId: "reward-action-legacy-leg-one",
        legId: "reward-leg-legacy",
        offerId: opened.offer.offerId,
        accountId: identity.accountId,
        personaId: identity.personaId,
        idempotencyKey: "legacy-leg-1",
        requestHash: hash("7"),
        legTermsHash: bytes32("8"),
        createdAt: new Date(Date.now() + 1).toISOString(),
        maxTicketPriceAtomic: 20_000n,
        entryCutoffSeconds: 300,
        eligibleActivities: ["study"] as const,
        minScoreBps: 7_000,
        emptyPoolPolicy: "no_purchase" as const,
        fallbackPayoutPersonaId: null,
        referralAllocationVersion: null,
        referralPolicyHash: null,
        referralDisclosedAt: null,
      };
      const added = await Effect.runPromise(store.addMegapotPoolLeg(legInput));

      // Degrade the row to its honest pre-policy state, then replay exactly:
      // the replayed projection must read legacy evidence, never invent a revision.
      await admin.query(
        `UPDATE song_reward_offer_legs
            SET owner_policy_kind='legacy_pre_policy',
                owner_policy_revision=NULL, owner_policy_hash=NULL
          WHERE leg_id=$1`,
        [added.leg.legId],
      );
      const replayed = await Effect.runPromise(
        store.addMegapotPoolLeg({
          ...legInput,
          actionId: "ignored-replay-action",
          legId: "ignored-replay-leg",
        }),
      );
      expect(replayed).toMatchObject({
        replayed: true,
        leg: {
          legId: added.leg.legId,
          ownerPolicyKind: "legacy_pre_policy",
          ownerPolicyRevision: null,
          ownerPolicyHash: null,
        },
      });

      // A frozen kind without its exact revision and hash is not representable.
      await expect(
        admin.query(
          `UPDATE song_reward_offer_legs SET owner_policy_kind='frozen_policy' WHERE leg_id=$1`,
          [added.leg.legId],
        ),
      ).rejects.toThrow();
    });
    completedTestCount += 1;
  });

  test("policy narrowing cannot interleave between leg authority and insertion", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "leg-race", address("d"));
      await seedMegapotAuthority(admin);
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-leg-race', 'megapot-base-sepolia-v2', 84532, 41,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 141, $1,
           clock_timestamp() - interval '2 minutes', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("4"), hash("4")],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const opened = await Effect.runPromise(
        store.openOffer({
          actionId: "reward-action-leg-race-open",
          offerId: "reward-offer-leg-race",
          accountId: identity.accountId,
          personaId: identity.personaId,
          communityId: identity.communityId,
          postId: identity.postId,
          idempotencyKey: "leg-race-open-1",
          requestHash: hash("5"),
          termsHash: hash("6"),
          rewardPolicy: {
            version: "scarce_reward_v1",
            community_id: identity.communityId,
            offer_id: "reward-offer-leg-race",
            requirements: ["human.personhood", "credential.subject_unique"],
            uniqueness: { kind: "single_authority", authority_id: "reward-offer-leg-race" },
            legal_eligibility: {
              age: null,
              geography: null,
              disclosure: null,
              environment: "test_staging_empty_v1",
            },
          },
          rewardPolicyHash: hash("a"),
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: new Date().toISOString(),
        }),
      );

      // Client A mirrors the repository's leg authority read, including the
      // FOR SHARE fence on the policy head, inside an open transaction.
      const authority = new Client({ connectionString: scopedConnection });
      const narrowing = new Client({ connectionString: scopedConnection });
      await Promise.all([authority.connect(), narrowing.connect()]);
      try {
        await authority.query("BEGIN");
        const held = await authority.query(
          `SELECT revision.policy_revision, revision.policy_hash
             FROM song_reward_offers offer
             JOIN song_owner_policies head
               ON head.community_id=offer.community_id
              AND head.post_id=offer.post_id
              AND head.audio_revision=offer.audio_revision
             JOIN song_owner_policy_revisions revision
               ON revision.community_id=head.community_id
              AND revision.post_id=head.post_id
              AND revision.owner_account_id=head.owner_account_id
              AND revision.policy_revision=head.current_policy_revision
              AND revision.policy_hash=head.current_policy_hash
            WHERE offer.offer_id=$1 AND offer.status IN ('draft','active')
              AND offer.ends_at > clock_timestamp()
            FOR SHARE OF head`,
          [opened.offer.offerId],
        );
        expect(held.rows).toHaveLength(1);

        // A concurrent narrowing genuinely attempts while A's read fences the
        // head; under lock_timeout it must fail rather than interleave.
        await narrowing.query("SET lock_timeout='2s'");
        await expect(
          narrowing.query(
            `SELECT * FROM append_song_owner_policy_revision_v1(
               $1, $2, $3, 1, 'owner_only', 'allowed', 'allowed'
             )`,
            [identity.communityId, identity.postId, identity.accountId],
          ),
        ).rejects.toThrow(/lock timeout|lock_timeout|lock not available/i);

        await authority.query("COMMIT");

        // With the fence released, the same narrowing succeeds and the next
        // leg freezes the new current revision.
        const appended = await narrowing.query<{ readonly policy_revision: string }>(
          `SELECT policy_revision::text FROM append_song_owner_policy_revision_v1(
             $1, $2, $3, 1, 'owner_only', 'allowed', 'allowed'
           )`,
          [identity.communityId, identity.postId, identity.accountId],
        );
        expect(appended.rows[0]?.policy_revision).toBe("2");
        const leg = await Effect.runPromise(
          store.addMegapotPoolLeg({
            actionId: "reward-action-leg-race-one",
            legId: "reward-leg-race",
            offerId: opened.offer.offerId,
            accountId: identity.accountId,
            personaId: identity.personaId,
            idempotencyKey: "leg-race-1",
            requestHash: hash("7"),
            legTermsHash: bytes32("8"),
            createdAt: new Date(Date.now() + 1).toISOString(),
            maxTicketPriceAtomic: 20_000n,
            entryCutoffSeconds: 300,
            eligibleActivities: ["study"] as const,
            minScoreBps: 7_000,
            emptyPoolPolicy: "no_purchase" as const,
            fallbackPayoutPersonaId: null,
            referralAllocationVersion: null,
            referralPolicyHash: null,
            referralDisclosedAt: null,
          }),
        );
        expect(leg.leg.ownerPolicyRevision).toBe(2);
      } finally {
        await Promise.all([authority.end(), narrowing.end()]);
      }
    });
    completedTestCount += 1;
  });

  test("adds only an exact active asset bonus and selects its terminal balance for refund", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "asset-command", address("d"));
      await seedMegapotAuthority(admin);
      const token = address("b");
      await admin.query(
        `INSERT INTO reward_asset_whitelist (
           chain_id,token_address,decimals,symbol,asset_kind,environment,status,
           policy_version,activated_at,plain_erc20_verified_at
         ) VALUES (84532,$1,18,'BONUS','bonus_asset','staging','active','bonus-v1',
           statement_timestamp(),statement_timestamp())`,
        [token],
      );
      const store = makeControlPlaneSongRewardOfferStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const now = new Date().toISOString();
      const opened = await Effect.runPromise(
        store.openOffer({
          actionId: "reward-action-open-asset-command",
          offerId: "reward-offer-asset-command",
          accountId: identity.accountId,
          personaId: identity.personaId,
          communityId: identity.communityId,
          postId: identity.postId,
          idempotencyKey: "open-asset-command-1",
          requestHash: hash("5"),
          termsHash: hash("6"),
          rewardPolicy: {
            version: "scarce_reward_v1",
            community_id: identity.communityId,
            offer_id: "reward-offer-asset-command",
            requirements: ["human.personhood", "credential.subject_unique"],
            uniqueness: {
              kind: "single_authority",
              authority_id: "reward-offer-asset-command",
            },
            legal_eligibility: {
              age: null,
              geography: null,
              disclosure: null,
              environment: "test_staging_empty_v1",
            },
          },
          rewardPolicyHash: hash("a"),
          startsAt: now,
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: now,
        }),
      );
      const legInput = {
        actionId: "reward-action-asset-leg-command",
        legId: "reward-asset-leg-command",
        offerId: opened.offer.offerId,
        accountId: identity.accountId,
        personaId: identity.personaId,
        idempotencyKey: "asset-leg-command-1",
        requestHash: hash("7"),
        legTermsHash: bytes32("8"),
        createdAt: new Date(Date.now() + 1).toISOString(),
        chainId: 84_532,
        tokenAddress: token,
        tokenDecimals: 18,
        tokenSymbol: "BONUS",
        assetPolicyVersion: "bonus-v1",
        amountPerClaimAtomic: 100n,
        maxClaims: 10,
      } as const;

      await expect(
        Effect.runPromise(
          store.addAssetBonusLeg({
            ...legInput,
            actionId: "reward-action-asset-leg-mismatch",
            legId: "reward-asset-leg-mismatch",
            idempotencyKey: "asset-leg-mismatch-1",
            tokenDecimals: 6,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "SongRewardOfferRejected", reason: "not-found" });

      const added = await Effect.runPromise(store.addAssetBonusLeg(legInput));
      expect(added).toMatchObject({
        replayed: false,
        leg: {
          status: "funding",
          tokenAddress: token,
          tokenDecimals: 18,
          tokenSymbol: "BONUS",
          assetPolicyVersion: "bonus-v1",
          custodyAddress: address("4"),
          amountPerClaimAtomic: 100n,
          maxClaims: 10,
        },
      });
      await expect(
        Effect.runPromise(
          store.addAssetBonusLeg({
            ...legInput,
            actionId: "ignored-asset-leg-action",
            legId: "ignored-asset-leg-id",
          }),
        ),
      ).resolves.toEqual({ ...added, replayed: true });

      const funding = await Effect.runPromise(
        makeControlPlaneRewardFundingStore(
          makeDirectPostgresControlPlaneLayer(scopedConnection),
        ).plan({
          fundingEffectId: "funding-asset-command",
          legId: added.leg.legId,
          funderAccountId: identity.accountId,
          senderAddress: address("d"),
          expectedAmountAtomic: 1_000n,
          requiredConfirmations: 3,
        }),
      );
      await expect(
        Effect.runPromise(
          store.recordFundingObservation({
            actionId: "reward-action-wrong-asset-observation",
            accountId: identity.accountId,
            personaId: identity.personaId,
            legId: added.leg.legId,
            legKind: "megapot_pool",
            fundingEffectId: funding.fundingEffectId,
            idempotencyKey: "wrong-asset-observation-1",
            requestHash: hash("b"),
            createdAt: new Date(Date.now() + 2).toISOString(),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "SongRewardOfferRejected", reason: "not-found" });
      await expect(
        Effect.runPromise(
          store.recordFundingObservation({
            actionId: "reward-action-asset-observation",
            accountId: identity.accountId,
            personaId: identity.personaId,
            legId: added.leg.legId,
            legKind: "asset_bonus",
            fundingEffectId: funding.fundingEffectId,
            idempotencyKey: "asset-observation-1",
            requestHash: hash("c"),
            createdAt: new Date(Date.now() + 2).toISOString(),
          }),
        ),
      ).resolves.toEqual({ replayed: false });

      const fundingStore = makeControlPlaneRewardFundingStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      await Effect.runPromise(
        fundingStore.bindTransaction({
          fundingEffectId: funding.fundingEffectId,
          transactionHash: bytes32("1"),
        }),
      );
      await Effect.runPromise(
        fundingStore.confirm({
          fundingEffectId: funding.fundingEffectId,
          transactionHash: bytes32("1"),
          transferLogIndex: 1,
          amountAtomic: 1_000n,
          blockNumber: 151n,
          blockHash: bytes32("2"),
          observationHash: hash("2"),
          confirmedAt: new Date().toISOString(),
        }),
      );
      await admin.query(
        `UPDATE song_reward_offer_legs
            SET status='ended',participation_ends_at=clock_timestamp(),
                updated_at=clock_timestamp() + interval '1 millisecond'
          WHERE leg_id=$1`,
        [added.leg.legId],
      );
      await admin.query(
        `UPDATE song_reward_offers
            SET status='ended',terminal_at=clock_timestamp(),
                updated_at=clock_timestamp() + interval '1 millisecond'
          WHERE offer_id=$1`,
        [opened.offer.offerId],
      );
      await expect(
        Effect.runPromise(
          makeControlPlaneMegapotWorkStore(
            makeDirectPostgresControlPlaneLayer(scopedConnection),
          ).loadRefunds(10),
        ),
      ).resolves.toEqual([funding.fundingEffectId]);

      await admin.query(
        `UPDATE reward_asset_whitelist SET status='retired',retired_at=clock_timestamp()
          WHERE chain_id=84532 AND token_address=$1`,
        [token],
      );
      await expect(
        Effect.runPromise(
          store.addAssetBonusLeg({
            ...legInput,
            actionId: "reward-action-retired-asset-leg",
            legId: "reward-retired-asset-leg",
            idempotencyKey: "retired-asset-leg-1",
            requestHash: hash("9"),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "SongRewardOfferRejected", reason: "not-found" });
    });
    completedTestCount += 1;
  });

  test("closes fallback score, availability, parallel-leg, and foreign-funder routes", async () => {
    await withSchema(async (admin) => {
      const identity = await seedSong(admin, "fallback");
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
        fallback: true,
        suffix: "fallback",
      });
      await expect(
        admin.query(
          `INSERT INTO song_reward_offer_legs (
             leg_id, offer_id, kind, status, funder_account_id, refund_policy,
             leg_terms_hash, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             min_score_bps, empty_pool_policy, funding_source,
             fallback_beneficiary_account_id, fallback_payout_persona_id,
             referral_allocation_version, referral_policy_hash, referral_disclosed_at
           ) SELECT 'bad-score-leg', offer_id, kind, 'draft', funder_account_id,
             refund_policy, $1, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             10000, empty_pool_policy, funding_source, fallback_beneficiary_account_id,
             fallback_payout_persona_id, referral_allocation_version,
             referral_policy_hash, referral_disclosed_at
           FROM song_reward_offer_legs WHERE leg_id=$2`,
          [bytes32("c"), legId],
        ),
      ).rejects.toBeDefined();
      await expect(
        admin.query(
          `INSERT INTO song_reward_offer_legs (
             leg_id, offer_id, kind, status, funder_account_id, refund_policy,
             leg_terms_hash, participation_starts_at, chain_id, token_address,
             token_decimals, tickets_per_drawing, max_ticket_price_atomic,
             entry_cutoff_seconds, beneficiary_algorithm_version, ticket_selection_version,
             attestation_id, participation_starts_drawing_id, eligible_activities,
             min_score_bps, empty_pool_policy, funding_source
           ) VALUES (
             'parallel-pool', $1, 'megapot_pool', 'draft', $2,
             'refund_to_funders_pro_rata', $3, clock_timestamp(), 84532, $4, 6,
             1, 10000, 300, 'equal_v1', 'keccak_packed_v1',
             'megapot-base-sepolia-v2', 100, ARRAY['study'], 7000,
             'no_purchase', 'leg_budget'
           )`,
          [offerId, identity.accountId, bytes32("d"), address("1")],
        ),
      ).rejects.toBeDefined();
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('foreign-funder', 'active', '{}'::jsonb)`,
      );
      await expect(
        admin.query(
          `INSERT INTO song_reward_leg_funding_effects (
             funding_effect_id, leg_id, funder_account_id, chain_id, token_address,
             sender_address, recipient_address, expected_amount_atomic,
             required_confirmations, state
           ) VALUES (
             'foreign-topup', $1, 'foreign-funder', 84532, $2, $3, $4,
             10000, 2, 'planned'
           )`,
          [legId, address("1"), address("e"), address("4")],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("fallback_sponsor_mismatch") });
    });
    completedTestCount += 1;
  });

  test("freezes one account share into a private/public commitment without identity leakage", async () => {
    await withSchema(async (admin) => {
      const identity = await seedSong(admin, "snapshot");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "snapshot",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-100', 'megapot-base-sepolia-v2', 84532, 100,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 101, $1,
           clock_timestamp() - interval '1 minute', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("e"), hash("e")],
      );
      await admin.query(
        `INSERT INTO megapot_pool_drawings (
           pool_leg_id, drawing_id, observation_id, status, entry_cutoff_at,
           ticket_price_ceiling_atomic
         ) SELECT $1, 100, 'drawing-observation-100', 'entry_open',
             drawing_time - interval '300 seconds', 10000
           FROM megapot_drawing_observations
          WHERE observation_id='drawing-observation-100'`,
        [legId],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO activity_qualifications (
             qualification_id, account_id, persona_id, community_id, post_id,
             audio_revision, activity_key, study_session_id, score_bps,
             qualification_policy_version_id, qualified_at, streak_day,
             evidence_summary
           ) VALUES (
             'qualification-snapshot', $1, $2, $3, $4, 3, 'study',
             'study-session-snapshot', 8000, 'study_session_first_pass_v2@1',
             clock_timestamp() - interval '1 minute', current_date,
             '{"kind":"study_session_first_pass_v2"}'::jsonb
           )`,
          [identity.accountId, identity.personaId, identity.communityId, identity.postId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(
        `INSERT INTO reward_eligibility_decisions (
           eligibility_decision_id, leg_id, account_id, persona_id, purpose,
           qualification_id, drawing_id, outcome, policy_version, evidence_hash,
           decided_at, expires_at
         ) VALUES (
           'eligibility-snapshot', $1, $2, $3, 'pool_share',
           'qualification-snapshot', 100, 'eligible', 'pool-legal-test-v1', $4,
           clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'
         )`,
        [legId, identity.accountId, identity.personaId, hash("f")],
      );
      await admin.query(
        `INSERT INTO megapot_pool_shares (
           pool_leg_id, drawing_id, account_id, persona_id, qualification_id,
           eligibility_decision_id, qualified_at
         ) SELECT $1, 100, account_id, persona_id, qualification_id,
             'eligibility-snapshot', qualified_at
           FROM activity_qualifications WHERE qualification_id='qualification-snapshot'`,
        [legId],
      );
      await expect(
        admin.query(
          `INSERT INTO megapot_pool_shares (
             pool_leg_id, drawing_id, account_id, persona_id, qualification_id,
             eligibility_decision_id, qualified_at
           ) SELECT $1, 100, account_id, persona_id, qualification_id,
               'eligibility-snapshot', qualified_at
             FROM activity_qualifications WHERE qualification_id='qualification-snapshot'`,
          [legId],
        ),
      ).rejects.toBeDefined();

      const orderKey = bytes32("1");
      const leafCommitment = bytes32("2");
      const snapshotHash = bytes32("3");
      const termsHash = bytes32("b");
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE megapot_pool_drawings
              SET status='cutoff_frozen', version=2, reserved_ticket_cost_atomic=10000,
                  frozen_share_count=1, fallback_beneficiary=false,
                  snapshot_id='snapshot-100', cutoff_frozen_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE pool_leg_id=$1 AND drawing_id=100`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_drawing_transitions (
             pool_leg_id, drawing_id, target_version, event_type, event
           ) VALUES ($1, 100, 2, 'cutoff', '{"type":"cutoff"}'::jsonb)`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_beneficiary_snapshots (
             snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
             algorithm_version, fallback, leaf_count, snapshot_hash,
             published_artifact, frozen_at
           ) VALUES (
             'snapshot-100', $1::text, 100,
             'pirate.megapot-pool-beneficiary-snapshot.v2', $2,
             'equal_v1', false, 1, $3,
             jsonb_build_object(
               'domain', 'pirate.megapot-pool-beneficiary-snapshot.v2',
               'poolLegId', $1::text,
               'drawingId', '100',
               'termsHash', $2::text,
               'algorithmVersion', 'equal_v1',
               'fallback', false,
               'leafCount', 1,
               'leafCommitments', jsonb_build_array($4::text),
               'snapshotHash', $3::text
             ), clock_timestamp()
           )`,
          [legId, termsHash, snapshotHash, leafCommitment],
        );
        await admin.query(
          `INSERT INTO megapot_pool_snapshot_private_leaves (
             snapshot_id, ordinal, account_id, persona_id, order_key, leaf_commitment
           ) VALUES ('snapshot-100', 0, $1, $2, $3, $4)`,
          [identity.accountId, identity.personaId, orderKey, leafCommitment],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      const snapshot = await admin.query<{ readonly published_artifact: unknown }>(
        `SELECT published_artifact FROM megapot_pool_beneficiary_snapshots
          WHERE snapshot_id='snapshot-100'`,
      );
      const published = JSON.stringify(snapshot.rows[0]?.published_artifact);
      expect(published).not.toContain(identity.accountId);
      expect(published).not.toContain(identity.personaId);
      await expect(
        admin.query(
          `DELETE FROM megapot_pool_snapshot_private_leaves
            WHERE snapshot_id='snapshot-100'`,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
    });
    completedTestCount += 1;
  });

  test("fences one active effect per signer nonce and freezes exact signed bytes", async () => {
    await withSchema(async (admin) => {
      const signer = address("4");
      await admin.query(
        `INSERT INTO reward_signer_nonces (
           chain_id, signer_address, next_nonce, observed_pending_nonce,
           observed_block_number, observed_block_hash, observed_at
         ) VALUES (84532, $1, 7, 7, 100, $2, clock_timestamp())`,
        [signer, bytes32("4")],
      );
      for (const effectId of ["purchase-effect", "duplicate-effect"]) {
        await admin.query(
          `INSERT INTO reward_chain_effects (
             effect_id, effect_kind, state, chain_id, signer_address,
             target_address, reserved_amount_atomic
           ) VALUES ($1, 'ticket_purchase', 'planned', 84532, $2, $3, 10000)`,
          [effectId, signer, address("2")],
        );
      }
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE reward_chain_effects
              SET state='nonce_reserved', version=2, nonce=7, updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
        );
        await admin.query(
          `INSERT INTO reward_chain_effect_transitions (
             effect_id, target_version, event_type, event
           ) VALUES ('purchase-effect', 2, 'nonce_reserved', '{"nonce":"7"}'::jsonb)`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await expect(
        admin.query("BEGIN").then(async () => {
          try {
            await admin.query(
              `UPDATE reward_chain_effects
                  SET state='nonce_reserved', version=2, nonce=7,
                      updated_at=clock_timestamp()
                WHERE effect_id='duplicate-effect'`,
            );
            await admin.query(
              `INSERT INTO reward_chain_effect_transitions (
                 effect_id, target_version, event_type, event
               ) VALUES ('duplicate-effect', 2, 'nonce_reserved', '{"nonce":"7"}'::jsonb)`,
            );
            await admin.query("COMMIT");
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        }),
      ).rejects.toBeDefined();
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE reward_chain_effects
              SET state='prepared', version=3, calldata='0xdeadbeef',
                  calldata_hash=$1, signed_transaction='0x0102',
                  signed_transaction_hash=$2, prepared_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
          [hash("5"), bytes32("5")],
        );
        await admin.query(
          `INSERT INTO reward_chain_effect_transitions (
             effect_id, target_version, event_type, event
           ) VALUES ('purchase-effect', 3, 'prepared', '{"type":"prepared"}'::jsonb)`,
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
      await expect(
        admin.query(
          `UPDATE reward_chain_effects
              SET calldata='0xcafebabe', version=4, state='broadcast_pending',
                  transaction_hash=$1, broadcast_at=clock_timestamp(),
                  updated_at=clock_timestamp()
            WHERE effect_id='purchase-effect'`,
          [bytes32("5")],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("bytes are immutable") });
      const effect = await admin.query<{
        readonly state: string;
        readonly reserved_amount_atomic: string;
      }>(
        `SELECT state, reserved_amount_atomic::text
           FROM reward_chain_effects WHERE effect_id='purchase-effect'`,
      );
      expect(effect.rows).toEqual([{ state: "prepared", reserved_amount_atomic: "10000" }]);
    });
    completedTestCount += 1;
  });

  test("persists nonce reserve through confirmed custody ticket without duplicate purchase", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "purchase-repository", address("f"));
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "purchase-repository",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-101', 'megapot-base-sepolia-v2', 84532, 101,
           10000, clock_timestamp() + interval '1 hour', 25, 13, false,
           100000000000000000, 100000000000000000, 110, $1,
           clock_timestamp() - interval '1 minute', 3, clock_timestamp(),
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("6"), hash("6")],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id, drawing_id, observation_id, status, version,
             entry_cutoff_at, ticket_price_ceiling_atomic,
             reserved_ticket_cost_atomic, actual_ticket_cost_atomic,
             frozen_share_count, fallback_beneficiary, snapshot_id,
             commitment_effect_id, cutoff_frozen_at
           ) VALUES (
             $1, 101, 'drawing-observation-101', 'committed', 3,
             clock_timestamp() + interval '55 minutes', 50000, 50000, 0,
             1, false, 'snapshot-101', 'commitment-101', clock_timestamp()
           )`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_beneficiary_snapshots (
             snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
             algorithm_version, fallback, leaf_count, snapshot_hash,
             published_artifact, frozen_at
           ) VALUES (
             'snapshot-101', $1, 101,
             'pirate.megapot-pool-beneficiary-snapshot.v2', $2,
             'equal_v1', false, 1, $3, '{}'::jsonb, clock_timestamp()
           )`,
          [legId, bytes32("b"), bytes32("7")],
        );
        await admin.query(
          `INSERT INTO megapot_pool_snapshot_private_leaves (
             snapshot_id, ordinal, account_id, persona_id, order_key, leaf_commitment
           ) VALUES ('snapshot-101', 0, $1, $2, $3, $4)`,
          [identity.accountId, identity.personaId, bytes32("8"), bytes32("9")],
        );
        await admin.query(
          `INSERT INTO megapot_pool_commitment_effects (
             commitment_effect_id, snapshot_id, payload_hash, signing_key_id,
             signature, state, prepared_at, published_at, public_reference
           ) VALUES (
             'commitment-101', 'snapshot-101', $1, 'test-commitment-key',
             'test-signature', 'published', clock_timestamp(), clock_timestamp(),
             'urn:pirate:test:commitment-101'
           )`,
          [hash("7")],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      await admin.query(`UPDATE song_reward_offer_legs SET reserved_atomic=50000 WHERE leg_id=$1`, [
        legId,
      ]);

      const work = makeControlPlaneMegapotWorkStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      await expect(
        Effect.runPromise(work.loadDrawings({ statuses: ["committed"], limit: 50 })),
      ).resolves.toEqual([
        {
          poolLegId: legId,
          drawingId: 101n,
          status: "committed",
          attestationId: "megapot-base-sepolia-v2",
          ticketPriceAtomic: 10_000n,
        },
      ]);

      const store = makeControlPlaneMegapotPurchaseStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const candidate = await Effect.runPromise(
        store.loadCandidate({ poolLegId: legId, drawingId: 101n }),
      );
      expect(candidate).toMatchObject({
        drawingVersion: 3,
        ticketPriceAtomic: 10_000n,
        ballMax: 25,
        bonusballMax: 13,
      });
      await admin.query(
        `INSERT INTO reward_signer_nonces (
           chain_id, signer_address, next_nonce, observed_pending_nonce,
           observed_block_number, observed_block_hash, observed_at
         ) VALUES ($1,$2,9,8,110,$3,clock_timestamp() - interval '1 second')`,
        [candidate.chainId, candidate.custodyAddress, bytes32("7")],
      );
      const reserved = await Effect.runPromise(
        store.reserveNonce({
          candidate,
          effectId: "purchase-effect-101",
          ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
          observedPendingNonce: 9n,
          observedBlockNumber: 111n,
          observedBlockHash: bytes32("8"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(reserved.nonce).toBe(9n);
      const transactionHash = bytes32("9");
      await Effect.runPromise(
        store.prepare({
          reservation: reserved,
          ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
          calldata: "0xdeadbeef",
          calldataHash: hash("8"),
          signedTransaction: "0x0102",
          signedTransactionHash: transactionHash,
          preparedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        store.recordSubmission({
          effectId: reserved.effectId,
          transactionHash,
          submittedAt: new Date().toISOString(),
          outcome: "accepted",
        }),
      );
      await expect(Effect.runPromise(work.loadChainEffects(50))).resolves.toContainEqual({
        effectId: "purchase-effect-101",
        effectKind: "ticket_purchase",
      });
      await Effect.runPromise(
        store.confirm({
          effectId: reserved.effectId,
          transactionHash,
          ticketId: 501n,
          purchaseLogIndex: 3,
          mintLogIndex: 4,
          blockNumber: 112n,
          blockHash: bytes32("a"),
          receiptHash: hash("a"),
          confirmations: 3,
          referralFeesAtomic: 100n,
          lpEarningsAtomic: 900n,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const rows = await admin.query<{
        readonly effect_state: string;
        readonly drawing_state: string;
        readonly ticket_state: string;
        readonly evidence_count: string;
        readonly reserved_atomic: string;
        readonly spent_atomic: string;
        readonly actual_ticket_cost_atomic: string;
        readonly referral_fees_atomic: string;
      }>(
        `SELECT effect.state AS effect_state, drawing.status AS drawing_state,
                ticket.status AS ticket_state,
                (SELECT count(*)::text FROM megapot_purchase_receipt_evidence
                  WHERE purchase_effect_id=effect.effect_id) AS evidence_count,
                leg.reserved_atomic::text, leg.spent_atomic::text,
                drawing.actual_ticket_cost_atomic::text,
                evidence.referral_fees_atomic::text
           FROM reward_chain_effects effect
           JOIN megapot_pool_drawings drawing
             ON drawing.purchase_effect_id=effect.effect_id
           JOIN megapot_ticket_inventory ticket
             ON ticket.purchase_effect_id=effect.effect_id
           JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
           JOIN megapot_purchase_receipt_evidence evidence
             ON evidence.purchase_effect_id=effect.effect_id
          WHERE effect.effect_id='purchase-effect-101'`,
      );
      expect(rows.rows).toEqual([
        {
          effect_state: "confirmed",
          drawing_state: "tickets_confirmed",
          ticket_state: "custodied",
          evidence_count: "1",
          reserved_atomic: "0",
          spent_atomic: "10000",
          actual_ticket_cost_atomic: "10000",
          referral_fees_atomic: "100",
        },
      ]);
      await expect(
        Effect.runPromise(
          work.loadDrawings({ statuses: ["tickets_confirmed", "drawing_pending"], limit: 50 }),
        ),
      ).resolves.toContainEqual({
        poolLegId: legId,
        drawingId: 101n,
        status: "tickets_confirmed",
        attestationId: "megapot-base-sepolia-v2",
        ticketPriceAtomic: 10_000n,
      });
      await expect(
        Effect.runPromise(
          store.reserveNonce({
            candidate,
            effectId: "purchase-effect-101-duplicate",
            ticket: { normals: [1, 2, 3, 4, 5], bonusball: 6 },
            observedPendingNonce: 9n,
            observedBlockNumber: 113n,
            observedBlockHash: bytes32("b"),
            observedAt: new Date().toISOString(),
          }),
        ),
      ).rejects.toMatchObject({ reason: "drawing-not-committed" });

      const sweepStore = makeControlPlaneMegapotSweepStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const sweepCandidate = await Effect.runPromise(
        sweepStore.loadCandidate({ poolLegId: legId, drawingId: 101n }),
      );
      const sweep = await Effect.runPromise(
        sweepStore.complete({
          candidate: sweepCandidate,
          sweepId: "sweep-101",
          observationBlockNumber: 120n,
          observationBlockHash: bytes32("c"),
          drawingStateHash: hash("c"),
          tierId: 7,
          custodyOwnerAddress: address("4"),
          grossWinningsAtomic: 1_001n,
          referralWinShareAtomic: 100_000_000_000_000_000n,
          referralAccrualAtomic: 100n,
          netWinningsAtomic: 901n,
          observedAt: new Date().toISOString(),
        }),
      );
      expect(sweep).toMatchObject({ outcome: "winnings_detected", netWinningsAtomic: 901n });
      await expect(Effect.runPromise(sweepStore.findResult("sweep-101"))).resolves.toEqual(sweep);
      const swept = await admin.query<{
        readonly drawing_state: string;
        readonly drawing_version: string;
        readonly ticket_state: string;
        readonly sweep_count: string;
      }>(
        `SELECT drawing.status AS drawing_state, drawing.version::text AS drawing_version,
                ticket.status AS ticket_state,
                (SELECT count(*)::text FROM megapot_sweep_ticket_evidence
                  WHERE sweep_id='sweep-101') AS sweep_count
           FROM megapot_pool_drawings drawing
           JOIN megapot_ticket_inventory ticket
             ON ticket.pool_leg_id=drawing.pool_leg_id
            AND ticket.drawing_id=drawing.drawing_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=101`,
        [legId],
      );
      expect(swept.rows).toEqual([
        {
          drawing_state: "winnings_detected",
          drawing_version: "7",
          ticket_state: "custodied",
          sweep_count: "1",
        },
      ]);

      const claimStore = makeControlPlaneMegapotClaimStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const claimCandidate = await Effect.runPromise(
        claimStore.loadCandidate({ poolLegId: legId, drawingId: 101n }),
      );
      expect(claimCandidate).toMatchObject({
        ticketId: 501n,
        expectedGrossWinningsAtomic: 1_001n,
        expectedReferralAccrualAtomic: 100n,
        expectedNetWinningsAtomic: 901n,
      });
      const claimReservation = await Effect.runPromise(
        claimStore.reserveNonce({
          candidate: claimCandidate,
          effectId: "claim-effect-101",
          custodyBalanceBeforeAtomic: 20_000n,
          referralBalanceBeforeAtomic: 1_000n,
          observedPendingNonce: 10n,
          observedBlockNumber: 121n,
          observedBlockHash: bytes32("d"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(claimReservation.nonce).toBe(10n);
      const claimTransactionHash = bytes32("e");
      await Effect.runPromise(
        claimStore.prepare({
          reservation: claimReservation,
          calldata: "0x1bf0ade0",
          calldataHash: hash("d"),
          signedTransaction: "0x0506",
          signedTransactionHash: claimTransactionHash,
          preparedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        claimStore.recordSubmission({
          effectId: claimReservation.effectId,
          transactionHash: claimTransactionHash,
          submittedAt: new Date().toISOString(),
          outcome: "accepted",
        }),
      );
      await Effect.runPromise(
        claimStore.confirm({
          effectId: claimReservation.effectId,
          transactionHash: claimTransactionHash,
          claimLogIndex: 4,
          burnLogIndex: 5,
          referralLogIndex: 6,
          transferLogIndex: 7,
          grossWinningsAtomic: 1_001n,
          referralAccrualAtomic: 100n,
          netWinningsAtomic: 901n,
          custodyBalanceAfterAtomic: 20_901n,
          referralBalanceAfterAtomic: 1_100n,
          blockNumber: 122n,
          blockHash: bytes32("e"),
          receiptHash: hash("e"),
          confirmations: 3,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const claimed = await admin.query<{
        readonly effect_state: string;
        readonly drawing_state: string;
        readonly ticket_state: string;
        readonly received_atomic: string;
        readonly win_share_atomic: string;
        readonly evidence_transaction_hash: string;
        readonly evidence_gross_atomic: string;
        readonly evidence_referral_atomic: string;
        readonly evidence_net_atomic: string;
        readonly evidence_block_number: string;
        readonly evidence_block_hash: string;
        readonly evidence_receipt_hash: string;
        readonly evidence_confirmations: number;
      }>(
        `SELECT effect.state AS effect_state, drawing.status AS drawing_state,
                ticket.status AS ticket_state, claim.received_atomic::text,
                revenue.amount_atomic::text AS win_share_atomic,
                evidence.transaction_hash AS evidence_transaction_hash,
                evidence.gross_winnings_atomic::text AS evidence_gross_atomic,
                evidence.referral_accrual_atomic::text AS evidence_referral_atomic,
                evidence.net_winnings_atomic::text AS evidence_net_atomic,
                evidence.block_number::text AS evidence_block_number,
                evidence.block_hash AS evidence_block_hash,
                evidence.receipt_hash AS evidence_receipt_hash,
                evidence.confirmations AS evidence_confirmations
           FROM reward_chain_effects effect
           JOIN megapot_claim_effects claim ON claim.claim_effect_id=effect.effect_id
           JOIN megapot_pool_drawings drawing ON drawing.claim_effect_id=effect.effect_id
           JOIN megapot_ticket_inventory ticket
             ON ticket.attestation_id=claim.attestation_id AND ticket.ticket_id=claim.ticket_id
           JOIN megapot_claim_receipt_evidence evidence
             ON evidence.claim_effect_id=effect.effect_id
           JOIN platform_referral_revenue_ledger revenue
             ON revenue.ticket_id=claim.ticket_id AND revenue.revenue_kind='win_share'
          WHERE effect.effect_id='claim-effect-101'`,
      );
      expect(claimed.rows).toEqual([
        {
          effect_state: "confirmed",
          drawing_state: "claimed",
          ticket_state: "claimed",
          received_atomic: "901",
          win_share_atomic: "100",
          evidence_transaction_hash: claimTransactionHash,
          evidence_gross_atomic: "1001",
          evidence_referral_atomic: "100",
          evidence_net_atomic: "901",
          evidence_block_number: "122",
          evidence_block_hash: bytes32("e"),
          evidence_receipt_hash: hash("e"),
          evidence_confirmations: 3,
        },
      ]);

      const allocationStore = makeControlPlaneMegapotAllocationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const allocationCoordinator = makeMegapotAllocationCoordinator({
        store: allocationStore,
        now: () => Date.now(),
      });
      const allocation = await Effect.runPromise(
        allocationCoordinator.allocate({ poolLegId: legId, drawingId: 101n }),
      );
      const allocationReplay = await Effect.runPromise(
        allocationCoordinator.allocate({ poolLegId: legId, drawingId: 101n }),
      );
      expect(allocation.allocations).toHaveLength(1);
      expect(allocation.allocations[0]).toMatchObject({
        accountId: identity.accountId,
        personaId: identity.personaId,
        amountAtomic: 901n,
        allocationKind: "participant",
      });
      expect(allocationReplay).toEqual(allocation);

      const credited = await admin.query<{
        readonly drawing_state: string;
        readonly batch_state: string;
        readonly amount_atomic: string;
        readonly credit_state: string;
        readonly allocation_count: string;
      }>(
        `SELECT drawing.status AS drawing_state, batch.state AS batch_state,
                credit.amount_atomic::text, credit.state AS credit_state,
                (SELECT count(*)::text FROM megapot_allocations allocation
                  WHERE allocation.allocation_batch_id=batch.allocation_batch_id)
                  AS allocation_count
           FROM megapot_pool_drawings drawing
           JOIN megapot_allocation_batches batch
             ON batch.allocation_batch_id=drawing.allocation_batch_id
           JOIN megapot_allocations allocation
             ON allocation.allocation_batch_id=batch.allocation_batch_id
           JOIN reward_ledger_credits credit ON credit.credit_id=allocation.credit_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=101`,
        [legId],
      );
      expect(credited.rows).toEqual([
        {
          drawing_state: "credited",
          batch_state: "credited",
          amount_atomic: "901",
          credit_state: "credited",
          allocation_count: "1",
        },
      ]);
      const creditId = allocation.allocations[0]?.creditId;
      if (creditId === null || creditId === undefined) throw new Error("missing payout credit");
      await expect(Effect.runPromise(work.loadCredits(50))).resolves.toContain(creditId);
      const projections = makeControlPlaneRewardProjectionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const publicPool = await Effect.runPromise(
        projections.findPublicSongPool({
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(publicPool).toMatchObject({
        offerId,
        legId,
        drawing: {
          drawingId: 101n,
          lifecycleStatus: "credited",
          state: "won",
          beneficiaryCount: 1,
          netWinningsAtomic: 901n,
          ticketId: 501n,
        },
      });
      const serializedPublicPool = JSON.stringify(publicPool, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      expect(serializedPublicPool).not.toContain(identity.accountId);
      expect(serializedPublicPool).not.toContain(identity.personaId);
      const standingBeforePayout = await Effect.runPromise(
        projections.findStanding({ accountId: identity.accountId, legId }),
      );
      expect(standingBeforePayout).toEqual({
        legId,
        drawingId: 101n,
        participantState: "won",
        shareHeld: true,
        shareAmountAtomic: 901n,
        sponsorFallbackState: null,
        sponsorFallbackAmountAtomic: null,
        rewardCreditId: creditId,
        rewardCreditState: "credited",
        beneficiaryCount: 1,
      });
      const creditsBeforePayout = await Effect.runPromise(
        projections.listCredits({ accountId: identity.accountId, cursor: null, limit: 25 }),
      );
      expect(creditsBeforePayout).toMatchObject({
        items: [{ creditId, amountAtomic: 901n, state: "credited" }],
        nextCursor: null,
      });
      await expect(
        Effect.runPromise(
          projections.listCredits({
            accountId: identity.accountId,
            cursor: "credit-not-owned",
            limit: 25,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "RewardProjectionRejected", reason: "invalid-cursor" });

      const solvencyStore = makeControlPlaneCustodySolvencyStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const solvencyCandidate = await Effect.runPromise(
        solvencyStore.loadCandidate("megapot-base-sepolia-v2"),
      );
      const solvency = await Effect.runPromise(
        solvencyStore.record({
          candidate: solvencyCandidate,
          observationId: "solvency-123",
          balanceAtomic: 100_000n,
          blockNumber: 123n,
          blockHash: bytes32("f"),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        }),
      );
      expect(solvency).toMatchObject({
        outstandingCreditAtomic: 901n,
        reservedPurchaseAtomic: 0n,
        pendingRefundAtomic: 90_000n,
        solvent: true,
      });

      const payoutStore = makeControlPlaneRewardPayoutStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const payoutCandidate = await Effect.runPromise(payoutStore.loadCandidate(creditId));
      const payoutReservation = await Effect.runPromise(
        payoutStore.reserveNonce({
          candidate: payoutCandidate,
          effectId: "payout-effect-101",
          observedPendingNonce: 11n,
          observedBlockNumber: 123n,
          observedBlockHash: bytes32("f"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(payoutReservation.nonce).toBe(11n);
      const payoutCalldata = encodeMegapotUsdcTransfer(address("f"), 901n);
      const payoutTransactionHash = bytes32("1");
      await Effect.runPromise(
        payoutStore.prepare({
          reservation: payoutReservation,
          calldata: payoutCalldata,
          calldataHash: hash("1"),
          signedTransaction: "0x0708",
          signedTransactionHash: payoutTransactionHash,
          preparedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        payoutStore.recordSubmission({
          effectId: payoutReservation.effectId,
          transactionHash: payoutTransactionHash,
          submittedAt: new Date().toISOString(),
          outcome: "accepted",
        }),
      );
      await Effect.runPromise(
        payoutStore.confirm({
          effectId: payoutReservation.effectId,
          transactionHash: payoutTransactionHash,
          transferLogIndex: 8,
          amountAtomic: 901n,
          custodyBalanceAfterAtomic: 99_099n,
          blockNumber: 124n,
          blockHash: bytes32("2"),
          receiptHash: hash("2"),
          confirmations: 3,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const paid = await admin.query<{
        readonly credit_state: string;
        readonly paid_atomic: string;
        readonly effect_state: string;
        readonly evidence_count: string;
      }>(
        `SELECT credit.state AS credit_state, credit.paid_atomic::text,
                effect.state AS effect_state,
                (SELECT count(*)::text FROM reward_erc20_transfer_receipt_evidence
                  WHERE effect_id=effect.effect_id) AS evidence_count
           FROM reward_ledger_credits credit
           JOIN reward_payout_effects payout ON payout.credit_id=credit.credit_id
           JOIN reward_chain_effects effect ON effect.effect_id=payout.payout_effect_id
          WHERE credit.credit_id=$1`,
        [creditId],
      );
      expect(paid.rows).toEqual([
        {
          credit_state: "sent",
          paid_atomic: "901",
          effect_state: "confirmed",
          evidence_count: "1",
        },
      ]);
      await expect(
        Effect.runPromise(projections.findStanding({ accountId: identity.accountId, legId })),
      ).resolves.toMatchObject({
        participantState: "sent",
        rewardCreditId: creditId,
        rewardCreditState: "sent",
      });
      await expect(
        Effect.runPromise(
          projections.listCredits({ accountId: identity.accountId, cursor: null, limit: 25 }),
        ),
      ).resolves.toMatchObject({
        items: [{ creditId, amountAtomic: 901n, paidAtomic: 901n, state: "sent" }],
      });
    });
    completedTestCount += 1;
  }, 10_000);

  test("closes a stale committed purchase before broadcast and releases its reservation", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "purchase-prebroadcast-close", address("e"));
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "purchase-prebroadcast-close",
        expired: true,
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-prebroadcast-close', 'megapot-base-sepolia-v2', 84532, 101,
           10000, clock_timestamp() - interval '10 minutes', 25, 13, false,
           100000000000000000, 100000000000000000, 110, $1,
           clock_timestamp() - interval '20 minutes', 3,
           clock_timestamp() - interval '15 minutes',
           clock_timestamp() - interval '10 minutes', $2
         )`,
        [bytes32("6"), hash("6")],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id, drawing_id, observation_id, status, version,
             entry_cutoff_at, ticket_price_ceiling_atomic,
             reserved_ticket_cost_atomic, actual_ticket_cost_atomic,
             frozen_share_count, fallback_beneficiary, snapshot_id,
             commitment_effect_id, cutoff_frozen_at, created_at, updated_at
           ) VALUES (
             $1, 101, 'drawing-observation-prebroadcast-close', 'committed', 3,
             clock_timestamp() - interval '15 minutes', 50000, 50000, 0,
             1, false, 'snapshot-prebroadcast-close',
             'commitment-prebroadcast-close', clock_timestamp() - interval '20 minutes',
             clock_timestamp() - interval '25 minutes',
             clock_timestamp() - interval '17 minutes'
           )`,
          [legId],
        );
        await admin.query(
          `INSERT INTO megapot_pool_beneficiary_snapshots (
             snapshot_id, pool_leg_id, drawing_id, domain, terms_hash,
             algorithm_version, fallback, leaf_count, snapshot_hash,
             published_artifact, frozen_at
           ) VALUES (
             'snapshot-prebroadcast-close', $1, 101,
             'pirate.megapot-pool-beneficiary-snapshot.v2', $2,
             'equal_v1', false, 1, $3, '{}'::jsonb,
             clock_timestamp() - interval '20 minutes'
           )`,
          [legId, bytes32("b"), bytes32("7")],
        );
        await admin.query(
          `INSERT INTO megapot_pool_commitment_effects (
             commitment_effect_id, snapshot_id, payload_hash, signing_key_id,
             signature, state, prepared_at, published_at, public_reference
           ) VALUES (
             'commitment-prebroadcast-close', 'snapshot-prebroadcast-close', $1,
             'test-commitment-key', 'test-signature', 'published',
             clock_timestamp() - interval '18 minutes',
             clock_timestamp() - interval '17 minutes',
             'urn:pirate:test:commitment-prebroadcast-close'
           )`,
          [hash("7")],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(`UPDATE song_reward_offer_legs SET reserved_atomic=50000 WHERE leg_id=$1`, [
        legId,
      ]);
      const layer = makeDirectPostgresControlPlaneLayer(scopedConnection);
      const store = makeControlPlaneMegapotPurchaseStore(layer);
      const candidate = await Effect.runPromise(
        store.loadCandidate({ poolLegId: legId, drawingId: 101n }),
      );
      await Effect.runPromise(
        store.closePreBroadcast({
          candidate,
          reason: "drawing_rolled_over",
          failedAt: new Date().toISOString(),
        }),
      );
      const closed = await admin.query<{
        readonly drawing_status: string;
        readonly terminal_reason: string;
        readonly reserved_atomic: string;
      }>(
        `SELECT drawing.status AS drawing_status, drawing.terminal_reason,
                leg.reserved_atomic::text
           FROM megapot_pool_drawings drawing
           JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=101`,
        [legId],
      );
      expect(closed.rows).toEqual([
        {
          drawing_status: "closed_purchase_unavailable",
          terminal_reason: "drawing_rolled_over",
          reserved_atomic: "0",
        },
      ]);
      await expect(
        admin.query(
          `UPDATE megapot_pool_drawings
              SET version=version + 1, updated_at=updated_at + interval '1 microsecond'
            WHERE pool_leg_id=$1 AND drawing_id=101`,
          [legId],
        ),
      ).rejects.toThrow(/terminal Megapot pool drawing is immutable/);
      const projections = makeControlPlaneRewardProjectionStore(layer);
      await expect(
        Effect.runPromise(
          projections.findPublicSongPool({
            communityId: identity.communityId,
            postId: identity.postId,
          }),
        ),
      ).resolves.toMatchObject({
        drawing: {
          lifecycleStatus: "operational_hold",
          state: "entry_closed",
        },
      });
      const terminal = makeControlPlaneRewardOfferTerminalStore(layer);
      await expect(Effect.runPromise(terminal.closeExpired(50))).resolves.toEqual([
        expect.objectContaining({ offerId, status: "expired", legIds: [legId] }),
      ]);
    });
    completedTestCount += 1;
  });

  test("atomically holds custody-integrity failures and removes them from retry work", async () => {
    await withSchema(async (admin, scopedConnection) => {
      await seedMegapotAuthority(admin);
      const sweepIdentity = await seedSong(admin, "sweep-review");
      const sweepLeg = await seedActivePoolLeg(admin, sweepIdentity, {
        fallback: false,
        suffix: "sweep-review",
      });
      await seedTicketReviewCandidate(admin, {
        legId: sweepLeg.legId,
        suffix: "sweep-review",
        drawingId: 201,
        stage: "sweep",
      });
      const layer = makeDirectPostgresControlPlaneLayer(scopedConnection);
      const sweepStore = makeControlPlaneMegapotSweepStore(layer);
      const sweepCandidate = await Effect.runPromise(
        sweepStore.loadCandidate({ poolLegId: sweepLeg.legId, drawingId: 201n }),
      );
      await Effect.runPromise(
        sweepStore.requireReview({
          candidate: sweepCandidate,
          sweepId: "sweep-review-201",
          reason: "ticket_owner_mismatch",
          observationBlockNumber: 203n,
          observationBlockHash: bytes32("5"),
          observedOwnerAddress: address("f"),
          observedAt: new Date().toISOString(),
        }),
      );
      const sweepHeld = await admin.query<{
        readonly drawing_state: string;
        readonly terminal_reason: string;
        readonly ticket_state: string;
        readonly source_kind: string;
        readonly observed_owner_address: string;
      }>(
        `SELECT drawing.status AS drawing_state, drawing.terminal_reason,
                ticket.status AS ticket_state, review.source_kind,
                review.observed_owner_address
           FROM megapot_pool_drawings drawing
           JOIN megapot_ticket_inventory ticket
             ON ticket.pool_leg_id=drawing.pool_leg_id
            AND ticket.drawing_id=drawing.drawing_id
           JOIN megapot_ticket_review_evidence review
             ON review.attestation_id=ticket.attestation_id
            AND review.ticket_id=ticket.ticket_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=201`,
        [sweepLeg.legId],
      );
      expect(sweepHeld.rows).toEqual([
        {
          drawing_state: "operational_hold",
          terminal_reason: "ticket_owner_mismatch",
          ticket_state: "needs_review",
          source_kind: "sweep",
          observed_owner_address: address("f"),
        },
      ]);
      await expect(
        Effect.runPromise(sweepStore.loadCandidate({ poolLegId: sweepLeg.legId, drawingId: 201n })),
      ).rejects.toMatchObject({ reason: "not-found" });

      const claimStore = makeControlPlaneMegapotClaimStore(layer);
      const preflightIdentity = await seedSong(admin, "claim-preflight-review");
      const preflightLeg = await seedActivePoolLeg(admin, preflightIdentity, {
        fallback: false,
        suffix: "claim-preflight-review",
      });
      await seedTicketReviewCandidate(admin, {
        legId: preflightLeg.legId,
        suffix: "claim-preflight-review",
        drawingId: 203,
        stage: "claim",
      });
      const preflightCandidate = await Effect.runPromise(
        claimStore.loadCandidate({ poolLegId: preflightLeg.legId, drawingId: 203n }),
      );
      await Effect.runPromise(
        claimStore.requireReview({
          candidate: preflightCandidate,
          reviewId: "claim-preflight-review-203",
          claimEffectId: null,
          reason: "ticket_owner_mismatch",
          observationBlockNumber: 204n,
          observationBlockHash: bytes32("6"),
          observedOwnerAddress: address("e"),
          observedAt: new Date().toISOString(),
        }),
      );
      const preflightHeld = await admin.query<{
        readonly drawing_state: string;
        readonly ticket_state: string;
        readonly source_kind: string;
        readonly claim_effect_id: string | null;
      }>(
        `SELECT drawing.status AS drawing_state, ticket.status AS ticket_state,
                review.source_kind, review.claim_effect_id
           FROM megapot_pool_drawings drawing
           JOIN megapot_ticket_inventory ticket
             ON ticket.pool_leg_id=drawing.pool_leg_id
            AND ticket.drawing_id=drawing.drawing_id
           JOIN megapot_ticket_review_evidence review
             ON review.attestation_id=ticket.attestation_id
            AND review.ticket_id=ticket.ticket_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=203`,
        [preflightLeg.legId],
      );
      expect(preflightHeld.rows).toEqual([
        {
          drawing_state: "operational_hold",
          ticket_state: "needs_review",
          source_kind: "claim",
          claim_effect_id: null,
        },
      ]);

      const claimIdentity = await seedSong(admin, "claim-review");
      const claimLeg = await seedActivePoolLeg(admin, claimIdentity, {
        fallback: false,
        suffix: "claim-review",
      });
      await seedTicketReviewCandidate(admin, {
        legId: claimLeg.legId,
        suffix: "claim-review",
        drawingId: 202,
        stage: "claim",
      });
      const claimCandidate = await Effect.runPromise(
        claimStore.loadCandidate({ poolLegId: claimLeg.legId, drawingId: 202n }),
      );
      const reservation = await Effect.runPromise(
        claimStore.reserveNonce({
          candidate: claimCandidate,
          effectId: "claim-review-202",
          custodyBalanceBeforeAtomic: 20_000n,
          referralBalanceBeforeAtomic: 1_000n,
          observedPendingNonce: 14n,
          observedBlockNumber: 204n,
          observedBlockHash: bytes32("6"),
          observedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        claimStore.requireReview({
          candidate: reservation,
          reviewId: reservation.effectId,
          claimEffectId: reservation.effectId,
          reason: "no_tickets_to_claim",
          observationBlockNumber: 205n,
          observationBlockHash: bytes32("7"),
          observedOwnerAddress: address("4"),
          observedAt: new Date().toISOString(),
        }),
      );
      const claimHeld = await admin.query<{
        readonly drawing_state: string;
        readonly terminal_reason: string;
        readonly ticket_state: string;
        readonly effect_state: string;
        readonly failure_class: string;
        readonly failure_reason: string;
        readonly claim_effect_id: string;
      }>(
        `SELECT drawing.status AS drawing_state, drawing.terminal_reason,
                ticket.status AS ticket_state, effect.state AS effect_state,
                effect.failure_class, effect.failure_reason, review.claim_effect_id
           FROM megapot_pool_drawings drawing
           JOIN megapot_ticket_inventory ticket
             ON ticket.pool_leg_id=drawing.pool_leg_id
            AND ticket.drawing_id=drawing.drawing_id
           JOIN megapot_ticket_review_evidence review
             ON review.attestation_id=ticket.attestation_id
            AND review.ticket_id=ticket.ticket_id
           JOIN reward_chain_effects effect ON effect.effect_id=review.claim_effect_id
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=202`,
        [claimLeg.legId],
      );
      expect(claimHeld.rows).toEqual([
        {
          drawing_state: "operational_hold",
          terminal_reason: "no_tickets_to_claim",
          ticket_state: "needs_review",
          effect_state: "terminal_failed",
          failure_class: "claim_preflight_integrity",
          failure_reason: "no_tickets_to_claim",
          claim_effect_id: "claim-review-202",
        },
      ]);
      const work = makeControlPlaneMegapotWorkStore(layer);
      await expect(Effect.runPromise(work.loadChainEffects(50))).resolves.not.toContainEqual({
        effectId: "claim-review-202",
        effectKind: "winnings_claim",
      });
      await expect(
        Effect.runPromise(
          work.loadDrawings({ statuses: ["winnings_detected", "claim_pending"], limit: 50 }),
        ),
      ).resolves.toEqual([]);
      await expect(
        admin.query(
          `UPDATE megapot_ticket_review_evidence SET reason='ticket_owner_mismatch'
            WHERE review_id='claim-review-202'`,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("review evidence is append-only"),
      });
    });
    completedTestCount += 1;
  }, 10_000);

  test("persists exact USDC approval evidence through the shared signer nonce fence", async () => {
    await withSchema(async (admin, scopedConnection) => {
      await seedMegapotAuthority(admin);
      const store = makeControlPlaneMegapotApprovalStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const candidate = await Effect.runPromise(store.loadCandidate("megapot-base-sepolia-v2"));
      await admin.query(
        `INSERT INTO reward_signer_nonces (
           chain_id, signer_address, next_nonce, observed_pending_nonce,
           observed_block_number, observed_block_hash, observed_at
         ) VALUES ($1,$2,12,11,119,$3,clock_timestamp() - interval '1 second')`,
        [candidate.chainId, candidate.custodyAddress, bytes32("b")],
      );
      const reserved = await Effect.runPromise(
        store.reserveNonce({
          candidate,
          effectId: "approval-effect-100000",
          allowanceBeforeAtomic: 0n,
          minimumAllowanceAtomic: 10_000n,
          approvedAmountAtomic: 100_000n,
          observedPendingNonce: 12n,
          observedBlockNumber: 120n,
          observedBlockHash: bytes32("c"),
          observedAt: new Date().toISOString(),
        }),
      );
      const transactionHash = bytes32("d");
      await Effect.runPromise(
        store.prepare({
          reservation: reserved,
          calldata: "0x095ea7b3",
          calldataHash: hash("d"),
          signedTransaction: "0x0304",
          signedTransactionHash: transactionHash,
          preparedAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(
        store.recordSubmission({
          effectId: reserved.effectId,
          transactionHash,
          submittedAt: new Date().toISOString(),
          outcome: "accepted",
        }),
      );
      await Effect.runPromise(
        store.confirm({
          effectId: reserved.effectId,
          transactionHash,
          approvalLogIndex: 2,
          approvedAmountAtomic: 100_000n,
          allowanceAfterAtomic: 100_000n,
          blockNumber: 121n,
          blockHash: bytes32("e"),
          receiptHash: hash("e"),
          confirmations: 3,
          confirmedAt: new Date().toISOString(),
        }),
      );
      const progress = await Effect.runPromise(store.findProgress(reserved.effectId));
      expect(progress).toMatchObject({
        state: "confirmed",
        approvedAmountAtomic: 100_000n,
        allowanceAfterAtomic: 100_000n,
        confirmations: 3,
      });
      const evidence = await admin.query<{
        readonly effect_kind: string;
        readonly effect_state: string;
        readonly approved_amount_atomic: string;
        readonly allowance_after_atomic: string;
      }>(
        `SELECT effect.effect_kind, effect.state AS effect_state,
                evidence.approved_amount_atomic::text,
                evidence.allowance_after_atomic::text
           FROM reward_chain_effects effect
           JOIN megapot_usdc_approval_receipt_evidence evidence
             ON evidence.approval_effect_id=effect.effect_id
          WHERE effect.effect_id='approval-effect-100000'`,
      );
      expect(evidence.rows).toEqual([
        {
          effect_kind: "usdc_approval",
          effect_state: "confirmed",
          approved_amount_atomic: "100000",
          allowance_after_atomic: "100000",
        },
      ]);
    });
    completedTestCount += 1;
  });

  test("confirms an exact user-authorized USDC top-up into the leg budget", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "funding-repository", address("d"));
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "funding-repository",
      });
      const store = makeControlPlaneRewardFundingStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const intent = await Effect.runPromise(
        store.plan({
          fundingEffectId: "funding-effect-top-up",
          legId,
          funderAccountId: identity.accountId,
          senderAddress: address("d"),
          expectedAmountAtomic: 500n,
          requiredConfirmations: 3,
        }),
      );
      expect(intent).toMatchObject({
        state: "planned",
        recipientAddress: address("4"),
        expectedAmountAtomic: 500n,
      });
      const transactionHash = bytes32("3");
      await Effect.runPromise(
        store.bindTransaction({ fundingEffectId: intent.fundingEffectId, transactionHash }),
      );
      await Effect.runPromise(
        store.confirm({
          fundingEffectId: intent.fundingEffectId,
          transactionHash,
          transferLogIndex: 9,
          amountAtomic: 500n,
          blockNumber: 130n,
          blockHash: bytes32("4"),
          observationHash: hash("4"),
          confirmedAt: new Date().toISOString(),
        }),
      );
      const funded = await admin.query<{
        readonly state: string;
        readonly confirmed_amount_atomic: string;
        readonly funded_atomic: string;
      }>(
        `SELECT funding.state, funding.confirmed_amount_atomic::text,
                leg.funded_atomic::text
           FROM song_reward_leg_funding_effects funding
           JOIN song_reward_offer_legs leg ON leg.leg_id=funding.leg_id
          WHERE funding.funding_effect_id='funding-effect-top-up'`,
      );
      expect(funded.rows).toEqual([
        { state: "confirmed", confirmed_amount_atomic: "500", funded_atomic: "100500" },
      ]);
    });
    completedTestCount += 1;
  });

  test("expires a settled pool and returns every unspent USDC atom pro rata", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "terminal-refunds");
      await seedMegapotAuthority(admin);
      const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "terminal-refunds",
        expired: true,
      });
      await admin.query(
        `INSERT INTO song_reward_leg_funding_effects (
           funding_effect_id, leg_id, funder_account_id, chain_id, token_address,
           sender_address, recipient_address, expected_amount_atomic,
           confirmed_amount_atomic, required_confirmations, state,
           transaction_hash, log_index, block_number, block_hash,
           observation_hash, confirmed_at
         ) VALUES
           ('funding-refund-a',$1,$2,84532,$3,$4,$5,33333,33333,3,'confirmed',
             $6,1,190,$7,$8,clock_timestamp()),
           ('funding-refund-b',$1,$2,84532,$3,$9,$5,66667,66667,3,'confirmed',
             $10,2,191,$11,$12,clock_timestamp()),
           ('funding-refund-unbound',$1,$2,84532,$3,$4,$5,123,NULL,3,'planned',
             NULL,NULL,NULL,NULL,NULL,NULL)`,
        [
          legId,
          identity.accountId,
          address("1"),
          address("b"),
          address("4"),
          bytes32("b"),
          bytes32("c"),
          hash("c"),
          address("c"),
          bytes32("d"),
          bytes32("e"),
          hash("e"),
        ],
      );
      await admin.query(
        `UPDATE song_reward_offer_legs
            SET spent_atomic=10000,updated_at=clock_timestamp()
          WHERE leg_id=$1`,
        [legId],
      );
      const layer = makeDirectPostgresControlPlaneLayer(scopedConnection);
      const terminalStore = makeControlPlaneRewardOfferTerminalStore(layer);
      const closed = await Effect.runPromise(terminalStore.closeExpired(10));
      expect(closed).toMatchObject([{ offerId, status: "expired", legIds: [legId] }]);
      const unbound = await admin.query<{
        readonly state: string;
        readonly failure_reason: string;
      }>(
        `SELECT state,failure_reason FROM song_reward_leg_funding_effects
          WHERE funding_effect_id='funding-refund-unbound'`,
      );
      expect(unbound.rows).toEqual([
        { state: "reclaimable_failed", failure_reason: "offer_ended_unbound" },
      ]);
      await expect(
        Effect.runPromise(makeControlPlaneRewardFundingStore(layer).find("funding-refund-unbound")),
      ).resolves.toMatchObject({ state: "reclaimable_failed", transactionHash: null });

      const work = makeControlPlaneMegapotWorkStore(layer);
      await expect(Effect.runPromise(work.loadRefunds(10))).resolves.toEqual([
        "funding-refund-a",
        "funding-refund-b",
      ]);
      const solvencyStore = makeControlPlaneCustodySolvencyStore(layer);
      const refundStore = makeControlPlaneRewardRefundStore(layer);
      const authority = await Effect.runPromise(
        solvencyStore.loadCandidate("megapot-base-sepolia-v2"),
      );

      const settle = async (input: {
        readonly fundingEffectId: string;
        readonly effectId: string;
        readonly amountAtomic: bigint;
        readonly blockNumber: bigint;
        readonly balanceBeforeAtomic: bigint;
        readonly balanceAfterAtomic: bigint;
        readonly hashByte: string;
      }) => {
        await Effect.runPromise(
          solvencyStore.record({
            candidate: authority,
            observationId: `solvency-${input.effectId}`,
            balanceAtomic: input.balanceBeforeAtomic,
            blockNumber: input.blockNumber,
            blockHash: bytes32(input.hashByte),
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
          }),
        );
        const candidate = await Effect.runPromise(refundStore.loadCandidate(input.fundingEffectId));
        expect(candidate.amountAtomic).toBe(input.amountAtomic);
        if (input.fundingEffectId === "funding-refund-a") {
          await expect(
            Effect.runPromise(
              refundStore.reserveNonce({
                candidate: { ...candidate, destinationAddress: address("f") },
                effectId: "refund-effect-tampered",
                observedPendingNonce: input.blockNumber,
                observedBlockNumber: input.blockNumber,
                observedBlockHash: bytes32(input.hashByte),
                observedAt: new Date().toISOString(),
              }),
            ),
          ).rejects.toMatchObject({ _tag: "RewardRefundRejected", reason: "effect-conflict" });
        }
        const reservation = await Effect.runPromise(
          refundStore.reserveNonce({
            candidate,
            effectId: input.effectId,
            observedPendingNonce: input.blockNumber,
            observedBlockNumber: input.blockNumber,
            observedBlockHash: bytes32(input.hashByte),
            observedAt: new Date().toISOString(),
          }),
        );
        const transactionHash = bytes32(input.hashByte);
        await Effect.runPromise(
          refundStore.prepare({
            reservation,
            calldata: encodeMegapotUsdcTransfer(
              candidate.destinationAddress,
              candidate.amountAtomic,
            ),
            calldataHash: hash(input.hashByte),
            signedTransaction: "0x090a",
            signedTransactionHash: transactionHash,
            preparedAt: new Date().toISOString(),
          }),
        );
        await Effect.runPromise(
          refundStore.recordSubmission({
            effectId: reservation.effectId,
            transactionHash,
            submittedAt: new Date().toISOString(),
            outcome: "accepted",
          }),
        );
        await Effect.runPromise(
          refundStore.confirm({
            effectId: reservation.effectId,
            transactionHash,
            transferLogIndex: Number(input.blockNumber),
            amountAtomic: input.amountAtomic,
            custodyBalanceAfterAtomic: input.balanceAfterAtomic,
            blockNumber: input.blockNumber + 1n,
            blockHash: bytes32(input.hashByte),
            receiptHash: hash(input.hashByte),
            confirmations: 3,
            confirmedAt: new Date().toISOString(),
          }),
        );
      };

      await settle({
        fundingEffectId: "funding-refund-a",
        effectId: "refund-effect-a",
        amountAtomic: 30_000n,
        blockNumber: 200n,
        balanceBeforeAtomic: 200_000n,
        balanceAfterAtomic: 170_000n,
        hashByte: "1",
      });
      await settle({
        fundingEffectId: "funding-refund-b",
        effectId: "refund-effect-b",
        amountAtomic: 60_000n,
        blockNumber: 202n,
        balanceBeforeAtomic: 170_000n,
        balanceAfterAtomic: 110_000n,
        hashByte: "2",
      });

      const refunds = await admin.query<{
        readonly funding_effect_id: string;
        readonly destination_address: string;
        readonly amount_atomic: string;
        readonly transfer_purpose: string;
      }>(
        `SELECT refund.funding_effect_id,refund.destination_address,
                refund.amount_atomic::text,evidence.transfer_purpose
           FROM reward_refund_effects refund
           JOIN reward_erc20_transfer_receipt_evidence evidence
             ON evidence.effect_id=refund.refund_effect_id
          WHERE refund.leg_id=$1 ORDER BY refund.funding_effect_id`,
        [legId],
      );
      expect(refunds.rows).toEqual([
        {
          funding_effect_id: "funding-refund-a",
          destination_address: address("b"),
          amount_atomic: "30000",
          transfer_purpose: "reward_refund",
        },
        {
          funding_effect_id: "funding-refund-b",
          destination_address: address("c"),
          amount_atomic: "60000",
          transfer_purpose: "reward_refund",
        },
      ]);
      const leg = await admin.query<{ readonly refunded_atomic: string }>(
        "SELECT refunded_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1",
        [legId],
      );
      expect(leg.rows).toEqual([{ refunded_atomic: "90000" }]);
      await expect(Effect.runPromise(work.loadRefunds(10))).resolves.toEqual([]);

      const unsettledIdentity = await seedSong(admin, "terminal-unsettled");
      const unsettled = await seedActivePoolLeg(admin, unsettledIdentity, {
        fallback: false,
        suffix: "terminal-unsettled",
        expired: true,
      });
      await admin.query(
        `INSERT INTO song_reward_leg_funding_effects (
           funding_effect_id,leg_id,funder_account_id,chain_id,token_address,
           sender_address,recipient_address,expected_amount_atomic,
           required_confirmations,state,transaction_hash
         ) VALUES ('funding-refund-confirming',$1,$2,84532,$3,$4,$5,500,3,
           'confirming',$6)`,
        [
          unsettled.legId,
          unsettledIdentity.accountId,
          address("1"),
          address("d"),
          address("4"),
          bytes32("9"),
        ],
      );
      await expect(Effect.runPromise(terminalStore.closeExpired(10))).resolves.toEqual([]);
      const stillOpen = await admin.query<{ readonly status: string }>(
        "SELECT status FROM song_reward_offers WHERE offer_id=$1",
        [unsettled.offerId],
      );
      expect(stillOpen.rows).toEqual([{ status: "active" }]);
    });
    completedTestCount += 1;
  }, 10_000);

  test("persists an attested drawing observation and opens each eligible pool once", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "drawing-observer");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "drawing-observer",
      });
      const endingIdentity = await seedSong(admin, "drawing-observer-ending");
      const ending = await seedActivePoolLeg(admin, endingIdentity, {
        fallback: false,
        suffix: "drawing-observer-ending",
        endsInMinutes: 30,
      });
      const store = makeControlPlaneMegapotDrawingObservationStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const authority = await Effect.runPromise(store.loadCandidate("megapot-base-sepolia-v2"));
      expect(authority).toMatchObject({
        chainId: 84_532,
        jackpotAddress: address("2"),
        usdcAddress: address("1"),
        custodyAddress: address("4"),
      });
      const now = Date.now();
      const observation = {
        observationId: "drawing-observation-repository-100",
        attestationId: authority.attestationId,
        chainId: authority.chainId,
        drawingId: 100n,
        grossPrizePoolAtomic: 9_007_199_254_740_993n,
        globalTicketsBought: 7n,
        ticketPriceAtomic: 10_000n,
        drawingTime: new Date(now + 60 * 60 * 1_000).toISOString(),
        ballMax: 25,
        bonusballMax: 13,
        drawingLocked: false,
        referralFeeWei: 100_000_000_000_000_000n,
        referralWinShareWei: 100_000_000_000_000_000n,
        blockNumber: 140n,
        blockHash: bytes32("5"),
        blockTimestamp: new Date(now - 5 * 60_000).toISOString(),
        confirmations: 1,
        observedAt: new Date(now - 4 * 60_000).toISOString(),
        expiresAt: new Date(now + 11 * 60_000).toISOString(),
        rawStateHash: hash("5"),
        legacyRawStateHash: hash("4"),
      } as const;
      const first = await Effect.runPromise(store.recordAndOpen(observation));
      const replay = await Effect.runPromise(store.recordAndOpen(observation));
      expect(first.openedPoolLegIds).toEqual([legId]);
      expect(replay.openedPoolLegIds).toEqual([]);
      expect(replay.observationId).toBe(first.observationId);
      const drawings = await admin.query<{
        readonly pool_leg_id: string;
        readonly status: string;
        readonly observation_id: string;
      }>(
        `SELECT pool_leg_id, status, observation_id
           FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=100`,
        [legId],
      );
      expect(drawings.rows).toEqual([
        {
          pool_leg_id: legId,
          status: "entry_open",
          observation_id: observation.observationId,
        },
      ]);
      const drawingsAfterOfferEnd = await admin.query(
        `SELECT pool_leg_id
           FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=100`,
        [ending.legId],
      );
      expect(drawingsAfterOfferEnd.rows).toEqual([]);

      const persisted = await admin.query<{
        readonly gross_prize_pool_atomic: string | null;
        readonly global_tickets_bought: string | null;
      }>(
        `SELECT gross_prize_pool_atomic::text, global_tickets_bought::text
           FROM megapot_drawing_observations WHERE observation_id=$1`,
        [observation.observationId],
      );
      expect(persisted.rows).toEqual([
        {
          gross_prize_pool_atomic: "9007199254740993",
          global_tickets_bought: "7",
        },
      ]);
      await expect(
        admin.query(
          `INSERT INTO megapot_drawing_observations (
             observation_id,attestation_id,chain_id,drawing_id,
             gross_prize_pool_atomic,global_tickets_bought,ticket_price_atomic,
             drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,
             referral_win_share_wei,block_number,block_hash,block_timestamp,
             confirmations,observed_at,expires_at,raw_state_hash
           )
           SELECT 'drawing-observation-repository-invalid-pair',attestation_id,chain_id,
                  drawing_id,NULL,1,ticket_price_atomic,drawing_time,ball_max,bonusball_max,
                  drawing_locked,referral_fee_wei,referral_win_share_wei,139,$2,
                  block_timestamp,confirmations,observed_at,expires_at,$3
             FROM megapot_drawing_observations WHERE observation_id=$1`,
          [observation.observationId, bytes32("9"), hash("9")],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "megapot_drawing_observations_prize_pool_pair",
      });

      const projections = makeControlPlaneRewardProjectionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const standingBeforeRefresh = await Effect.runPromise(
        projections.findStanding({ accountId: identity.accountId, legId }),
      );
      const laterObservation = {
        ...observation,
        observationId: "drawing-observation-repository-100-later",
        grossPrizePoolAtomic: 18_014_398_509_481_987n,
        globalTicketsBought: 11n,
        blockNumber: 141n,
        blockHash: bytes32("6"),
        blockTimestamp: new Date(now - 4 * 60_000).toISOString(),
        observedAt: new Date(now - 3 * 60_000).toISOString(),
        expiresAt: new Date(now + 12 * 60_000).toISOString(),
        rawStateHash: hash("6"),
        legacyRawStateHash: hash("a"),
      } as const;
      await Effect.runPromise(store.recordAndOpen(laterObservation));
      await Effect.runPromise(store.recordAndOpen(observation));
      const latestPool = await Effect.runPromise(
        projections.findPublicSongPool({
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(latestPool?.drawing).toMatchObject({
        drawingId: 100n,
        grossPrizePoolAtomic: 18_014_398_509_481_987n,
        globalTicketsBought: 11n,
        prizePoolObservedAt: laterObservation.observedAt,
        prizePoolBasis:
          "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
        globalTicketsBasis: "drawing_wide_all_megapot_buyers",
      });
      const standingAfterRefresh = await Effect.runPromise(
        projections.findStanding({ accountId: identity.accountId, legId }),
      );
      expect(standingAfterRefresh).toEqual(standingBeforeRefresh);

      const expiredObservation = {
        ...observation,
        observationId: "drawing-observation-repository-100-expired",
        grossPrizePoolAtomic: 27_021_597_764_222_981n,
        globalTicketsBought: 13n,
        blockNumber: 142n,
        blockHash: bytes32("7"),
        blockTimestamp: new Date(now - 3 * 60_000).toISOString(),
        observedAt: new Date(now - 2 * 60_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(),
        rawStateHash: hash("7"),
        legacyRawStateHash: hash("b"),
      } as const;
      await Effect.runPromise(store.recordAndOpen(expiredObservation));
      await expect(
        Effect.runPromise(
          store.recordAndOpen({
            ...expiredObservation,
            observationId: "drawing-observation-repository-100-conflict",
            rawStateHash: hash("8"),
          }),
        ),
      ).rejects.toMatchObject({ reason: "conflict" });
      const staleOpenPool = await Effect.runPromise(
        projections.findPublicSongPool({
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(staleOpenPool?.drawing).toMatchObject({
        grossPrizePoolAtomic: null,
        globalTicketsBought: null,
        prizePoolObservedAt: null,
      });

      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE megapot_pool_drawings
              SET status='closed_no_entries', frozen_share_count=0,
                  fallback_beneficiary=false, cutoff_frozen_at=clock_timestamp(),
                  terminal_at=clock_timestamp(), version=version+1,
                  updated_at=clock_timestamp()
            WHERE pool_leg_id=$1 AND drawing_id=100`,
          [legId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const terminalPool = await Effect.runPromise(
        projections.findPublicSongPool({
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(terminalPool?.drawing).toMatchObject({
        lifecycleStatus: "closed_no_entries",
        grossPrizePoolAtomic: 27_021_597_764_222_981n,
        globalTicketsBought: 13n,
        prizePoolObservedAt: expiredObservation.observedAt,
      });

      const legacyRawStateHash = hash("c");
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id,attestation_id,chain_id,drawing_id,ticket_price_atomic,
           drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,
           referral_win_share_wei,block_number,block_hash,block_timestamp,
           confirmations,observed_at,expires_at,raw_state_hash
         ) VALUES ($1,$2,$3,100,10000,$4::timestamptz,25,13,false,$5,$6,143,$7,
           $8::timestamptz,1,$9::timestamptz,$10::timestamptz,$11)`,
        [
          "drawing-observation-repository-100-legacy",
          authority.attestationId,
          authority.chainId,
          observation.drawingTime,
          observation.referralFeeWei.toString(),
          observation.referralWinShareWei.toString(),
          bytes32("8"),
          new Date(now - 2 * 60_000).toISOString(),
          new Date(now - 60_000).toISOString(),
          new Date(now + 14 * 60_000).toISOString(),
          legacyRawStateHash,
        ],
      );
      const legacyReplay = await Effect.runPromise(
        store.recordAndOpen({
          ...observation,
          observationId: "drawing-observation-repository-100-v2-replay",
          grossPrizePoolAtomic: 36_028_797_018_963_975n,
          globalTicketsBought: 17n,
          blockNumber: 143n,
          blockHash: bytes32("8"),
          blockTimestamp: new Date(now - 2 * 60_000).toISOString(),
          observedAt: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 14 * 60_000).toISOString(),
          rawStateHash: hash("d"),
          legacyRawStateHash,
        }),
      );
      expect(legacyReplay).toMatchObject({
        observationId: "drawing-observation-repository-100-legacy",
        grossPrizePoolAtomic: null,
        globalTicketsBought: null,
      });
      const legacyPool = await Effect.runPromise(
        projections.findPublicSongPool({
          communityId: identity.communityId,
          postId: identity.postId,
        }),
      );
      expect(legacyPool?.drawing).toMatchObject({
        grossPrizePoolAtomic: null,
        globalTicketsBought: null,
        prizePoolObservedAt: null,
      });

      await admin.query("SET enable_seqscan=off");
      try {
        const explain = await admin.query<{ readonly "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT latest.gross_prize_pool_atomic
             FROM song_reward_offer_legs leg
             JOIN LATERAL (
               SELECT candidate.gross_prize_pool_atomic
                 FROM megapot_drawing_observations candidate
                WHERE candidate.attestation_id=leg.attestation_id
                  AND candidate.drawing_id=100
                ORDER BY candidate.block_number DESC,
                         candidate.observed_at DESC,
                         candidate.observation_id
                LIMIT 1
             ) latest ON true
            WHERE leg.leg_id=$1`,
          [legId],
        );
        expect(explain.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
          "megapot_drawing_observations_latest_idx",
        );
      } finally {
        await admin.query("RESET enable_seqscan");
      }
    });
    completedTestCount += 1;
  });

  test("rejects direct drawing attachment outside the active offer window", async () => {
    await withSchema(async (admin) => {
      await seedMegapotAuthority(admin);
      const cases = [
        {
          suffix: "drawing-guard-paused",
          offerStatus: "paused",
          endsInMinutes: 120,
          drawingInMinutes: 60,
        },
        {
          suffix: "drawing-guard-expired",
          offerStatus: "expired",
          endsInMinutes: 120,
          drawingInMinutes: 60,
        },
        {
          suffix: "drawing-guard-after-end",
          offerStatus: "active",
          endsInMinutes: 30,
          drawingInMinutes: 60,
        },
        {
          suffix: "drawing-guard-past-cutoff",
          offerStatus: "active",
          endsInMinutes: 120,
          drawingInMinutes: 4,
        },
      ] as const;

      for (const [index, testCase] of cases.entries()) {
        const identity = await seedSong(admin, testCase.suffix);
        const { legId, offerId } = await seedActivePoolLeg(admin, identity, {
          fallback: false,
          suffix: testCase.suffix,
          endsInMinutes: testCase.endsInMinutes,
        });
        if (testCase.offerStatus !== "active") {
          await admin.query(
            `UPDATE song_reward_offers
                SET status=$2,
                    terminal_at=CASE WHEN $2='expired' THEN clock_timestamp() ELSE NULL END,
                    updated_at=updated_at + interval '1 microsecond'
              WHERE offer_id=$1`,
            [offerId, testCase.offerStatus],
          );
        }
        const observationId = `observation-${testCase.suffix}`;
        const drawingId = 201 + index;
        await admin.query(
          `INSERT INTO megapot_drawing_observations (
             observation_id, attestation_id, chain_id, drawing_id,
             ticket_price_atomic, drawing_time, ball_max, bonusball_max,
             drawing_locked, referral_fee_wei, referral_win_share_wei,
             block_number, block_hash, block_timestamp, confirmations,
             observed_at, expires_at, raw_state_hash
           ) VALUES (
             $1, 'megapot-base-sepolia-v2', 84532, $2, 10000,
             clock_timestamp() + make_interval(mins => $3), 25, 13, false,
             100000000000000000, 100000000000000000, $4, $5,
             clock_timestamp() - interval '1 minute', 3, clock_timestamp(),
             clock_timestamp() + interval '2 hours', $6
           )`,
          [
            observationId,
            drawingId,
            testCase.drawingInMinutes,
            200 + index,
            bytes32(String(index + 1)),
            hash(String(index + 1)),
          ],
        );
        await expect(
          admin.query(
            `INSERT INTO megapot_pool_drawings (
               pool_leg_id, drawing_id, observation_id, status, version,
               entry_cutoff_at, ticket_price_ceiling_atomic
             ) SELECT $1, $2, $3, 'entry_open', 1,
                      drawing_time - interval '300 seconds', 10000
                 FROM megapot_drawing_observations
                WHERE observation_id=$3`,
            [legId, drawingId, observationId],
          ),
        ).rejects.toThrow(/Megapot pool drawing does not match live leg and observation/);
      }
    });
    completedTestCount += 1;
  });

  test("closes a due no-entry drawing without reserving ticket budget", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "cutoff-empty");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "cutoff-empty",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-cutoff-empty', 'megapot-base-sepolia-v2', 84532, 100,
           10000, clock_timestamp() + interval '4 minutes', 25, 13, false,
           100000000000000000, 100000000000000000, 150, $1,
           clock_timestamp() - interval '2 minutes', 1,
           clock_timestamp() - interval '1 minute',
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("6"), hash("6")],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id, drawing_id, observation_id, status,
             entry_cutoff_at, ticket_price_ceiling_atomic
           ) SELECT $1, 100, observation_id, 'entry_open',
                    drawing_time - interval '300 seconds', 10000
               FROM megapot_drawing_observations
              WHERE observation_id='drawing-observation-cutoff-empty'`,
          [legId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const store = makeControlPlaneMegapotCutoffStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const coordinator = makeMegapotCutoffCoordinator({
        store,
        externalSponsorDailyTicketCeiling: 5,
        externalSponsorDailySpendCeilingAtomic: 50_000n,
        sharedSponsorDailyTicketCeiling: 10,
        sharedSponsorDailySpendCeilingAtomic: 100_000n,
      });
      await expect(Effect.runPromise(coordinator.freezeDue())).resolves.toMatchObject([
        {
          poolLegId: legId,
          drawingId: 100n,
          status: "closed_no_entries",
          reservedTicketCostAtomic: 0n,
          snapshotId: null,
        },
      ]);
      const leg = await admin.query<{ readonly reserved_atomic: string }>(
        "SELECT reserved_atomic::text FROM song_reward_offer_legs WHERE leg_id=$1",
        [legId],
      );
      expect(leg.rows).toEqual([{ reserved_atomic: "0" }]);
    });
    completedTestCount += 1;
  });

  test("freezes the verified external sponsor only when a due drawing has no shares", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "cutoff-fallback");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: true,
        suffix: "cutoff-fallback",
      });
      await admin.query(
        `INSERT INTO megapot_drawing_observations (
           observation_id, attestation_id, chain_id, drawing_id,
           ticket_price_atomic, drawing_time, ball_max, bonusball_max,
           drawing_locked, referral_fee_wei, referral_win_share_wei,
           block_number, block_hash, block_timestamp, confirmations,
           observed_at, expires_at, raw_state_hash
         ) VALUES (
           'drawing-observation-cutoff-fallback', 'megapot-base-sepolia-v2', 84532, 100,
           10000, clock_timestamp() + interval '4 minutes', 25, 13, false,
           100000000000000000, 100000000000000000, 151, $1,
           clock_timestamp() - interval '2 minutes', 1,
           clock_timestamp() - interval '1 minute',
           clock_timestamp() + interval '30 minutes', $2
         )`,
        [bytes32("7"), hash("7")],
      );
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id, drawing_id, observation_id, status,
             entry_cutoff_at, ticket_price_ceiling_atomic
           ) SELECT $1, 100, observation_id, 'entry_open',
                    drawing_time - interval '300 seconds', 10000
               FROM megapot_drawing_observations
              WHERE observation_id='drawing-observation-cutoff-fallback'`,
          [legId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(
        `INSERT INTO reward_eligibility_decisions (
           eligibility_decision_id, leg_id, account_id, persona_id, purpose,
           drawing_id, outcome, policy_version, evidence_hash, decided_at, expires_at
         ) VALUES (
           'eligibility-cutoff-fallback', $1, $2, $3, 'fallback_cutoff', 100,
           'eligible', 'pool-legal-test-v1', $4,
           clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'
         )`,
        [legId, identity.accountId, identity.personaId, hash("8")],
      );
      const store = makeControlPlaneMegapotCutoffStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const coordinator = makeMegapotCutoffCoordinator({
        store,
        externalSponsorDailyTicketCeiling: 5,
        externalSponsorDailySpendCeilingAtomic: 50_000n,
        sharedSponsorDailyTicketCeiling: 10,
        sharedSponsorDailySpendCeilingAtomic: 100_000n,
      });
      const outcomes = await Effect.runPromise(coordinator.freezeDue());
      expect(outcomes).toMatchObject([
        {
          poolLegId: legId,
          drawingId: 100n,
          status: "cutoff_frozen",
          frozenShareCount: 0,
          fallback: true,
          reservedTicketCostAtomic: 10_000n,
        },
      ]);
      const frozen = await admin.query<{
        readonly account_id: string;
        readonly persona_id: string;
        readonly leaf_count: number;
        readonly reserved_atomic: string;
        readonly reserved_ticket_count: number;
      }>(
        `SELECT leaf.account_id, leaf.persona_id, snapshot.leaf_count,
                leg.reserved_atomic::text, total.reserved_ticket_count
           FROM megapot_pool_drawings drawing
           JOIN megapot_pool_beneficiary_snapshots snapshot
             ON snapshot.snapshot_id=drawing.snapshot_id
           JOIN megapot_pool_snapshot_private_leaves leaf
             ON leaf.snapshot_id=snapshot.snapshot_id
           JOIN song_reward_offer_legs leg ON leg.leg_id=drawing.pool_leg_id
           JOIN sponsor_daily_ticket_totals total
             ON total.sponsor_account_id=leg.funder_account_id
            AND total.sponsor_kind='external_fallback'
          WHERE drawing.pool_leg_id=$1 AND drawing.drawing_id=100`,
        [legId],
      );
      expect(frozen.rows).toEqual([
        {
          account_id: identity.accountId,
          persona_id: identity.personaId,
          leaf_count: 1,
          reserved_atomic: "10000",
          reserved_ticket_count: 1,
        },
      ]);
      const commitmentStore = makeControlPlaneMegapotCommitmentStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      const commitment = makeMegapotCommitmentCoordinator({
        store: commitmentStore,
        signer: {
          sign: async () => ({
            signingKeyId: "test-commitment-key-v1",
            signature: "test-commitment-signature-v1",
          }),
        },
        publisher: {
          publish: async (input) => ({
            publicReference: `urn:pirate:test:${input.idempotencyKey}`,
            publishedAt: new Date(Date.now() + 1_000).toISOString(),
          }),
        },
      });
      const published = await Effect.runPromise(
        commitment.commit({ poolLegId: legId, drawingId: 100n }),
      );
      const commitmentReplay = await Effect.runPromise(
        commitment.commit({ poolLegId: legId, drawingId: 100n }),
      );
      expect(published).toEqual(commitmentReplay);
      expect(published).toMatchObject({ state: "published", drawingVersion: 3 });
      const committed = await admin.query<{
        readonly status: string;
        readonly commitment_effect_id: string;
      }>(
        `SELECT status, commitment_effect_id
           FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=100`,
        [legId],
      );
      expect(committed.rows).toEqual([
        { status: "committed", commitment_effect_id: published.commitmentEffectId },
      ]);
      const projections = makeControlPlaneRewardProjectionStore(
        makeDirectPostgresControlPlaneLayer(scopedConnection),
      );
      await expect(
        Effect.runPromise(
          projections.findPublicSongPool({
            communityId: identity.communityId,
            postId: identity.postId,
          }),
        ),
      ).resolves.toMatchObject({
        emptyPoolPolicy: "funder_fallback",
        drawing: { state: "committed", beneficiaryCount: 0 },
      });
      await expect(
        Effect.runPromise(projections.findStanding({ accountId: identity.accountId, legId })),
      ).resolves.toEqual({
        legId,
        drawingId: 100n,
        participantState: "entry_closed",
        shareHeld: false,
        shareAmountAtomic: null,
        sponsorFallbackState: "fallback_active",
        sponsorFallbackAmountAtomic: null,
        rewardCreditId: null,
        rewardCreditState: null,
        beneficiaryCount: 0,
      });
      await expect(Effect.runPromise(coordinator.freezeDue())).resolves.toEqual([]);
    });
    completedTestCount += 1;
  });

  test("projects only rewards work beyond the fixed liveness grace period", async () => {
    await withSchema(async (admin, scopedConnection) => {
      const identity = await seedSong(admin, "aged-pending");
      await seedMegapotAuthority(admin);
      const { legId } = await seedActivePoolLeg(admin, identity, {
        fallback: false,
        suffix: "aged-pending",
      });

      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `INSERT INTO reward_chain_effects (
             effect_id,effect_kind,state,version,chain_id,signer_address,target_address,
             reserved_amount_atomic,nonce,created_at,updated_at
           ) VALUES
             ('aged-chain-effect','reward_payout','nonce_reserved',2,84532,$1,$2,
                1000,1,clock_timestamp()-interval '20 minutes',
                clock_timestamp()-interval '11 minutes'),
             ('recent-chain-effect','reward_payout','nonce_reserved',2,84532,$1,$2,
                1000,2,clock_timestamp()-interval '1 minute',clock_timestamp())`,
          [address("4"), address("1")],
        );
        await admin.query(
          `INSERT INTO song_reward_leg_funding_effects (
             funding_effect_id,leg_id,funder_account_id,chain_id,token_address,
             sender_address,recipient_address,expected_amount_atomic,
             required_confirmations,state,transaction_hash,created_at,updated_at
           ) VALUES (
             'aged-funding-effect',$1,$2,84532,$3,$4,$5,1000,3,'confirming',$6,
             clock_timestamp()-interval '20 minutes',
             clock_timestamp()-interval '11 minutes'
           )`,
          [legId, identity.accountId, address("1"), address("6"), address("4"), bytes32("a")],
        );
        await admin.query(
          `INSERT INTO reward_ledger_credits (
             credit_id,account_id,payout_persona_id,chain_id,token_address,
             amount_atomic,source_kind,source_reference,state,created_at,updated_at
           ) VALUES (
             'aged-credit',$1,$2,84532,$3,1000,'asset_bonus','aged-credit-source',
             'credited',clock_timestamp()-interval '20 minutes',
             clock_timestamp()-interval '11 minutes'
           )`,
          [identity.accountId, identity.personaId, address("1")],
        );
        await admin.query(
          `INSERT INTO megapot_drawing_observations (
             observation_id,attestation_id,chain_id,drawing_id,ticket_price_atomic,
             drawing_time,ball_max,bonusball_max,drawing_locked,referral_fee_wei,
             referral_win_share_wei,block_number,block_hash,block_timestamp,
             confirmations,observed_at,expires_at,raw_state_hash
           ) VALUES
             ('observation-cutoff-aged','megapot-base-sepolia-v2',84532,201,10000,
                clock_timestamp()-interval '6 minutes',25,13,false,
                100000000000000000,100000000000000000,201,$1,
                clock_timestamp()-interval '1 hour',3,clock_timestamp(),
                clock_timestamp()+interval '1 hour',$2),
             ('observation-drawing-aged','megapot-base-sepolia-v2',84532,203,10000,
                clock_timestamp()-interval '11 minutes',25,13,false,
                100000000000000000,100000000000000000,203,$3,
                clock_timestamp()-interval '1 hour',3,clock_timestamp(),
                clock_timestamp()+interval '1 hour',$4),
             ('observation-drawing-future','megapot-base-sepolia-v2',84532,204,10000,
                clock_timestamp()+interval '30 minutes',25,13,false,
                100000000000000000,100000000000000000,204,$5,
                clock_timestamp()-interval '1 hour',3,clock_timestamp(),
                clock_timestamp()+interval '1 hour',$6)`,
          [bytes32("1"), hash("1"), bytes32("3"), hash("3"), bytes32("4"), hash("4")],
        );
        await admin.query(
          `INSERT INTO megapot_pool_drawings (
             pool_leg_id,drawing_id,observation_id,status,version,entry_cutoff_at,
             ticket_price_ceiling_atomic,reserved_ticket_cost_atomic,
             actual_ticket_cost_atomic,frozen_share_count,fallback_beneficiary,
             snapshot_id,commitment_effect_id,purchase_effect_id,cutoff_frozen_at,
             created_at,updated_at
           ) VALUES
             ($1,201,'observation-cutoff-aged','entry_open',1,
                clock_timestamp()-interval '11 minutes',10000,0,0,
                NULL,NULL,NULL,NULL,NULL,NULL,
                clock_timestamp()-interval '20 minutes',clock_timestamp()),
             ($1,203,'observation-drawing-aged','drawing_pending',5,
                clock_timestamp()-interval '16 minutes',10000,10000,10000,
                1,false,'snapshot-aged','commitment-aged','purchase-aged',
                clock_timestamp()-interval '19 minutes',
                clock_timestamp()-interval '20 minutes',clock_timestamp()),
             ($1,204,'observation-drawing-future','drawing_pending',5,
                clock_timestamp()+interval '25 minutes',10000,10000,10000,
                1,false,'snapshot-future','commitment-future','purchase-future',
                clock_timestamp()-interval '19 minutes',
                clock_timestamp()-interval '20 minutes',
                clock_timestamp()-interval '20 minutes')`,
          [legId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const refundIdentity = await seedSong(admin, "aged-refund");
      const terminal = await seedActivePoolLeg(admin, refundIdentity, {
        fallback: false,
        suffix: "aged-refund",
      });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE song_reward_offer_legs
              SET status='ended',participation_ends_at=clock_timestamp()-interval '11 minutes',
                  created_at=clock_timestamp()-interval '1 day',
                  activated_at=clock_timestamp()-interval '23 hours',
                  updated_at=clock_timestamp()-interval '11 minutes'
            WHERE leg_id=$1`,
          [terminal.legId],
        );
        await admin.query(
          `UPDATE song_reward_offers
              SET status='expired',terminal_at=clock_timestamp()-interval '11 minutes',
                  created_at=clock_timestamp()-interval '1 day',
                  activated_at=clock_timestamp()-interval '23 hours',
                  updated_at=clock_timestamp()-interval '11 minutes'
            WHERE offer_id=$1`,
          [terminal.offerId],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      const pending = await Effect.runPromise(
        makeControlPlaneMegapotWorkStore(
          makeDirectPostgresControlPlaneLayer(scopedConnection),
        ).loadAgedPending(600),
      );
      expect(pending.map(({ family, count }) => ({ family, count }))).toEqual([
        { family: "chain_effects", count: 1 },
        { family: "credits", count: 1 },
        { family: "drawings", count: 2 },
        { family: "funding_effects", count: 1 },
        { family: "refund_liabilities", count: 1 },
      ]);
      expect(pending.every((entry) => entry.oldestAgeSeconds >= 600)).toBe(true);
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (required && completedTestCount === testCount) {
    await Bun.write(sentinelPath, sentinelContents);
  }
});
