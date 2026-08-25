import type { Digest32, MegapotTicket } from "@pirate/domain";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

const jackpotReadAbi = parseAbi([
  "function currentDrawingId() view returns (uint256)",
  "function getDrawingState(uint256 _drawingId) view returns ((uint256 prizePool, uint256 ticketPrice, uint256 edgePerTicket, uint256 referralWinShare, uint256 referralFee, uint256 globalTicketsBought, uint256 lpEarnings, uint256 drawingTime, uint256 winningTicket, uint8 ballMax, uint8 bonusballMax, address payoutCalculator, bool jackpotLock))",
  "function getDrawingTierPayouts(uint256 _drawingId) view returns (uint256[12])",
  "function getTicketTierIds(uint256[] _ticketIds) view returns (uint256[] tierIds)",
  "function referralFees(address _referrer) view returns (uint256)",
]);

const jackpotWriteAbi = parseAbi([
  "function buyTickets((uint8[] normals, uint8 bonusball)[] _tickets, address _recipient, address[] _referrers, uint256[] _referralSplit, bytes32 _source) returns (uint256[] ticketIds)",
  "function claimWinnings(uint256[] _userTicketIds)",
]);

const ticketPurchasedAbi = parseAbi([
  "event TicketPurchased(address indexed recipient, uint256 indexed currentDrawingId, bytes32 indexed source, uint256 userTicketId, uint8[] normals, uint8 bonusball, bytes32 referralScheme)",
]);

const ticketOrderProcessedAbi = parseAbi([
  "event TicketOrderProcessed(address indexed buyer, address indexed recipient, uint256 indexed currentDrawingId, uint256 numberOfTickets, uint256 lpEarnings, uint256 referralFees)",
]);

const ticketWinningsClaimedAbi = parseAbi([
  "event TicketWinningsClaimed(address indexed userAddress, uint256 indexed drawingId, uint256 userTicketId, uint256 matchedNormals, bool bonusballMatch, uint256 winningsAmount)",
]);

const referralFeeCollectedAbi = parseAbi([
  "event ReferralFeeCollected(address indexed referrer, uint256 amount)",
]);

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const MEGAPOT_REFERRAL_SPLIT_SCALE = 1_000_000_000_000_000_000n;
export const EVM_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type MegapotV2Environment = "test" | "staging" | "production";

export type MegapotV2DeploymentAttestation = Readonly<{
  environment: MegapotV2Environment;
  chainId: number;
  jackpotAddress: string;
  ticketNftAddress: string;
  usdcAddress: string;
  custodyAddress: string;
  referrerAddress: string;
  jackpotCodeHash: string;
  ticketNftCodeHash: string;
  usdcCodeHash: string;
  attestationId: string;
}>;

export type MegapotV2DrawingState = Readonly<{
  prizePool: bigint;
  ticketPrice: bigint;
  edgePerTicket: bigint;
  referralWinShare: bigint;
  referralFee: bigint;
  globalTicketsBought: bigint;
  lpEarnings: bigint;
  drawingTime: bigint;
  winningTicket: bigint;
  ballMax: number;
  bonusballMax: number;
  payoutCalculator: string;
  jackpotLock: boolean;
}>;

export type MegapotReceiptLog = Readonly<{
  address: string;
  topics: [Hex, ...Hex[]];
  data: Hex;
  logIndex: number;
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  removed?: boolean;
}>;

export type MegapotTransactionReceipt = Readonly<{
  chainId: number;
  status: "success" | "reverted";
  transactionHash: string;
  from: string;
  to: string | null;
  blockHash: string;
  blockNumber: bigint;
  logs: readonly MegapotReceiptLog[];
}>;

export type MegapotPurchaseReceiptEvidence = Readonly<{
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  ticketIds: readonly bigint[];
  purchaseLogIndices: readonly number[];
  mintLogIndices: readonly number[];
  referralFeesAtomic: bigint;
  lpEarningsAtomic: bigint;
}>;

export type MegapotClaimReceiptEvidence = Readonly<{
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  ticketIds: readonly bigint[];
  claimLogIndices: readonly number[];
  burnLogIndices: readonly number[];
  referralLogIndices: readonly number[];
  grossWinningsAtomic: bigint;
  netWinningsAtomic: bigint;
  referralAccrualAtomic: bigint;
  transferLogIndex: number;
}>;

export type MegapotApprovalReceiptEvidence = Readonly<{
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  approvalLogIndex: number;
  approvedAmountAtomic: bigint;
}>;

export class MegapotV2EvidenceInvalid extends Error {
  readonly _tag = "MegapotV2EvidenceInvalid";

  constructor(
    readonly reason:
      | "invalid-address"
      | "invalid-hash"
      | "invalid-attestation"
      | "invalid-chain"
      | "invalid-drawing-state"
      | "invalid-ticket"
      | "invalid-referral"
      | "invalid-source"
      | "invalid-receipt"
      | "wrong-party"
      | "wrong-drawing"
      | "wrong-ticket"
      | "wrong-source"
      | "duplicate-log"
      | "missing-log"
      | "reorg",
  ) {
    super(reason);
  }
}

const addressPattern = /^0x[0-9a-f]{40}$/u;
const hashPattern = /^0x[0-9a-f]{64}$/u;

function address(value: string): `0x${string}` {
  const canonical = value.toLowerCase();
  if (!addressPattern.test(canonical)) throw new MegapotV2EvidenceInvalid("invalid-address");
  return canonical as `0x${string}`;
}

function hash(value: string): `0x${string}` {
  const canonical = value.toLowerCase();
  if (!hashPattern.test(canonical)) throw new MegapotV2EvidenceInvalid("invalid-hash");
  return canonical as `0x${string}`;
}

function validId(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function sameAddress(left: string, right: string): boolean {
  return address(left) === address(right);
}

function assertReceiptIdentity(receipt: MegapotTransactionReceipt): void {
  hash(receipt.transactionHash);
  hash(receipt.blockHash);
  if (receipt.blockNumber < 0n) throw new MegapotV2EvidenceInvalid("invalid-receipt");
  const seen = new Set<number>();
  for (const log of receipt.logs) {
    address(log.address);
    hash(log.transactionHash);
    hash(log.blockHash);
    if (
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0 ||
      log.blockNumber !== receipt.blockNumber ||
      log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      log.removed === true
    ) {
      throw new MegapotV2EvidenceInvalid(log.removed === true ? "reorg" : "invalid-receipt");
    }
    if (seen.has(log.logIndex)) throw new MegapotV2EvidenceInvalid("duplicate-log");
    seen.add(log.logIndex);
  }
}

function sameTicket(left: MegapotTicket, normals: readonly number[], bonusball: number): boolean {
  return (
    left.bonusball === bonusball &&
    left.normals.length === normals.length &&
    left.normals.every((normal, index) => normal === normals[index])
  );
}

export function validateMegapotV2DeploymentAttestation(
  value: MegapotV2DeploymentAttestation,
): MegapotV2DeploymentAttestation {
  if (
    !validId(value.attestationId) ||
    (value.environment === "production" && value.chainId !== 8_453) ||
    (value.environment !== "production" && value.chainId !== 84_532)
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-attestation");
  }
  const addresses = [
    address(value.jackpotAddress),
    address(value.ticketNftAddress),
    address(value.usdcAddress),
    address(value.custodyAddress),
    address(value.referrerAddress),
  ] as const;
  if (
    addresses.includes(EVM_ZERO_ADDRESS) ||
    new Set(addresses.slice(0, 4)).size !== 4 ||
    value.custodyAddress.toLowerCase() === value.referrerAddress.toLowerCase()
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-attestation");
  }
  hash(value.jackpotCodeHash);
  hash(value.ticketNftCodeHash);
  hash(value.usdcCodeHash);
  return {
    ...value,
    jackpotAddress: addresses[0],
    ticketNftAddress: addresses[1],
    usdcAddress: addresses[2],
    custodyAddress: addresses[3],
    referrerAddress: addresses[4],
    jackpotCodeHash: value.jackpotCodeHash.toLowerCase(),
    ticketNftCodeHash: value.ticketNftCodeHash.toLowerCase(),
    usdcCodeHash: value.usdcCodeHash.toLowerCase(),
  };
}

export const megapotKeccak256: Digest32 = (input) => toBytes(keccak256(input));

export function encodeMegapotCurrentDrawingId(): Hex {
  return encodeFunctionData({ abi: jackpotReadAbi, functionName: "currentDrawingId" });
}

export function decodeMegapotCurrentDrawingId(data: Hex): bigint {
  return decodeFunctionResult({ abi: jackpotReadAbi, functionName: "currentDrawingId", data });
}

export function encodeMegapotDrawingState(drawingId: bigint): Hex {
  if (drawingId < 0n) throw new MegapotV2EvidenceInvalid("wrong-drawing");
  return encodeFunctionData({
    abi: jackpotReadAbi,
    functionName: "getDrawingState",
    args: [drawingId],
  });
}

export function decodeMegapotDrawingState(data: Hex): MegapotV2DrawingState {
  const decoded = decodeFunctionResult({
    abi: jackpotReadAbi,
    functionName: "getDrawingState",
    data,
  });
  if (
    decoded.ticketPrice < 1n ||
    decoded.drawingTime < 1n ||
    decoded.ballMax < 5 ||
    decoded.bonusballMax < 1 ||
    decoded.referralWinShare > MEGAPOT_REFERRAL_SPLIT_SCALE ||
    decoded.referralFee > MEGAPOT_REFERRAL_SPLIT_SCALE
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-drawing-state");
  }
  return { ...decoded, payoutCalculator: address(decoded.payoutCalculator) };
}

export function encodeMegapotDrawingTierPayouts(drawingId: bigint): Hex {
  if (drawingId < 0n) throw new MegapotV2EvidenceInvalid("wrong-drawing");
  return encodeFunctionData({
    abi: jackpotReadAbi,
    functionName: "getDrawingTierPayouts",
    args: [drawingId],
  });
}

export function decodeMegapotDrawingTierPayouts(data: Hex): readonly bigint[] {
  return decodeFunctionResult({
    abi: jackpotReadAbi,
    functionName: "getDrawingTierPayouts",
    data,
  });
}

export function encodeMegapotTicketTierIds(ticketIds: readonly bigint[]): Hex {
  if (
    ticketIds.length === 0 ||
    ticketIds.some((ticketId) => ticketId < 0n) ||
    new Set(ticketIds.map(String)).size !== ticketIds.length
  ) {
    throw new MegapotV2EvidenceInvalid("wrong-ticket");
  }
  return encodeFunctionData({
    abi: jackpotReadAbi,
    functionName: "getTicketTierIds",
    args: [[...ticketIds]],
  });
}

export function decodeMegapotTicketTierIds(data: Hex, expectedCount: number): readonly bigint[] {
  const tierIds = decodeFunctionResult({
    abi: jackpotReadAbi,
    functionName: "getTicketTierIds",
    data,
  });
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    tierIds.length !== expectedCount ||
    tierIds.some((tierId) => tierId < 0n || tierId > 11n)
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-ticket");
  }
  return tierIds;
}

export function encodeMegapotReferralFees(referrer: string): Hex {
  return encodeFunctionData({
    abi: jackpotReadAbi,
    functionName: "referralFees",
    args: [address(referrer)],
  });
}

export function decodeMegapotReferralFees(data: Hex): bigint {
  return decodeFunctionResult({ abi: jackpotReadAbi, functionName: "referralFees", data });
}

export function encodeMegapotBuyTickets(input: {
  readonly tickets: readonly MegapotTicket[];
  readonly recipient: string;
  readonly referrers: readonly string[];
  readonly referralSplit: readonly bigint[];
  readonly source: string;
}): Hex {
  if (input.tickets.length !== 1) throw new MegapotV2EvidenceInvalid("invalid-ticket");
  const ticket = input.tickets[0];
  if (
    ticket === undefined ||
    ticket.normals.length !== 5 ||
    new Set(ticket.normals).size !== 5 ||
    ticket.normals.some((normal) => !Number.isSafeInteger(normal) || normal < 1 || normal > 255) ||
    !Number.isSafeInteger(ticket.bonusball) ||
    ticket.bonusball < 1 ||
    ticket.bonusball > 255
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-ticket");
  }
  if (
    input.referrers.length !== input.referralSplit.length ||
    input.referrers.length !== 1 ||
    input.referralSplit.reduce((sum, share) => sum + share, 0n) !== MEGAPOT_REFERRAL_SPLIT_SCALE
  ) {
    throw new MegapotV2EvidenceInvalid("invalid-referral");
  }
  return encodeFunctionData({
    abi: jackpotWriteAbi,
    functionName: "buyTickets",
    args: [
      [{ normals: [...ticket.normals], bonusball: ticket.bonusball }],
      address(input.recipient),
      input.referrers.map(address),
      [...input.referralSplit],
      hash(input.source),
    ],
  });
}

export function encodeMegapotClaimWinnings(ticketIds: readonly bigint[]): Hex {
  if (
    ticketIds.length === 0 ||
    ticketIds.some((ticketId) => ticketId < 0n) ||
    new Set(ticketIds.map(String)).size !== ticketIds.length
  ) {
    throw new MegapotV2EvidenceInvalid("wrong-ticket");
  }
  return encodeFunctionData({
    abi: jackpotWriteAbi,
    functionName: "claimWinnings",
    args: [[...ticketIds]],
  });
}

export function encodeMegapotUsdcApproval(spender: string, amountAtomic: bigint): Hex {
  if (amountAtomic < 0n) throw new MegapotV2EvidenceInvalid("invalid-ticket");
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [address(spender), amountAtomic],
  });
}

export function encodeMegapotUsdcAllowance(owner: string, spender: string): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [address(owner), address(spender)],
  });
}

export function decodeMegapotUsdcAllowance(data: Hex): bigint {
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data });
}

export function encodeMegapotUsdcBalance(account: string): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [address(account)] });
}

export function decodeMegapotUsdcBalance(data: Hex): bigint {
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data });
}

export function encodeMegapotTicketOwner(ticketId: bigint): Hex {
  if (ticketId < 0n) throw new MegapotV2EvidenceInvalid("wrong-ticket");
  return encodeFunctionData({ abi: erc721Abi, functionName: "ownerOf", args: [ticketId] });
}

export function decodeMegapotTicketOwner(data: Hex): string {
  return address(decodeFunctionResult({ abi: erc721Abi, functionName: "ownerOf", data }));
}

export function validateMegapotPurchaseReceipt(input: {
  readonly deployment: MegapotV2DeploymentAttestation;
  readonly receipt: MegapotTransactionReceipt;
  readonly drawingId: bigint;
  readonly source: string;
  readonly tickets: readonly MegapotTicket[];
}): MegapotPurchaseReceiptEvidence {
  const deployment = validateMegapotV2DeploymentAttestation(input.deployment);
  const receipt = input.receipt;
  assertReceiptIdentity(receipt);
  if (receipt.chainId !== deployment.chainId) throw new MegapotV2EvidenceInvalid("invalid-chain");
  if (receipt.status !== "success") throw new MegapotV2EvidenceInvalid("invalid-receipt");
  if (
    receipt.to === null ||
    !sameAddress(receipt.to, deployment.jackpotAddress) ||
    !sameAddress(receipt.from, deployment.custodyAddress)
  ) {
    throw new MegapotV2EvidenceInvalid("wrong-party");
  }
  if (input.tickets.length !== 1) throw new MegapotV2EvidenceInvalid("invalid-ticket");
  const expectedSource = hash(input.source);
  const purchaseEvents: Array<{ ticketId: bigint; logIndex: number }> = [];
  const orderEvents: Array<{ referralFees: bigint; lpEarnings: bigint }> = [];
  const mintEvents: Array<{ ticketId: bigint; logIndex: number }> = [];
  for (const log of receipt.logs) {
    if (sameAddress(log.address, deployment.jackpotAddress)) {
      try {
        const event = decodeEventLog({
          abi: ticketPurchasedAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (!sameAddress(event.args.recipient, deployment.custodyAddress)) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        if (event.args.currentDrawingId !== input.drawingId) {
          throw new MegapotV2EvidenceInvalid("wrong-drawing");
        }
        if (event.args.source.toLowerCase() !== expectedSource) {
          throw new MegapotV2EvidenceInvalid("wrong-source");
        }
        const expectedTicket = input.tickets[purchaseEvents.length];
        if (
          expectedTicket === undefined ||
          !sameTicket(expectedTicket, event.args.normals, event.args.bonusball)
        ) {
          throw new MegapotV2EvidenceInvalid("wrong-ticket");
        }
        purchaseEvents.push({ ticketId: event.args.userTicketId, logIndex: log.logIndex });
        continue;
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
      try {
        const event = decodeEventLog({
          abi: ticketOrderProcessedAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          !sameAddress(event.args.buyer, deployment.custodyAddress) ||
          !sameAddress(event.args.recipient, deployment.custodyAddress)
        ) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        if (event.args.currentDrawingId !== input.drawingId) {
          throw new MegapotV2EvidenceInvalid("wrong-drawing");
        }
        if (event.args.numberOfTickets !== BigInt(input.tickets.length)) {
          throw new MegapotV2EvidenceInvalid("wrong-ticket");
        }
        orderEvents.push({
          referralFees: event.args.referralFees,
          lpEarnings: event.args.lpEarnings,
        });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
    if (sameAddress(log.address, deployment.ticketNftAddress)) {
      try {
        const event = decodeEventLog({
          abi: erc721Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          !sameAddress(event.args.from, EVM_ZERO_ADDRESS) ||
          !sameAddress(event.args.to, deployment.custodyAddress)
        ) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        mintEvents.push({ ticketId: event.args.tokenId, logIndex: log.logIndex });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
  }
  if (
    purchaseEvents.length !== input.tickets.length ||
    mintEvents.length !== input.tickets.length ||
    orderEvents.length !== 1
  ) {
    throw new MegapotV2EvidenceInvalid("missing-log");
  }
  for (const purchase of purchaseEvents) {
    if (!mintEvents.some((mint) => mint.ticketId === purchase.ticketId)) {
      throw new MegapotV2EvidenceInvalid("wrong-ticket");
    }
  }
  return {
    transactionHash: hash(receipt.transactionHash),
    blockHash: hash(receipt.blockHash),
    blockNumber: receipt.blockNumber,
    ticketIds: purchaseEvents.map(({ ticketId }) => ticketId),
    purchaseLogIndices: purchaseEvents.map(({ logIndex }) => logIndex),
    mintLogIndices: mintEvents.map(({ logIndex }) => logIndex),
    referralFeesAtomic: orderEvents[0]?.referralFees ?? 0n,
    lpEarningsAtomic: orderEvents[0]?.lpEarnings ?? 0n,
  };
}

export function validateMegapotUsdcApprovalReceipt(input: {
  readonly deployment: MegapotV2DeploymentAttestation;
  readonly receipt: MegapotTransactionReceipt;
  readonly approvedAmountAtomic: bigint;
}): MegapotApprovalReceiptEvidence {
  const deployment = validateMegapotV2DeploymentAttestation(input.deployment);
  const receipt = input.receipt;
  assertReceiptIdentity(receipt);
  if (receipt.chainId !== deployment.chainId) throw new MegapotV2EvidenceInvalid("invalid-chain");
  if (receipt.status !== "success") throw new MegapotV2EvidenceInvalid("invalid-receipt");
  if (
    receipt.to === null ||
    !sameAddress(receipt.to, deployment.usdcAddress) ||
    !sameAddress(receipt.from, deployment.custodyAddress) ||
    input.approvedAmountAtomic < 1n
  ) {
    throw new MegapotV2EvidenceInvalid("wrong-party");
  }
  const approvals: Array<{ logIndex: number; amountAtomic: bigint }> = [];
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, deployment.usdcAddress)) continue;
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        eventName: "Approval",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        !sameAddress(event.args.owner, deployment.custodyAddress) ||
        !sameAddress(event.args.spender, deployment.jackpotAddress) ||
        event.args.value !== input.approvedAmountAtomic
      ) {
        throw new MegapotV2EvidenceInvalid("wrong-party");
      }
      approvals.push({ logIndex: log.logIndex, amountAtomic: event.args.value });
    } catch (error) {
      if (error instanceof MegapotV2EvidenceInvalid) throw error;
    }
  }
  const approval = approvals[0];
  if (approvals.length !== 1 || approval === undefined) {
    throw new MegapotV2EvidenceInvalid("missing-log");
  }
  return {
    transactionHash: hash(receipt.transactionHash),
    blockHash: hash(receipt.blockHash),
    blockNumber: receipt.blockNumber,
    approvalLogIndex: approval.logIndex,
    approvedAmountAtomic: approval.amountAtomic,
  };
}

export function validateMegapotClaimReceipt(input: {
  readonly deployment: MegapotV2DeploymentAttestation;
  readonly receipt: MegapotTransactionReceipt;
  readonly drawingId: bigint;
  readonly ticketIds: readonly bigint[];
  readonly expectedGrossWinningsAtomic: bigint;
  readonly expectedNetWinningsAtomic: bigint;
  readonly expectedReferralAccrualAtomic: bigint;
}): MegapotClaimReceiptEvidence {
  const deployment = validateMegapotV2DeploymentAttestation(input.deployment);
  const receipt = input.receipt;
  assertReceiptIdentity(receipt);
  if (receipt.chainId !== deployment.chainId) throw new MegapotV2EvidenceInvalid("invalid-chain");
  if (receipt.status !== "success") throw new MegapotV2EvidenceInvalid("invalid-receipt");
  if (
    receipt.to === null ||
    !sameAddress(receipt.to, deployment.jackpotAddress) ||
    !sameAddress(receipt.from, deployment.custodyAddress)
  ) {
    throw new MegapotV2EvidenceInvalid("wrong-party");
  }
  const expected = new Set(input.ticketIds.map(String));
  if (expected.size === 0 || expected.size !== input.ticketIds.length) {
    throw new MegapotV2EvidenceInvalid("wrong-ticket");
  }
  const claims: Array<{ ticketId: bigint; amount: bigint; logIndex: number }> = [];
  const burns: Array<{ ticketId: bigint; logIndex: number }> = [];
  const referrals: Array<{ amount: bigint; logIndex: number }> = [];
  const transfers: Array<{ amount: bigint; logIndex: number }> = [];
  for (const log of receipt.logs) {
    if (sameAddress(log.address, deployment.jackpotAddress)) {
      try {
        const event = decodeEventLog({
          abi: ticketWinningsClaimedAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (!sameAddress(event.args.userAddress, deployment.custodyAddress)) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        if (event.args.drawingId !== input.drawingId) {
          throw new MegapotV2EvidenceInvalid("wrong-drawing");
        }
        if (!expected.has(event.args.userTicketId.toString())) {
          throw new MegapotV2EvidenceInvalid("wrong-ticket");
        }
        claims.push({
          ticketId: event.args.userTicketId,
          amount: event.args.winningsAmount,
          logIndex: log.logIndex,
        });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
    if (sameAddress(log.address, deployment.jackpotAddress)) {
      try {
        const event = decodeEventLog({
          abi: referralFeeCollectedAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (!sameAddress(event.args.referrer, deployment.referrerAddress)) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        referrals.push({ amount: event.args.amount, logIndex: log.logIndex });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
    if (sameAddress(log.address, deployment.ticketNftAddress)) {
      try {
        const event = decodeEventLog({
          abi: erc721Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          !sameAddress(event.args.from, deployment.custodyAddress) ||
          !sameAddress(event.args.to, EVM_ZERO_ADDRESS) ||
          !expected.has(event.args.tokenId.toString())
        ) {
          throw new MegapotV2EvidenceInvalid("wrong-ticket");
        }
        burns.push({ ticketId: event.args.tokenId, logIndex: log.logIndex });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
    if (sameAddress(log.address, deployment.usdcAddress)) {
      try {
        const event = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          !sameAddress(event.args.from, deployment.jackpotAddress) ||
          !sameAddress(event.args.to, deployment.custodyAddress)
        ) {
          throw new MegapotV2EvidenceInvalid("wrong-party");
        }
        transfers.push({ amount: event.args.amount, logIndex: log.logIndex });
      } catch (error) {
        if (error instanceof MegapotV2EvidenceInvalid) throw error;
      }
    }
  }
  if (claims.length !== expected.size || burns.length !== expected.size) {
    throw new MegapotV2EvidenceInvalid("missing-log");
  }
  for (const ticketId of expected) {
    if (
      claims.filter((claim) => claim.ticketId.toString() === ticketId).length !== 1 ||
      burns.filter((burn) => burn.ticketId.toString() === ticketId).length !== 1
    ) {
      throw new MegapotV2EvidenceInvalid("duplicate-log");
    }
  }
  const netWinningsAtomic = claims.reduce((sum, claim) => sum + claim.amount, 0n);
  const referralAccrualAtomic = referrals.reduce((sum, referral) => sum + referral.amount, 0n);
  const transfer = transfers[0];
  if (
    transfer === undefined ||
    transfers.length !== 1 ||
    transfer.amount !== input.expectedNetWinningsAtomic ||
    netWinningsAtomic !== input.expectedNetWinningsAtomic ||
    referralAccrualAtomic !== input.expectedReferralAccrualAtomic ||
    netWinningsAtomic + referralAccrualAtomic !== input.expectedGrossWinningsAtomic
  ) {
    throw new MegapotV2EvidenceInvalid("missing-log");
  }
  return {
    transactionHash: hash(receipt.transactionHash),
    blockHash: hash(receipt.blockHash),
    blockNumber: receipt.blockNumber,
    ticketIds: claims.map(({ ticketId }) => ticketId),
    claimLogIndices: claims.map(({ logIndex }) => logIndex),
    burnLogIndices: burns.map(({ logIndex }) => logIndex),
    referralLogIndices: referrals.map(({ logIndex }) => logIndex),
    grossWinningsAtomic: input.expectedGrossWinningsAtomic,
    netWinningsAtomic,
    referralAccrualAtomic,
    transferLogIndex: transfer.logIndex,
  };
}
