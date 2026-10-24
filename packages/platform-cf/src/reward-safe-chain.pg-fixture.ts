/**
 * A small in-memory Base for owner-executed Safe pool proofs: owner executions of
 * purchases, claims and transfers land in blocks the coordinators read, each block
 * answers with its own canonical hash, and a test may replace one to orphan a receipt.
 */
import {
  decodeFunctionData,
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
import { rewardSafeTransactionHash } from "./reward-safe-execution.ts";

export const address = (byte: string) => `0x${byte.repeat(40)}`;
export const hash = (byte: string) => `0x${byte.repeat(64)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
export const SAFE = address("5");
export const JACKPOT = address("2");
export const NFT = address("4");
export const USDC = address("3");
const OWNER = address("9");
export const REFERRER = address("6");
export const ATTESTATION = "megapot-base-safe-pilot";
export const SOURCE = hash("8");
export const PRICE = 1_000_000n;
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

export function fakeSafeChain(
  options: {
    /** The Safe's USDC before anything here moves it. */
    readonly usdcBalance?: bigint;
    /** Whether a successful purchase takes the ticket price from the Safe. */
    readonly purchaseSpends?: boolean;
  } = {},
) {
  let head = 1_000n;
  let safeNonce = 3n;
  let ticketId = 500n;
  let sequence = 0;
  // Drawing 212 settles when the test says so, with the pool ticket in `tier`.
  let currentDrawingId = 212n;
  let tier = 0n;
  let ticketOwner = SAFE;
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
  // The canonical block at each height; an orphaned execution's receipt keeps its own.
  const canonical = new Map<bigint, string>();
  let blocksUnreadable = false;
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
    readUsdcBalance: async (_owner, blockNumber) =>
      at(usdcDeltas, options.usdcBalance ?? 50_000_000n, blockNumber),
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 50_000_000n,
    readTicketOwner: async () => ticketOwner,
    readPendingNonce: async () => 0n,
    estimateGas: async () => 0n,
    readFeeQuote: unused,
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
    canonical.set(block, blockHash);
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
      if (options.purchaseSpends === true) usdcDeltas.push({ block, amount: -PRICE });
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
    /** Who the ticket contract reports as every ticket's owner. */
    ticketOwner: (owner: string) => {
      ticketOwner = owner;
    },
    settle: (ticketTier: bigint) => {
      currentDrawingId = 213n;
      tier = ticketTier;
    },
    /** A funder's own USDC transfer into the Safe; its block reads back with the same hash. */
    fund: (sender: string, amount: bigint) => {
      sequence += 1;
      head += 1n;
      const block = head;
      const transactionHash = `0x${sequence.toString(16).padStart(64, "0")}`;
      usdcDeltas.push({ block, amount });
      receipts.set(transactionHash, {
        chainId: 8453,
        status: "success",
        transactionHash,
        from: sender,
        to: USDC,
        blockHash: hash("1"),
        blockNumber: block,
        logs: [
          {
            address: USDC,
            topics: topics(
              encodeEventTopics({
                abi: erc20,
                eventName: "Transfer",
                args: { from: sender as Hex, to: SAFE as Hex },
              }),
            ),
            data: encodeAbiParameters([{ type: "uint256" }], [amount]),
            logIndex: 0,
            transactionHash,
            blockHash: hash("1"),
            blockNumber: block,
          },
        ],
      });
      return transactionHash;
    },
  };
}
