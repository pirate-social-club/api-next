/**
 * PostgreSQL rotation proof for rewards obligation authority, not chain E2E.
 * SQL seeds two deployment attestations with distinct custody addresses, legs,
 * funding effects and allocation credits under each, then retires the first
 * attestation. The production payout, refund, funding and solvency stores must
 * keep every pre-rotation obligation pinned to the originating attestation,
 * admit new work only under the active one, and refuse missing or mismatched
 * lineage before any chain effect exists.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import {
  AUTHOR_ID,
  AUTHOR_PERSONA_ID,
  addressFor,
  COMMUNITY_ID,
  POST_ID,
} from "./activity-participation-composed.pg-fixture.ts";
import {
  confirmWallet,
  prepareIdentity,
  seedFundedAssetBonus,
} from "./activity-participation-composed-identity.pg-fixture.ts";
import { seedActivitySong } from "./activity-participation-composed-song.pg-fixture.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardEffectAttestationStore } from "./reward-effect-attestation-repository.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import { makeControlPlaneRewardPayoutStore } from "./reward-payout-repository.ts";
import { makeControlPlaneRewardRefundStore } from "./reward-refund-repository.ts";
import {
  bytes32,
  seedActivePoolLeg,
  seedMegapotAuthority,
} from "./rewards-composed-pool.pg-fixture.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const address = (byte: string): string => `0x${byte.repeat(40)}`;

const RETIRED_ATTESTATION = "megapot-base-sepolia-v2";
const ACTIVE_ATTESTATION = "megapot-base-sepolia-v2-r2";
const RETIRED_CUSTODY = address("4");
const ACTIVE_CUSTODY = address("7");
const SETTLEMENT_TOKEN = address("1");

const legIdentity = {
  accountId: AUTHOR_ID,
  personaId: AUTHOR_PERSONA_ID,
  communityId: COMMUNITY_ID,
  postId: POST_ID,
};

async function confirmFunding(
  admin: Client,
  fundingEffectId: string,
  txByte: string,
): Promise<void> {
  await admin.query(
    `UPDATE song_reward_leg_funding_effects
        SET state='confirming', transaction_hash=$2, updated_at=clock_timestamp()
      WHERE funding_effect_id=$1`,
    [fundingEffectId, `0x${txByte.repeat(32)}`],
  );
  await admin.query(
    `UPDATE song_reward_leg_funding_effects
        SET state='confirmed', confirmed_amount_atomic=expected_amount_atomic,
            log_index=1, block_number=500, block_hash=$2,
            observation_hash=$3, confirmed_at=clock_timestamp(),
            updated_at=clock_timestamp()
      WHERE funding_effect_id=$1`,
    [fundingEffectId, bytes32("8"), "2f".repeat(32)],
  );
}

async function seedRotationAttestation(admin: Client): Promise<void> {
  await admin.query(
    `INSERT INTO megapot_deployment_attestations (
       attestation_id, environment, chain_id, jackpot_address, usdc_address,
       ticket_nft_address, custody_address, referrer_address, source_tag,
       jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
       attestation_block_number, attestation_block_hash, abi_version, status, verified_at
     ) VALUES ($1,'staging',84532,$2,$3,$4,$5,$6,$7,$8,$9,$10,200,$11,
       'megapot_v2','active',clock_timestamp())`,
    [
      ACTIVE_ATTESTATION,
      address("5"),
      SETTLEMENT_TOKEN,
      address("6"),
      ACTIVE_CUSTODY,
      address("8"),
      `0x${"9".repeat(64)}`,
      `0x${"a".repeat(64)}`,
      `0x${"b".repeat(64)}`,
      `0x${"c".repeat(64)}`,
      `0x${"d".repeat(64)}`,
    ],
  );
}

async function retireAttestation(admin: Client): Promise<void> {
  await admin.query(
    `UPDATE megapot_deployment_attestations
        SET status='retired', retired_at=clock_timestamp()
      WHERE attestation_id=$1`,
    [RETIRED_ATTESTATION],
  );
}

async function terminalizeLeg(admin: Client, legId: string): Promise<void> {
  await admin.query(
    `UPDATE song_reward_offer_legs
        SET status='ended', participation_ends_at=clock_timestamp() - interval '1 hour',
            updated_at=clock_timestamp()
      WHERE leg_id=$1`,
    [legId],
  );
  await admin.query(
    `UPDATE song_reward_offers
        SET status='ended', terminal_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE offer_id=(SELECT offer_id FROM song_reward_offer_legs WHERE leg_id=$1)`,
    [legId],
  );
}

async function seedAllocatedCredit(
  admin: Client,
  input: Readonly<{
    creditId: string;
    allocationBatchId: string;
    legId: string;
    drawingId: string;
    accountId: string;
    personaId: string;
    amountAtomic: string;
    attestationId: string;
    tokenAddress?: string;
  }>,
): Promise<void> {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query(
      `INSERT INTO megapot_pool_drawings (
         pool_leg_id, drawing_id, observation_id, status, version,
         entry_cutoff_at, ticket_price_ceiling_atomic, reserved_ticket_cost_atomic,
         actual_ticket_cost_atomic, gross_winnings_atomic, net_winnings_atomic,
         frozen_share_count, fallback_beneficiary, snapshot_id,
         commitment_effect_id, purchase_effect_id, claim_effect_id,
         allocation_batch_id, cutoff_frozen_at, created_at, updated_at, terminal_at
       ) VALUES ($2,$3,$4,'credited',9,
         clock_timestamp() - interval '3 hours',10000,10000,10000,$5,$5,1,false,$6,
         $7,$8,$9,$1,
         clock_timestamp() - interval '2 hours',
         clock_timestamp() - interval '3 hours',
         clock_timestamp() - interval '3 hours',
         clock_timestamp() - interval '1 hour')`,
      [
        input.allocationBatchId,
        input.legId,
        input.drawingId,
        `observation-${input.allocationBatchId}`,
        input.amountAtomic,
        `snapshot-${input.allocationBatchId}`,
        `commitment-${input.allocationBatchId}`,
        `purchase-${input.allocationBatchId}`,
        `claim-${input.allocationBatchId}`,
      ],
    );
    await admin.query(
      `INSERT INTO megapot_allocation_batches (
         allocation_batch_id, pool_leg_id, drawing_id, snapshot_id, claim_effect_id,
         algorithm_version, net_winnings_atomic, allocation_count, allocation_hash,
         state, created_at, credited_at
       ) VALUES ($1,$2,$3,$4,$5,'equal_v1',$6,1,$7,'credited',
         clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour')`,
      [
        input.allocationBatchId,
        input.legId,
        input.drawingId,
        `snapshot-${input.allocationBatchId}`,
        `claim-${input.allocationBatchId}`,
        input.amountAtomic,
        "2b".repeat(32),
      ],
    );
    await admin.query(
      `INSERT INTO megapot_allocations (
         allocation_batch_id, ordinal, account_id, persona_id, amount_atomic,
         allocation_kind, credit_id
       ) VALUES ($1,0,$2,$3,$4,'participant',$5)`,
      [
        input.allocationBatchId,
        input.accountId,
        input.personaId,
        input.amountAtomic,
        input.creditId,
      ],
    );
    await admin.query(
      `INSERT INTO reward_ledger_credits (
         credit_id, account_id, payout_persona_id, chain_id, token_address,
         amount_atomic, source_kind, source_reference, state
       ) VALUES ($1,$2,$3,84532,$4,$5,'megapot_allocation',$6,'credited')`,
      [
        input.creditId,
        input.accountId,
        input.personaId,
        input.tokenAddress ?? SETTLEMENT_TOKEN,
        input.amountAtomic,
        `allocation:${input.allocationBatchId}`,
      ],
    );
    await admin.query(
      `INSERT INTO megapot_participant_claims (
         credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
         evidence_receipt_id, accepted_at
       ) VALUES ($1,$2,$3,$4,'accepted',$5,$6,clock_timestamp() - interval '30 minutes')`,
      [
        input.creditId,
        input.accountId,
        input.legId,
        input.drawingId,
        `subject-${input.creditId}`,
        `receipt-${input.creditId}`,
      ],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

async function seedIsolatedCredit(
  admin: Client,
  input: Readonly<{
    creditId: string;
    accountId: string;
    personaId: string;
    tokenAddress: string;
    amountAtomic: string;
    sourceKind: "megapot_allocation" | "asset_bonus";
    sourceReference: string;
  }>,
): Promise<void> {
  await admin.query(
    `INSERT INTO reward_ledger_credits (
       credit_id, account_id, payout_persona_id, chain_id, token_address,
       amount_atomic, source_kind, source_reference, state
     ) VALUES ($1,$2,$3,84532,$4,$5,$6,$7,'credited')`,
    [
      input.creditId,
      input.accountId,
      input.personaId,
      input.tokenAddress,
      input.amountAtomic,
      input.sourceKind,
      input.sourceReference,
    ],
  );
}

suite("Reward obligation attestation pinning", () => {
  test("keeps pre-rotation obligations on the originating attestation and refuses missing lineage", async () => {
    if (!connectionString) throw new Error("test URL was not configured");
    const schema = `reward_attestation_pin_${Date.now()}`;
    const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      await admin.query("SET session_replication_role = replica");
      try {
        await seedActivitySong(admin);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await seedMegapotAuthority(admin);
      const layer = makeDirectPostgresControlPlaneLayer(scoped);
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

      for (const account of ["pin-winner", "pin-successor", "pin-sponsor"]) {
        await admin.query("INSERT INTO users (user_id) VALUES ($1)", [account]);
      }
      const winner = await prepareIdentity(layer)("pin-winner", "pin-winner");
      await confirmWallet(layer)("pin-winner", winner.persona_id);
      const successor = await prepareIdentity(layer)("pin-successor", "pin-successor");
      await confirmWallet(layer)("pin-successor", successor.persona_id);
      const sponsor = await prepareIdentity(layer)("pin-sponsor", "pin-sponsor");
      await confirmWallet(layer)("pin-sponsor", sponsor.persona_id);
      const sponsorAddress = await addressFor(`pin-sponsor:${sponsor.persona_id}`);

      const seedPost = async (postId: string): Promise<string> => {
        await admin.query(
          `INSERT INTO posts (
             community_id, post_id, author_user_id, author_persona_id, post_type,
             status, visibility, title, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,'song','published','public','Attestation pin song',
             clock_timestamp(),clock_timestamp())`,
          [COMMUNITY_ID, postId, AUTHOR_ID, AUTHOR_PERSONA_ID],
        );
        await admin.query("UPDATE posts SET content_rating='general' WHERE post_id=$1", [postId]);
        return postId;
      };
      const retired = await seedActivePoolLeg(admin, legIdentity, {
        fallback: false,
        suffix: "pin-retired",
      });
      const seedPoolLeg = async (suffix: string, attestationId: string) => {
        const postId = await seedPost(`pin-post-${suffix}`);
        await admin.query("SET session_replication_role = replica");
        try {
          const seeded = await seedActivePoolLeg(
            admin,
            { ...legIdentity, postId },
            {
              fallback: false,
              suffix,
            },
          );
          await admin.query(`UPDATE song_reward_offer_legs SET attestation_id=$1 WHERE leg_id=$2`, [
            attestationId,
            seeded.legId,
          ]);
          return seeded;
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      };
      const retiredOpen = await seedPoolLeg("retired-open", RETIRED_ATTESTATION);
      const active = await seedPoolLeg("active", ACTIVE_ATTESTATION);
      const activeOpen = await seedPoolLeg("active-open", ACTIVE_ATTESTATION);

      const funding = makeControlPlaneRewardFundingStore(layer);
      const retiredIntent = await run(
        funding.plan({
          fundingEffectId: "pin-funding-retired",
          legId: retired.legId,
          funderAccountId: "pin-sponsor",
          senderAddress: sponsorAddress,
          expectedAmountAtomic: 100000n,
          requiredConfirmations: 3,
        }),
      );
      expect(retiredIntent.recipientAddress).toBe(RETIRED_CUSTODY);
      await terminalizeLeg(admin, retired.legId);
      const bonus = await seedFundedAssetBonus(admin);
      const bonusIntent = await run(
        funding.plan({
          fundingEffectId: "pin-funding-bonus",
          legId: bonus.legId,
          funderAccountId: "pin-sponsor",
          senderAddress: sponsorAddress,
          expectedAmountAtomic: 200n,
          requiredConfirmations: 3,
        }),
      );
      expect(bonusIntent.recipientAddress).toBe(RETIRED_CUSTODY);

      await seedAllocatedCredit(admin, {
        creditId: "pin-credit-retired",
        allocationBatchId: "pin-batch-retired",
        legId: retired.legId,
        drawingId: "900",
        accountId: "pin-winner",
        personaId: winner.persona_id,
        amountAtomic: "901",
        attestationId: RETIRED_ATTESTATION,
      });
      await admin.query("SET session_replication_role = replica");
      try {
        await seedIsolatedCredit(admin, {
          creditId: "pin-credit-orphan",
          accountId: "pin-winner",
          personaId: winner.persona_id,
          tokenAddress: SETTLEMENT_TOKEN,
          amountAtomic: "500",
          sourceKind: "megapot_allocation",
          sourceReference: "allocation:missing",
        });
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await admin.query(
        `INSERT INTO reward_asset_whitelist (
           chain_id, token_address, decimals, symbol, asset_kind, environment,
           status, policy_version, activated_at, plain_erc20_verified_at
         ) VALUES (84532,$1,6,'OTHER','settlement_usdc','staging','active',
           'other-v1',statement_timestamp(),statement_timestamp())`,
        [address("e")],
      );
      await seedAllocatedCredit(admin, {
        creditId: "pin-credit-mismatched",
        allocationBatchId: "pin-batch-mismatched",
        legId: retired.legId,
        drawingId: "901",
        accountId: "pin-winner",
        personaId: winner.persona_id,
        amountAtomic: "501",
        attestationId: RETIRED_ATTESTATION,
        tokenAddress: address("e"),
      });
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          `UPDATE song_reward_offer_legs
              SET fulfilled_atomic=100, updated_at=clock_timestamp()
            WHERE leg_id=$1`,
          [bonus.legId],
        );
        await admin.query(
          `INSERT INTO song_reward_bundle_claim_legs (
             account_id, offer_id, leg_id, amount_atomic, credit_id, state
           ) VALUES ('pin-winner',$1,$2,100,'pin-credit-bonus','credited')`,
          [bonus.offerId, bonus.legId],
        );
        await seedIsolatedCredit(admin, {
          creditId: "pin-credit-bonus",
          accountId: "pin-winner",
          personaId: winner.persona_id,
          tokenAddress: bonus.token,
          amountAtomic: "100",
          sourceKind: "asset_bonus",
          sourceReference: "bundle:pin-credit-bonus",
        });
      } finally {
        await admin.query("SET session_replication_role = origin");
      }

      // Routing authority must be readable before any balance observation exists.
      const payoutRouting = makeControlPlaneRewardPayoutStore(layer);
      expect(await run(payoutRouting.loadAuthority("pin-credit-retired"))).toEqual({
        attestationId: RETIRED_ATTESTATION,
        tokenAddress: SETTLEMENT_TOKEN,
      });
      await expect(run(payoutRouting.loadAuthority("pin-credit-orphan"))).rejects.toMatchObject({
        reason: "attestation-lineage-missing",
      });
      await expect(run(payoutRouting.loadAuthority("pin-credit-mismatched"))).rejects.toMatchObject(
        { reason: "attestation-lineage-missing" },
      );
      const solvency = makeControlPlaneCustodySolvencyStore(layer);
      const retiredSolvency = await run(
        solvency.record({
          candidate: await run(solvency.loadCandidate(RETIRED_ATTESTATION)),
          observationId: "pin-solvency-retired",
          balanceAtomic: 10000000n,
          blockNumber: 600n,
          blockHash: bytes32("3"),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(retiredSolvency.solvent).toBe(true);

      await retireAttestation(admin);
      await seedRotationAttestation(admin);
      await admin.query("SET session_replication_role = replica");
      try {
        await terminalizeLeg(admin, active.legId);
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      await terminalizeLeg(admin, bonus.legId);
      await confirmFunding(admin, "pin-funding-retired", "22");
      await confirmFunding(admin, "pin-funding-bonus", "23");
      expect(await run(payoutRouting.loadAuthority("pin-credit-bonus"))).toEqual({
        attestationId: RETIRED_ATTESTATION,
        tokenAddress: bonus.token,
      });

      await admin.query(
        `INSERT INTO song_reward_leg_funding_effects (
           funding_effect_id, leg_id, funder_account_id, chain_id, token_address,
           sender_address, recipient_address, expected_amount_atomic,
           required_confirmations, state, transaction_hash, log_index,
           block_number, block_hash, confirmed_amount_atomic,
           observation_hash, confirmed_at
         ) VALUES ('pin-funding-active',$1,'pin-sponsor',84532,$2,$3,$4,100000,3,
           'confirmed',$5,2,501,$6,100000,$7,clock_timestamp())`,
        [
          active.legId,
          SETTLEMENT_TOKEN,
          address("9"),
          ACTIVE_CUSTODY,
          `0x${"2a".repeat(32)}`,
          bytes32("4"),
          "30".repeat(32),
        ],
      );
      await seedAllocatedCredit(admin, {
        creditId: "pin-credit-active",
        allocationBatchId: "pin-batch-active",
        legId: active.legId,
        drawingId: "902",
        accountId: "pin-successor",
        personaId: successor.persona_id,
        amountAtomic: "701",
        attestationId: ACTIVE_ATTESTATION,
      });

      const refundRouting = makeControlPlaneRewardRefundStore(layer);
      expect(await run(refundRouting.loadAuthority("pin-funding-active"))).toEqual({
        attestationId: ACTIVE_ATTESTATION,
        tokenAddress: SETTLEMENT_TOKEN,
      });
      expect(await run(refundRouting.loadAuthority("pin-funding-retired"))).toEqual({
        attestationId: RETIRED_ATTESTATION,
        tokenAddress: SETTLEMENT_TOKEN,
      });
      expect(await run(refundRouting.loadAuthority("pin-funding-bonus"))).toEqual({
        attestationId: RETIRED_ATTESTATION,
        tokenAddress: bonus.token,
      });
      expect(await run(payoutRouting.loadAuthority("pin-credit-active"))).toEqual({
        attestationId: ACTIVE_ATTESTATION,
        tokenAddress: SETTLEMENT_TOKEN,
      });

      const activeSolvency = await run(
        solvency.record({
          candidate: await run(solvency.loadCandidate(ACTIVE_ATTESTATION)),
          observationId: "pin-solvency-active",
          balanceAtomic: 10000000n,
          blockNumber: 700n,
          blockHash: bytes32("5"),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(activeSolvency.solvent).toBe(true);
      const retiredRefresh = await run(
        solvency.record({
          candidate: await run(solvency.loadCandidate(RETIRED_ATTESTATION)),
          observationId: "pin-solvency-retired-refresh",
          balanceAtomic: 9000000n,
          blockNumber: 800n,
          blockHash: bytes32("5"),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(retiredRefresh.solvent).toBe(true);
      const retiredBonusSolvency = await run(
        solvency.record({
          candidate: await run(solvency.loadCandidate(RETIRED_ATTESTATION, bonus.token)),
          observationId: "pin-solvency-retired-bonus",
          balanceAtomic: 100000n,
          blockNumber: 801n,
          blockHash: bytes32("6"),
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
      expect(retiredBonusSolvency.solvent).toBe(true);
      const retiredTokens = await run(solvency.listTokenAddresses(RETIRED_ATTESTATION));
      expect(retiredTokens).toContain(SETTLEMENT_TOKEN);
      expect(retiredTokens).toContain(bonus.token);

      const payout = makeControlPlaneRewardPayoutStore(layer);
      const retiredCandidate = await run(payout.loadCandidate("pin-credit-retired"));
      expect(retiredCandidate.attestationId).toBe(RETIRED_ATTESTATION);
      expect(retiredCandidate.custodyAddress).toBe(RETIRED_CUSTODY);
      expect(retiredCandidate.solvencyObservationId).toBe("pin-solvency-retired-refresh");
      const reserved = await run(
        payout.reserveNonce({
          candidate: retiredCandidate,
          effectId: "pin-payout-retired",
          observedPendingNonce: 9n,
          observedBlockNumber: 900n,
          observedBlockHash: bytes32("7"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(reserved.nonce).toBe(9n);
      const effectAttestations = makeControlPlaneRewardEffectAttestationStore(layer);
      expect(await run(effectAttestations.load("pin-payout-retired", "reward_payout"))).toBe(
        RETIRED_ATTESTATION,
      );
      await expect(
        run(effectAttestations.load("pin-payout-retired", "reward_refund")),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      await expect(
        run(effectAttestations.load("missing-effect", "reward_payout")),
      ).rejects.toMatchObject({ reason: "invalid-row" });
      const activeCandidate = await run(payout.loadCandidate("pin-credit-active"));
      expect(activeCandidate.attestationId).toBe(ACTIVE_ATTESTATION);
      expect(activeCandidate.custodyAddress).toBe(ACTIVE_CUSTODY);
      await expect(run(payout.loadCandidate("pin-credit-orphan"))).rejects.toMatchObject({
        reason: "attestation-lineage-missing",
      });
      await expect(run(payout.loadCandidate("pin-credit-mismatched"))).rejects.toMatchObject({
        reason: "attestation-lineage-missing",
      });
      const retiredBonusCandidate = await run(payout.loadCandidate("pin-credit-bonus"));
      expect(retiredBonusCandidate.attestationId).toBe(RETIRED_ATTESTATION);
      expect(retiredBonusCandidate.custodyAddress).toBe(RETIRED_CUSTODY);
      expect(retiredBonusCandidate.tokenAddress).toBe(bonus.token);
      expect(retiredBonusCandidate.solvencyObservationId).toBe("pin-solvency-retired-bonus");
      const retiredBonusReserved = await run(
        payout.reserveNonce({
          candidate: retiredBonusCandidate,
          effectId: "pin-payout-retired-bonus",
          observedPendingNonce: 11n,
          observedBlockNumber: 901n,
          observedBlockHash: bytes32("2"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(retiredBonusReserved.nonce).toBe(11n);
      const chainEffects = await admin.query(
        `SELECT count(*)::int AS count FROM reward_chain_effects
          WHERE signer_address IN ($1,$2)`,
        [RETIRED_CUSTODY, ACTIVE_CUSTODY],
      );
      expect(chainEffects.rows[0]?.count).toBe(2);

      const refund = makeControlPlaneRewardRefundStore(layer);
      const retiredRefund = await run(refund.loadCandidate("pin-funding-retired"));
      expect(retiredRefund.attestationId).toBe(RETIRED_ATTESTATION);
      expect(retiredRefund.custodyAddress).toBe(RETIRED_CUSTODY);
      expect(retiredRefund.amountAtomic).toBe(100000n);
      const activeRefund = await run(refund.loadCandidate("pin-funding-active"));
      expect(activeRefund.attestationId).toBe(ACTIVE_ATTESTATION);
      expect(activeRefund.custodyAddress).toBe(ACTIVE_CUSTODY);
      expect(activeRefund.amountAtomic).toBe(100000n);
      const refundReserved = await run(
        refund.reserveNonce({
          candidate: activeRefund,
          effectId: "pin-refund-active",
          observedPendingNonce: 0n,
          observedBlockNumber: 902n,
          observedBlockHash: bytes32("8"),
          observedAt: new Date().toISOString(),
        }),
      );
      expect(refundReserved.nonce).toBe(0n);
      expect(await run(effectAttestations.load("pin-refund-active", "reward_refund"))).toBe(
        ACTIVE_ATTESTATION,
      );
      const retiredBonusRefund = await run(refund.loadCandidate("pin-funding-bonus"));
      expect(retiredBonusRefund.attestationId).toBe(RETIRED_ATTESTATION);
      expect(retiredBonusRefund.custodyAddress).toBe(RETIRED_CUSTODY);
      expect(retiredBonusRefund.tokenAddress).toBe(bonus.token);
      expect(retiredBonusRefund.amountAtomic).toBe(100n);

      const retiredIntentAfterRotation = await run(funding.find("pin-funding-retired"));
      expect(retiredIntentAfterRotation?.attestationId).toBe(RETIRED_ATTESTATION);
      expect(retiredIntentAfterRotation?.custodyAddress).toBe(RETIRED_CUSTODY);
      const bonusIntentAfterRotation = await run(funding.find("pin-funding-bonus"));
      expect(bonusIntentAfterRotation?.attestationId).toBe(RETIRED_ATTESTATION);
      expect(bonusIntentAfterRotation?.custodyAddress).toBe(RETIRED_CUSTODY);
      await expect(
        run(
          funding.plan({
            fundingEffectId: "pin-funding-retired-open",
            legId: retiredOpen.legId,
            funderAccountId: "pin-sponsor",
            senderAddress: sponsorAddress,
            expectedAmountAtomic: 1000n,
            requiredConfirmations: 3,
          }),
        ),
      ).rejects.toMatchObject({ reason: "funding-not-allowed" });
      const activeOpenIntent = await run(
        funding.plan({
          fundingEffectId: "pin-funding-active-open",
          legId: activeOpen.legId,
          funderAccountId: "pin-sponsor",
          senderAddress: sponsorAddress,
          expectedAmountAtomic: 1000n,
          requiredConfirmations: 3,
        }),
      );
      expect(activeOpenIntent.recipientAddress).toBe(ACTIVE_CUSTODY);

      const observations = makeControlPlaneMegapotDrawingObservationStore(layer);
      const retiredDeployment = await run(observations.loadCandidate(RETIRED_ATTESTATION));
      expect(retiredDeployment.custodyAddress).toBe(RETIRED_CUSTODY);
      const activeDeployment = await run(observations.loadCandidate(ACTIVE_ATTESTATION));
      expect(activeDeployment.custodyAddress).toBe(ACTIVE_CUSTODY);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`RESET search_path`);
      await admin.end();
    }
  });
});
