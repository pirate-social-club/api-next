/**
 * PostgreSQL proof of the owner procedure for Safe purchases executed after their
 * ticket-first drawing closed, with a fake chain. Leg, observation and credit lineage
 * rows are seeded with triggers disabled; every purchase, settlement, solvency, payout
 * and recovery step under test runs with all triggers enforced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import type { Hex } from "viem";
import {
  inspectLateSafePurchases,
  recoverLateSafePurchase,
} from "../../../scripts/safe-pool-recover-late-purchase.ts";
import { makeCustodySolvencyCoordinator } from "./custody-solvency-coordinator.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  ATTESTATION,
  address,
  fakeSafeChain,
  hash,
  JACKPOT,
  NFT,
  PRICE,
  REFERRER,
  SAFE,
  SOURCE,
  USDC,
} from "./reward-safe-chain.pg-fixture.ts";
import { makeRewardSafePayoutCoordinator } from "./reward-safe-payout-coordinator.ts";
import { makeRewardSafePurchaseCoordinator } from "./reward-safe-purchase-coordinator.ts";
import { makeRewardSafeExecutionScanner } from "./reward-safe-settlement.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
/** An accepted participant credit from an earlier drawing, unrelated to the late ticket. */
const CREDIT = 2_500_000n;

/**
 * One schema and fake chain per suite. The Safe starts with `usdcBalance`, and an
 * accepted credit of CREDIT from an earlier drawing is payable from it.
 */
function lateSafePurchaseFixture(prefix: string, usdcBalance: bigint) {
  const schema = `${prefix}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  const scoped = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}`,
  )}`;
  const chain = fakeSafeChain({ usdcBalance, purchaseSpends: true });
  const layer = () => makeDirectPostgresControlPlaneLayer(scoped);
  const options = (minimumEntrySeconds = 600) => ({
    layer: layer(),
    rpc: chain.rpc,
    requiredConfirmations: 3,
    productionEnabled: true,
    maximumScanBlocks: 500,
    maximumScanLogs: 50,
    minimumEntrySeconds,
  });
  const recovery = {
    layer: layer(),
    rpc: chain.rpc,
    attestationId: ATTESTATION,
    requiredConfirmations: 3,
    productionEnabled: true,
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const scan = () =>
    run(makeRewardSafeExecutionScanner(options())({ chainId: 8453, safeAddress: SAFE }));
  const observeSolvency = () =>
    run(
      makeCustodySolvencyCoordinator({
        store: makeControlPlaneCustodySolvencyStore(layer()),
        rpc: chain.rpc,
        requiredConfirmations: 3,
        safePilot: { productionEnabled: true },
      }).observe(ATTESTATION),
    );
  const one = async <T>(text: string, values: unknown[] = []) =>
    (await admin.query(text, values)).rows as T[];
  const leg = async (legId: string) =>
    (
      await one<{ reserved: string; spent: string }>(
        `SELECT reserved_atomic::text AS reserved, spent_atomic::text AS spent
           FROM song_reward_offer_legs WHERE leg_id=$1`,
        [legId],
      )
    )[0];
  const drawing = async (legId: string) =>
    (
      await one(
        `SELECT status, terminal_reason, version, actual_ticket_cost_atomic::text AS actual,
                snapshot_id, frozen_share_count,
                (SELECT count(*)::int FROM megapot_pool_drawing_transitions event
                  WHERE event.pool_leg_id=drawing.pool_leg_id
                    AND event.drawing_id=drawing.drawing_id) AS events,
                (SELECT count(*)::int FROM megapot_pool_shares share
                  WHERE share.pool_leg_id=drawing.pool_leg_id
                    AND share.drawing_id=drawing.drawing_id) AS shares
           FROM megapot_pool_drawings drawing WHERE pool_leg_id=$1 AND drawing_id=212`,
        [legId],
      )
    )[0];
  const brakeRevision = async () =>
    BigInt(
      (await one<{ revision: string }>("SELECT revision::text FROM reward_operations_control"))[0]
        ?.revision ?? "-1",
    );
  const setPaused = async (paused: boolean) => {
    await admin.query("SELECT set_reward_operations_paused_v1($1::bigint,$2,'late_purchase')", [
      (await brakeRevision()).toString(),
      paused,
    ]);
  };
  const recover = async (effectId: string, revision: bigint) =>
    recoverLateSafePurchase({ ...recovery, effectId, brakeRevision: revision });
  const callOf = (file: { readonly transactions: readonly { to: string; data: Hex }[] }) => {
    const call = file.transactions[0];
    if (call === undefined) throw new Error("missing call");
    return call;
  };

  /** An active ticket-first leg funded for exactly one ticket, so it owes no refund. */
  const seedLeg = async (legId: string) => {
    await admin.query("SET session_replication_role = replica");
    await admin.query(
      `INSERT INTO song_reward_offers (offer_id, community_id, post_id, audio_revision,
         created_by_account_id, status, starts_at, ends_at, owner_policy_snapshot, terms_hash,
         reward_policy_version_id, activated_at)
       VALUES ($2,'community-late',$3,1,'account-owner','active',
         clock_timestamp()-interval '1 day', clock_timestamp()+interval '30 days','{}'::jsonb,
         $1,'policy-late',clock_timestamp())`,
      ["d".repeat(64), `offer-${legId}`, `post-${legId}`],
    );
    await admin.query(
      `INSERT INTO song_reward_offer_legs (leg_id, offer_id, kind, status, funder_account_id,
         refund_policy, leg_terms_hash, participation_starts_at, chain_id, token_address,
         token_decimals, tickets_per_drawing, max_ticket_price_atomic, entry_cutoff_seconds,
         beneficiary_algorithm_version, ticket_selection_version, attestation_id,
         participation_starts_drawing_id, eligible_activities, min_score_bps,
         empty_pool_policy, funding_source, funded_atomic, purchase_order, legal_activation_gate,
         activated_at)
       VALUES ($1,$6,'megapot_pool','active','account-owner',
         'refund_to_funders_pro_rata',$2,clock_timestamp()-interval '1 day',8453,$3,6,1,
         $4,300,'equal_v1','keccak_packed_v1',$5,1,ARRAY['study','karaoke'],7000,
         'no_purchase','leg_budget',$4,'ticket_first_v1','production_approved',
         clock_timestamp())`,
      [legId, hash("3"), USDC, PRICE.toString(), ATTESTATION, `offer-${legId}`],
    );
    await admin.query("SET session_replication_role = origin");
  };

  /**
   * The owner executes a leg's purchase only after its drawing closed unexecuted and
   * the scan binds it. A successful ticket lands in `landedDrawingId`.
   */
  const lateExecution = async (
    legId: string,
    outcome: "success" | "failure",
    landedDrawingId = 212n,
  ) => {
    await seedLeg(legId);
    const purchases = makeRewardSafePurchaseCoordinator(options());
    const prepared = await run(purchases.prepare(legId));
    if (prepared.kind !== "prepared") throw new Error(`not prepared: ${prepared.kind}`);
    // A minimum entry window longer than the time left makes the deadline already past.
    expect(
      await run(makeRewardSafePurchaseCoordinator(options(4 * 3_600)).closeUnexecuted(10)),
    ).toBe(1);
    const ticketId = chain.execute(
      callOf(prepared.transactionBuilderFile),
      outcome,
      landedDrawingId,
    );
    const block = chain.head();
    chain.mine(2n);
    await scan();
    const settle = () => run(purchases.settle(prepared.effectId));
    return { effectId: prepared.effectId, ticketId, block, settle };
  };
  /** A late successful purchase, which settlement holds. */
  const latePurchase = async (legId: string, landedDrawingId = 212n) => {
    const late = await lateExecution(legId, "success", landedDrawingId);
    return { ...late, settled: await late.settle() };
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(
      await Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text(),
    );
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query("SELECT set_reward_operations_paused_v1(0,FALSE,'late_purchase_test')");
    await admin.query(
      `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
         observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
         nonce_authority)
       VALUES (8453,$1,0,0,1,$2,clock_timestamp(),'safe_owner_v1')`,
      [SAFE, hash("1")],
    );
    await admin.query("SET session_replication_role = replica");
    await admin.query(
      `INSERT INTO reward_asset_whitelist (chain_id, token_address, decimals, symbol, asset_kind,
         environment, status, policy_version, activated_at, plain_erc20_verified_at)
       VALUES (8453,$1,6,'USDC','settlement_usdc','production','active','base-usdc-v1',
         now(),now())`,
      [USDC],
    );
    await admin.query(
      `INSERT INTO megapot_deployment_attestations (attestation_id, environment, chain_id,
         jackpot_address, usdc_address, ticket_nft_address, custody_address, referrer_address,
         source_tag, jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
         attestation_block_number, attestation_block_hash, abi_version, status, verified_at)
       VALUES ($1,'production',8453,$2,$3,$4,$5,$6,$7,$8,$9,$10,900,$11,'megapot_v2','active',
         clock_timestamp())`,
      [
        ATTESTATION,
        JACKPOT,
        USDC,
        NFT,
        SAFE,
        REFERRER,
        SOURCE,
        hash("7"),
        hash("e"),
        hash("f"),
        hash("a"),
      ],
    );
    await admin.query(
      `INSERT INTO megapot_drawing_observations (observation_id, attestation_id, chain_id,
         drawing_id, ticket_price_atomic, drawing_time, ball_max, bonusball_max, drawing_locked,
         referral_fee_wei, referral_win_share_wei, block_number, block_hash, block_timestamp,
         confirmations, observed_at, expires_at, raw_state_hash)
       VALUES ('observation-212',$1,8453,212,$2,clock_timestamp()+interval '2 hours',30,10,false,
         0,0,990,$3,clock_timestamp(),3,clock_timestamp(),clock_timestamp()+interval '1 hour',$4)`,
      [ATTESTATION, PRICE.toString(), hash("b"), "c".repeat(64)],
    );
    // An earlier drawing's accepted credit, payable from the Safe: lineage only.
    await admin.query(
      `INSERT INTO song_reward_offer_legs (leg_id, offer_id, kind, status, funder_account_id,
         refund_policy, leg_terms_hash, participation_starts_at, chain_id, token_address,
         token_decimals, tickets_per_drawing, max_ticket_price_atomic, entry_cutoff_seconds,
         beneficiary_algorithm_version, ticket_selection_version, attestation_id,
         participation_starts_drawing_id, eligible_activities, min_score_bps,
         empty_pool_policy, funding_source, funded_atomic, purchase_order, legal_activation_gate)
       VALUES ('leg-earlier','offer-earlier','megapot_pool','active','account-owner',
         'refund_to_funders_pro_rata',$1,clock_timestamp()-interval '1 day',8453,$2,6,1,$3,300,
         'equal_v1','keccak_packed_v1',$4,1,ARRAY['study','karaoke'],7000,'no_purchase',
         'leg_budget',0,'ticket_first_v1','production_approved')`,
      [hash("3"), USDC, PRICE.toString(), ATTESTATION],
    );
    await admin.query(
      `INSERT INTO megapot_allocation_batches (allocation_batch_id, pool_leg_id, drawing_id,
         snapshot_id, claim_effect_id, algorithm_version, net_winnings_atomic,
         allocation_count, allocation_hash, state, credited_at)
       VALUES ('batch-earlier','leg-earlier',211,'snapshot-earlier','claim-earlier','equal_v1',
         $1,1,$2,'credited',clock_timestamp())`,
      [CREDIT.toString(), "b".repeat(64)],
    );
    await admin.query("INSERT INTO users (user_id) VALUES ('account-owner'), ('account-a')");
    await admin.query(
      "INSERT INTO personas (persona_id, account_id) VALUES ('persona-a','account-a')",
    );
    await admin.query(
      `INSERT INTO megapot_allocations (allocation_batch_id, ordinal, account_id, persona_id,
         amount_atomic, allocation_kind, credit_id)
       VALUES ('batch-earlier',0,'account-a','persona-a',$1,'participant','credit-earlier')`,
      [CREDIT.toString()],
    );
    await admin.query(
      `INSERT INTO reward_ledger_credits (credit_id, account_id, payout_persona_id, chain_id,
         token_address, amount_atomic, source_kind, source_reference, state)
       VALUES ('credit-earlier','account-a','persona-a',8453,$1,$2,'megapot_allocation',
         'batch-earlier','credited')`,
      [USDC, CREDIT.toString()],
    );
    await admin.query(
      `INSERT INTO megapot_participant_claims (credit_id, account_id, pool_leg_id, drawing_id,
         status, subject_key_id, evidence_receipt_id, accepted_at)
       VALUES ('credit-earlier','account-a','leg-earlier',211,'accepted','subject-a','receipt-a',
         clock_timestamp())`,
    );
    await admin.query(
      `INSERT INTO persona_wallet_assignments (assignment_id, persona_id, account_id,
         chain_account_kind, status, reservation_idempotency_key, address, assigned_at,
         hd_wallet_index, created_at, updated_at)
       VALUES ('wallet-a','persona-a','account-a','evm','active','reserve-a',$1,now(),0,now(),
         now())`,
      [address("b")],
    );
    await admin.query("SET session_replication_role = origin");
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  return {
    admin,
    scoped,
    chain,
    options,
    recovery,
    run,
    observeSolvency,
    one,
    leg,
    drawing,
    brakeRevision,
    setPaused,
    recover,
    lateExecution,
    latePurchase,
  };
}

suite("late Safe purchase recovery", () => {
  // The Safe holds the credit it owes and one ticket's price, which the late purchase spends.
  const {
    admin,
    scoped,
    chain,
    options,
    recovery,
    run,
    observeSolvency,
    one,
    leg,
    drawing,
    brakeRevision,
    setPaused,
    recover,
    latePurchase,
  } = lateSafePurchaseFixture("reward_safe_late_purchase", CREDIT + PRICE);

  test("a recovered late purchase stops blocking an unrelated payout without new funding", async () => {
    const late = await latePurchase("late-ok");
    expect(late.settled).toEqual({
      kind: "reconciliation_required",
      reason: "safe_purchase_after_close",
    });
    expect(await leg("late-ok")).toEqual({ reserved: "1000000", spent: "0" });
    const closed = await drawing("late-ok");
    expect(closed).toMatchObject({
      status: "closed_purchase_unavailable",
      terminal_reason: "safe_purchase_not_executed",
      actual: "0",
      snapshot_id: null,
      frozen_share_count: null,
      shares: 0,
    });

    // The Safe holds exactly what it owes the credit, but the spent ticket is still
    // counted as a reservation on top: the October 23 rehearsal's freeze.
    expect(await observeSolvency()).toMatchObject({
      balanceAtomic: CREDIT,
      reservedPurchaseAtomic: PRICE,
      outstandingCreditAtomic: CREDIT,
      pendingRefundAtomic: 0n,
      solvent: false,
    });
    const payouts = makeRewardSafePayoutCoordinator(options());
    await expect(run(payouts.prepare("credit-earlier"))).rejects.toMatchObject({
      reason: "solvency-insufficient",
    });

    // The dry run re-verifies the chain and writes nothing.
    expect(await inspectLateSafePurchases({ ...recovery, effectId: late.effectId })).toEqual([
      expect.objectContaining({
        kind: "recoverable",
        effectId: late.effectId,
        drawingId: 212n,
        ticketId: late.ticketId,
        costAtomic: PRICE,
        blockNumber: late.block,
        confirmations: 3,
      }),
    ]);
    expect(await leg("late-ok")).toEqual({ reserved: "1000000", spent: "0" });

    // Refused while operations run, and against a brake revision that is not current.
    const running = await brakeRevision();
    await expect(recover(late.effectId, running)).rejects.toMatchObject({
      reason: "recovery-not-isolated",
    });
    await setPaused(true);
    const paused = await brakeRevision();
    await expect(recover(late.effectId, running)).rejects.toMatchObject({
      reason: "recovery-not-isolated",
    });
    expect(await recover(late.effectId, paused)).toMatchObject({
      kind: "recovered",
      effectId: late.effectId,
      ticketId: late.ticketId,
      drawingId: 212n,
      costAtomic: PRICE,
      brakeRevision: paused,
    });
    // Exactly once: a replay finds nothing held and changes nothing.
    expect(await recover(late.effectId, paused)).toEqual({
      kind: "not_held",
      effectId: late.effectId,
    });
    await setPaused(false);

    expect(await leg("late-ok")).toEqual({ reserved: "0", spent: "1000000" });
    expect(
      await one(
        `SELECT state, settled_amount_atomic::text AS settled, receipt_status, failure_reason
           FROM reward_chain_effects WHERE effect_id=$1`,
        [late.effectId],
      ),
    ).toEqual([
      { state: "confirmed", settled: "1000000", receipt_status: "success", failure_reason: null },
    ]);
    expect(
      await one(
        `SELECT ticket_id::text, status, drawing_id::text, custody_address,
                owner_observation_block_number::text AS owner_block
           FROM megapot_ticket_inventory WHERE purchase_effect_id=$1`,
        [late.effectId],
      ),
    ).toEqual([
      {
        ticket_id: late.ticketId.toString(),
        status: "held_late",
        drawing_id: "212",
        custody_address: SAFE,
        owner_block: late.block.toString(),
      },
    ]);
    expect(
      await one(
        `SELECT ticket_id::text, block_number::text AS block, confirmations
           FROM megapot_purchase_receipt_evidence WHERE purchase_effect_id=$1`,
        [late.effectId],
      ),
    ).toEqual([
      { ticket_id: late.ticketId.toString(), block: late.block.toString(), confirmations: 3 },
    ]);
    expect(
      await one(
        `SELECT event->>'ticket_disposition' AS disposition, event->>'brake_revision' AS brake,
                event->>'cost_atomic' AS cost, event->>'drawing_status' AS drawing_status
           FROM reward_chain_effect_transitions
          WHERE effect_id=$1 AND event_type='late_purchase_recovered'`,
        [late.effectId],
      ),
    ).toEqual([
      {
        disposition: "held_late",
        brake: paused.toString(),
        cost: "1000000",
        drawing_status: "closed_purchase_unavailable",
      },
    ]);
    // The closed drawing and its history are untouched: no entries, no snapshot.
    expect(await drawing("late-ok")).toEqual(closed);

    // With no new funding, the next observation is solvent and the payout is prepared.
    chain.mine(1n);
    expect(await observeSolvency()).toMatchObject({
      balanceAtomic: CREDIT,
      reservedPurchaseAtomic: 0n,
      outstandingCreditAtomic: CREDIT,
      solvent: true,
    });
    const payout = await run(payouts.prepare("credit-earlier"));
    expect(payout.transactionBuilderFile.transactions).toHaveLength(1);
  });

  test("the held ticket is never claimed, assigned or entered another way", async () => {
    const [held] = await one<{ attestation_id: string; ticket_id: string }>(
      "SELECT attestation_id, ticket_id::text FROM megapot_ticket_inventory WHERE status='held_late'",
    );
    if (held === undefined) throw new Error("no held ticket");
    for (const status of ["claim_pending", "no_win", "needs_review", "custodied"]) {
      await expect(
        admin.query(
          `UPDATE megapot_ticket_inventory SET status=$3, updated_at=clock_timestamp()
            WHERE attestation_id=$1 AND ticket_id=$2`,
          [held.attestation_id, held.ticket_id, status],
        ),
      ).rejects.toThrow(/invalid Megapot ticket inventory transition/u);
    }
  });

  test("a concurrent second recovery of the same purchase is refused", async () => {
    const late = await latePurchase("late-race");
    const [plan] = await inspectLateSafePurchases({ ...recovery, effectId: late.effectId });
    if (plan?.kind !== "recoverable") throw new Error("not recoverable");
    await setPaused(true);
    const revision = await brakeRevision();
    const call = (client: Client, verifiedAt = new Date().toISOString()) =>
      client.query(
        `SELECT recover_late_safe_purchase_v1($1,$2::bigint,$3::bigint,$4::numeric,$5,$6,
           $7::bigint,$8,$9,$10,$11::numeric,$12::numeric,$13::timestamptz)`,
        [
          plan.effectId,
          plan.effectVersion.toString(),
          revision.toString(),
          plan.ticketId.toString(),
          plan.purchaseLogIndex,
          plan.mintLogIndex,
          plan.blockNumber.toString(),
          plan.blockHash,
          plan.receiptHash,
          plan.confirmations,
          plan.referralFeesAtomic.toString(),
          plan.lpEarningsAtomic.toString(),
          verifiedAt,
        ],
      );
    const first = new Client({ connectionString: scoped });
    const second = new Client({ connectionString: scoped });
    await first.connect();
    await second.connect();
    try {
      // Evidence verified more than a minute ago is stale.
      await expect(
        call(second, new Date(Date.now() - 120_000).toISOString()),
      ).rejects.toMatchObject({ code: "PR005" });
      await first.query("BEGIN");
      await call(first);
      // The second waits on the effect's row lock, then finds it already confirmed.
      const racing = call(second).then(
        () => "applied",
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query("COMMIT");
      expect(await racing).toBe("PR005");
    } finally {
      await first.end();
      await second.end();
      await setPaused(false);
    }
    expect(await leg("late-race")).toEqual({ reserved: "0", spent: "1000000" });
    expect(
      await one(
        `SELECT count(*)::int AS events FROM reward_chain_effect_transitions
          WHERE effect_id=$1 AND event_type='late_purchase_recovered'`,
        [late.effectId],
      ),
    ).toEqual([{ events: 1 }]);
  });

  test("a live run lease refuses recovery even while paused", async () => {
    const late = await latePurchase("late-lease");
    await setPaused(true);
    await admin.query("SELECT acquire_reward_run_lease_v1('late-purchase-run',60,600)");
    try {
      await expect(recover(late.effectId, await brakeRevision())).rejects.toMatchObject({
        reason: "recovery-not-isolated",
      });
      expect(await leg("late-lease")).toEqual({ reserved: "1000000", spent: "0" });
    } finally {
      await admin.query(
        `UPDATE reward_operations_run_lease
            SET expires_at = clock_timestamp() - interval '1 second' WHERE singleton`,
      );
    }
    expect(await recover(late.effectId, await brakeRevision())).toMatchObject({
      kind: "recovered",
    });
    await setPaused(false);
  });

  test("wrong-drawing, orphaned, unreadable and nonconforming purchases stay held", async () => {
    // Earlier cases spent the Safe's USDC on their tickets; fund these four.
    chain.fund(address("e"), 4n * PRICE);
    const wrong = await latePurchase("late-wrong", 213n);
    expect(wrong.settled).toEqual({
      kind: "reconciliation_required",
      reason: "safe_purchase_wrong_drawing",
    });
    const orphaned = await latePurchase("late-orphan");
    const unreadable = await latePurchase("late-unreadable");
    const foreign = await latePurchase("late-foreign");
    chain.orphan(orphaned.block);
    await setPaused(true);
    const revision = await brakeRevision();
    try {
      const attempt = async (effectId: string) => {
        const [assessed] = await inspectLateSafePurchases({ ...recovery, effectId });
        const recovered = await recover(effectId, revision);
        expect<unknown>(recovered).toEqual(assessed);
        return recovered.kind === "held" ? recovered.reason : recovered.kind;
      };
      expect(await attempt(wrong.effectId)).toBe("safe_purchase_wrong_drawing");
      expect(await attempt(orphaned.effectId)).toBe("safe_execution_receipt_not_canonical");
      chain.blocksUnreadable(true);
      try {
        expect(await attempt(unreadable.effectId)).toBe("safe_execution_rpc_unavailable");
      } finally {
        chain.blocksUnreadable(false);
      }
      chain.ticketOwner(address("7"));
      try {
        expect(await attempt(foreign.effectId)).toBe("safe_purchase_ticket_owner_mismatch");
      } finally {
        chain.ticketOwner(SAFE);
      }
      // The database refuses a held purchase whatever evidence it is handed.
      const version = (
        await one<{ version: string }>(
          "SELECT version::text FROM reward_chain_effects WHERE effect_id=$1",
          [wrong.effectId],
        )
      )[0]?.version;
      await expect(
        admin.query(
          `SELECT recover_late_safe_purchase_v1($1,$2::bigint,$3::bigint,$4::numeric,0,1,
             $5::bigint,$6,$7,3,0,0,clock_timestamp())`,
          [
            wrong.effectId,
            version,
            revision.toString(),
            wrong.ticketId.toString(),
            wrong.block.toString(),
            hash("c"),
            "f".repeat(64),
          ],
        ),
      ).rejects.toMatchObject({ code: "PR005" });
      // Nor may a held ticket be entered into inventory outside the recovery.
      await expect(
        admin.query(
          `INSERT INTO megapot_ticket_inventory (attestation_id, ticket_id, purchase_effect_id,
             pool_leg_id, drawing_id, custody_address, owner_observation_block_number,
             owner_observation_block_hash, minted_transaction_hash, minted_log_index, status,
             acquired_at)
           SELECT $1,$2,effect_id,'late-wrong',212,$3,$4,$5,transaction_hash,1,'held_late',
                  clock_timestamp()
             FROM reward_chain_effects WHERE effect_id=$6`,
          [
            ATTESTATION,
            wrong.ticketId.toString(),
            SAFE,
            wrong.block.toString(),
            hash("c"),
            wrong.effectId,
          ],
        ),
      ).rejects.toThrow(/held late Megapot ticket requires its recovery evidence/u);
    } finally {
      await setPaused(false);
    }
    for (const legId of ["late-wrong", "late-orphan", "late-unreadable", "late-foreign"]) {
      expect(await leg(legId)).toEqual({ reserved: "1000000", spent: "0" });
    }
    expect(
      await one(
        `SELECT count(*)::int AS held FROM reward_chain_effects
          WHERE state='reconciliation_required' AND effect_kind='ticket_purchase'`,
      ),
    ).toEqual([{ held: 4 }]);
  });
});

suite("late failed Safe purchase", () => {
  // The Safe holds the credit it owes and the leg's ticket price, which a failed
  // execution never spends.
  const { chain, options, run, observeSolvency, one, leg, drawing, lateExecution } =
    lateSafePurchaseFixture("reward_safe_late_failure", CREDIT + PRICE);
  const failures = async (effectId: string) =>
    one(
      `SELECT effect.state, effect.receipt_status, effect.safe_execution_outcome,
              effect.settled_amount_atomic,
              (SELECT count(*)::int FROM reward_chain_effect_transitions event
                WHERE event.effect_id=effect.effect_id
                  AND event.event_type='safe_execution_failed') AS failed_events,
              (SELECT count(*)::int FROM megapot_ticket_inventory ticket
                WHERE ticket.purchase_effect_id=effect.effect_id) AS tickets
         FROM reward_chain_effects effect WHERE effect.effect_id=$1`,
      [effectId],
    );

  test("a canonical late failure releases its reservation once and leaves its drawing closed", async () => {
    const late = await lateExecution("fail-ok", "failure");
    expect(await leg("fail-ok")).toEqual({ reserved: "1000000", spent: "0" });
    const closed = await drawing("fail-ok");
    expect(closed).toMatchObject({
      status: "closed_purchase_unavailable",
      terminal_reason: "safe_purchase_not_executed",
      actual: "0",
      snapshot_id: null,
      shares: 0,
    });
    // The failed purchase spent nothing, so the ticket price still in the Safe backs
    // the reservation: unlike a late ticket, a late failure never froze payouts.
    expect(await observeSolvency()).toMatchObject({
      balanceAtomic: CREDIT + PRICE,
      reservedPurchaseAtomic: PRICE,
      pendingRefundAtomic: 0n,
      outstandingCreditAtomic: CREDIT,
      solvent: true,
    });

    expect(await late.settle()).toEqual({ kind: "released" });
    expect(await leg("fail-ok")).toEqual({ reserved: "0", spent: "0" });
    expect(await failures(late.effectId)).toEqual([
      {
        state: "reverted",
        receipt_status: "success",
        safe_execution_outcome: "failure",
        settled_amount_atomic: null,
        failed_events: 1,
        tickets: 0,
      },
    ]);
    // The drawing stays exactly as it closed: no entries, no snapshot, no new history.
    expect(await drawing("fail-ok")).toEqual(closed);
    // Exactly once: a replay finds nothing to settle and changes nothing.
    expect(await late.settle()).toEqual({ kind: "not_bound" });
    expect(await leg("fail-ok")).toEqual({ reserved: "0", spent: "0" });

    // The released price is owed back to the leg's funders instead, so the obligations
    // are unchanged and the unrelated credit is paid without new funding.
    chain.mine(1n);
    expect(await observeSolvency()).toMatchObject({
      balanceAtomic: CREDIT + PRICE,
      reservedPurchaseAtomic: 0n,
      pendingRefundAtomic: PRICE,
      outstandingCreditAtomic: CREDIT,
      solvent: true,
    });
    const payout = await run(makeRewardSafePayoutCoordinator(options()).prepare("credit-earlier"));
    expect(payout.transactionBuilderFile.transactions).toHaveLength(1);
  });

  test("concurrent settlements of a late failure release it once", async () => {
    const late = await lateExecution("fail-race", "failure");
    const outcomes = await Promise.allSettled([late.settle(), late.settle()]);
    const released = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value.kind === "released",
    );
    expect(released).toHaveLength(1);
    // The other found the effect already settled, or lost the row lock and was refused.
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        expect(["released", "not_bound"]).toContain(outcome.value.kind);
      } else {
        expect(outcome.reason).toMatchObject({ reason: "effect-conflict" });
      }
    }
    expect(await leg("fail-race")).toEqual({ reserved: "0", spent: "0" });
    expect(await failures(late.effectId)).toMatchObject([{ state: "reverted", failed_events: 1 }]);
  });

  test("an orphaned or unreadable late failure keeps its reservation", async () => {
    const orphaned = await lateExecution("fail-orphan", "failure");
    const closed = await drawing("fail-orphan");
    chain.orphan(orphaned.block);
    expect(await orphaned.settle()).toEqual({
      kind: "reconciliation_required",
      reason: "safe_execution_receipt_not_canonical",
    });
    expect(await leg("fail-orphan")).toEqual({ reserved: "1000000", spent: "0" });
    expect(await failures(orphaned.effectId)).toMatchObject([
      { state: "reconciliation_required", failed_events: 0 },
    ]);
    expect(await drawing("fail-orphan")).toEqual(closed);

    const unreadable = await lateExecution("fail-unreadable", "failure");
    chain.blocksUnreadable(true);
    try {
      await expect(unreadable.settle()).rejects.toMatchObject({ reason: "rpc_unavailable" });
    } finally {
      chain.blocksUnreadable(false);
    }
    expect(await leg("fail-unreadable")).toEqual({ reserved: "1000000", spent: "0" });
    expect(await failures(unreadable.effectId)).toMatchObject([
      { state: "confirming", failed_events: 0 },
    ]);
  });
});
