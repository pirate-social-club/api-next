import { describe, expect, test } from "bun:test";
import { deriveMegapotTicket } from "@pirate/domain";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type Hex,
  parseAbi,
  parseAbiParameters,
} from "viem";

import {
  decodeMegapotCurrentDrawingId,
  decodeMegapotDrawingState,
  EVM_ZERO_ADDRESS,
  encodeMegapotBuyTickets,
  encodeMegapotClaimWinnings,
  encodeMegapotCurrentDrawingId,
  encodeMegapotDrawingState,
  encodeMegapotTicketOwner,
  encodeMegapotUsdcApproval,
  MEGAPOT_REFERRAL_SPLIT_SCALE,
  type MegapotReceiptLog,
  type MegapotTransactionReceipt,
  type MegapotV2DeploymentAttestation,
  MegapotV2EvidenceInvalid,
  megapotKeccak256,
  validateMegapotClaimReceipt,
  validateMegapotPurchaseReceipt,
  validateMegapotUsdcApprovalReceipt,
  validateMegapotV2DeploymentAttestation,
} from "./megapot-v2.ts";

const JACKPOT = "0x465da3c859f193a3807386387bee941b2a4c3279";
const NFT = "0x45084829ac63f9dc6a3d4981a46fa896f9180ecd";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const CUSTODY = "0x1111111111111111111111111111111111111111";
const REFERRER = "0x2222222222222222222222222222222222222222";
const PAYOUT_CALCULATOR = "0x3333333333333333333333333333333333333333";
const SOURCE = `0x${"44".repeat(32)}` as Hex;
const TX = `0x${"aa".repeat(32)}` as Hex;
const BLOCK = `0x${"bb".repeat(32)}` as Hex;

const deployment: MegapotV2DeploymentAttestation = {
  environment: "staging",
  chainId: 84_532,
  jackpotAddress: JACKPOT,
  ticketNftAddress: NFT,
  usdcAddress: USDC,
  custodyAddress: CUSTODY,
  referrerAddress: REFERRER,
  jackpotCodeHash: `0x${"01".repeat(32)}`,
  ticketNftCodeHash: `0x${"02".repeat(32)}`,
  usdcCodeHash: `0x${"03".repeat(32)}`,
  attestationId: "megapot-base-sepolia-v2-test",
};

const ticketPurchasedEvent = parseAbi([
  "event TicketPurchased(address indexed recipient, uint256 indexed currentDrawingId, bytes32 indexed source, uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme)",
]);
const ticketOrderProcessedEvent = parseAbi([
  "event TicketOrderProcessed(address indexed buyer, address indexed recipient, uint256 indexed currentDrawingId, uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees)",
]);
const ticketWinningsClaimedEvent = parseAbi([
  "event TicketWinningsClaimed(address indexed userAddress, uint256 indexed drawingId, uint256 userTicketId, uint256 matchedNormals, bool bonusballMatch, uint256 winningsAmount)",
]);
const transferEvent = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const approvalEvent = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

function log(input: {
  address: string;
  topics: [Hex, ...Hex[]];
  data: Hex;
  logIndex: number;
  removed?: boolean;
}): MegapotReceiptLog {
  return {
    ...input,
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: 123n,
  };
}

function topics(value: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  if (value.some((topic) => typeof topic !== "string")) throw new Error("invalid topic fixture");
  return value as [Hex, ...Hex[]];
}

function receipt(logs: readonly MegapotReceiptLog[]): MegapotTransactionReceipt {
  return {
    chainId: 84_532,
    status: "success",
    transactionHash: TX,
    from: CUSTODY,
    to: JACKPOT,
    blockHash: BLOCK,
    blockNumber: 123n,
    logs,
  };
}

const ticket = deriveMegapotTicket({
  effectId: `0x${"11".repeat(32)}`,
  drawingId: 8_327n,
  ticketIndex: 0,
  ballMax: 25,
  bonusballMax: 13,
  keccak256: megapotKeccak256,
});

function purchaseLogs(drawingId = 8_327n): readonly MegapotReceiptLog[] {
  return [
    log({
      address: JACKPOT,
      topics: topics(
        encodeEventTopics({
          abi: ticketPurchasedEvent,
          eventName: "TicketPurchased",
          args: { recipient: CUSTODY, currentDrawingId: drawingId, source: SOURCE },
        }),
      ),
      data: encodeAbiParameters(
        parseAbiParameters(
          "uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme",
        ),
        [91n, [...ticket.normals], ticket.bonusball, `0x${"55".repeat(32)}`],
      ),
      logIndex: 4,
    }),
    log({
      address: JACKPOT,
      topics: topics(
        encodeEventTopics({
          abi: ticketOrderProcessedEvent,
          eventName: "TicketOrderProcessed",
          args: { buyer: CUSTODY, recipient: CUSTODY, currentDrawingId: drawingId },
        }),
      ),
      data: encodeAbiParameters(
        parseAbiParameters("uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees"),
        [1n, 1_000n, 500n],
      ),
      logIndex: 5,
    }),
    log({
      address: NFT,
      topics: topics(
        encodeEventTopics({
          abi: transferEvent,
          eventName: "Transfer",
          args: { from: EVM_ZERO_ADDRESS, to: CUSTODY, tokenId: 91n },
        }),
      ),
      data: "0x",
      logIndex: 6,
    }),
  ];
}

function claimLogs(drawingId = 8_327n): readonly MegapotReceiptLog[] {
  return [
    log({
      address: JACKPOT,
      topics: topics(
        encodeEventTopics({
          abi: ticketWinningsClaimedEvent,
          eventName: "TicketWinningsClaimed",
          args: { userAddress: CUSTODY, drawingId },
        }),
      ),
      data: encodeAbiParameters(
        parseAbiParameters(
          "uint256 userTicketId, uint256 matchedNormals, bool bonusballMatch, uint256 winningsAmount",
        ),
        [91n, 3n, false, 901n],
      ),
      logIndex: 7,
    }),
    log({
      address: NFT,
      topics: topics(
        encodeEventTopics({
          abi: transferEvent,
          eventName: "Transfer",
          args: { from: CUSTODY, to: EVM_ZERO_ADDRESS, tokenId: 91n },
        }),
      ),
      data: "0x",
      logIndex: 8,
    }),
  ];
}

describe("Megapot v2 ABI", () => {
  test("pins current v2 selectors and decodes the live drawing tuple shape", () => {
    expect(encodeMegapotCurrentDrawingId()).toBe("0x9c010218");
    expect(encodeMegapotDrawingState(8_327n).slice(0, 10)).toBe("0xd8d0f5ba");
    expect(encodeMegapotClaimWinnings([91n]).slice(0, 10)).toBe("0x1bf0ade0");
    expect(encodeMegapotUsdcApproval(JACKPOT, 10_000n).slice(0, 10)).toBe("0x095ea7b3");
    expect(encodeMegapotTicketOwner(91n).slice(0, 10)).toBe("0x6352211e");

    const currentDrawingData = encodeFunctionResult({
      abi: parseAbi(["function currentDrawingId() view returns (uint256)"]),
      functionName: "currentDrawingId",
      result: 8_327n,
    });
    expect(decodeMegapotCurrentDrawingId(currentDrawingData)).toBe(8_327n);

    const drawingData = encodeFunctionResult({
      abi: parseAbi([
        "function getDrawingState(uint256) view returns ((uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
      ]),
      functionName: "getDrawingState",
      result: {
        prizePool: 5_488_549_112n,
        ticketPrice: 10_000n,
        edgePerTicket: 2_000n,
        referralWinShare: 100_000_000_000_000_000n,
        referralFee: 100_000_000_000_000_000n,
        globalTicketsBought: 9n,
        lpEarnings: 1n,
        drawingTime: 1_787_687_400n,
        winningTicket: 0n,
        ballMax: 25,
        bonusballMax: 13,
        payoutCalculator: PAYOUT_CALCULATOR,
        jackpotLock: false,
      },
    });
    expect(decodeMegapotDrawingState(drawingData)).toMatchObject({
      ticketPrice: 10_000n,
      ballMax: 25,
      bonusballMax: 13,
      payoutCalculator: PAYOUT_CALCULATOR,
      jackpotLock: false,
    });
  });

  test("encodes exact replayable purchase bytes with custody as recipient", () => {
    const input = {
      tickets: [ticket],
      recipient: CUSTODY,
      referrers: [REFERRER],
      referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
      source: SOURCE,
    } as const;
    const first = encodeMegapotBuyTickets(input);
    expect(first.slice(0, 10)).toBe("0xde88c28a");
    expect(encodeMegapotBuyTickets(input)).toBe(first);
    expect(() =>
      encodeMegapotBuyTickets({ ...input, referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE - 1n] }),
    ).toThrow("invalid-referral");
  });
});

describe("Megapot v2 deployment and receipt evidence", () => {
  test("admits testnet only under a test or staging attestation", () => {
    expect(validateMegapotV2DeploymentAttestation(deployment)).toMatchObject({
      environment: "staging",
      chainId: 84_532,
    });
    expect(() =>
      validateMegapotV2DeploymentAttestation({ ...deployment, environment: "production" }),
    ).toThrow(MegapotV2EvidenceInvalid);
  });

  test("proves purchase drawing, custody recipient, ticket ids, mint, and log identity", () => {
    expect(
      validateMegapotPurchaseReceipt({
        deployment,
        receipt: receipt(purchaseLogs()),
        drawingId: 8_327n,
        source: SOURCE,
        tickets: [ticket],
      }),
    ).toEqual({
      transactionHash: TX,
      blockHash: BLOCK,
      blockNumber: 123n,
      ticketIds: [91n],
      purchaseLogIndices: [4],
      mintLogIndices: [6],
      referralFeesAtomic: 500n,
      lpEarningsAtomic: 1_000n,
    });
  });

  test("proves the exact custody USDC allowance approval", () => {
    const approvalLog = log({
      address: USDC,
      topics: topics(
        encodeEventTopics({
          abi: approvalEvent,
          eventName: "Approval",
          args: { owner: CUSTODY, spender: JACKPOT },
        }),
      ),
      data: encodeAbiParameters(parseAbiParameters("uint256 value"), [100_000n]),
      logIndex: 2,
    });
    expect(
      validateMegapotUsdcApprovalReceipt({
        deployment,
        receipt: { ...receipt([approvalLog]), to: USDC },
        approvedAmountAtomic: 100_000n,
      }),
    ).toEqual({
      transactionHash: TX,
      blockHash: BLOCK,
      blockNumber: 123n,
      approvalLogIndex: 2,
      approvedAmountAtomic: 100_000n,
    });
    expect(() =>
      validateMegapotUsdcApprovalReceipt({
        deployment,
        receipt: { ...receipt([approvalLog]), to: USDC },
        approvedAmountAtomic: 99_999n,
      }),
    ).toThrow("wrong-party");
  });

  test("rejects another drawing, missing NFT custody evidence, and removed logs", () => {
    expect(() =>
      validateMegapotPurchaseReceipt({
        deployment,
        receipt: receipt(purchaseLogs(8_328n)),
        drawingId: 8_327n,
        source: SOURCE,
        tickets: [ticket],
      }),
    ).toThrow("wrong-drawing");
    expect(() =>
      validateMegapotPurchaseReceipt({
        deployment,
        receipt: receipt(purchaseLogs().slice(0, 2)),
        drawingId: 8_327n,
        source: SOURCE,
        tickets: [ticket],
      }),
    ).toThrow("missing-log");
    const [first, ...remaining] = purchaseLogs();
    if (first === undefined) throw new Error("missing fixture log");
    expect(() =>
      validateMegapotPurchaseReceipt({
        deployment,
        receipt: receipt([{ ...first, removed: true }, ...remaining]),
        drawingId: 8_327n,
        source: SOURCE,
        tickets: [ticket],
      }),
    ).toThrow("reorg");
  });

  test("proves claim attribution and the matching custody NFT burn", () => {
    expect(
      validateMegapotClaimReceipt({
        deployment,
        receipt: receipt(claimLogs()),
        drawingId: 8_327n,
        ticketIds: [91n],
      }),
    ).toEqual({
      transactionHash: TX,
      blockHash: BLOCK,
      blockNumber: 123n,
      ticketIds: [91n],
      claimLogIndices: [7],
      burnLogIndices: [8],
      grossWinningsAtomic: 901n,
    });
    expect(() =>
      validateMegapotClaimReceipt({
        deployment,
        receipt: receipt(claimLogs().slice(0, 1)),
        drawingId: 8_327n,
        ticketIds: [91n],
      }),
    ).toThrow("missing-log");
  });
});
