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
import type {
  MegapotReceiptLog,
  MegapotTransactionReceipt,
  MegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";
import type {
  MegapotV2FullRpcClient,
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
const erc20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
// encodeEventTopics allows null or OR-ed entries for filters; these events set every
// indexed argument, so each topic is one value.
const topics = (value: readonly (Hex | Hex[] | null)[]) => value as [Hex, ...Hex[]];

export function fakeSafeChain(
  options: {
    /** The Safe's USDC before anything here moves it. */
    readonly usdcBalance?: bigint;
    /** Whether a successful purchase takes the ticket price from the Safe. */
    readonly purchaseSpends?: boolean;
    readonly deployment?: MegapotV2DeploymentAttestation;
    readonly sourceTag?: string;
    readonly walletBalances?: Readonly<Record<string, bigint>>;
    readonly initialDrawingId?: bigint;
    readonly anchor?: { readonly blockNumber: bigint; readonly blockHash: string };
  } = {},
) {
  const chainId = options.deployment?.chainId ?? 8453;
  if (chainId !== 8453 && chainId !== 84532) throw Error("Unsupported fixture chain");
  const safe = options.deployment?.custodyAddress ?? SAFE;
  const jackpot = options.deployment?.jackpotAddress ?? JACKPOT;
  const nft = options.deployment?.ticketNftAddress ?? NFT;
  const usdc = options.deployment?.usdcAddress ?? USDC;
  const referrer = options.deployment?.referrerAddress ?? REFERRER;
  const source = options.sourceTag ?? SOURCE;
  const initialDrawingId = options.initialDrawingId ?? 212n;
  let head = 1_000n;
  let safeNonce = 3n;
  let ticketId = 500n;
  let sequence = 0;
  // Drawing 212 settles when the test says so, with the pool ticket in `tier`.
  let currentDrawingId = initialDrawingId;
  let tier = 0n;
  let ticketOwner = safe;
  const nonceAt = new Map<bigint, bigint>();
  // Balance changes by block, so reads at a block see only what landed by then.
  const usdcDeltas: Array<{ block: bigint; amount: bigint }> = [];
  const walletDeltas = new Map<string, Array<{ block: bigint; amount: bigint }>>();
  const creditWallet = (owner: string, block: bigint, amount: bigint) => {
    const entries = walletDeltas.get(owner) ?? [];
    entries.push({ block, amount });
    walletDeltas.set(owner, entries);
  };
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
  if (options.anchor) canonical.set(options.anchor.blockNumber, options.anchor.blockHash);
  const blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
  const timestamps = new Map<bigint, bigint>();
  let finalized: bigint | null = null;
  const identity = (blockNumber: bigint) => ({
    blockNumber,
    blockHash: canonical.get(blockNumber) ?? hash("1"),
    blockTimestamp: timestamps.get(blockNumber) ?? blockTimestamp,
  });
  let blocksUnreadable = false;
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const rpc: MegapotV2FullRpcClient = {
    attestDeployment: async () => ({
      jackpotCodeHash: options.deployment?.jackpotCodeHash ?? hash("7"),
      ticketNftCodeHash: options.deployment?.ticketNftCodeHash ?? hash("f"),
      usdcCodeHash: options.deployment?.usdcCodeHash ?? hash("e"),
    }),
    ...(options.deployment ? { deployment: options.deployment } : {}),
    attestDeploymentAt: async () => rpc.attestDeployment(),
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
      winningTicket: currentDrawingId > initialDrawingId ? 123n : 0n,
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
    readUsdcBalance: async (owner, blockNumber) =>
      owner === safe
        ? at(usdcDeltas, options.usdcBalance ?? 50_000_000n, blockNumber)
        : at(walletDeltas.get(owner) ?? [], options.walletBalances?.[owner] ?? 0n, blockNumber),
    readNativeBalance: async () => 0n,
    readUsdcAllowance: async () => 50_000_000n,
    readTicketOwner: async () => ticketOwner,
    readPendingNonce: async (sender) => rpc.readTransactionCount?.(sender, head) ?? 0n,
    readTransactionCount: async (sender, atBlock) =>
      [...transactions.values()]
        .filter(
          (tx) =>
            tx.from === sender && tx.blockNumber !== null && tx.blockNumber <= (atBlock ?? head),
        )
        .reduce((nonce, tx) => (tx.nonce >= nonce ? tx.nonce + 1n : nonce), 0n),
    readFinalizedHead: async () => identity(finalized ?? head),
    readFundingTransferLogs: async (input) => {
      if (input.toBlock - input.fromBlock + 1n > BigInt(input.maximumBlocks))
        throw Error("Scan bound exceeded");
      const logs = [...receipts.values()]
        .flatMap((receipt) => receipt.logs)
        .filter(
          (log) =>
            log.address === input.token &&
            log.blockNumber >= input.fromBlock &&
            log.blockNumber <= input.toBlock &&
            log.topics[0] ===
              "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" &&
            log.topics[1] === `0x${input.sender.slice(2).padStart(64, "0")}` &&
            log.topics[2] === `0x${input.custody.slice(2).padStart(64, "0")}`,
        );
      if (logs.length > input.maximumLogs) throw Error("Log bound exceeded");
      return logs;
    },
    estimateGas: async () => 0n,
    readFeeQuote: unused,
    sendRawTransaction: async () => {
      throw new Error("Pirate never broadcasts for the Safe");
    },
    readReceipt: async (transactionHash) => receipts.get(transactionHash) ?? null,
    readHead: async () => identity(head),
    readBlock: async (blockNumber) => {
      if (blocksUnreadable) throw new Error("block unavailable");
      return identity(blockNumber);
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
    landedDrawingId = initialDrawingId,
  ) => {
    sequence += 1;
    head += 1n;
    const block = head;
    const transactionHash = `0x${sequence.toString(16).padStart(64, "0")}`;
    const blockHash = hash(sequence % 2 === 0 ? "c" : "d");
    canonical.set(block, blockHash);
    const safeTxGas = 120_000n;
    const safeTransactionHash = rewardSafeTransactionHash({
      chainId,
      safeAddress: safe as Hex,
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
      chainId,
      from: OWNER,
      to: safe,
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
      creditWallet(recipient, block, amount);
      logs.push({
        ...base,
        address: usdc,
        logIndex: 0,
        topics: topics(
          encodeEventTopics({
            abi: erc20,
            eventName: "Transfer",
            args: { from: safe as Hex, to: recipient },
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
          address: jackpot,
          logIndex: 0,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketWinningsClaimed",
              args: { userAddress: safe as Hex, drawingId: initialDrawingId },
            }),
          ),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }],
            [claimed, 3n, false, net],
          ),
        },
        {
          ...base,
          address: jackpot,
          logIndex: 1,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "ReferralFeeCollected",
              args: { referrer: referrer as Hex },
            }),
          ),
          data: encodeAbiParameters([{ type: "uint256" }], [referral]),
        },
        {
          ...base,
          address: nft,
          logIndex: 2,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: safe as Hex, to: ZERO, tokenId: claimed },
            }),
          ),
          data: "0x",
        },
        {
          ...base,
          address: usdc,
          logIndex: 3,
          topics: topics(
            encodeEventTopics({
              abi: erc20,
              eventName: "Transfer",
              args: { from: jackpot as Hex, to: safe as Hex },
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
          address: jackpot,
          logIndex: 0,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketPurchased",
              args: {
                recipient: safe as Hex,
                currentDrawingId: landedDrawingId,
                source: source as Hex,
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
          address: nft,
          logIndex: 1,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "Transfer",
              args: { from: ZERO, to: safe as Hex, tokenId: ticketId },
            }),
          ),
          data: "0x",
        },
        {
          ...base,
          address: jackpot,
          logIndex: 2,
          topics: topics(
            encodeEventTopics({
              abi,
              eventName: "TicketOrderProcessed",
              args: {
                buyer: safe as Hex,
                recipient: safe as Hex,
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
      address: safe,
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
      chainId,
      status: "success",
      transactionHash,
      from: OWNER,
      to: safe,
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
  const transfer = (sender: string, recipient: string, amount: bigint) => {
    sequence += 1;
    head += 1n;
    const block = head;
    timestamps.set(block, BigInt(Math.floor(Date.now() / 1000)));
    const transactionHash = `0x${sequence.toString(16).padStart(64, "0")}`;
    if (recipient === safe) usdcDeltas.push({ block, amount });
    else creditWallet(recipient, block, amount);
    creditWallet(sender, block, -amount);
    const nonce = [...transactions.values()]
      .filter((tx) => tx.from === sender)
      .reduce((n, tx) => (tx.nonce >= n ? tx.nonce + 1n : n), 0n);
    transactions.set(transactionHash, {
      transactionHash,
      chainId,
      from: sender,
      to: usdc,
      nonce,
      valueWei: 0n,
      input: encodeFunctionData({
        abi: erc20,
        functionName: "transfer",
        args: [recipient as Hex, amount],
      }),
      blockNumber: block,
    });
    receipts.set(transactionHash, {
      chainId,
      status: "success",
      transactionHash,
      from: sender,
      to: usdc,
      blockHash: hash("1"),
      blockNumber: block,
      logs: [
        {
          address: usdc,
          topics: topics(
            encodeEventTopics({
              abi: erc20,
              eventName: "Transfer",
              args: { from: sender as Hex, to: recipient as Hex },
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
  };
  return {
    rpc,
    execute,
    head: () => head,
    finalize: (block: bigint | null) => {
      finalized = block;
    },
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
      currentDrawingId = initialDrawingId + 1n;
      tier = ticketTier;
    },
    /** A funder's own usdc transfer into the Safe; its block reads back with the same hash. */
    fund: (sender: string, amount: bigint) => transfer(sender, safe, amount),
    transfer,
  };
}
