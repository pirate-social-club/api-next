/**
 * Owner decision 2026-09-25: a winner who claimed and was paid USDC gets a
 * bounded, platform-funded native gas top-up to the wallet that received the
 * payout. Prerequisite rows (users, personas, wallets, the paid and claimed
 * credits, their confirmed payout records, the custody attestation) are
 * seeded with triggers disabled; every top-up, budget, gas wallet, effect,
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
import { type Hex, keccak256, parseTransaction } from "viem";
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

const WALLETS = {
  w1: address("a1"),
  w2: address("a2"),
  w3: address("a3"),
  w4: address("a4"),
  unclaimed: address("a5"),
  unpaid: address("a6"),
  unpaidOut: address("a7"),
  other: address("b1"),
  otherNew: address("b2"),
  third: address("c1"),
} as const;

type Fixture = Readonly<{
  account: string;
  persona: string;
  wallet: keyof typeof WALLETS;
  state: "sent" | "credited";
  claimed: boolean;
  paidOut: boolean;
}>;

const FIXTURES: readonly Fixture[] = [
  { account: "winner", persona: "p1", wallet: "w1", state: "sent", claimed: true, paidOut: true },
  { account: "winner", persona: "p2", wallet: "w2", state: "sent", claimed: true, paidOut: true },
  { account: "winner", persona: "p3", wallet: "w3", state: "sent", claimed: true, paidOut: true },
  { account: "winner", persona: "p4", wallet: "w4", state: "sent", claimed: true, paidOut: true },
  {
    account: "winner",
    persona: "p5",
    wallet: "unclaimed",
    state: "sent",
    claimed: false,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p6",
    wallet: "unpaid",
    state: "credited",
    claimed: true,
    paidOut: false,
  },
  {
    account: "winner",
    persona: "p7",
    wallet: "unpaidOut",
    state: "sent",
    claimed: true,
    paidOut: false,
  },
  { account: "other", persona: "q1", wallet: "other", state: "sent", claimed: true, paidOut: true },
  { account: "third", persona: "r1", wallet: "third", state: "sent", claimed: true, paidOut: true },
];

async function seedPrerequisites(admin: Client) {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) VALUES ('winner'), ('other'), ('third')");
    for (const [index, row] of FIXTURES.entries()) {
      const credit = `credit-${row.persona}`;
      const assignment = `assignment-${row.persona}`;
      await admin.query("INSERT INTO personas (persona_id, account_id) VALUES ($1,$2)", [
        row.persona,
        row.account,
      ]);
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id, persona_id, account_id, chain_account_kind, hd_wallet_index,
           address, status, reservation_idempotency_key, assigned_at, created_at, updated_at
         ) VALUES ($1,$2,$3,'evm',$5,$4,'active',$1,now(),now(),now())`,
        [assignment, row.persona, row.account, WALLETS[row.wallet], index],
      );
      await admin.query(
        `INSERT INTO reward_ledger_credits (
           credit_id, account_id, payout_persona_id, chain_id, token_address, amount_atomic,
           source_kind, source_reference, state, paid_atomic, settled_at
         ) VALUES ($1,$2,$3,$4,$5,1000000,'megapot_allocation',$1,$6,
                   CASE WHEN $6='sent' THEN 1000000 ELSE 0 END,
                   CASE WHEN $6='sent' THEN clock_timestamp() END)`,
        [credit, row.account, row.persona, CHAIN_ID, USDC, row.state],
      );
      if (row.claimed) {
        await admin.query(
          `INSERT INTO megapot_participant_claims (
             credit_id, account_id, pool_leg_id, drawing_id, status, subject_key_id,
             evidence_receipt_id, accepted_at
           ) VALUES ($1,$2,'leg-1',1,'accepted',$3,'receipt',clock_timestamp())`,
          [credit, row.account, `subject-${row.persona}`],
        );
      }
      if (row.paidOut) {
        // The confirmed USDC payout that fixes the gas destination.
        const effectId = `payout-${row.persona}`;
        const transactionHash = blockHash(BigInt(10_000 + index));
        await admin.query(
          `INSERT INTO reward_chain_effects (
             effect_id, effect_kind, state, version, chain_id, signer_address, target_address,
             settled_amount_atomic, nonce, calldata, calldata_hash, signed_transaction,
             signed_transaction_hash, transaction_hash, receipt_status, receipt_block_number,
             receipt_block_hash, receipt_hash, confirmations, prepared_at, broadcast_at,
             confirmed_at, created_at, updated_at
           ) VALUES ($1,'reward_payout','confirmed',5,$2,$3,$4,1000000,$5,'0x00',$6,'0x01',
                     $7,$7,'success',10,$8,$6,3,now(),now(),now(),now(),now())`,
          [
            effectId,
            CHAIN_ID,
            CUSTODY,
            USDC,
            index,
            "ab".repeat(32),
            transactionHash,
            blockHash(10n),
          ],
        );
        await admin.query(
          `INSERT INTO reward_payout_effects (
             payout_effect_id, attestation_id, credit_id, account_id, payout_persona_id,
             destination_address, amount_atomic, wallet_assignment_id,
             solvency_observation_id, custody_balance_before_atomic
           ) VALUES ($1,'attestation-1',$2,$3,$4,$5,1000000,$6,'observation',1000000)`,
          [effectId, credit, row.account, row.persona, WALLETS[row.wallet], assignment],
        );
        await admin.query(
          `INSERT INTO reward_erc20_transfer_receipt_evidence (
             effect_id, transfer_purpose, attestation_id, token_address, sender_address,
             recipient_address, amount_atomic, transaction_hash, transfer_log_index,
             custody_balance_after_atomic, block_number, block_hash, receipt_hash,
             confirmations, confirmed_at
           ) VALUES ($1,'reward_payout','attestation-1',$2,$3,$4,1000000,$5,0,0,10,$6,$7,3,now())`,
          [
            effectId,
            USDC,
            CUSTODY,
            WALLETS[row.wallet],
            transactionHash,
            blockHash(10n),
            "ab".repeat(32),
          ],
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
  const sent: Hex[] = [];
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
  const offlineSigner: MegapotV2TransactionSigner = {
    address: GAS_SIGNER,
    sign: async () => {
      throw new Error("signer offline");
    },
  };
  const budget = async () =>
    (
      await admin.query(
        "SELECT ceiling_wei::text, reserved_wei::text, confirmed_wei::text FROM reward_gas_topup_daily_budgets",
      )
    ).rows;
  const topupRow = async (topupId: string) =>
    (
      await admin.query(
        `SELECT status, amount_wei::text, recipient_address, effect_id, release_reason
           FROM reward_gas_topups WHERE topup_id=$1`,
        [topupId],
      )
    ).rows[0];
  const insertAttestation = (id: string, custody: string) =>
    admin.query(
      `INSERT INTO megapot_deployment_attestations (
         attestation_id, environment, chain_id, jackpot_address, usdc_address,
         ticket_nft_address, custody_address, source_tag, jackpot_code_hash,
         usdc_code_hash, ticket_nft_code_hash, attestation_block_number,
         attestation_block_hash, abi_version, status, verified_at
       ) VALUES ($1,'staging',$2,$3,$4,$3,$5,$6,$6,$6,$6,1,$6,'megapot_v2','retired',
                 clock_timestamp())`,
      [id, CHAIN_ID, address("0e"), USDC, custody, blockHash(2n)],
    );

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

  test("custody and gas wallets stay separate in both registration orders", async () => {
    // Custody first: that address can never become a gas wallet.
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
    // Gas wallet first: no attestation may name it as custody, new or amended.
    await expect(insertAttestation("attestation-gas", GAS_SIGNER)).rejects.toThrow(
      "cannot be a reward gas top-up wallet",
    );
    await expect(
      admin.query(
        "UPDATE megapot_deployment_attestations SET custody_address=$1 WHERE attestation_id='attestation-1'",
        [GAS_SIGNER],
      ),
    ).rejects.toThrow("cannot be a reward gas top-up wallet");
    await expect(
      admin.query(
        "INSERT INTO reward_gas_topup_wallets (chain_id, signer_address, status) VALUES ($1,$2,'active')",
        [CHAIN_ID, address("ee")],
      ),
    ).rejects.toThrow();
  });

  test("refuses foreign, unclaimed, unpaid and never-paid-out credits", async () => {
    expect(await failure("winner", "q1", "k-foreign")).toMatchObject({ reason: "not-found" });
    for (const persona of ["p5", "p6", "p7"]) {
      expect(await failure("winner", persona, `k-${persona}`)).toMatchObject({
        reason: "credit-not-eligible",
      });
    }
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

  test("reserves the capped shortfall once per credit and replays it idempotently", async () => {
    const first = await request("winner", "p1", "k-1");
    expect(first).toMatchObject({ status: "pending", amountWei: 30_000n });
    topups.w1 = first.topupId as string;
    expect(await request("winner", "p1", "k-1")).toEqual(first);
    expect(await failure("winner", "p2", "k-1")).toMatchObject({ reason: "idempotency-conflict" });
    // A second key for the same credit returns its open top-up.
    expect(await request("winner", "p1", "k-1b")).toEqual(first);
    // The database also refuses a second unreleased top-up for the credit.
    await expect(
      admin.query(
        `INSERT INTO reward_gas_topups (
           topup_id, account_id, persona_id, credit_id, wallet_assignment_id,
           recipient_address, chain_id, balance_before_wei, target_balance_wei,
           amount_wei, budget_day, idempotency_key, status
         ) SELECT 'direct-duplicate', account_id, persona_id, credit_id, wallet_assignment_id,
                  recipient_address, chain_id, 0, 50000, 1, budget_day, 'k-direct', 'requested'
             FROM reward_gas_topups WHERE topup_id=$1`,
        [topups.w1],
      ),
    ).rejects.toThrow("reward_gas_topup_credit_open_uidx");
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "30000", confirmed_wei: "0" },
    ]);
  });

  test("enforces the per-account daily count and the platform daily budget", async () => {
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
    expect(
      await Effect.runPromise(Effect.flip(coordinator(offlineSigner).send(topupId))),
    ).toMatchObject({ _tag: "RewardGasTopupCoordinatorFailed", phase: "prepare" });
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

    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("submitted");
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
          "SELECT event_type FROM reward_chain_effect_transitions WHERE effect_id=$1 ORDER BY target_version",
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
    // Replaying a confirmed top-up is a no-op, and the credit is now capped.
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("confirmed");
    expect(chain.sent).toHaveLength(1);
    expect(await request("winner", "p1", "k-1c")).toMatchObject({ status: "limit_reached" });
  });

  test("a reverted receipt is terminal, returns the budget and frees the credit", async () => {
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
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "0", confirmed_wei: "30000" },
    ]);
    // A released top-up blocks neither the credit nor the daily count.
    walletBalances.set(WALLETS.w2, 45_000n);
    const again = await request("winner", "p2", "k-2b");
    expect(again).toMatchObject({ status: "pending", amountWei: 5_000n });
    topups.w2again = again.topupId as string;
  });

  test("a terminal chain failure releases the top-up and its budget in one transaction", async () => {
    const topupId = topups.w2again as string;
    const effectId = deriveRewardGasTopupEffectId(topupId);
    await Effect.runPromise(Effect.flip(coordinator(offlineSigner).send(topupId)));
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "5000", confirmed_wei: "30000" },
    ]);
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO reward_chain_effect_transitions (effect_id, target_version, event_type, event)
       VALUES ($1,3,'operator_terminal','{}'::jsonb)`,
      [effectId],
    );
    await admin.query(
      `UPDATE reward_chain_effects
          SET state='terminal_failed', version=3, failure_class='operator',
              failure_reason='nonce abandoned', updated_at=clock_timestamp()
        WHERE effect_id=$1`,
      [effectId],
    );
    await admin.query("COMMIT");
    expect(await topupRow(topupId)).toMatchObject({
      status: "released",
      release_reason: "effect_terminal_failed",
    });
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "0", confirmed_wei: "30000" },
    ]);
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("released");
  });

  test("a partial deposit before sending shrinks the top-up and returns the difference", async () => {
    const reserved = await request("winner", "p3", "k-3b");
    expect(reserved).toMatchObject({ status: "pending", amountWei: 5_000n });
    const topupId = reserved.topupId as string;
    // The reservation used 45000 wei; the wallet now holds 47000.
    chain.balances.set(WALLETS.w3, 47_000n);
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("submitted");
    expect(await topupRow(topupId)).toMatchObject({ status: "broadcast", amount_wei: "3000" });
    expect(
      (
        await admin.query("SELECT value_wei::text FROM reward_chain_effects WHERE effect_id=$1", [
          deriveRewardGasTopupEffectId(topupId),
        ])
      ).rows,
    ).toEqual([{ value_wei: "3000" }]);
    expect(parseTransaction(chain.sent[chain.sent.length - 1] as Hex).value).toBe(3_000n);
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "3000", confirmed_wei: "30000" },
    ]);
    // Funded in full before sending: released, nothing sent, budget returned.
    const funded = await request("third", "r1", "k-r1");
    chain.balances.set(WALLETS.third, 60_000n);
    const sentBefore = chain.sent.length;
    expect(await Effect.runPromise(coordinator().send(funded.topupId as string))).toMatchObject({
      kind: "released",
      reason: "recipient_funded",
    });
    expect(chain.sent).toHaveLength(sentBefore);
    expect(await budget()).toEqual([
      { ceiling_wei: "80000", reserved_wei: "3000", confirmed_wei: "30000" },
    ]);
  });

  test("gas goes to the confirmed payout wallet even after a wallet change", async () => {
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(
        `UPDATE persona_wallet_assignments SET status='tombstoned', tombstoned_at=now()
          WHERE assignment_id='assignment-q1'`,
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments (
           assignment_id, persona_id, account_id, chain_account_kind, hd_wallet_index,
           address, status, reservation_idempotency_key, assigned_at, created_at, updated_at
         ) VALUES ('assignment-q1-new','q1','other','evm',99,$1,'active','assignment-q1-new',
                   now(),now(),now())`,
        [WALLETS.otherNew],
      );
    } finally {
      await admin.query("SET session_replication_role = origin");
    }
    const requested = await request("other", "q1", "k-q1");
    expect(requested).toMatchObject({ status: "pending", amountWei: 30_000n });
    const topupId = requested.topupId as string;
    expect(await topupRow(topupId)).toMatchObject({ recipient_address: WALLETS.other });
    expect((await Effect.runPromise(coordinator().send(topupId))).kind).toBe("submitted");
    expect(parseTransaction(chain.sent[chain.sent.length - 1] as Hex).to?.toLowerCase()).toBe(
      WALLETS.other,
    );
    // A top-up can never be written against the new wallet.
    await expect(
      admin.query(
        `INSERT INTO reward_gas_topups (
           topup_id, account_id, persona_id, credit_id, wallet_assignment_id,
           recipient_address, chain_id, balance_before_wei, target_balance_wei,
           amount_wei, budget_day, idempotency_key, status
         ) SELECT 'direct-new-wallet', account_id, persona_id, 'credit-p4',
                  'assignment-q1-new', $1, chain_id, 0, 50000, 1, budget_day,
                  'k-direct-new', 'requested'
             FROM reward_gas_topups WHERE topup_id=$2`,
        [WALLETS.otherNew, topupId],
      ),
    ).rejects.toThrow("must target the confirmed payout wallet");
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
        [CHAIN_ID, CUSTODY, WALLETS.w4],
      ),
    ).rejects.toThrow("must be signed by the active gas wallet");

    walletBalances.set(WALLETS.third, 45_000n);
    const open = await request("third", "r1", "k-r1b");
    expect(open).toMatchObject({ status: "pending", amountWei: 5_000n });
    const bind = (effectId: string) =>
      admin.query("UPDATE reward_gas_topups SET effect_id=$2 WHERE topup_id=$1", [
        open.topupId,
        effectId,
      ]);
    await admin.query(
      `INSERT INTO reward_chain_effects (
         effect_id, effect_kind, state, chain_id, signer_address, target_address, value_wei
       ) VALUES ('wrong-amount','gas_topup','planned',$1,$2,$3,4999),
                ('wrong-target','gas_topup','planned',$1,$2,$4,5000),
                ('retired-signer','gas_topup','planned',$1,$2,$3,5000)`,
      [CHAIN_ID, GAS_SIGNER, WALLETS.third, WALLETS.w4],
    );
    await expect(bind("wrong-amount")).rejects.toThrow("does not match the top-up");
    await expect(bind("wrong-target")).rejects.toThrow("does not match the top-up");
    // The amount may not grow, and may only shrink before sending.
    await expect(
      admin.query("UPDATE reward_gas_topups SET amount_wei=6000 WHERE topup_id=$1", [open.topupId]),
    ).rejects.toThrow("may only shrink");
    // Retiring the gas wallet blocks binding, and a retired signer still can
    // never become custody.
    await admin.query(
      "UPDATE reward_gas_topup_wallets SET status='retired', retired_at=clock_timestamp() WHERE signer_address=$1",
      [GAS_SIGNER],
    );
    await expect(bind("retired-signer")).rejects.toThrow("does not match the top-up");
    await expect(insertAttestation("attestation-retired-gas", GAS_SIGNER)).rejects.toThrow(
      "cannot be a reward gas top-up wallet",
    );
    await expect(
      admin.query("DELETE FROM reward_native_transfer_receipt_evidence"),
    ).rejects.toThrow("append-only");
  });
});
