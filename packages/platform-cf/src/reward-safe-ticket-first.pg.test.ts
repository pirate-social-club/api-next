/**
 * PostgreSQL proof of ticket-first Safe purchases and freezes with a fake chain. Leg,
 * offer, observation and share rows are seeded with triggers disabled; every purchase,
 * reconciliation and cutoff step under test runs with all triggers enforced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  parseAbi,
} from "viem";
import { makeMegapotTicketFirstCutoff } from "./megapot-ticket-first-cutoff.ts";
import type { MegapotReceiptLog, MegapotTransactionReceipt } from "./megapot-v2.ts";
import type {
  MegapotV2RpcClient,
  MegapotV2SafeExecutionLog,
  MegapotV2Transaction,
} from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";
import { makeRewardSafePurchaseCoordinator } from "./reward-safe-purchase-coordinator.ts";
import { makeRewardSafeExecutionScanner } from "./reward-safe-settlement.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
}
const suite = url ? describe : describe.skip;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const SAFE = address("5");
const JACKPOT = address("2");
const NFT = address("4");
const USDC = address("3");
const OWNER = address("9");
const ATTESTATION = "megapot-base-safe-pilot";
const SOURCE = hash("8");
const PRICE = 1_000_000n;
const abi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
  "function buyTickets((uint8[] normals,uint8 bonusball)[] tickets,address recipient,address[] referrers,uint256[] referralSplit,bytes32 source)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
  "event TicketPurchased(address indexed recipient, uint256 indexed currentDrawingId, bytes32 indexed source, uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme)",
  "event TicketOrderProcessed(address indexed buyer, address indexed recipient, uint256 indexed currentDrawingId, uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
// encodeEventTopics allows null or OR-ed entries for filters; these events set every
// indexed argument, so each topic is one value.
const topics = (value: readonly (Hex | Hex[] | null)[]) => value as [Hex, ...Hex[]];

function fakeChain() {
  let head = 1_000n;
  let safeNonce = 3n;
  let ticketId = 500n;
  let sequence = 0;
  const nonceAt = new Map<bigint, bigint>();
  const transactions = new Map<string, MegapotV2Transaction>();
  const receipts = new Map<string, MegapotTransactionReceipt>();
  const executions: MegapotV2SafeExecutionLog[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const rpc: MegapotV2RpcClient = {
    attestDeployment: unused,
    readCurrentDrawing: unused,
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawingId: async () => 212n,
    readDrawing: unused,
    readDrawingTierPayouts: async () => [],
    readTicketTierIds: async () => [],
    readReferralFees: async () => 0n,
    readUsdcBalance: async () => 50_000_000n,
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 50_000_000n,
    readTicketOwner: async () => SAFE,
    readPendingNonce: async () => 0n,
    estimateGas: async () => 0n,
    readFeeQuote: unused,
    sendRawTransaction: async () => {
      throw new Error("Pirate never broadcasts for the Safe");
    },
    readReceipt: async (transactionHash) => receipts.get(transactionHash) ?? null,
    readHead: async () => ({ blockNumber: head, blockHash: hash("1") }),
    readBlock: async (blockNumber) => ({ blockNumber, blockHash: hash("1") }),
    readTransaction: async (transactionHash) => transactions.get(transactionHash) ?? null,
    readSafeNonce: async (_safe, blockNumber) => {
      let nonce = 3n;
      for (const [block, value] of nonceAt) if (block <= blockNumber) nonce = value;
      return nonce;
    },
    readSafeExecutionLogs: async ({ fromBlock, toBlock }) =>
      executions.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
  };
  /** The owner executes a prepared purchase; the ticket lands in `landedDrawingId`. */
  const execute = (
    call: { readonly to: string; readonly data: Hex },
    outcome: "success" | "failure",
    landedDrawingId = 212n,
  ) => {
    sequence += 1;
    head += 1n;
    const block = head;
    const transactionHash = `0x${sequence.toString(16).padStart(64, "0")}`;
    const blockHash = hash(sequence % 2 === 0 ? "c" : "d");
    const safeTxGas = 120_000n;
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
    transactions.set(transactionHash, {
      transactionHash,
      chainId: 8453,
      from: OWNER,
      to: SAFE,
      nonce: BigInt(sequence),
      valueWei: 0n,
      input: encodeFunctionData({
        abi,
        functionName: "execTransaction",
        args: [call.to as Hex, 0n, call.data, 0, safeTxGas, 0n, 0n, ZERO, ZERO, "0x"],
      }),
      blockNumber: block,
    });
    const base = { transactionHash, blockHash, blockNumber: block };
    const logs: MegapotReceiptLog[] = [];
    if (outcome === "success") {
      const decoded = decodeFunctionData({ abi, data: call.data });
      if (decoded.functionName !== "buyTickets") throw new Error("not a purchase");
      const ticket = decoded.args[0][0];
      if (ticket === undefined) throw new Error("no ticket");
      ticketId += 1n;
      logs.push(
        {
          ...base,
          address: JACKPOT,
          logIndex: 0,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketPurchased",
              args: {
                recipient: SAFE as Hex,
                currentDrawingId: landedDrawingId,
                source: SOURCE as Hex,
              },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint8[]" }, { type: "uint8" }, { type: "bytes32" }],
            [ticketId, [...ticket.normals], ticket.bonusball, hash("0") as Hex],
          ),
        },
        {
          ...base,
          address: NFT,
          logIndex: 1,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: ZERO, to: SAFE as Hex, tokenId: ticketId },
            }),
          ),
          data: "0x",
        },
        {
          ...base,
          address: JACKPOT,
          logIndex: 2,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketOrderProcessed",
              args: {
                buyer: SAFE as Hex,
                recipient: SAFE as Hex,
                currentDrawingId: landedDrawingId,
              },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
            [1n, 0n, 0n],
          ),
        },
      );
    }
    logs.push({
      ...base,
      address: SAFE,
      logIndex: logs.length,
      topics: topics(
        encodeEventTopics({
          abi,
          eventName: outcome === "success" ? "ExecutionSuccess" : "ExecutionFailure",
          args: { txHash: safeTransactionHash },
        }),
      ),
      data: encodeAbiParameters([{ type: "uint256" }], [0n]),
    });
    receipts.set(transactionHash, {
      chainId: 8453,
      status: "success",
      transactionHash,
      from: OWNER,
      to: SAFE,
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
    return ticketId;
  };
  return {
    rpc,
    execute,
    mine: (blocks: bigint) => {
      head += blocks;
    },
  };
}

suite("ticket-first owner-executed Safe pools", () => {
  const schema = `reward_safe_ticket_first_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: url });
  const scoped = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(
    `-c search_path=${schema}`,
  )}`;
  const chain = fakeChain();
  const options = (minimumEntrySeconds = 600) => ({
    layer: makeDirectPostgresControlPlaneLayer(scoped),
    rpc: chain.rpc,
    requiredConfirmations: 3,
    productionEnabled: true,
    maximumScanBlocks: 500,
    maximumScanLogs: 50,
    minimumEntrySeconds,
  });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const scan = () =>
    run(makeRewardSafeExecutionScanner(options())({ chainId: 8453, safeAddress: SAFE }));
  const drawing = async (legId: string) =>
    (
      await admin.query(
        `SELECT status, terminal_reason, reserved_ticket_cost_atomic::text AS reserved,
                actual_ticket_cost_atomic::text AS actual, frozen_share_count, snapshot_id
           FROM megapot_pool_drawings WHERE pool_leg_id=$1 AND drawing_id=212`,
        [legId],
      )
    ).rows[0];
  const leg = async (legId: string) =>
    (
      await admin.query(
        `SELECT reserved_atomic::text AS reserved, spent_atomic::text AS spent
           FROM song_reward_offer_legs WHERE leg_id=$1`,
        [legId],
      )
    ).rows[0];
  const callOf = (file: { readonly transactions: readonly { to: string; data: Hex }[] }) => {
    const call = file.transactions[0];
    if (call === undefined) throw new Error("missing call");
    return call;
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(
      await Bun.file(new URL("../../../db/postgres/schema.sql", import.meta.url)).text(),
    );
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query("SELECT set_reward_operations_paused_v1(0,FALSE,'ticket_first_test')");
    await admin.query(
      `INSERT INTO reward_signer_nonces (chain_id,signer_address,next_nonce,
         observed_pending_nonce,observed_block_number,observed_block_hash,observed_at,
         nonce_authority)
       VALUES (8453,$1,0,0,1,$2,clock_timestamp(),'safe_owner_v1')`,
      [SAFE, hash("1")],
    );
    await admin.query("SET session_replication_role = replica");
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
        address("6"),
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
    for (const legId of ["tf-ok", "tf-fail", "tf-late", "tf-wrong", "tf-empty"]) {
      await admin.query(
        `INSERT INTO song_reward_offers (offer_id, community_id, post_id, audio_revision,
         created_by_account_id, status, starts_at, ends_at, owner_policy_snapshot, terms_hash,
         reward_policy_version_id, activated_at)
       VALUES ($2,'community-tf',$3,1,'account-owner','active',
         clock_timestamp()-interval '1 day', clock_timestamp()+interval '30 days','{}'::jsonb,
         $1,'policy-tf',clock_timestamp())`,
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
           'no_purchase','leg_budget',10000000,'ticket_first_v1','production_approved',
           clock_timestamp())`,
        [legId, hash("3"), USDC, PRICE.toString(), ATTESTATION, `offer-${legId}`],
      );
    }
    await admin.query("SET session_replication_role = origin");
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  test("a confirmed ticket opens entries and a freeze snapshots its qualifiers", async () => {
    const purchases = makeRewardSafePurchaseCoordinator(options());
    const prepared = await run(purchases.prepare("tf-ok"));
    if (prepared.kind !== "prepared") throw new Error(`not prepared: ${prepared.kind}`);
    expect(prepared.drawingId).toBe(212n);
    expect(await drawing("tf-ok")).toMatchObject({
      status: "ticket_pending",
      reserved: "1000000",
      actual: "0",
    });
    expect(await leg("tf-ok")).toEqual({ reserved: "1000000", spent: "0" });
    expect(await run(purchases.prepare("tf-ok"))).toEqual({ kind: "no_drawing" });
    const ticketId = chain.execute(callOf(prepared.transactionBuilderFile), "success");
    chain.mine(2n);
    await scan();
    expect(await run(purchases.settle(prepared.effectId))).toEqual({
      kind: "confirmed",
      ticketId,
      drawingId: 212n,
    });
    expect(await drawing("tf-ok")).toMatchObject({
      status: "entry_open",
      reserved: "1000000",
      actual: "1000000",
    });
    expect(await leg("tf-ok")).toEqual({ reserved: "0", spent: "1000000" });
    expect(
      (
        await admin.query(
          "SELECT status, custody_address FROM megapot_ticket_inventory WHERE pool_leg_id='tf-ok'",
        )
      ).rows,
    ).toEqual([{ status: "custodied", custody_address: SAFE }]);
    await admin.query("SET session_replication_role = replica");
    for (const account of ["account-a", "account-b"]) {
      // Snapshot leaves reference real accounts and personas.
      await admin.query("INSERT INTO users (user_id) VALUES ($1)", [account]);
      await admin.query("INSERT INTO personas (persona_id, account_id) VALUES ($1,$2)", [
        `persona-${account}`,
        account,
      ]);
      await admin.query(
        `INSERT INTO megapot_pool_shares (pool_leg_id, drawing_id, account_id, persona_id,
           qualification_id, eligibility_decision_id, qualified_at)
         VALUES ('tf-ok',212,$1,$2,$3,$4,clock_timestamp())`,
        [account, `persona-${account}`, `qualification-${account}`, `decision-${account}`],
      );
    }
    await admin.query("SET session_replication_role = origin");
    const cutoff = makeMegapotTicketFirstCutoff({
      layer: makeDirectPostgresControlPlaneLayer(scoped),
      now: () => Date.now() + 3 * 3_600_000,
    });
    const frozen = await run(cutoff.freezeDue());
    expect(frozen.find((result) => result.poolLegId === "tf-ok")).toMatchObject({
      status: "cutoff_frozen",
    });
    expect(await drawing("tf-ok")).toMatchObject({
      status: "cutoff_frozen",
      frozen_share_count: 2,
    });
  });

  test("an ExecutionFailure releases the reservation and closes the drawing unopened", async () => {
    const purchases = makeRewardSafePurchaseCoordinator(options());
    const prepared = await run(purchases.prepare("tf-fail"));
    if (prepared.kind !== "prepared") throw new Error("not prepared");
    chain.execute(callOf(prepared.transactionBuilderFile), "failure");
    chain.mine(2n);
    await scan();
    expect(await run(purchases.settle(prepared.effectId))).toEqual({ kind: "released" });
    expect(await drawing("tf-fail")).toMatchObject({
      status: "closed_purchase_unavailable",
      terminal_reason: "safe_purchase_execution_failed",
    });
    expect(await leg("tf-fail")).toEqual({ reserved: "0", spent: "0" });
  });

  test("an unexecuted purchase closes at its deadline and keeps its reservation", async () => {
    const prepared = await run(makeRewardSafePurchaseCoordinator(options()).prepare("tf-late"));
    if (prepared.kind !== "prepared") throw new Error("not prepared");
    const late = makeRewardSafePurchaseCoordinator(options(4 * 3_600));
    expect(await run(late.closeUnexecuted(10))).toBe(1);
    expect(await drawing("tf-late")).toMatchObject({
      status: "closed_purchase_unavailable",
      terminal_reason: "safe_purchase_not_executed",
    });
    expect(await leg("tf-late")).toEqual({ reserved: "1000000", spent: "0" });
    expect(
      (
        await admin.query("SELECT state FROM reward_chain_effects WHERE effect_id=$1", [
          prepared.effectId,
        ])
      ).rows,
    ).toEqual([{ state: "prepared" }]);
  });

  test("a ticket that landed in another drawing opens nothing and is held", async () => {
    const purchases = makeRewardSafePurchaseCoordinator(options());
    const prepared = await run(purchases.prepare("tf-wrong"));
    if (prepared.kind !== "prepared") throw new Error("not prepared");
    chain.execute(callOf(prepared.transactionBuilderFile), "success", 213n);
    chain.mine(2n);
    await scan();
    expect(await run(purchases.settle(prepared.effectId))).toEqual({
      kind: "reconciliation_required",
      reason: "safe_purchase_wrong_drawing",
    });
    expect(await drawing("tf-wrong")).toMatchObject({
      status: "operational_hold",
      terminal_reason: "safe_purchase_wrong_drawing",
    });
    expect(
      (
        await admin.query("SELECT state FROM reward_chain_effects WHERE effect_id=$1", [
          prepared.effectId,
        ])
      ).rows,
    ).toEqual([{ state: "reconciliation_required" }]);
  });

  test("a ticketed drawing with no qualifiers is held, never allocated", async () => {
    const purchases = makeRewardSafePurchaseCoordinator(options());
    const prepared = await run(purchases.prepare("tf-empty"));
    if (prepared.kind !== "prepared") throw new Error("not prepared");
    chain.execute(callOf(prepared.transactionBuilderFile), "success");
    chain.mine(2n);
    await scan();
    expect(await run(purchases.settle(prepared.effectId))).toMatchObject({ kind: "confirmed" });
    const cutoff = makeMegapotTicketFirstCutoff({
      layer: makeDirectPostgresControlPlaneLayer(scoped),
      now: () => Date.now() + 3 * 3_600_000,
    });
    await run(cutoff.freezeDue());
    expect(await drawing("tf-empty")).toMatchObject({
      status: "operational_hold",
      terminal_reason: "empty_ticketed_drawing",
      frozen_share_count: 0,
    });
  });
});
