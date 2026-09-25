/**
 * Owner decision 2026-09-25: a winner who claimed and was paid USDC gets a
 * bounded, platform-funded native gas top-up. Prerequisite rows (users,
 * personas, wallets, the paid and claimed credits, the custody attestation)
 * are seeded with triggers disabled; every top-up, budget, wallet, effect,
 * nonce and evidence row is written through the production repositories and
 * guard triggers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  makeRewardGasTopupRequester,
  type RewardGasTopupLimits,
  type RewardGasTopupRequester,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { type Hex, keccak256 } from "viem";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import {
  deriveBaseSepoliaMegapotAddress,
  type MegapotV2TransactionSigner,
  makeBaseSepoliaMegapotV2PrivateKeySigner,
} from "./megapot-v2-signer.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  deriveRewardGasTopupEffectId,
  makeRewardGasTopupCoordinator,
  type RewardGasTopupRpc,
} from "./reward-gas-topup-coordinator.ts";
import {
  makeControlPlaneRewardGasTopupRequestStore,
  makeControlPlaneRewardGasTopupSendStore,
} from "./reward-gas-topup-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const CHAIN_ID = 84_532;
const GAS_KEY = `0x${"11".repeat(32)}`;
const GAS_SIGNER = deriveBaseSepoliaMegapotAddress(GAS_KEY);
const CUSTODY = `0x${"cc".repeat(20)}`;
const USDC = `0x${"0a".repeat(20)}`;
const address = (byte: string) => `0x${byte.repeat(20)}`;
const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const LIMITS: RewardGasTopupLimits = {
  targetBalanceWei: 50_000n,
  maxTopupWei: 30_000n,
  accountDailyCount: 2,
  platformDailyWei: 80_000n,
};

// Winner holds four paid, claimed credits on four personas with four wallets;
// other holds one. Refusal fixtures cover unclaimed, unpaid and walletless.
const WALLETS = {
  w1: address("a1"),
  w2: address("a2"),
  w3: address("a3"),
  w4: address("a4"),
  other: address("b1"),
  unclaimed: address("a5"),
  unpaid: address("a6"),
} as const;

async function seedPrerequisites(admin: Client) {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) VALUES ('winner'), ('other')");
    const rows: Array<[string, string, keyof typeof WALLETS | null, string, boolean]> = [
      ["winner", "p1", "w1", "sent", true],
      ["winner", "p2", "w2", "sent", true],
      ["winner", "p3", "w3", "sent", true],
      ["winner", "p4", "w4", "sent", true],
      ["winner", "p5", "unclaimed", "sent", false],
      ["winner", "p6", "unpaid", "credited", true],
      ["winner", "p7", null, "sent", true],
      ["other", "q1", "other", "sent", true],
    ];
    for (const [index, [account, persona, wallet, state, claimed]] of rows.entries()) {
      const credit = `credit-${persona}`;
      await admin.query("INSERT INTO personas (persona_id, account_id) VALUES ($1,$2)", [
        persona,
        account,
      ]);
      if (wallet !== null) {
        await admin.query(
          `INSERT INTO persona_wallet_assignments (
             assignment_id, persona_id, account_id, chain_account_kind, hd_wallet_index,
             address, status, reservation_idempotency_key, assigned_at, created_at, updated_at
           ) VALUES ($1,$2,$3,'evm',$5,$4,'active',$1,now(),now(),now())`,
          [`assignment-${persona}`, persona, account, WALLETS[wallet], index],
        );
      }
      await admin.query(
        `INSERT INTO reward_ledger_credits (
           credit_id, account_id, payout_persona_id, chain_id, token_address, amount_atomic,
           source_kind, source_reference, state, paid_atomic, settled_at
         ) VALUES ($1,$2,$3,$4,$5,1000000,'megapot_allocation',$1,$6,
                   CASE WHEN $6='sent' THEN 1000000 ELSE 0 END,
                   CASE WHEN $6='sent' THEN clock_timestamp() END)`,
        [credit, account, persona, CHAIN_ID, USDC, state],
      );
      if (claimed) {
        await admin.query(
          `INSERT INTO megapot_participant_claims (
             credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
             evidence_receipt_id, accepted_at
           ) VALUES ($1,$2,'leg-1',1,'accepted',$3,'receipt',clock_timestamp())`,
          [credit, account, `subject-${persona}`],
        );
      }
    }
    await admin.query(
      `INSERT INTO megapot_deployment_attestations (
         attestation_id, environment, chain_id, jackpot_address, usdc_address,
         ticket_nft_address, custody_address, source_tag, jackpot_code_hash,
         usdc_code_hash, ticket_nft_code_hash, attestation_block_number,
         attestation_block_hash, abi_version, status, verified_at
       ) VALUES ('attestation-1','test',$1,$2,$3,$2,$4,$5,$5,$5,$5,1,$5,'megapot_v2','active',
                 clock_timestamp())`,
      [CHAIN_ID, address("0d"), USDC, CUSTODY, blockHash(1n)],
    );
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

/** A deterministic chain: balances by address, one receipt per hash, a movable head. */
function fakeChain() {
  const balances = new Map<string, bigint>([[GAS_SIGNER, 10n ** 18n]]);
  const receipts = new Map<string, MegapotTransactionReceipt>();
  const sent: string[] = [];
  let head = 100n;
  const rpc: RewardGasTopupRpc = {
    readFeeQuote: async () => ({
      baseFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 3n,
      observedBlockNumber: head,
      observedBlockHash: blockHash(head),
    }),
    readBlock: async (blockNumber) => ({ blockNumber, blockHash: blockHash(blockNumber) }),
    readHead: async () => ({ blockNumber: head, blockHash: blockHash(head) }),
    readNativeBalance: async (account) => balances.get(account.toLowerCase()) ?? 0n,
    readPendingNonce: async () => 7n,
    estimateGas: async () => 21_000n,
    sendRawTransaction: async (signed) => {
      sent.push(signed);
      return keccak256(signed);
    },
    readReceipt: async (hash) => receipts.get(hash) ?? null,
  };
  return {
    rpc,
    balances,
    sent,
    advance: (blocks: bigint) => {
      head += blocks;
    },
    mine: (hash: string, to: string, status: "success" | "reverted") => {
      receipts.set(hash, {
        chainId: CHAIN_ID,
        status,
        transactionHash: hash,
        from: GAS_SIGNER,
        to,
        blockHash: blockHash(head + 1n),
        blockNumber: head + 1n,
        logs: [],
      });
    },
  };
}

suite("Postgres 17 Megapot winner gas top-up", () => {
  const schema = `reward_gas_topup_${Date.now()}`;
  const scoped = connectionString
    ? `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`
    : "";
  const admin = new Client({ connectionString });
  let requester: RewardGasTopupRequester;
  const chain = fakeChain();
  const walletBalances = new Map<string, bigint>();
  let layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  const topups: Record<string, string> = {};

  const request = (accountId: string, persona: string, key: string) =>
    Effect.runPromise(
      requester.request({ accountId, creditId: `credit-${persona}`, idempotencyKey: key }),
    );
  const failure = (accountId: string, persona: string, key: string) =>
    Effect.runPromise(
      Effect.flip(
        requester.request({ accountId, creditId: `credit-${persona}`, idempotencyKey: key }),
      ),
    );
  const coordinator = (signer?: MegapotV2TransactionSigner) =>
    makeRewardGasTopupCoordinator({
      store: makeControlPlaneRewardGasTopupSendStore(layer),
      rpc: chain.rpc,
      signer:
        signer ??
        makeBaseSepoliaMegapotV2PrivateKeySigner({
          privateKey: GAS_KEY,
          expectedAddress: GAS_SIGNER,
        }),
      requiredConfirmations: 3,
      gasLimitMultiplierBps: 12_000,
      nativeGasReserveFloorWei: 1_000n,
    });
  const budget = async () =>
    (
      await admin.query(
        "SELECT ceiling_wei::text, reserved_wei::text, confirmed_wei::text FROM reward_gas_topup_daily_budgets",
      )
    ).rows;
  const topupRow = async (topupId: string) =>
    (
      await admin.query(
        `SELECT status, amount_wei::text, effect_id, release_reason
           FROM reward_gas_topups WHERE topup_id=$1`,
        [topupId],
      )
    ).rows[0];

  beforeAll(async () => {
    if (!connectionString) return;
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await seedPrerequisites(admin);
    layer = makeDirectPostgresControlPlaneLayer(scoped);
    let sequence = 0;
    requester = makeRewardGasTopupRequester({
      store: makeControlPlaneRewardGasTopupRequestStore(layer),
      readNativeBalance: (account) => Effect.succeed(walletBalances.get(account) ?? 0n),
      limits: LIMITS,
      ids: { next: Effect.sync(() => `t${++sequence}`) },
    });
  }, 120_000);

  afterAll(async () => {
    if (!connectionString) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("the gas wallet is registered once and can never be the custody signer", async () => {
    await expect(
      admin.query(
        "INSERT INTO reward_gas_topup_wallets (chain_id, signer_address, status) VALUES ($1,$2,'active')",
        [CHAIN_ID, CUSTODY],
      ),
    ).rejects.toThrow("cannot be a Megapot custody signer");
    // Without an active gas wallet a request is refused as unavailable.
    expect(await failure("winner", "p1", "k-none")).toMatchObject({
      _tag: "RewardGasTopupRejected",
      reason: "gas-wallet-unavailable",
    });
    await admin.query(
      "INSERT INTO reward_gas_topup_wallets (chain_id, signer_address, status) VALUES ($1,$2,'active')",
      [CHAIN_ID, GAS_SIGNER],
    );
    await expect(
      admin.query(
        "INSERT INTO reward_gas_topup_wallets (chain_id, signer_address, status) VALUES ($1,$2,'active')",
        [CHAIN_ID, address("ee")],
      ),
    ).rejects.toThrow();
  });

  test("refuses foreign, unclaimed, unpaid and walletless credits", async () => {
    expect(await failure("winner", "q1", "k-foreign")).toMatchObject({ reason: "not-found" });
    expect(await failure("winner", "p5", "k-unclaimed")).toMatchObject({
      reason: "credit-not-eligible",
    });
    expect(await failure("winner", "p6", "k-unpaid")).toMatchObject({
      reason: "credit-not-eligible",
    });
    expect(await failure("winner", "p7", "k-walletless")).toMatchObject({
      reason: "recipient-pending",
    });
    expect((await admin.query("SELECT count(*)::int AS n FROM reward_gas_topups")).rows).toEqual([
      { n: 0 },
    ]);
  });

  test("stores nothing when the wallet already holds the target", async () => {
    walletBalances.set(WALLETS.w1, 50_000n);
    expect(await request("winner", "p1", "k-full")).toEqual({
      status: "not_needed",
      topupId: null,
      amountWei: null,
    });
    walletBalances.set(WALLETS.w1, 0n);
    expect((await admin.query("SELECT count(*)::int AS n FROM reward_gas_topups")).rows).toEqual([
      { n: 0 },
    ]);
  });

  test("reserves the capped shortfall once and replays it idempotently", async () => {
    const first = await request("winner", "p1", "k-1");
    expect(first).toMatchObject({ status: "pending", amountWei: 30_000n });
    topups.w1 = first.topupId as string;
    expect(await request("winner", "p1", "k-1")).toEqual(first);
    expect(await failure("winner", "p2", "k-1")).toMatchObject({ reason: "idempotency-conflict" });
    // A second key while the wallet's top-up is open returns the open one.
    expect(await request("winner", "p1", "k-1b")).toEqual(first);
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "30000", confirmed_wei: "0" },
    ]);
  });

  test("enforces the per-account daily count and the platform daily budget", async () => {
    walletBalances.set(WALLETS.w2, 0n);
    const second = await request("winner", "p2", "k-2");
    expect(second).toMatchObject({ status: "pending", amountWei: 30_000n });
    topups.w2 = second.topupId as string;
    // A third top-up would fit the budget (5000 wei) but exceeds the count of two.
    walletBalances.set(WALLETS.w3, 45_000n);
    expect(await request("winner", "p3", "k-3")).toEqual({
      status: "limit_reached",
      topupId: null,
      amountWei: null,
    });
    // Another account is refused by the 80000 wei platform budget (60000 + 30000).
    expect(await request("other", "q1", "k-other")).toMatchObject({ status: "limit_reached" });
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "60000", confirmed_wei: "0" },
    ]);
  });

  test("sends requested -> nonce_reserved -> prepared -> broadcast -> confirmed with evidence", async () => {
    const topupId = topups.w1 as string;
    const effectId = deriveRewardGasTopupEffectId(topupId);
    const failingSigner: MegapotV2TransactionSigner = {
      address: GAS_SIGNER,
      sign: async () => {
        throw new Error("signer offline");
      },
    };
    expect(
      await Effect.runPromise(Effect.flip(coordinator(failingSigner).send(topupId))),
    ).toMatchObject({
      _tag: "RewardGasTopupCoordinatorFailed",
      phase: "prepare",
    });
    expect(await topupRow(topupId)).toMatchObject({ status: "requested", effect_id: effectId });
    expect(
      (
        await admin.query(
          "SELECT effect_kind, state, nonce::text, signer_address, target_address, value_wei::text FROM reward_chain_effects WHERE effect_id=$1",
          [effectId],
        )
      ).rows,
    ).toEqual([
      {
        effect_kind: "gas_topup",
        state: "nonce_reserved",
        nonce: "7",
        signer_address: GAS_SIGNER,
        target_address: WALLETS.w1,
        value_wei: "30000",
      },
    ]);

    const submitted = await Effect.runPromise(coordinator().send(topupId));
    expect(submitted.kind).toBe("submitted");
    expect(await topupRow(topupId)).toMatchObject({ status: "broadcast" });
    expect(chain.sent).toHaveLength(1);
    const hash = keccak256(chain.sent[0] as Hex);

    chain.mine(hash, WALLETS.w1, "success");
    chain.advance(1n);
    // One block of depth is below the three required confirmations.
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("submitted");
    chain.advance(2n);
    expect(await Effect.runPromise(coordinator().send(topupId))).toMatchObject({
      kind: "confirmed",
      topupId,
      transactionHash: hash,
    });
    expect(await topupRow(topupId)).toMatchObject({ status: "confirmed" });
    expect(
      (
        await admin.query(
          "SELECT event_type, target_version FROM reward_chain_effect_transitions WHERE effect_id=$1 ORDER BY target_version",
          [effectId],
        )
      ).rows.map((row) => row.event_type),
    ).toEqual(["nonce_reserved", "prepared", "broadcast_submitted", "receipt_confirmed"]);
    expect(
      (
        await admin.query(
          `SELECT sender_address, recipient_address, amount_wei::text, transaction_hash,
                  block_number::text, confirmations
             FROM reward_native_transfer_receipt_evidence WHERE effect_id=$1`,
          [effectId],
        )
      ).rows,
    ).toEqual([
      {
        sender_address: GAS_SIGNER,
        recipient_address: WALLETS.w1,
        amount_wei: "30000",
        transaction_hash: hash,
        block_number: "101",
        confirmations: 3,
      },
    ]);
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "30000", confirmed_wei: "30000" },
    ]);
    // Replaying a confirmed top-up is a no-op.
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);
  });

  test("a reverted receipt is terminal and returns the reserved budget", async () => {
    const topupId = topups.w2 as string;
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("submitted");
    const hash = keccak256(chain.sent[1] as Hex);
    chain.mine(hash, WALLETS.w2, "reverted");
    chain.advance(3n);
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("reverted");
    expect(await topupRow(topupId)).toMatchObject({
      status: "released",
      release_reason: "receipt_reverted",
    });
    expect(
      (
        await admin.query("SELECT state FROM reward_chain_effects WHERE effect_id=$1", [
          deriveRewardGasTopupEffectId(topupId),
        ])
      ).rows,
    ).toEqual([{ state: "reverted" }]);
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "0", confirmed_wei: "30000" },
    ]);
    // Released top-ups no longer count, so the winner may request again today.
    walletBalances.set(WALLETS.w3, 45_000n);
    expect(await request("winner", "p3", "k-3b")).toMatchObject({
      status: "pending",
      amountWei: 5_000n,
    });
  });

  test("the guard rejects a custody-signed or mismatched gas top-up effect", async () => {
    await admin.query(
      `INSERT INTO reward_signer_nonces (
         chain_id, signer_address, next_nonce, observed_pending_nonce,
         observed_block_number, observed_block_hash, observed_at
       ) VALUES ($1,$2,0,0,1,$3,clock_timestamp())`,
      [CHAIN_ID, CUSTODY, blockHash(1n)],
    );
    await expect(
      admin.query(
        `INSERT INTO reward_chain_effects (
           effect_id, effect_kind, state, chain_id, signer_address, target_address, value_wei
         ) VALUES ('custody-topup','gas_topup','planned',$1,$2,$3,5000)`,
        [CHAIN_ID, CUSTODY, WALLETS.w3],
      ),
    ).rejects.toThrow("must be signed by the active gas wallet");

    const open = (
      await admin.query(
        "SELECT topup_id FROM reward_gas_topups WHERE status='requested' AND recipient_address=$1",
        [WALLETS.w3],
      )
    ).rows[0] as { topup_id: string };
    const bind = (effectId: string) =>
      admin.query("UPDATE reward_gas_topups SET effect_id=$2 WHERE topup_id=$1", [
        open.topup_id,
        effectId,
      ]);
    await admin.query(
      `INSERT INTO reward_chain_effects (
         effect_id, effect_kind, state, chain_id, signer_address, target_address, value_wei
       ) VALUES ('wrong-amount','gas_topup','planned',$1,$2,$3,4999),
                ('wrong-target','gas_topup','planned',$1,$2,$4,5000)`,
      [CHAIN_ID, GAS_SIGNER, WALLETS.w3, WALLETS.w4],
    );
    await expect(bind("wrong-amount")).rejects.toThrow("does not match the top-up");
    await expect(bind("wrong-target")).rejects.toThrow("does not match the top-up");
    // Retiring the gas wallet also blocks binding a later effect.
    await admin.query(
      `INSERT INTO reward_chain_effects (
         effect_id, effect_kind, state, chain_id, signer_address, target_address, value_wei
       ) VALUES ('retired-signer','gas_topup','planned',$1,$2,$3,5000)`,
      [CHAIN_ID, GAS_SIGNER, WALLETS.w3],
    );
    await admin.query(
      "UPDATE reward_gas_topup_wallets SET status='retired', retired_at=clock_timestamp() WHERE signer_address=$1",
      [GAS_SIGNER],
    );
    await expect(bind("retired-signer")).rejects.toThrow("does not match the top-up");
    await expect(
      admin.query("DELETE FROM reward_native_transfer_receipt_evidence"),
    ).rejects.toThrow("append-only");
  });
});
