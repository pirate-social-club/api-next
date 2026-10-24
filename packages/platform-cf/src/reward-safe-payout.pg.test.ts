/**
 * PostgreSQL proof of owner-executed Safe payouts with a fake chain. The credit's
 * allocation lineage is seeded with triggers disabled; every payout step under test
 * runs with all triggers and constraints enforced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  parseAbi,
} from "viem";
import type { MegapotReceiptLog, MegapotTransactionReceipt } from "./megapot-v2.ts";
import type {
  MegapotV2RpcClient,
  MegapotV2SafeExecutionLog,
  MegapotV2Transaction,
} from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";
import { makeControlPlaneRewardSafeExecutionStore } from "./reward-safe-execution-repository.ts";
import { makeRewardSafePayoutCoordinator } from "./reward-safe-payout-coordinator.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = address("5");
const USDC = address("3");
const OWNER = address("9");
const WALLET_A = address("a");
const WALLET_B = address("b");
const WALLET_C = address("c");
const WALLET_D = address("d");
const WALLET_E = address("e");
const WALLET_F = address("f");
const WALLET_G = address("1");
const ATTESTATION = "megapot-base-safe-pilot";
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

/** A small in-memory Base: owner executions land in blocks the coordinator reads. */
function fakeChain() {
  let head = 1_000n;
  let safeNonce = 7n;
  const nonceAt = new Map<bigint, bigint>();
  const transactions = new Map<string, MegapotV2Transaction>();
  const receipts = new Map<string, MegapotTransactionReceipt>();
  const executions: MegapotV2SafeExecutionLog[] = [];
  // The canonical block at each height; an orphaned execution's receipt keeps its own.
  const canonical = new Map<bigint, string>();
  let blocksUnreadable = false;
  let sequence = 0;
  const rpc: MegapotV2RpcClient = {
    attestDeployment: async () => {
      throw new Error("unused");
    },
    readCurrentDrawing: async () => {
      throw new Error("unused");
    },
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawingId: async () => 1n,
    readDrawing: async () => {
      throw new Error("unused");
    },
    readDrawingTierPayouts: async () => [],
    readTicketTierIds: async () => [],
    readReferralFees: async () => 0n,
    readUsdcBalance: async () => 50_000_000n,
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 0n,
    readTicketOwner: async () => SAFE,
    readPendingNonce: async () => 0n,
    estimateGas: async () => 0n,
    readFeeQuote: async () => {
      throw new Error("unused");
    },
    sendRawTransaction: async () => {
      throw new Error("Pirate never broadcasts for the Safe");
    },
    readReceipt: async (transactionHash) => receipts.get(transactionHash) ?? null,
    readHead: async () => ({ blockNumber: head, blockHash: hash("1") }),
    readBlock: async (blockNumber) => {
      if (blocksUnreadable) throw new Error("block unavailable");
      return { blockNumber, blockHash: canonical.get(blockNumber) ?? hash("1") };
    },
    readTransaction: async (transactionHash) => transactions.get(transactionHash) ?? null,
    readSafeNonce: async (_safe, blockNumber) => {
      let nonce = 7n;
      for (const [block, value] of nonceAt) if (block <= blockNumber) nonce = value;
      return nonce;
    },
    readSafeExecutionLogs: async ({ fromBlock, toBlock }) =>
      executions.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
  };
  /** The owner executes one prepared call in Safe{Wallet}; it lands in the next block. */
  const execute = (
    call: { readonly to: string; readonly data: Hex },
    outcome: "success" | "failure",
    via: string = SAFE,
  ) => {
    sequence += 1;
    head += 1n;
    const block = head;
    const transactionHash = `0x${sequence.toString(16).padStart(64, "0")}`;
    const blockHash = hash(sequence % 2 === 0 ? "c" : "d");
    canonical.set(block, blockHash);
    const safeTxGas = 90_000n;
    const safeTransactionHash = rewardSafeTransactionHash({
      chainId: 8453,
      safeAddress: SAFE as Hex,
      nonce: safeNonce,
      to: call.to as Hex,
      data: call.data,
      operation: 0,
      safeTxGas,
    });
    safeNonce += 1n;
    nonceAt.set(block, safeNonce);
    const input = encodeFunctionData({
      abi,
      functionName: "execTransaction",
      args: [call.to as Hex, 0n, call.data, 0, safeTxGas, 0n, 0n, ZERO, ZERO, "0x"],
    });
    transactions.set(transactionHash, {
      transactionHash,
      chainId: 8453,
      from: OWNER,
      to: via,
      nonce: BigInt(sequence),
      valueWei: 0n,
      input,
      blockNumber: block,
    });
    const logs: MegapotReceiptLog[] = [];
    if (outcome === "success") {
      const [recipient, amount] = (() => {
        const body = call.data.slice(10);
        return [`0x${body.slice(24, 64)}`, BigInt(`0x${body.slice(64, 128)}`)] as const;
      })();
      logs.push({
        address: USDC,
        topics: encodeEventTopics({
          abi,
          eventName: "Transfer",
          args: { from: SAFE as Hex, to: recipient as Hex },
        }) as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }], [amount]),
        logIndex: 0,
        transactionHash,
        blockHash,
        blockNumber: block,
      });
    }
    logs.push({
      address: SAFE,
      topics: encodeEventTopics({
        abi,
        eventName: outcome === "success" ? "ExecutionSuccess" : "ExecutionFailure",
        args: { txHash: safeTransactionHash },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [0n]),
      logIndex: logs.length,
      transactionHash,
      blockHash,
      blockNumber: block,
    });
    receipts.set(transactionHash, {
      chainId: 8453,
      status: "success",
      transactionHash,
      from: OWNER,
      to: via,
      blockHash,
      blockNumber: block,
      logs,
    });
    executions.push({
      transactionHash,
      blockNumber: block,
      blockHash,
      logIndex: logs.length - 1,
      safeTransactionHash,
      outcome,
    });
    return transactionHash;
  };
  return {
    rpc,
    execute,
    head: () => head,
    mine: (blocks: bigint) => {
      head += blocks;
    },
    /** A reorganization replaces the block at this height; old receipts still name it. */
    orphan: (blockNumber: bigint) => {
      canonical.set(blockNumber, hash("e"));
    },
    blocksUnreadable: (value: boolean) => {
      blocksUnreadable = value;
    },
  };
}

suite("owner-executed Safe payouts", () => {
  const schema = `reward_safe_payout_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  const scoped = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}`,
  )}`;
  const chain = fakeChain();
  const coordinator = () =>
    makeRewardSafePayoutCoordinator({
      layer: makeDirectPostgresControlPlaneLayer(scoped),
      rpc: chain.rpc,
      requiredConfirmations: 3,
      runtimeEnvironment: "production",
      productionEnabled: true,
      maximumScanBlocks: 500,
      maximumScanLogs: 50,
    });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const credit = async (creditId: string) =>
    (
      await admin.query(
        "SELECT state, reserved_atomic::text, paid_atomic::text FROM reward_ledger_credits WHERE credit_id=$1",
        [creditId],
      )
    ).rows[0];

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(
      await Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text(),
    );
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query("SELECT set_reward_operations_paused_v1(0,FALSE,'safe_payout_test')");
    await admin.query(
      `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
         observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
         nonce_authority)
       VALUES (8453,$1,0,0,1,$2,clock_timestamp(),'safe_owner_v1')`,
      [SAFE, hash("1")],
    );
    // Lineage only: allocation, credit and claim rows a settled drawing would leave.
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
        address("2"),
        USDC,
        address("4"),
        SAFE,
        address("6"),
        hash("7"),
        hash("8"),
        hash("9"),
        hash("e"),
        hash("f"),
      ],
    );
    await admin.query(
      `INSERT INTO song_reward_offer_legs (leg_id, offer_id, kind, status, funder_account_id,
         refund_policy, leg_terms_hash, participation_starts_at, chain_id, token_address,
         token_decimals, tickets_per_drawing, max_ticket_price_atomic, entry_cutoff_seconds,
         beneficiary_algorithm_version, ticket_selection_version, attestation_id,
         participation_starts_drawing_id, eligible_activities, min_score_bps,
         empty_pool_policy, funding_source, funded_atomic)
       VALUES ('leg-safe','offer-safe','megapot_pool','active','account-owner',
         'refund_to_funders_pro_rata',$1,clock_timestamp()-interval '1 day',8453,$2,6,1,
         1000000,300,'equal_v1','keccak_packed_v1',$3,1,ARRAY['study','karaoke'],7000,
         'no_purchase','leg_budget',10000000)`,
      [hash("a"), USDC, ATTESTATION],
    );
    await admin.query(
      `INSERT INTO megapot_allocation_batches (allocation_batch_id, pool_leg_id, drawing_id,
         snapshot_id, claim_effect_id, algorithm_version, net_winnings_atomic,
         allocation_count, allocation_hash, state, credited_at)
       VALUES ('batch-safe','leg-safe',212,'snapshot-safe','claim-safe','equal_v1',3330000,2,
         $1,'credited',clock_timestamp())`,
      [hash("b").slice(2)],
    );
    for (const [ordinal, account, persona, wallet, amount] of [
      [0, "account-a", "persona-a", WALLET_A, 1_110_000],
      [1, "account-b", "persona-b", WALLET_B, 2_220_000],
      [2, "account-c", "persona-c", WALLET_C, 1_000_000],
      [3, "account-d", "persona-d", WALLET_D, 1_000_000],
      [4, "account-e", "persona-e", WALLET_E, 1_000_000],
      [5, "account-f", "persona-f", WALLET_F, 1_000_000],
      [6, "account-g", "persona-g", WALLET_G, 1_000_000],
    ] as const) {
      const creditId = `credit-${account}`;
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [account]);
      await admin.query("INSERT INTO personas (persona_id, account_id) VALUES ($1,$2)", [
        persona,
        account,
      ]);
      await admin.query(
        `INSERT INTO megapot_allocations (allocation_batch_id, ordinal, account_id, persona_id,
           amount_atomic, allocation_kind, credit_id)
         VALUES ('batch-safe',$1,$2,$3,$4,'participant',$5)`,
        [ordinal, account, persona, amount, creditId],
      );
      await admin.query(
        `INSERT INTO reward_ledger_credits (credit_id, account_id, payout_persona_id, chain_id,
           token_address, amount_atomic, source_kind, source_reference, state)
         VALUES ($1,$2,$3,8453,$4,$5,'megapot_allocation','batch-safe','credited')`,
        [creditId, account, persona, USDC, amount],
      );
      await admin.query(
        `INSERT INTO megapot_participant_claims (credit_id, account_id, pool_leg_id, drawing_id,
           status, subject_key_id, evidence_receipt_id, accepted_at)
         VALUES ($1,$2,'leg-safe',212,'accepted',$3,$4,clock_timestamp())`,
        [creditId, account, `subject-${account}`, `receipt-${account}`],
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments (assignment_id, persona_id, account_id,
           chain_account_kind, status, reservation_idempotency_key, address, assigned_at,
           hd_wallet_index, created_at, updated_at)
         VALUES ($1,$2,$3,'evm','active',$4,$5,now(),$6,now(),now())`,
        [`wallet-${account}`, persona, account, `reserve-${account}`, wallet, ordinal],
      );
    }
    await admin.query(
      `INSERT INTO custody_solvency_observations (observation_id, attestation_id, chain_id,
         custody_address, token_address, balance_atomic, reserved_purchase_atomic,
         outstanding_credit_atomic, pending_refund_atomic, shared_sponsorship_atomic,
         block_number, block_hash, observed_at, expires_at)
       VALUES ('solvency-safe',$1,8453,$2,$3,50000000,0,3330000,0,0,999,$4,
         clock_timestamp(),clock_timestamp()+interval '1 day')`,
      [ATTESTATION, SAFE, USDC, hash("2")],
    );
    await admin.query("SET session_replication_role = origin");
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("prepares, binds and confirms one owner-executed payout exactly once", async () => {
    const payouts = coordinator();
    const prepared = await run(payouts.prepare("credit-account-a"));
    // The first eligible block is the one after the mined head at preparation.
    expect(prepared.preparedBlockNumber).toBe(1_001n);
    const file = prepared.transactionBuilderFile;
    expect(file).toMatchObject({
      chainId: "8453",
      meta: { createdFromSafeAddress: expect.any(String) },
    });
    expect(file.transactions).toHaveLength(1);
    expect(await credit("credit-account-a")).toEqual({
      state: "payout_pending",
      reserved_atomic: "1110000",
      paid_atomic: "0",
    });
    await expect(run(payouts.prepare("credit-account-a"))).rejects.toMatchObject({
      reason: "credit-not-payable",
    });
    const call = {
      to: file.transactions[0]?.to ?? "",
      data: file.transactions[0]?.data ?? "0x",
    } as const;
    const transactionHash = chain.execute(call, "success");
    expect(await run(payouts.settle(prepared.effectId))).toEqual({ kind: "not_bound" });
    expect(await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }))).toEqual({
      scanned: false,
    });
    chain.mine(2n);
    const scanned = await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(scanned).toMatchObject({
      scanned: true,
      findings: [{ kind: "matched", safeNonce: 7n }],
    });
    const bound = (
      await admin.query(
        `SELECT state, transaction_hash, safe_nonce::text, safe_execution_outcome, nonce,
                signed_transaction FROM reward_chain_effects WHERE effect_id=$1`,
        [prepared.effectId],
      )
    ).rows[0];
    expect(bound).toEqual({
      state: "confirming",
      transaction_hash: transactionHash,
      safe_nonce: "7",
      safe_execution_outcome: "success",
      nonce: null,
      signed_transaction: null,
    });
    expect(await run(payouts.settle(prepared.effectId))).toEqual({
      kind: "confirmed",
      transactionHash,
    });
    expect(await credit("credit-account-a")).toEqual({
      state: "sent",
      reserved_atomic: "0",
      paid_atomic: "1110000",
    });
    expect(
      (
        await admin.query(
          `SELECT recipient_address, amount_atomic::text FROM reward_erc20_transfer_receipt_evidence
            WHERE effect_id=$1`,
          [prepared.effectId],
        )
      ).rows,
    ).toEqual([{ recipient_address: WALLET_A, amount_atomic: "1110000" }]);
    // Once confirmed, the payout is no longer awaiting settlement.
    expect(await run(payouts.settle(prepared.effectId))).toEqual({ kind: "not_bound" });
  });

  test("a Safe ExecutionFailure releases the credit for a new call", async () => {
    const payouts = coordinator();
    const first = await run(payouts.prepare("credit-account-b"));
    const transaction = first.transactionBuilderFile.transactions[0];
    if (transaction === undefined) throw new Error("missing call");
    chain.execute(transaction, "failure");
    chain.mine(2n);
    await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(await run(payouts.settle(first.effectId))).toEqual({ kind: "released" });
    expect(await credit("credit-account-b")).toEqual({
      state: "credited",
      reserved_atomic: "0",
      paid_atomic: "0",
    });
    const effect = (
      await admin.query(
        `SELECT state, receipt_status, safe_execution_outcome, settled_amount_atomic
           FROM reward_chain_effects WHERE effect_id=$1`,
        [first.effectId],
      )
    ).rows[0];
    expect(effect).toEqual({
      state: "reverted",
      receipt_status: "success",
      safe_execution_outcome: "failure",
      settled_amount_atomic: null,
    });
    const retry = await run(payouts.prepare("credit-account-b"));
    expect(retry.effectId).not.toBe(first.effectId);
    const retried = retry.transactionBuilderFile.transactions[0];
    if (retried === undefined) throw new Error("missing call");
    chain.execute(retried, "success");
    chain.mine(2n);
    await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(await run(payouts.settle(retry.effectId))).toMatchObject({ kind: "confirmed" });
    expect(await credit("credit-account-b")).toMatchObject({
      state: "sent",
      paid_atomic: "2220000",
    });
  });

  for (const [outcome, creditId] of [
    ["success", "credit-account-e"],
    ["failure", "credit-account-f"],
  ] as const) {
    test(`an orphaned ${outcome} receipt is held and the credit stays owed`, async () => {
      const payouts = coordinator();
      const prepared = await run(payouts.prepare(creditId));
      const transaction = prepared.transactionBuilderFile.transactions[0];
      if (transaction === undefined) throw new Error("missing call");
      chain.execute(transaction, outcome);
      const block = chain.head();
      chain.mine(2n);
      await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
      chain.orphan(block);
      expect(await run(payouts.settle(prepared.effectId))).toEqual({
        kind: "reconciliation_required",
      });
      expect(
        (
          await admin.query(
            `SELECT state, failure_reason, receipt_block_hash, settled_amount_atomic
               FROM reward_chain_effects WHERE effect_id=$1`,
            [prepared.effectId],
          )
        ).rows,
      ).toEqual([
        {
          state: "reconciliation_required",
          failure_reason: "safe_execution_receipt_not_canonical",
          receipt_block_hash: null,
          settled_amount_atomic: null,
        },
      ]);
      // Neither paid nor released: the credit keeps its reservation under reconciliation
      // and no second call is prepared.
      expect(await credit(creditId)).toEqual({
        state: "reconciliation_required",
        reserved_atomic: "1000000",
        paid_atomic: "0",
      });
      await expect(run(payouts.prepare(creditId))).rejects.toMatchObject({
        reason: "credit-not-payable",
      });
      expect(await run(payouts.settle(prepared.effectId))).toEqual({ kind: "not_bound" });
    });
  }

  test("an unreadable canonical block settles, releases and retries nothing", async () => {
    const payouts = coordinator();
    const prepared = await run(payouts.prepare("credit-account-g"));
    const transaction = prepared.transactionBuilderFile.transactions[0];
    if (transaction === undefined) throw new Error("missing call");
    chain.execute(transaction, "failure");
    chain.mine(2n);
    await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    chain.blocksUnreadable(true);
    try {
      await expect(run(payouts.settle(prepared.effectId))).rejects.toMatchObject({
        reason: "rpc_unavailable",
      });
      expect(
        (
          await admin.query("SELECT state FROM reward_chain_effects WHERE effect_id=$1", [
            prepared.effectId,
          ])
        ).rows,
      ).toEqual([{ state: "confirming" }]);
      expect(await credit("credit-account-g")).toMatchObject({
        state: "payout_pending",
        reserved_atomic: "1000000",
      });
      await expect(run(payouts.prepare("credit-account-g"))).rejects.toMatchObject({
        reason: "credit-not-payable",
      });
    } finally {
      chain.blocksUnreadable(false);
    }
    // Once the chain answers, the bound failure releases the credit as usual.
    expect(await run(payouts.settle(prepared.effectId))).toEqual({ kind: "released" });
  });

  test("an identical transfer mined in the preparation head never binds; the next block does", async () => {
    const payouts = coordinator();
    // An unrelated owner transfer with this payout's exact target and calldata, already
    // mined in the head the payout is prepared at.
    const identical = {
      to: USDC,
      data: encodeFunctionData({
        abi,
        functionName: "transfer",
        args: [WALLET_C as Hex, 1_000_000n],
      }),
    } as const;
    const earlier = chain.execute(identical, "success");
    const preparationHead = chain.head();
    const prepared = await run(payouts.prepare("credit-account-c"));
    expect(prepared.preparedBlockNumber).toBe(preparationHead + 1n);
    expect(prepared.transactionBuilderFile.transactions).toEqual([
      expect.objectContaining({ to: identical.to, data: identical.data }),
    ]);
    chain.mine(2n);
    const missed = await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(missed).toMatchObject({ scanned: true, findings: [] });
    expect(await run(payouts.settle(prepared.effectId))).toEqual({ kind: "not_bound" });
    expect(await credit("credit-account-c")).toMatchObject({ state: "payout_pending" });

    const authorized = chain.execute(identical, "success");
    expect(authorized).not.toBe(earlier);
    chain.mine(2n);
    await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(await run(payouts.settle(prepared.effectId))).toEqual({
      kind: "confirmed",
      transactionHash: authorized,
    });
    expect(await credit("credit-account-c")).toMatchObject({
      state: "sent",
      paid_atomic: "1000000",
    });
  });

  test("a scan whose snapshot missed a newly prepared call is refused", async () => {
    const store = makeControlPlaneRewardSafeExecutionStore();
    const layer = makeDirectPostgresControlPlaneLayer(scoped);
    const state = await run(
      Effect.provide(layer)(store.loadScanState({ chainId: 8453, safeAddress: SAFE })),
    );
    if (state === null) throw new Error("cursor missing");
    await admin.query(
      `INSERT INTO reward_chain_effects (effect_id,effect_kind,state,chain_id,signer_address,
         target_address,reserved_amount_atomic,execution_mode)
       VALUES ('late-call','reward_payout','planned',8453,$1,$2,1,'safe_owner_v1')`,
      [SAFE, USDC],
    );
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO reward_chain_effect_transitions (effect_id,target_version,event_type,event)
       VALUES ('late-call',2,'safe_call_prepared','{}'::jsonb)`,
    );
    await admin.query(
      `UPDATE reward_chain_effects SET state='prepared', version=2, calldata=$1, calldata_hash=$2,
              prepared_at=clock_timestamp(), safe_prepared_block_number=$3,
              updated_at=clock_timestamp()
        WHERE effect_id='late-call'`,
      [`0xa9059cbb${"77".repeat(64)}`, "7".repeat(64), state.nextBlockNumber.toString()],
    );
    await admin.query("COMMIT");
    await expect(
      run(
        Effect.provide(layer)(
          store.recordScan({
            chainId: 8453,
            safeAddress: SAFE,
            fromBlock: state.nextBlockNumber,
            throughBlock: state.nextBlockNumber,
            scannedEffectIds: state.calls.map((call) => call.effectId),
            findings: [],
          }),
        ),
      ),
    ).rejects.toMatchObject({ reason: "scan-conflict" });
  });

  test("an execution routed through another contract is kept for review", async () => {
    const payouts = coordinator();
    chain.execute({ to: USDC, data: `0xa9059cbb${"88".repeat(64)}` as Hex }, "success", OWNER);
    chain.mine(3n);
    const scanned = await run(payouts.scan({ chainId: 8453, safeAddress: SAFE }));
    expect(scanned).toMatchObject({ scanned: true });
    expect(
      (await admin.query("SELECT reason, outcome FROM reward_safe_unbound_executions")).rows,
    ).toEqual([{ reason: "undecodable", outcome: "success" }]);
  });

  test("a cursor already beyond the block after the head is the first eligible block", async () => {
    const payouts = coordinator();
    const ahead = chain.head() + 25n;
    await admin.query(
      `UPDATE reward_safe_execution_cursors SET next_block_number=$1, updated_at=clock_timestamp()
        WHERE chain_id=8453 AND safe_address=$2`,
      [ahead.toString(), SAFE],
    );
    const prepared = await run(payouts.prepare("credit-account-d"));
    expect(prepared.preparedBlockNumber).toBe(ahead);
  });
});
