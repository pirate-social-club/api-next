/**
 * A winner's onward send of claimed, paid USDC: one durable record per credit,
 * a server-fixed sender nonce per attempt, and a status derived only from
 * chain reads at finality and depth. Prerequisite rows (users, personas, wallets, the paid
 * and claimed credits and their confirmed payout records) are seeded with
 * triggers disabled; every send, attempt, transaction and outcome row is
 * written through the production repository, chain adapter and guards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  encodeRewardWinnerSendCalldata,
  makeRewardWinnerSendService,
  type RewardWinnerSendRecord,
  type RewardWinnerSendService,
  type RewardWinnerSendStore,
} from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import type { MegapotTransactionReceipt } from "./megapot-v2.ts";
import type { MegapotV2Transaction } from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardProjectionStore } from "./reward-projection-repository.ts";
import { makeRewardWinnerSendChain, type RewardWinnerSendRpc } from "./reward-winner-send-chain.ts";
import { makeControlPlaneRewardWinnerSendStore } from "./reward-winner-send-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

const CHAIN_ID = 84_532;
const CUSTODY = `0x${"cc".repeat(20)}`;
const USDC = `0x${"0a".repeat(20)}`;
const PAID = 1_000_000n;
const REQUIRED_CONFIRMATIONS = 3;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const address = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const topic = (account: string) => `0x${account.slice(2).padStart(64, "0")}` as `0x${string}`;

const WALLETS = {
  w1: address("a1"),
  w2: address("a2"),
  w3: address("a3"),
  w4: address("a4"),
  unclaimed: address("a5"),
  unpaid: address("a6"),
  unpaidOut: address("a7"),
  other: address("b1"),
  shared: address("a8"),
  dropped: address("a9"),
  late: address("aa"),
  raceAttach: address("ab"),
  raceSettle: address("ac"),
  cancelWins: address("ad"),
  transferWins: address("ae"),
  finality: address("af"),
  lateCancel: address("b2"),
  lateRevert: address("b3"),
  raceCancel: address("b4"),
  delayedCancelReceipt: address("b5"),
  delayedTransferReceipt: address("b6"),
} as const;
const RECIPIENT = address("d1");
const RECIPIENT_2 = address("d2");

type Fixture = Readonly<{
  account: string;
  persona: string;
  wallet: keyof typeof WALLETS;
  state: "sent" | "credited";
  claimed: boolean;
  paidOut: boolean;
  /** Credits paid to this persona's wallet; one named after the persona by default. */
  credits?: readonly string[];
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
  {
    account: "winner",
    persona: "p8",
    wallet: "shared",
    state: "sent",
    claimed: true,
    paidOut: true,
    credits: ["credit-p8a", "credit-p8b", "credit-p8c", "credit-p8d"],
  },
  {
    account: "winner",
    persona: "p9",
    wallet: "dropped",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p10",
    wallet: "late",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p11",
    wallet: "raceAttach",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p12",
    wallet: "raceSettle",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p13",
    wallet: "cancelWins",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p14",
    wallet: "transferWins",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p15",
    wallet: "finality",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p16",
    wallet: "lateCancel",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p17",
    wallet: "lateRevert",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p18",
    wallet: "raceCancel",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p19",
    wallet: "delayedCancelReceipt",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
  {
    account: "winner",
    persona: "p20",
    wallet: "delayedTransferReceipt",
    state: "sent",
    claimed: true,
    paidOut: true,
  },
];

async function seedPrerequisites(admin: Client) {
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("INSERT INTO users (user_id) VALUES ('winner'), ('other')");
    await admin.query(
      `INSERT INTO reward_asset_whitelist (
         chain_id, token_address, decimals, symbol, asset_kind, environment, status,
         policy_version, activated_at, plain_erc20_verified_at
       ) VALUES ($1,$2,6,'USDC','settlement_usdc','staging','active',
         'base-sepolia-usdc-v1',statement_timestamp(),statement_timestamp())`,
      [CHAIN_ID, USDC],
    );
    let payoutIndex = 0;
    for (const [index, row] of FIXTURES.entries()) {
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
      for (const credit of row.credits ?? [`credit-${row.persona}`]) {
        payoutIndex += 1;
        await admin.query(
          `INSERT INTO reward_ledger_credits (
           credit_id, account_id, payout_persona_id, chain_id, token_address, amount_atomic,
           source_kind, source_reference, state, paid_atomic, settled_at
         ) VALUES ($1,$2,$3,$4,$5,$7,'megapot_allocation',$1,$6,
                   CASE WHEN $6='sent' THEN $7::numeric ELSE 0 END,
                   CASE WHEN $6='sent' THEN clock_timestamp() END)`,
          [credit, row.account, row.persona, CHAIN_ID, USDC, row.state, PAID.toString()],
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
          const effectId = `payout-${credit}`;
          const transactionHash = blockHash(BigInt(10_000 + payoutIndex));
          await admin.query(
            `INSERT INTO reward_chain_effects (
             effect_id, effect_kind, state, version, chain_id, signer_address, target_address,
             settled_amount_atomic, nonce, calldata, calldata_hash, signed_transaction,
             signed_transaction_hash, transaction_hash, receipt_status, receipt_block_number,
             receipt_block_hash, receipt_hash, confirmations, prepared_at, broadcast_at,
             confirmed_at, created_at, updated_at
           ) VALUES ($1,'reward_payout','confirmed',5,$2,$3,$4,$9,$5,'0x00',$6,'0x01',
                     $7,$7,'success',10,$8,$6,3,now(),now(),now(),now(),now())`,
            [
              effectId,
              CHAIN_ID,
              CUSTODY,
              USDC,
              payoutIndex,
              "ab".repeat(32),
              transactionHash,
              blockHash(10n),
              PAID.toString(),
            ],
          );
          await admin.query(
            `INSERT INTO reward_payout_effects (
             payout_effect_id, attestation_id, credit_id, account_id, payout_persona_id,
             destination_address, amount_atomic, wallet_assignment_id,
             solvency_observation_id, custody_balance_before_atomic
           ) VALUES ($1,'attestation-1',$2,$3,$4,$5,$7,$6,'observation',$7)`,
            [
              effectId,
              credit,
              row.account,
              row.persona,
              WALLETS[row.wallet],
              assignment,
              PAID.toString(),
            ],
          );
          await admin.query(
            `INSERT INTO reward_erc20_transfer_receipt_evidence (
             effect_id, transfer_purpose, attestation_id, token_address, sender_address,
             recipient_address, amount_atomic, transaction_hash, transfer_log_index,
             custody_balance_after_atomic, block_number, block_hash, receipt_hash,
             confirmations, confirmed_at
           ) VALUES ($1,'reward_payout','attestation-1',$2,$3,$4,$8,$5,0,0,10,$6,$7,3,now())`,
            [
              effectId,
              USDC,
              CUSTODY,
              WALLETS[row.wallet],
              transactionHash,
              blockHash(10n),
              "ab".repeat(32),
              PAID.toString(),
            ],
          );
        }
      }
    }
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

/**
 * A deterministic chain behind the production adapter: nonces consumed per
 * block, transactions and receipts by hash, a movable head and blocks whose
 * hash can be replaced to simulate a reorg.
 */
function fakeChain() {
  let head = 100n;
  let finalized: bigint | null = null;
  const pending = new Map<string, bigint>();
  const consumed = new Map<string, bigint[]>();
  const transactions = new Map<string, MegapotV2Transaction>();
  const receipts = new Map<string, MegapotTransactionReceipt>();
  const replacedBlocks = new Map<bigint, string>();
  let nonceDelayMs = 0;
  const transactionCount = (account: string, block: bigint) =>
    BigInt((consumed.get(account) ?? []).filter((mined) => mined <= block).length);
  const consume = (account: string) => {
    const blocks = consumed.get(account) ?? [];
    head += 1n;
    blocks.push(head);
    consumed.set(account, blocks);
    return head;
  };
  const rpc: RewardWinnerSendRpc = {
    readPendingNonce: async (account) => {
      // Widens the window between a sender check and a nonce read.
      if (nonceDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, nonceDelayMs));
      return pending.get(account) ?? transactionCount(account, head);
    },
    readTransactionCount: async (account, blockNumber) =>
      transactionCount(account, blockNumber ?? head),
    readTransaction: async (transactionHash) => transactions.get(transactionHash) ?? null,
    readReceipt: async (transactionHash) => receipts.get(transactionHash) ?? null,
    readHead: async () => ({ blockNumber: head, blockHash: blockHash(head) }),
    readFinalizedHead: async () => ({
      blockNumber: finalized ?? head,
      blockHash: blockHash(finalized ?? head),
    }),
    readBlock: async (blockNumber) => ({
      blockNumber,
      blockHash: replacedBlocks.get(blockNumber) ?? blockHash(blockNumber),
    }),
  };
  return {
    rpc,
    setFinalizedHead: (blockNumber: bigint | null) => {
      finalized = blockNumber;
    },
    setPendingNonce: (account: string, nonce: bigint) => pending.set(account, nonce),
    clearPendingNonce: (account: string) => pending.delete(account),
    setNonceDelay: (milliseconds: number) => {
      nonceDelayMs = milliseconds;
    },
    /** The node forgets an unmined transaction. */
    drop: (transactionHash: string) => transactions.delete(transactionHash),
    /** Seeds the sender's history so the next mined nonce is `nonce`. */
    history: (account: string, nonce: number) =>
      consumed.set(
        account,
        Array.from({ length: nonce }, () => 1n),
      ),
    broadcast: (transaction: Partial<MegapotV2Transaction> & { transactionHash: string }) => {
      transactions.set(transaction.transactionHash, {
        chainId: CHAIN_ID,
        from: WALLETS.w1,
        to: USDC,
        nonce: 0n,
        valueWei: 0n,
        input: "0x",
        blockNumber: null,
        ...transaction,
      });
    },
    /** Mines a broadcast transaction in the next block. */
    mine: (transactionHash: string, status: "success" | "reverted") => {
      const transaction = transactions.get(transactionHash);
      if (transaction === undefined) throw new Error("unknown transaction");
      const blockNumber = consume(transaction.from);
      const transfer = transaction.input.startsWith("0xa9059cbb");
      const input = transaction.input.slice(10);
      const recipient = `0x${input.slice(24, 64)}`;
      const amount = transfer ? BigInt(`0x${input.slice(64, 128)}`) : 0n;
      receipts.set(transactionHash, {
        chainId: CHAIN_ID,
        status,
        transactionHash,
        from: transaction.from,
        to: transaction.to,
        blockHash: blockHash(blockNumber),
        blockNumber,
        logs:
          status === "reverted" || !transfer
            ? []
            : [
                {
                  address: USDC,
                  topics: [TRANSFER_TOPIC, topic(transaction.from), topic(recipient)],
                  data: `0x${amount.toString(16).padStart(64, "0")}`,
                  logIndex: 0,
                  transactionHash,
                  blockHash: blockHash(blockNumber),
                  blockNumber,
                },
              ],
      });
    },
    /** Consumes the sender's next nonce with a transaction nobody reported. */
    mineUnknown: (account: string) => consume(account),
    advance: (blocks: bigint) => {
      head += blocks;
    },
    replaceBlock: (blockNumber: bigint, replacement: string | null) => {
      if (replacement === null) replacedBlocks.delete(blockNumber);
      else replacedBlocks.set(blockNumber, replacement);
    },
    receipt: (transactionHash: string) => receipts.get(transactionHash),
    hideReceipt: (transactionHash: string) => receipts.delete(transactionHash),
    restoreReceipt: (transactionHash: string, value: MegapotTransactionReceipt) =>
      receipts.set(transactionHash, value),
  };
}

suite("Postgres 17 Megapot winner send record", () => {
  const schema = `reward_winner_send_${Date.now()}`;
  const scoped = connectionString
    ? `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`
    : "";
  const admin = new Client({ connectionString });
  const chain = fakeChain();
  let layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  let service: RewardWinnerSendService;
  let store: RewardWinnerSendStore;
  let sequence = 0;
  const serviceWith = (overrides: Partial<RewardWinnerSendStore>) =>
    makeRewardWinnerSendService({
      store: { ...store, ...overrides },
      chain: makeRewardWinnerSendChain(chain.rpc),
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      ids: { next: Effect.sync(() => `s${++sequence}`) },
    });

  const send = (
    persona: string,
    key: string,
    recipient = RECIPIENT,
    amount = 400_000n,
    accountId = "winner",
  ) =>
    Effect.runPromise(
      service.request({
        accountId,
        creditId: `credit-${persona}`,
        recipientAddress: recipient,
        amountAtomic: amount,
        idempotencyKey: key,
      }),
    );
  const refused = (
    persona: string,
    key: string,
    recipient = RECIPIENT,
    amount = 400_000n,
    accountId = "winner",
  ) =>
    Effect.runPromise(
      Effect.flip(
        service.request({
          accountId,
          creditId: `credit-${persona}`,
          recipientAddress: recipient,
          amountAtomic: amount,
          idempotencyKey: key,
        }),
      ),
    );
  const attach = (sendId: string, transactionHash: string, accountId = "winner") =>
    Effect.runPromise(service.attachTransaction({ accountId, sendId, transactionHash }));
  const attachRefused = (sendId: string, transactionHash: string) =>
    Effect.runPromise(
      Effect.flip(service.attachTransaction({ accountId: "winner", sendId, transactionHash })),
    );
  const cancel = (sendId: string, transactionHash: string, accountId = "winner") =>
    Effect.runPromise(service.cancel({ accountId, sendId, transactionHash }));
  const cancelRefused = (sendId: string, transactionHash: string, accountId = "winner") =>
    Effect.runPromise(Effect.flip(service.cancel({ accountId, sendId, transactionHash })));
  /** A zero-value, empty-calldata self-transaction at the record's nonce. */
  const selfCancel = (
    record: RewardWinnerSendRecord,
    transactionHash: string,
    overrides: Partial<MegapotV2Transaction> = {},
  ) =>
    chain.broadcast({
      transactionHash,
      from: record.senderAddress,
      to: record.senderAddress,
      nonce: record.nonce,
      input: "0x",
      ...overrides,
    });
  const get = (sendId: string, accountId = "winner") =>
    Effect.runPromise(service.get({ accountId, sendId }));
  const count = async (table: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  const signed = (
    record: RewardWinnerSendRecord,
    transactionHash: string,
    overrides: Partial<MegapotV2Transaction> = {},
  ) =>
    chain.broadcast({
      transactionHash,
      from: record.senderAddress,
      nonce: record.nonce,
      input: encodeRewardWinnerSendCalldata(
        record.recipientAddress,
        record.amountAtomic,
      ) as `0x${string}`,
      ...overrides,
    });

  beforeAll(async () => {
    if (!connectionString) return;
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyPostgresTestBaselineConnection({ connectionString: scoped });
    await seedPrerequisites(admin);
    layer = makeDirectPostgresControlPlaneLayer(scoped);
    store = makeControlPlaneRewardWinnerSendStore(layer);
    service = serviceWith({});
    chain.history(WALLETS.w1, 5);
    chain.history(WALLETS.w2, 9);
    chain.history(WALLETS.w3, 4);
    chain.history(WALLETS.shared, 3);
    chain.history(WALLETS.dropped, 2);
    chain.history(WALLETS.late, 7);
    chain.history(WALLETS.raceAttach, 1);
    chain.history(WALLETS.raceSettle, 1);
    chain.history(WALLETS.cancelWins, 0);
    chain.history(WALLETS.transferWins, 0);
  }, 120_000);

  afterAll(async () => {
    if (!connectionString) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("refuses foreign, unclaimed, unpaid and never-paid-out credits", async () => {
    expect(await refused("q1", "k-foreign")).toMatchObject({ reason: "not-found" });
    expect(await refused("missing", "k-missing")).toMatchObject({ reason: "not-found" });
    for (const persona of ["p5", "p6", "p7"]) {
      expect(await refused(persona, `k-${persona}`)).toMatchObject({
        reason: "credit-not-eligible",
      });
    }
    expect(await count("reward_winner_sends")).toBe(0);
  });

  test("validates the recipient and amount before recording anything", async () => {
    for (const recipient of [`0x${"00".repeat(20)}`, WALLETS.w1, USDC, "0x1234"]) {
      expect(await refused("p1", `k-r-${recipient}`, recipient)).toMatchObject({
        reason: "invalid-recipient",
      });
    }
    for (const amount of [0n, PAID + 1n]) {
      expect(await refused("p1", `k-a-${amount}`, RECIPIENT, amount)).toMatchObject({
        reason: "invalid-amount",
      });
    }
    expect(await count("reward_winner_sends")).toBe(0);
  });

  let first: RewardWinnerSendRecord;

  test("creates one record per credit with the sender's pending nonce and replays it", async () => {
    // A mixed-case recipient is normalized; the pending nonce is fixed.
    first = await send("p1", "k-1", RECIPIENT.toUpperCase().replace("0X", "0x"));
    expect(first).toMatchObject({
      creditId: "credit-p1",
      status: "retryable",
      chainId: CHAIN_ID,
      senderAddress: WALLETS.w1,
      recipientAddress: RECIPIENT,
      tokenAddress: USDC,
      amountAtomic: 400_000n,
      nonce: 5n,
      attempt: 1,
      transactionHashes: [],
    });
    expect(await send("p1", "k-1")).toEqual(first);
    // The same key with another body or credit is an idempotency conflict.
    expect(await refused("p1", "k-1", RECIPIENT_2)).toMatchObject({
      reason: "idempotency-conflict",
    });
    expect(await refused("p2", "k-1")).toMatchObject({ reason: "idempotency-conflict" });
    // Another key with the same body returns the record; another body is 409.
    expect(await send("p1", "k-1b")).toEqual(first);
    expect(await refused("p1", "k-1c", RECIPIENT, 1n)).toMatchObject({
      reason: "send-conflict",
    });
    // The sender's pending nonce moving on does not change the fixed nonce.
    chain.setPendingNonce(WALLETS.w1, 6n);
    expect((await send("p1", "k-1")).nonce).toBe(5n);
    expect(await count("reward_winner_sends")).toBe(1);
    expect(await count("reward_winner_send_attempts")).toBe(1);
    // The database refuses a second record for the credit outright.
    await expect(
      admin.query(
        `INSERT INTO reward_winner_sends (
           send_id, credit_id, account_id, persona_id, wallet_assignment_id, chain_id,
           token_address, sender_address, attempt, status
         ) VALUES ('dup','credit-p1','winner','p1','assignment-p1',$1,$2,$3,1,'retryable')`,
        [CHAIN_ID, USDC, WALLETS.w1],
      ),
    ).rejects.toThrow("duplicate key");
    // Foreign accounts cannot see it.
    expect(
      await Effect.runPromise(
        Effect.flip(service.get({ accountId: "other", sendId: first.sendId })),
      ),
    ).toMatchObject({ reason: "not-found" });
    const credits = await Effect.runPromise(
      makeControlPlaneRewardProjectionStore(layer).listCredits({
        accountId: "winner",
        cursor: null,
        limit: 25,
      }),
    );
    expect(credits.items.find((credit) => credit.creditId === "credit-p1")?.send).toEqual({
      sendId: first.sendId,
      status: "retryable",
    });
    expect(credits.items.find((credit) => credit.creditId === "credit-p2")?.send).toBeNull();
  });

  test("the guard fixes the sender to the confirmed payout wallet and the credit", async () => {
    const insert = (sender: string, credit = "credit-p4", persona = "p4", status = "retryable") =>
      admin.query(
        `INSERT INTO reward_winner_sends (
           send_id, credit_id, account_id, persona_id, wallet_assignment_id, chain_id,
           token_address, sender_address, attempt, status
         ) VALUES ('guard','${credit}','winner','${persona}','assignment-${persona}',$1,$2,$3,1,$4)`,
        [CHAIN_ID, USDC, sender, status],
      );
    await expect(insert(WALLETS.w1)).rejects.toThrow("confirmed payout wallet");
    await expect(insert(WALLETS.unclaimed, "credit-p5", "p5")).rejects.toThrow(
      "claimed and paid participant credit",
    );
    await expect(insert(WALLETS.w4, "credit-p4", "p4", "confirmed")).rejects.toThrow(
      "begin retryable",
    );
    // A record whose current attempt never appears fails at commit.
    await expect(insert(WALLETS.w4)).rejects.toThrow("no current attempt");
  });

  test("accepts only the exact transfer at the fixed nonce, then confirms at depth", async () => {
    expect(await get(first.sendId)).toMatchObject({ status: "retryable" });
    expect(await attachRefused(first.sendId, hash("e0"))).toMatchObject({
      reason: "transaction-not-found",
    });
    const wrong: Array<[string, Partial<MegapotV2Transaction>]> = [
      [hash("e2"), { nonce: 6n }],
      [
        hash("e3"),
        { input: encodeRewardWinnerSendCalldata(RECIPIENT_2, 400_000n) as `0x${string}` },
      ],
      [hash("e4"), { input: encodeRewardWinnerSendCalldata(RECIPIENT, 400_001n) as `0x${string}` }],
      [hash("e5"), { from: WALLETS.w2 }],
      [hash("e6"), { to: address("0b") }],
      [hash("e7"), { valueWei: 1n }],
      [hash("e8"), { chainId: 8_453 }],
    ];
    for (const [transactionHash, overrides] of wrong) {
      signed(first, transactionHash, overrides);
      expect(await attachRefused(first.sendId, transactionHash)).toMatchObject({
        reason: "transaction-mismatch",
      });
    }
    expect(await count("reward_winner_send_transactions")).toBe(0);

    signed(first, hash("f1"));
    const attached = await attach(first.sendId, hash("f1").toUpperCase().replace("0X", "0x"));
    expect(attached).toMatchObject({ status: "pending", transactionHashes: [hash("f1")] });
    // A fee bump re-signs the same nonce; both hashes are kept.
    signed(first, hash("f2"));
    expect(await attach(first.sendId, hash("f2"))).toMatchObject({
      status: "pending",
      transactionHashes: [hash("f1"), hash("f2")],
    });
    expect(await attach(first.sendId, hash("f2"))).toMatchObject({
      transactionHashes: [hash("f1"), hash("f2")],
    });

    chain.mine(hash("f2"), "success");
    expect(await get(first.sendId)).toMatchObject({ status: "pending" });
    chain.advance(2n);
    // A reorged receipt block is not evidence.
    const minedAt = chain.receipt(hash("f2"))?.blockNumber ?? 0n;
    chain.replaceBlock(minedAt, hash("9f"));
    expect(await get(first.sendId)).toMatchObject({ status: "pending" });
    chain.replaceBlock(minedAt, null);
    const confirmed = await get(first.sendId);
    expect(confirmed).toMatchObject({ status: "confirmed", nonce: 5n, attempt: 1 });
    const outcome = await admin.query(
      `SELECT outcome, transaction_hash, block_number::text FROM reward_winner_send_outcomes
        WHERE send_id=$1`,
      [first.sendId],
    );
    expect(outcome.rows).toEqual([
      { outcome: "confirmed", transaction_hash: hash("f2"), block_number: minedAt.toString() },
    ]);

    // Confirmed is terminal: the same body replays, nothing new is accepted.
    expect(await send("p1", "k-after")).toMatchObject({ status: "confirmed" });
    signed(first, hash("f3"));
    expect(await attachRefused(first.sendId, hash("f3"))).toMatchObject({
      reason: "send-conflict",
    });
    await expect(
      admin.query("UPDATE reward_winner_sends SET status='pending' WHERE send_id=$1", [
        first.sendId,
      ]),
    ).rejects.toThrow("terminal");
    expect(await count("reward_winner_sends")).toBe(1);
  });

  test("a revert at depth allows one new attempt with a fresh, higher nonce", async () => {
    const record = await send("p2", "k-2");
    expect(record).toMatchObject({ nonce: 9n, attempt: 1, status: "retryable" });
    signed(record, hash("a1"));
    await attach(record.sendId, hash("a1"));
    chain.mine(hash("a1"), "reverted");
    expect(await get(record.sendId)).toMatchObject({ status: "pending" });
    // No new attempt before the revert is final.
    expect(await refused("p2", "k-2-early", RECIPIENT_2)).toMatchObject({
      reason: "send-conflict",
    });
    chain.advance(2n);
    expect(await get(record.sendId)).toMatchObject({ status: "reverted" });
    // Replaying the first key never starts an attempt.
    expect(await send("p2", "k-2")).toMatchObject({ status: "reverted", attempt: 1 });
    // A stale pending nonce cannot open the next attempt.
    chain.setPendingNonce(WALLETS.w2, 9n);
    expect(await refused("p2", "k-2b", RECIPIENT_2, 250_000n)).toMatchObject({
      reason: "nonce-not-consumed",
    });
    chain.setPendingNonce(WALLETS.w2, 10n);
    const retry = await send("p2", "k-2b", RECIPIENT_2, 250_000n);
    expect(retry).toMatchObject({
      sendId: record.sendId,
      status: "retryable",
      attempt: 2,
      nonce: 10n,
      recipientAddress: RECIPIENT_2,
      amountAtomic: 250_000n,
      transactionHashes: [],
    });
    expect(await send("p2", "k-2b", RECIPIENT_2, 250_000n)).toEqual(retry);
    expect(await refused("p2", "k-2c")).toMatchObject({ reason: "send-conflict" });
    // The old nonce is no longer accepted.
    signed(record, hash("a2"));
    expect(await attachRefused(record.sendId, hash("a2"))).toMatchObject({
      reason: "transaction-mismatch",
    });
    signed(retry, hash("a3"));
    expect(await attach(record.sendId, hash("a3"))).toMatchObject({
      status: "pending",
      transactionHashes: [hash("a3")],
    });
    chain.mine(hash("a3"), "success");
    chain.advance(2n);
    expect(await get(record.sendId)).toMatchObject({ status: "confirmed", attempt: 2 });
    expect(await count("reward_winner_sends")).toBe(2);
    // The database refuses an attempt that skips the revert rule.
    await expect(
      admin.query(
        `INSERT INTO reward_winner_send_attempts (
           send_id, attempt, account_id, idempotency_key, recipient_address, amount_atomic, nonce
         ) VALUES ($1,3,'winner','k-raw',$2,1,11)`,
        [record.sendId, RECIPIENT],
      ),
    ).rejects.toThrow();
  });

  test("a nonce consumed at depth by an unreported transaction is terminal", async () => {
    const record = await send("p3", "k-3");
    expect(record).toMatchObject({ nonce: 4n, status: "retryable" });
    chain.mineUnknown(WALLETS.w3);
    expect(await get(record.sendId)).toMatchObject({ status: "pending" });
    chain.advance(2n);
    const settled = await get(record.sendId);
    expect(settled).toMatchObject({ status: "settled_unverified", transactionHashes: [] });
    expect(
      (
        await admin.query(
          "SELECT outcome, transaction_hash FROM reward_winner_send_outcomes WHERE send_id=$1",
          [record.sendId],
        )
      ).rows,
    ).toEqual([{ outcome: "settled_unverified", transaction_hash: null }]);
    // Never another send: no attempt, no new hash, no second record.
    chain.setPendingNonce(WALLETS.w3, 5n);
    expect(await send("p3", "k-3b")).toMatchObject({ status: "settled_unverified", attempt: 1 });
    expect(await refused("p3", "k-3c", RECIPIENT_2)).toMatchObject({ reason: "send-conflict" });
    signed(record, hash("b1"));
    expect(await attachRefused(record.sendId, hash("b1"))).toMatchObject({
      reason: "send-conflict",
    });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM reward_winner_sends WHERE credit_id='credit-p3'",
        )
      ).rows[0].n,
    ).toBe(1);
    const view = await Effect.runPromise(
      service.getByCredit({ accountId: "winner", creditId: "credit-p3" }),
    );
    expect(view.status).toBe("settled_unverified");
  });

  test("one open send per wallet: parallel sends for two credits yield one record and one 409", async () => {
    chain.setNonceDelay(50);
    const outcomes = await Promise.allSettled([
      send("p8a", "k-8a"),
      send("p8b", "k-8b", RECIPIENT_2, 300_000n),
    ]);
    chain.setNonceDelay(0);
    const created = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const refusals = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    expect(created).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ _tag: "RewardWinnerSendRejected", reason: "sender-busy" });
    const open = created[0] as RewardWinnerSendRecord;
    expect(open).toMatchObject({ senderAddress: WALLETS.shared, nonce: 3n, status: "retryable" });
    const otherPersona = open.creditId === "credit-p8a" ? "p8b" : "p8a";
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM reward_winner_sends WHERE sender_address=$1",
          [WALLETS.shared],
        )
      ).rows[0].n,
    ).toBe(1);
    // The database refuses a second open send from the wallet on its own.
    await expect(
      admin.query(
        `INSERT INTO reward_winner_sends (
           send_id, credit_id, account_id, persona_id, wallet_assignment_id, chain_id,
           token_address, sender_address, attempt, status
         ) VALUES ('second-open',$1,'winner','p8','assignment-p8',$2,$3,$4,1,'retryable')`,
        [`credit-${otherPersona}`, CHAIN_ID, USDC, WALLETS.shared],
      ),
    ).rejects.toThrow("duplicate key");
    // Still busy while the first send is pending.
    signed(open, hash("c1"));
    await attach(open.sendId, hash("c1"));
    expect(await refused(otherPersona, "k-8-busy", RECIPIENT_2, 300_000n)).toMatchObject({
      reason: "sender-busy",
    });
    // Once it settles, the other credit reserves the next nonce.
    chain.mine(hash("c1"), "success");
    chain.advance(2n);
    expect(await get(open.sendId)).toMatchObject({ status: "confirmed" });
    const next = await send(otherPersona, "k-8-next", RECIPIENT_2, 300_000n);
    expect(next).toMatchObject({ senderAddress: WALLETS.shared, nonce: 4n, status: "retryable" });
    // A stale nonce read never reuses a nonce the wallet already reserved.
    signed(next, hash("c2"));
    await attach(next.sendId, hash("c2"));
    chain.mine(hash("c2"), "success");
    chain.advance(2n);
    expect(await get(next.sendId)).toMatchObject({ status: "confirmed" });
    chain.setPendingNonce(WALLETS.shared, 4n);
    expect(await refused("p8c", "k-8c", RECIPIENT, 1n)).toMatchObject({
      reason: "nonce-not-consumed",
    });
    chain.setPendingNonce(WALLETS.shared, 5n);
    expect(await send("p8c", "k-8c", RECIPIENT, 1n)).toMatchObject({ nonce: 5n });
    await expect(
      admin.query(
        `INSERT INTO reward_winner_send_attempts (
           send_id, attempt, account_id, idempotency_key, recipient_address, amount_atomic, nonce
         ) VALUES ($1,2,'winner','k-raw-8',$2,1,4)`,
        [next.sendId, RECIPIENT],
      ),
    ).rejects.toThrow("exceed every nonce");
  });

  test("a dropped hash becomes retryable and a re-sign with the same nonce is accepted", async () => {
    const record = await send("p9", "k-9");
    expect(record).toMatchObject({ nonce: 2n, status: "retryable" });
    signed(record, hash("d5"));
    expect(await attach(record.sendId, hash("d5"))).toMatchObject({ status: "pending" });
    chain.drop(hash("d5"));
    expect(await get(record.sendId)).toMatchObject({
      status: "retryable",
      nonce: 2n,
      transactionHashes: [hash("d5")],
    });
    signed(record, hash("d6"));
    expect(await attach(record.sendId, hash("d6"))).toMatchObject({
      status: "pending",
      attempt: 1,
      nonce: 2n,
      transactionHashes: [hash("d5"), hash("d6")],
    });
    chain.mine(hash("d6"), "success");
    chain.advance(2n);
    expect(await get(record.sendId)).toMatchObject({ status: "confirmed", attempt: 1 });
  });

  test("a verified late hash moves settled_unverified to confirmed, and nothing moves back", async () => {
    const record = await send("p10", "k-10");
    signed(record, hash("e9"));
    chain.mine(hash("e9"), "success");
    chain.advance(2n);
    expect(await get(record.sendId)).toMatchObject({
      status: "settled_unverified",
      transactionHashes: [],
    });
    // A hash that does not verify is refused and changes nothing.
    signed(record, hash("ea"), { nonce: record.nonce + 1n });
    expect(await attachRefused(record.sendId, hash("ea"))).toMatchObject({
      reason: "transaction-mismatch",
    });
    const recovered = await attach(record.sendId, hash("e9"));
    expect(recovered).toMatchObject({ status: "confirmed", transactionHashes: [hash("e9")] });
    expect(
      (
        await admin.query(
          `SELECT outcome FROM reward_winner_send_outcomes WHERE send_id=$1
            ORDER BY created_at`,
          [record.sendId],
        )
      ).rows.map((row) => row.outcome),
    ).toEqual(["settled_unverified", "confirmed"]);
    for (const status of ["settled_unverified", "pending", "reverted"]) {
      await expect(
        admin.query("UPDATE reward_winner_sends SET status=$2 WHERE send_id=$1", [
          record.sendId,
          status,
        ]),
      ).rejects.toThrow("terminal");
    }
    // The database refuses a hash added to settled_unverified without the proof.
    const settled = await send("p3", "k-3");
    await expect(
      admin.query(
        `INSERT INTO reward_winner_send_transactions (transaction_hash, send_id, attempt, kind)
         VALUES ($1,$2,1,'transfer')`,
        [hash("eb"), settled.sendId],
      ),
    ).rejects.toThrow("must prove a final outcome");
  });

  test("a recent revert cannot open another nonce until its block is finalized", async () => {
    const opened = await send("p15", "k-15");
    signed(opened, hash("15"));
    await attach(opened.sendId, hash("15"));
    chain.setFinalizedHead((await chain.rpc.readHead()).blockNumber);
    chain.mine(hash("15"), "reverted");
    chain.advance(2n);
    expect(await get(opened.sendId)).toMatchObject({ status: "pending" });
    expect(await refused("p15", "k-15-more", RECIPIENT_2)).toMatchObject({
      reason: "send-conflict",
    });
    chain.setFinalizedHead((await chain.rpc.readHead()).blockNumber);
    expect(await get(opened.sendId)).toMatchObject({ status: "reverted" });
    const retry = await send("p15", "k-15-more", RECIPIENT_2);
    expect(retry).toMatchObject({ attempt: 2, nonce: opened.nonce + 1n });
    chain.setFinalizedHead(null);
  });

  test("a late verified cancellation resolves an unverified nonce and releases the credit", async () => {
    const opened = await send("p16", "k-16");
    selfCancel(opened, hash("16"));
    chain.mine(hash("16"), "success");
    chain.drop(hash("16"));
    expect(await cancelRefused(opened.sendId, hash("16"))).toMatchObject({
      reason: "transaction-not-found",
    });
    chain.advance(2n);
    expect(await get(opened.sendId)).toMatchObject({ status: "settled_unverified" });
    selfCancel(opened, hash("16"));
    expect(await cancel(opened.sendId, hash("16"))).toMatchObject({
      status: "cancelled",
      cancellationHashes: [hash("16")],
    });
    expect(await send("p16", "k-16-again")).toMatchObject({
      status: "retryable",
      nonce: opened.nonce + 1n,
    });
  });

  test("a late verified reverted transfer resolves an unverified nonce", async () => {
    const opened = await send("p17", "k-17");
    signed(opened, hash("17"));
    chain.mine(hash("17"), "reverted");
    chain.drop(hash("17"));
    chain.advance(2n);
    expect(await get(opened.sendId)).toMatchObject({ status: "settled_unverified" });
    signed(opened, hash("17"));
    expect(await attach(opened.sendId, hash("17"))).toMatchObject({
      status: "reverted",
      transactionHashes: [hash("17")],
    });
    expect(await send("p17", "k-17-again", RECIPIENT_2)).toMatchObject({
      attempt: 2,
      nonce: opened.nonce + 1n,
    });
  });

  test("a cancellation attached after a racing status write resolves under the row lock", async () => {
    const opened = await send("p18", "k-18");
    selfCancel(opened, hash("18"));
    chain.mine(hash("18"), "success");
    chain.advance(2n);
    const settleFirst = serviceWith({
      attachTransaction: (input) =>
        service.get({ accountId: input.accountId, sendId: input.sendId }).pipe(
          Effect.orDie,
          Effect.andThen(() => store.attachTransaction(input)),
        ),
    });
    expect(
      await Effect.runPromise(
        settleFirst.cancel({
          accountId: "winner",
          sendId: opened.sendId,
          transactionHash: hash("18"),
        }),
      ),
    ).toMatchObject({ status: "cancelled" });
  });

  test("an accepted cancel hash can resolve after its receipt appears late", async () => {
    const opened = await send("p19", "k-19");
    selfCancel(opened, hash("19"));
    await cancel(opened.sendId, hash("19"));
    chain.mine(hash("19"), "success");
    const mined = chain.receipt(hash("19"));
    if (mined === undefined) throw new Error("missing mined receipt");
    chain.hideReceipt(hash("19"));
    chain.advance(2n);
    expect(await get(opened.sendId)).toMatchObject({ status: "settled_unverified" });
    chain.restoreReceipt(hash("19"), mined);
    expect(await cancel(opened.sendId, hash("19"))).toMatchObject({ status: "cancelled" });
  });

  test("an accepted reverted transfer hash can resolve after its receipt appears late", async () => {
    const opened = await send("p20", "k-20");
    signed(opened, hash("20"));
    await attach(opened.sendId, hash("20"));
    chain.mine(hash("20"), "reverted");
    const mined = chain.receipt(hash("20"));
    if (mined === undefined) throw new Error("missing mined receipt");
    chain.hideReceipt(hash("20"));
    chain.advance(2n);
    expect(await get(opened.sendId)).toMatchObject({ status: "settled_unverified" });
    chain.restoreReceipt(hash("20"), mined);
    expect(await attach(opened.sendId, hash("20"))).toMatchObject({ status: "reverted" });
  });

  test("a status write racing an attach converges on confirmed in both orders", async () => {
    // Attach commits between the observation and the terminal write.
    const first = await send("p11", "k-11");
    signed(first, hash("71"));
    chain.mine(hash("71"), "success");
    chain.advance(2n);
    const attachFirst = serviceWith({
      recordOutcome: (input) =>
        store
          .attachTransaction({
            accountId: "winner",
            sendId: input.sendId,
            attempt: input.attempt,
            transactionHash: hash("71"),
            kind: "transfer",
          })
          .pipe(Effect.andThen(() => store.recordOutcome(input))),
    });
    expect(
      await Effect.runPromise(attachFirst.get({ accountId: "winner", sendId: first.sendId })),
    ).toMatchObject({ status: "confirmed", transactionHashes: [hash("71")] });
    expect(
      (
        await admin.query("SELECT outcome FROM reward_winner_send_outcomes WHERE send_id=$1", [
          first.sendId,
        ])
      ).rows,
    ).toEqual([{ outcome: "confirmed" }]);

    // The status write commits settled_unverified before the attach lands.
    const second = await send("p12", "k-12");
    signed(second, hash("72"));
    chain.mine(hash("72"), "success");
    chain.advance(2n);
    const settleFirst = serviceWith({
      attachTransaction: (input) =>
        service.get({ accountId: input.accountId, sendId: input.sendId }).pipe(
          Effect.orDie,
          Effect.andThen(() => store.attachTransaction(input)),
        ),
    });
    expect(
      await Effect.runPromise(
        settleFirst.attachTransaction({
          accountId: "winner",
          sendId: second.sendId,
          transactionHash: hash("72"),
        }),
      ),
    ).toMatchObject({ status: "confirmed", transactionHashes: [hash("72")] });
    expect(
      (
        await admin.query(
          `SELECT outcome FROM reward_winner_send_outcomes WHERE send_id=$1
            ORDER BY created_at`,
          [second.sendId],
        )
      ).rows.map((row) => row.outcome),
    ).toEqual(["settled_unverified", "confirmed"]);
  });

  test("a verified cancellation frees the wallet and lets the credit start again", async () => {
    chain.clearPendingNonce(WALLETS.shared);
    // credit-p8c is still open on the shared wallet and blocks it.
    const open = await Effect.runPromise(
      service.getByCredit({ accountId: "winner", creditId: "credit-p8c" }),
    );
    expect(open).toMatchObject({ status: "retryable", nonce: 5n });
    expect(await refused("p8d", "k-8d", RECIPIENT, 1n)).toMatchObject({ reason: "sender-busy" });
    // Foreign accounts cannot cancel it.
    selfCancel(open, hash("81"));
    expect(await cancelRefused(open.sendId, hash("81"), "other")).toMatchObject({
      reason: "not-found",
    });
    const reported = await cancel(open.sendId, hash("81"));
    expect(reported).toMatchObject({
      status: "pending",
      transactionHashes: [],
      cancellationHashes: [hash("81")],
    });
    // A cancellation hash is not a transfer hash.
    expect(await attachRefused(open.sendId, hash("81"))).toMatchObject({
      reason: "transaction-mismatch",
    });
    chain.mine(hash("81"), "success");
    expect(await get(open.sendId)).toMatchObject({ status: "pending" });
    chain.advance(2n);
    expect(await get(open.sendId)).toMatchObject({ status: "cancelled", nonce: 5n });
    expect(
      (
        await admin.query(
          "SELECT outcome, transaction_hash FROM reward_winner_send_outcomes WHERE send_id=$1",
          [open.sendId],
        )
      ).rows,
    ).toEqual([{ outcome: "cancelled", transaction_hash: hash("81") }]);
    await expect(
      admin.query("UPDATE reward_winner_sends SET status='retryable' WHERE send_id=$1", [
        open.sendId,
      ]),
    ).rejects.toThrow("terminal");
    // The wallet is free: another credit sends with the next nonce.
    const other = await send("p8d", "k-8d", RECIPIENT, 1n);
    expect(other).toMatchObject({ nonce: 6n, status: "retryable" });
    signed(other, hash("82"));
    await attach(other.sendId, hash("82"));
    chain.mine(hash("82"), "success");
    chain.advance(2n);
    expect(await get(other.sendId)).toMatchObject({ status: "confirmed" });
    // The cancelled credit starts a new record with a fresh nonce; the old
    // key still replays the cancelled one.
    expect(await send("p8c", "k-8c", RECIPIENT, 1n)).toMatchObject({
      sendId: open.sendId,
      status: "cancelled",
    });
    const again = await send("p8c", "k-8c-again", RECIPIENT, 1n);
    expect(again.sendId).not.toBe(open.sendId);
    expect(again).toMatchObject({ creditId: "credit-p8c", nonce: 7n, status: "retryable" });
    expect(
      await Effect.runPromise(service.getByCredit({ accountId: "winner", creditId: "credit-p8c" })),
    ).toMatchObject({ sendId: again.sendId });
    const credits = await Effect.runPromise(
      makeControlPlaneRewardProjectionStore(layer).listCredits({
        accountId: "winner",
        cursor: null,
        limit: 50,
      }),
    );
    expect(credits.items.find((credit) => credit.creditId === "credit-p8c")?.send).toEqual({
      sendId: again.sendId,
      status: "retryable",
    });
    // Only one non-cancelled record per credit.
    await expect(
      admin.query(
        `INSERT INTO reward_winner_sends (
           send_id, credit_id, account_id, persona_id, wallet_assignment_id, chain_id,
           token_address, sender_address, attempt, status
         ) VALUES ('third-live','credit-p8c','winner','p8','assignment-p8',$1,$2,$3,1,'retryable')`,
        [CHAIN_ID, USDC, WALLETS.shared],
      ),
    ).rejects.toThrow("duplicate key");
  });

  test("a cancellation of the wrong shape or of a settled send is refused", async () => {
    const record = await send("p13", "k-13");
    expect(record).toMatchObject({ nonce: 0n, status: "retryable" });
    const wrong: Array<[string, Partial<MegapotV2Transaction>]> = [
      [hash("91"), { to: RECIPIENT }],
      [hash("92"), { valueWei: 1n }],
      [hash("93"), { input: "0x00" }],
      [hash("94"), { nonce: 1n }],
      [hash("95"), { from: WALLETS.w1 }],
      [hash("96"), { chainId: 8_453 }],
    ];
    for (const [transactionHash, overrides] of wrong) {
      selfCancel(record, transactionHash, overrides);
      expect(await cancelRefused(record.sendId, transactionHash)).toMatchObject({
        reason: "transaction-mismatch",
      });
    }
    expect(await cancelRefused(record.sendId, hash("97"))).toMatchObject({
      reason: "transaction-not-found",
    });
    // A transfer hash is not a cancellation, and a confirmed send cannot be cancelled.
    selfCancel(first, hash("98"));
    expect(await cancelRefused(first.sendId, hash("98"))).toMatchObject({
      reason: "send-conflict",
    });
    expect(await cancelRefused(first.sendId, hash("f2"))).toMatchObject({
      reason: "transaction-mismatch",
    });
  });

  test("a cancellation racing a transfer: whichever is mined decides", async () => {
    // The cancellation is mined: the transfer can never land.
    const cancelWins = await Effect.runPromise(
      service.getByCredit({ accountId: "winner", creditId: "credit-p13" }),
    );
    signed(cancelWins, hash("a7"));
    await attach(cancelWins.sendId, hash("a7"));
    selfCancel(cancelWins, hash("a8"));
    expect(await cancel(cancelWins.sendId, hash("a8"))).toMatchObject({
      status: "pending",
      transactionHashes: [hash("a7")],
      cancellationHashes: [hash("a8")],
    });
    chain.mine(hash("a8"), "success");
    chain.advance(2n);
    expect(await get(cancelWins.sendId)).toMatchObject({ status: "cancelled" });
    expect(await attach(cancelWins.sendId, hash("a7"))).toMatchObject({ status: "cancelled" });
    signed(cancelWins, hash("a9"));
    expect(await attachRefused(cancelWins.sendId, hash("a9"))).toMatchObject({
      reason: "send-conflict",
    });

    // The transfer is mined: the cancellation can never land or be reported after.
    const transferWins = await send("p14", "k-14");
    signed(transferWins, hash("b7"));
    await attach(transferWins.sendId, hash("b7"));
    selfCancel(transferWins, hash("b8"));
    await cancel(transferWins.sendId, hash("b8"));
    chain.mine(hash("b7"), "success");
    chain.advance(2n);
    expect(await get(transferWins.sendId)).toMatchObject({
      status: "confirmed",
      transactionHashes: [hash("b7")],
      cancellationHashes: [hash("b8")],
    });
    selfCancel(transferWins, hash("b9"));
    expect(await cancelRefused(transferWins.sendId, hash("b9"))).toMatchObject({
      reason: "send-conflict",
    });
  });

  test("attempts, transactions and outcomes are append-only", async () => {
    await expect(admin.query("DELETE FROM reward_winner_send_transactions")).rejects.toThrow(
      "append-only",
    );
    await expect(
      admin.query("UPDATE reward_winner_send_attempts SET nonce=nonce+1"),
    ).rejects.toThrow("append-only");
    await expect(admin.query("DELETE FROM reward_winner_send_outcomes")).rejects.toThrow(
      "append-only",
    );
    await expect(admin.query("DELETE FROM reward_winner_sends")).rejects.toThrow("never deleted");
  });
});
