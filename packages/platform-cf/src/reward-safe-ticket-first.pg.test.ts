/**
 * PostgreSQL proof of ticket-first Safe purchases and freezes with a fake chain. Leg,
 * offer, observation and share rows are seeded with triggers disabled; every purchase,
 * reconciliation and cutoff step under test runs with all triggers enforced.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { exportSafePoolCalls } from "../../../scripts/safe-pool-export-calls.ts";
import { seedVeryRewardEvidence } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeCustodySolvencyCoordinator } from "./custody-solvency-coordinator.ts";
import { makeControlPlaneCustodySolvencyStore } from "./custody-solvency-repository.ts";
import { makeMegapotAllocationCoordinator } from "./megapot-allocation-coordinator.ts";
import { makeControlPlaneMegapotAllocationStore } from "./megapot-allocation-repository.ts";
import {
  makeMegapotCommitmentCoordinator,
  megapotUnsignedOwnerSafeSigner,
} from "./megapot-commitment-coordinator.ts";
import { makeControlPlaneMegapotCommitmentStore } from "./megapot-commitment-repository.ts";
import { makeMegapotSweepCoordinator } from "./megapot-sweep-coordinator.ts";
import { makeControlPlaneMegapotSweepStore } from "./megapot-sweep-repository.ts";
import { makeMegapotTicketFirstCutoff } from "./megapot-ticket-first-cutoff.ts";
import type { MegapotReceiptLog, MegapotTransactionReceipt } from "./megapot-v2.ts";
import type {
  MegapotV2RpcClient,
  MegapotV2SafeExecutionLog,
  MegapotV2Transaction,
} from "./megapot-v2-rpc.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeRewardSafeClaimCoordinator } from "./reward-safe-claim-coordinator.ts";
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";
import { makeRewardSafePayoutCoordinator } from "./reward-safe-payout-coordinator.ts";
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
const REFERRER = address("6");
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
  "function claimWinnings(uint256[] _userTicketIds)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event TicketWinningsClaimed(address indexed userAddress, uint256 indexed drawingId, uint256 userTicketId, uint256 matchedNormals, bool bonusballMatch, uint256 winningsAmount)",
  "event ReferralFeeCollected(address indexed referrer, uint256 amount)",
]);
const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
// encodeEventTopics allows null or OR-ed entries for filters; these events set every
// indexed argument, so each topic is one value.
const topics = (value: readonly (Hex | Hex[] | null)[]) => value as [Hex, ...Hex[]];

function fakeChain() {
  let head = 1_000n;
  let safeNonce = 3n;
  let ticketId = 500n;
  let sequence = 0;
  // Drawing 212 settles when the test says so, with the pool ticket in `tier`.
  let currentDrawingId = 212n;
  let tier = 0n;
  const nonceAt = new Map<bigint, bigint>();
  // Balance changes by block, so reads at a block see only what landed by then.
  const usdcDeltas: Array<{ block: bigint; amount: bigint }> = [];
  const referralDeltas: Array<{ block: bigint; amount: bigint }> = [];
  const at = (deltas: typeof usdcDeltas, base: bigint, blockNumber: bigint | undefined) =>
    deltas
      .filter((delta) => blockNumber === undefined || delta.block <= blockNumber)
      .reduce((sum, delta) => sum + delta.amount, base);
  const transactions = new Map<string, MegapotV2Transaction>();
  const receipts = new Map<string, MegapotTransactionReceipt>();
  const executions: MegapotV2SafeExecutionLog[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const rpc: MegapotV2RpcClient = {
    attestDeployment: async () => ({
      jackpotCodeHash: hash("7"),
      ticketNftCodeHash: hash("f"),
      usdcCodeHash: hash("e"),
    }),
    readCurrentDrawing: unused,
    readTicketPurchasesAllowed: async () => true,
    readCurrentDrawingId: async () => currentDrawingId,
    readDrawing: async () => ({
      prizePool: 10_000_000n,
      ticketPrice: PRICE,
      edgePerTicket: 100_000n,
      referralWinShare: 100_000_000_000_000_000n,
      referralFee: 100_000_000_000_000_000n,
      globalTicketsBought: 10n,
      lpEarnings: 9_000_000n,
      drawingTime: 1_800_000_000n,
      winningTicket: currentDrawingId > 212n ? 123n : 0n,
      ballMax: 30,
      bonusballMax: 10,
      payoutCalculator: address("a"),
      jackpotLock: false,
    }),
    readDrawingTierPayouts: async () =>
      Array.from({ length: 12 }, (_, index) =>
        BigInt(index) === tier && tier !== 0n && tier !== 2n ? 1_001n : 0n,
      ),
    readTicketTierIds: async (ticketIds) => ticketIds.map(() => tier),
    readReferralFees: async (_referrer, blockNumber) => at(referralDeltas, 0n, blockNumber),
    readUsdcBalance: async (_owner, blockNumber) => at(usdcDeltas, 50_000_000n, blockNumber),
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
    const decoded = decodeFunctionData({ abi, data: call.data });
    if (outcome === "success" && decoded.functionName === "transfer") {
      const [recipient, amount] = decoded.args;
      usdcDeltas.push({ block, amount: -amount });
      logs.push({
        ...base,
        address: USDC,
        logIndex: 0,
        topics: topics(
          encodeEventTopics({
            abi: erc20,
            eventName: "Transfer",
            args: { from: SAFE as Hex, to: recipient },
          }),
        ),
        data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      });
    } else if (outcome === "success" && decoded.functionName === "claimWinnings") {
      const claimed = decoded.args[0][0];
      if (claimed === undefined) throw new Error("no ticket");
      const net = 901n;
      const referral = 100n;
      usdcDeltas.push({ block, amount: net });
      referralDeltas.push({ block, amount: referral });
      logs.push(
        {
          ...base,
          address: JACKPOT,
          logIndex: 0,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketWinningsClaimed",
              args: { userAddress: SAFE as Hex, drawingId: 212n },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }],
            [claimed, 3n, false, net],
          ),
        },
        {
          ...base,
          address: JACKPOT,
          logIndex: 1,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "ReferralFeeCollected",
              args: { referrer: REFERRER as Hex },
            }),
          ),
          data: encodeAbiParameters([{ type: "uint256" }], [referral]),
        },
        {
          ...base,
          address: NFT,
          logIndex: 2,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: SAFE as Hex, to: ZERO, tokenId: claimed },
            }),
          ),
          data: "0x",
        },
        {
          ...base,
          address: USDC,
          logIndex: 3,
          topics: topics(
            encodeEventTopics({
              abi: erc20,
              eventName: "Transfer",
              args: { from: JACKPOT as Hex, to: SAFE as Hex },
            }),
          ),
          data: encodeAbiParameters([{ type: "uint256" }], [net]),
        },
      );
    } else if (outcome === "success") {
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
    settle: (ticketTier: bigint) => {
      currentDrawingId = 213n;
      tier = ticketTier;
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

  test("one pool runs from its ticket purchase to paying both qualifiers", async () => {
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

    const layer = makeDirectPostgresControlPlaneLayer(scoped);
    const commitment = makeMegapotCommitmentCoordinator({
      store: makeControlPlaneMegapotCommitmentStore(layer),
      signer: megapotUnsignedOwnerSafeSigner,
      publisher: {
        publish: async (request) => ({
          publicReference: `https://commitments.test/${request.idempotencyKey}.json`,
          publishedAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
      authority: { ensure: () => Effect.void },
    });
    expect(await run(commitment.commit({ poolLegId: "tf-ok", drawingId: 212n }))).toMatchObject({
      state: "published",
      signingKeyId: "unsigned_owner_safe_v1",
      signature: null,
    });
    expect(await drawing("tf-ok")).toMatchObject({ status: "committed" });

    const sweep = (safeProductionEnabled: boolean) =>
      run(
        makeMegapotSweepCoordinator({
          store: makeControlPlaneMegapotSweepStore(layer),
          rpc: chain.rpc,
          requiredConfirmations: 3,
          safeProductionEnabled,
        }).sweep({ poolLegId: "tf-ok", drawingId: 212n }),
      );
    await expect(sweep(false)).rejects.toMatchObject({ reason: "production_disabled" });
    expect(await sweep(true)).toMatchObject({ kind: "drawing_pending" });
    expect(await drawing("tf-ok")).toMatchObject({ status: "drawing_pending" });
    chain.settle(7n);
    expect(await sweep(true)).toMatchObject({
      kind: "complete",
      outcome: "winnings_detected",
      grossWinningsAtomic: 1_001n,
      referralAccrualAtomic: 100n,
      netWinningsAtomic: 901n,
    });
    expect(await drawing("tf-ok")).toMatchObject({ status: "winnings_detected" });

    // The owner's first claim execution fails; the attempt is released and a second
    // attempt is prepared, executed and settled.
    const claims = makeRewardSafeClaimCoordinator(options());
    const subject = { poolLegId: "tf-ok", drawingId: 212n };
    const first = await run(claims.prepare(subject));
    if (first.kind !== "prepared") throw new Error(`claim not prepared: ${first.kind}`);
    expect(await run(claims.prepare(subject))).toMatchObject({
      kind: "prepared",
      effectId: first.effectId,
    });
    chain.execute(callOf(first.transactionBuilderFile), "failure");
    chain.mine(2n);
    await scan();
    expect(await run(claims.settle(subject))).toEqual({ kind: "released" });
    expect(await drawing("tf-ok")).toMatchObject({ status: "winnings_detected" });
    const second = await run(claims.prepare(subject));
    if (second.kind !== "prepared") throw new Error(`claim not prepared: ${second.kind}`);
    expect(second.effectId).not.toBe(first.effectId);
    chain.execute(callOf(second.transactionBuilderFile), "success");
    expect(await run(claims.settle(subject))).toEqual({ kind: "not_bound" });
    chain.mine(2n);
    await scan();
    expect(await run(claims.settle(subject))).toEqual({
      kind: "claimed",
      effectId: second.effectId,
      netWinningsAtomic: 901n,
    });
    expect(await run(claims.settle(subject))).toEqual({
      kind: "claimed",
      effectId: second.effectId,
    });
    expect(await drawing("tf-ok")).toMatchObject({ status: "claimed" });
    expect(
      (
        await admin.query(
          `SELECT evidence.custody_balance_before_atomic::text AS before,
                  evidence.custody_balance_after_atomic::text AS after,
                  evidence.net_winnings_atomic::text AS net,
                  ticket.status AS ticket_status,
                  (SELECT amount_atomic::text FROM platform_referral_revenue_ledger
                    WHERE pool_leg_id='tf-ok') AS referral
             FROM megapot_claim_receipt_evidence evidence
             JOIN megapot_ticket_inventory ticket
               ON ticket.attestation_id=evidence.attestation_id
              AND ticket.ticket_id=evidence.ticket_id
            WHERE evidence.claim_effect_id=$1`,
          [second.effectId],
        )
      ).rows,
    ).toEqual([
      {
        before: "50000000",
        after: "50000901",
        net: "901",
        ticket_status: "claimed",
        referral: "100",
      },
    ]);

    // The claimed net winnings are split equally across the frozen qualifiers.
    await run(
      makeMegapotAllocationCoordinator({
        store: makeControlPlaneMegapotAllocationStore(layer),
      }).allocate(subject),
    );
    expect(await drawing("tf-ok")).toMatchObject({ status: "credited" });
    expect(
      (
        await admin.query(
          `SELECT account_id, amount_atomic::text AS amount, state, chain_id
             FROM reward_ledger_credits WHERE source_kind='megapot_allocation'
            ORDER BY account_id`,
        )
      ).rows,
    ).toEqual([
      { account_id: "account-a", amount: "451", state: "credited", chain_id: "8453" },
      { account_id: "account-b", amount: "450", state: "credited", chain_id: "8453" },
    ]);

    // Each qualifier claims with palm-scan evidence, and the owner's Safe pays the
    // credit to the persona wallet. Wallets and evidence are participant identity
    // fixtures; acceptance, solvency and payout run the real code.
    const wallets = { "account-a": address("b"), "account-b": address("c") } as const;
    await admin.query("SET session_replication_role = replica");
    for (const [ordinal, account] of (["account-a", "account-b"] as const).entries()) {
      await admin.query(
        `INSERT INTO persona_wallet_assignments (assignment_id, persona_id, account_id,
           chain_account_kind, status, reservation_idempotency_key, address, assigned_at,
           hd_wallet_index, created_at, updated_at)
         VALUES ($1,$2,$3,'evm','active',$4,$5,now(),$6,now(),now())`,
        [
          `wallet-${account}`,
          `persona-${account}`,
          account,
          `reserve-${account}`,
          wallets[account],
          ordinal,
        ],
      );
    }
    await admin.query("SET session_replication_role = origin");
    const credits = (
      await admin.query<{ credit_id: string; account_id: "account-a" | "account-b" }>(
        `SELECT credit_id, account_id FROM reward_ledger_credits
          WHERE source_kind='megapot_allocation' ORDER BY account_id`,
      )
    ).rows;
    for (const [ordinal, credit] of credits.entries()) {
      await seedVeryRewardEvidence(
        admin,
        credit.account_id,
        `tf-claim-${credit.account_id}`,
        String(ordinal + 2).repeat(64),
      );
      expect(
        (
          await admin.query(
            "SELECT outcome, claim_status FROM accept_megapot_participant_claim_v1($1, $2)",
            [credit.credit_id, credit.account_id],
          )
        ).rows,
      ).toEqual([{ outcome: "accepted", claim_status: "accepted" }]);
    }
    await run(
      makeCustodySolvencyCoordinator({
        store: makeControlPlaneCustodySolvencyStore(layer),
        rpc: chain.rpc,
        requiredConfirmations: 3,
        safePilot: { productionEnabled: true },
      }).observe(ATTESTATION),
    );
    const payouts = makeRewardSafePayoutCoordinator(options());
    for (const credit of credits) {
      const payout = await run(payouts.prepare(credit.credit_id));
      chain.execute(callOf(payout.transactionBuilderFile), "success");
      chain.mine(2n);
      await scan();
      expect(await run(payouts.settle(payout.effectId))).toMatchObject({ kind: "confirmed" });
    }
    expect(
      (
        await admin.query(
          `SELECT credit.account_id, credit.state, credit.paid_atomic::text AS paid,
                  effect.state AS effect_state, effect.target_address
             FROM reward_ledger_credits credit
             JOIN reward_payout_effects payout ON payout.credit_id=credit.credit_id
             JOIN reward_chain_effects effect ON effect.effect_id=payout.payout_effect_id
            WHERE credit.source_kind='megapot_allocation' ORDER BY credit.account_id`,
        )
      ).rows,
    ).toEqual([
      {
        account_id: "account-a",
        state: "sent",
        paid: "451",
        effect_state: "confirmed",
        target_address: USDC,
      },
      {
        account_id: "account-b",
        state: "sent",
        paid: "450",
        effect_state: "confirmed",
        target_address: USDC,
      },
    ]);
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

  test("exports each unexecuted owner call as its own Transaction Builder file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "safe-pool-export-"));
    try {
      const prepared = (
        await admin.query<{ effect_id: string; calldata: string }>(
          `SELECT effect_id, calldata FROM reward_chain_effects
            WHERE execution_mode='safe_owner_v1' AND state='prepared' ORDER BY effect_id`,
        )
      ).rows;
      expect(prepared.length).toBeGreaterThan(0);
      const written = await exportSafePoolCalls({
        attestationId: ATTESTATION,
        outDirectory: directory,
        layer: makeDirectPostgresControlPlaneLayer(scoped),
        now: () => 0,
      });
      expect(written).toHaveLength(prepared.length);
      for (const call of prepared) {
        const path = written.find((file) => file.endsWith(`-${call.effect_id}.json`));
        if (path === undefined) throw new Error(`missing export for ${call.effect_id}`);
        const file = JSON.parse(await readFile(path, "utf8"));
        expect(file).toMatchObject({
          chainId: "8453",
          meta: { createdFromSafeAddress: SAFE },
          transactions: [{ value: "0", data: call.calldata }],
        });
        expect(file.transactions).toHaveLength(1);
      }
      await expect(
        exportSafePoolCalls({
          attestationId: ATTESTATION,
          outDirectory: directory,
          layer: makeDirectPostgresControlPlaneLayer(scoped),
          now: () => 0,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  test("a pool leg's purchase order follows its custody", async () => {
    await admin.query("SET session_replication_role = replica");
    await admin.query(
      "INSERT INTO users (user_id) VALUES ('account-owner') ON CONFLICT DO NOTHING",
    );
    await admin.query(
      `INSERT INTO megapot_deployment_attestations (attestation_id, environment, chain_id,
         jackpot_address, usdc_address, ticket_nft_address, custody_address, referrer_address,
         source_tag, jackpot_code_hash, usdc_code_hash, ticket_nft_code_hash,
         attestation_block_number, attestation_block_hash, abi_version, status, verified_at,
         retired_at)
       SELECT 'megapot-base-eoa', environment, chain_id, jackpot_address, usdc_address,
              ticket_nft_address, $1, referrer_address, source_tag, jackpot_code_hash,
              usdc_code_hash, ticket_nft_code_hash, attestation_block_number,
              attestation_block_hash, abi_version, 'retired', verified_at, verified_at
         FROM megapot_deployment_attestations WHERE attestation_id=$2`,
      [address("7"), ATTESTATION],
    );
    for (const offerId of ["offer-order-safe", "offer-order-eoa", "offer-order-refused"]) {
      await admin.query(
        `INSERT INTO song_reward_offers (offer_id, community_id, post_id, audio_revision,
           created_by_account_id, status, starts_at, ends_at, owner_policy_snapshot, terms_hash,
           reward_policy_version_id)
         VALUES ($1,'community-tf',$1,1,'account-owner','draft',clock_timestamp(),
           clock_timestamp()+interval '30 days','{}'::jsonb,$2,'policy-tf')`,
        [offerId, "d".repeat(64)],
      );
    }
    await admin.query("SET session_replication_role = origin");
    // Only the assignment trigger runs, inside this test's own schema.
    await admin.query("ALTER TABLE song_reward_offer_legs DISABLE TRIGGER USER");
    await admin.query(
      "ALTER TABLE song_reward_offer_legs ENABLE TRIGGER song_reward_offer_legs_purchase_order_assign",
    );
    const insertLeg = (legId: string, attestationId: string, purchaseOrder?: string) =>
      admin.query(
        `INSERT INTO song_reward_offer_legs (leg_id, offer_id, kind, status, funder_account_id,
           refund_policy, leg_terms_hash, participation_starts_at, chain_id, token_address,
           token_decimals, tickets_per_drawing, max_ticket_price_atomic, entry_cutoff_seconds,
           beneficiary_algorithm_version, ticket_selection_version, attestation_id,
           participation_starts_drawing_id, eligible_activities, min_score_bps,
           empty_pool_policy, funding_source${purchaseOrder === undefined ? "" : ", purchase_order"})
         VALUES ($1,$2,'megapot_pool','draft','account-owner','refund_to_funders_pro_rata',$3,
           clock_timestamp(),8453,$4,6,1,$5,300,'equal_v1','keccak_packed_v1',$6,1,
           ARRAY['study','karaoke'],7000,'no_purchase','leg_budget'
           ${purchaseOrder === undefined ? "" : ",$7"})`,
        [
          legId,
          `offer-${legId}`,
          hash("3"),
          USDC,
          PRICE.toString(),
          attestationId,
          ...(purchaseOrder === undefined ? [] : [purchaseOrder]),
        ],
      );
    try {
      await insertLeg("order-safe", ATTESTATION);
      await insertLeg("order-eoa", "megapot-base-eoa");
      await expect(
        insertLeg("order-refused", "megapot-base-eoa", "ticket_first_v1"),
      ).rejects.toThrow("ticket-first pool legs require owner-executed Safe custody");
    } finally {
      await admin.query("ALTER TABLE song_reward_offer_legs ENABLE TRIGGER USER");
    }
    expect(
      (
        await admin.query(
          `SELECT leg_id, purchase_order FROM song_reward_offer_legs
            WHERE leg_id LIKE 'order-%' ORDER BY leg_id`,
        )
      ).rows,
    ).toEqual([
      { leg_id: "order-eoa", purchase_order: "commit_first" },
      { leg_id: "order-safe", purchase_order: "ticket_first_v1" },
    ]);
  });

  test("a shared-song leg buys only a drawing its terms planned", async () => {
    const termsHash = hash("4");
    await admin.query("SET session_replication_role = replica");
    // Shared-song legs name Dance, which the baseline leaves reserved.
    await admin.query(
      `UPDATE activity_registry SET status='active', producer_version='dance_test',
              current_policy_version_id='dance-policy-test' WHERE activity_key='dance'`,
    );
    await admin.query(
      `INSERT INTO song_reward_offers (offer_id, community_id, post_id, audio_revision,
         created_by_account_id, status, starts_at, ends_at, owner_policy_snapshot, terms_hash,
         reward_policy_version_id, activated_at)
       VALUES ('offer-tf-planned','community-tf','post-tf-planned',1,'account-owner','active',
         clock_timestamp()-interval '1 day', clock_timestamp()+interval '30 days','{}'::jsonb,
         $1,'policy-tf',clock_timestamp())`,
      ["d".repeat(64)],
    );
    await admin.query(
      `INSERT INTO song_reward_offer_legs (leg_id, offer_id, kind, status, funder_account_id,
         refund_policy, leg_terms_hash, participation_starts_at, chain_id, token_address,
         token_decimals, tickets_per_drawing, max_ticket_price_atomic, entry_cutoff_seconds,
         beneficiary_algorithm_version, ticket_selection_version, attestation_id,
         participation_starts_drawing_id, eligible_activities, empty_pool_policy,
         funding_source, funded_atomic, purchase_order, legal_activation_gate, activated_at,
         qualification_family_v2, shared_song_terms_v2)
       VALUES ('tf-planned','offer-tf-planned','megapot_pool','active','account-owner',
         'refund_to_funders_pro_rata',$1,clock_timestamp()-interval '1 day',8453,$2,6,1,$3,300,
         'equal_v1','keccak_packed_v1',$4,1,ARRAY['study','karaoke','dance'],'no_purchase',
         'leg_budget',10000000,'ticket_first_v1','production_approved',clock_timestamp(),
         'shared_song',jsonb_build_object('version','shared-song-megapot-v2',
           'terms_hash',substring($1 from 3),'planned_drawing_ids',jsonb_build_array('213')))`,
      [termsHash, USDC, PRICE.toString(), ATTESTATION],
    );
    await admin.query("SET session_replication_role = origin");
    const purchases = makeRewardSafePurchaseCoordinator(options());
    expect(await run(purchases.prepare("tf-planned"))).toEqual({ kind: "no_drawing" });
    await admin.query(
      `INSERT INTO megapot_drawing_observations (observation_id, attestation_id, chain_id,
         drawing_id, ticket_price_atomic, drawing_time, ball_max, bonusball_max, drawing_locked,
         referral_fee_wei, referral_win_share_wei, block_number, block_hash, block_timestamp,
         confirmations, observed_at, expires_at, raw_state_hash)
       VALUES ('observation-213',$1,8453,213,$2,clock_timestamp()+interval '3 hours',30,10,false,
         0,0,995,$3,clock_timestamp(),3,clock_timestamp(),clock_timestamp()+interval '1 hour',$4)`,
      [ATTESTATION, PRICE.toString(), hash("c"), "d".repeat(64)],
    );
    expect(await run(purchases.prepare("tf-planned"))).toMatchObject({
      kind: "prepared",
      drawingId: 213n,
    });
  });
});
