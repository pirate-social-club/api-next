import {
  defineMoneyFlowMachine,
  rejectTransition,
  type TransitionRejection,
  transitionMachineEvent,
} from "../money/state-machine.ts";

export const MEGAPOT_TICKET_SELECTION_VERSION = "keccak_packed_v1" as const;
export const MEGAPOT_BENEFICIARY_ALGORITHM_VERSION = "equal_v1" as const;
export const MEGAPOT_SNAPSHOT_DOMAIN = "pirate.megapot-pool-beneficiary-snapshot.v2" as const;

export type Digest32 = (input: Uint8Array) => Uint8Array;

export type MegapotTicket = Readonly<{
  normals: readonly [number, number, number, number, number];
  bonusball: number;
}>;

export type MegapotSnapshotBeneficiary = Readonly<{
  accountId: string;
  personaId: string;
}>;

export type MegapotSnapshotPrivateLeaf = Readonly<{
  accountId: string;
  personaId: string;
  orderKey: string;
  leafCommitment: string;
}>;

export type MegapotPublishedSnapshot = Readonly<{
  domain: typeof MEGAPOT_SNAPSHOT_DOMAIN;
  poolLegId: string;
  drawingId: string;
  termsHash: string;
  algorithmVersion: typeof MEGAPOT_BENEFICIARY_ALGORITHM_VERSION;
  fallback: boolean;
  leafCount: number;
  leafCommitments: readonly string[];
  snapshotHash: string;
}>;

export type MegapotBeneficiarySnapshot = Readonly<{
  privateLeaves: readonly MegapotSnapshotPrivateLeaf[];
  published: MegapotPublishedSnapshot;
}>;

export type MegapotAllocation = Readonly<{
  accountId: string;
  personaId: string;
  amountAtomic: bigint;
  ordinal: number;
}>;

export type MegapotAllocationOutcome =
  | Readonly<{
      kind: "user_allocations";
      allocations: readonly MegapotAllocation[];
      totalAtomic: bigint;
    }>
  | Readonly<{
      kind: "fallback_sponsorship_credit";
      sponsorAccountId: string;
      sponsorPersonaId: string;
      amountAtomic: bigint;
    }>;

export class MegapotPoolInvariantError extends Error {
  readonly _tag = "MegapotPoolInvariantError";

  constructor(
    readonly reason:
      | "invalid-digest"
      | "invalid-identifier"
      | "invalid-range"
      | "invalid-drawing"
      | "invalid-hash"
      | "duplicate-beneficiary"
      | "empty-beneficiaries"
      | "invalid-amount"
      | "invalid-snapshot"
      | "invalid-state",
  ) {
    super(reason);
  }
}

const encoder = new TextEncoder();
const bytes32Pattern = /^0x[0-9a-f]{64}$/u;

function validId(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function bytes32(value: string): Uint8Array {
  if (!bytes32Pattern.test(value)) throw new MegapotPoolInvariantError("invalid-hash");
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function checkedDigest(digest: Digest32, input: Uint8Array): Uint8Array {
  const output = digest(input);
  if (!(output instanceof Uint8Array) || output.byteLength !== 32) {
    throw new MegapotPoolInvariantError("invalid-digest");
  }
  return new Uint8Array(output);
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function uint32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new MegapotPoolInvariantError("invalid-range");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function uint256(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new MegapotPoolInvariantError("invalid-drawing");
  }
  const output = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function lengthPrefixed(value: string): Uint8Array {
  const body = encoder.encode(value);
  return concat(uint32(body.byteLength), body);
}

function streamBytes(seed: Uint8Array, digest: Digest32): () => number {
  let block = seed;
  let offset = 0;
  let round = 0;
  return () => {
    if (offset === block.byteLength) {
      round += 1;
      block = checkedDigest(digest, concat(seed, uint32(round)));
      offset = 0;
    }
    const value = block[offset];
    offset += 1;
    if (value === undefined) throw new MegapotPoolInvariantError("invalid-digest");
    return value;
  };
}

/**
 * Versioned quick-pick selection over an injected Keccak-256 implementation.
 * The preimage is bytes32 effect id, uint256 drawing id, and uint32 ticket
 * index. Collisions consume the next deterministic byte; exhausted blocks are
 * expanded as keccak(seed || uint32(round)).
 */
export function deriveMegapotTicket(input: {
  readonly effectId: string;
  readonly drawingId: bigint;
  readonly ticketIndex: number;
  readonly ballMax: number;
  readonly bonusballMax: number;
  readonly keccak256: Digest32;
}): MegapotTicket {
  if (
    !Number.isSafeInteger(input.ballMax) ||
    input.ballMax < 5 ||
    input.ballMax > 255 ||
    !Number.isSafeInteger(input.bonusballMax) ||
    input.bonusballMax < 1 ||
    input.bonusballMax > 255
  ) {
    throw new MegapotPoolInvariantError("invalid-range");
  }
  const seed = checkedDigest(
    input.keccak256,
    concat(bytes32(input.effectId), uint256(input.drawingId), uint32(input.ticketIndex)),
  );
  const nextByte = streamBytes(seed, input.keccak256);
  const normals = new Set<number>();
  while (normals.size < 5) normals.add((nextByte() % input.ballMax) + 1);
  const sorted = [...normals].sort((left, right) => left - right);
  const [one, two, three, four, five] = sorted;
  if (
    one === undefined ||
    two === undefined ||
    three === undefined ||
    four === undefined ||
    five === undefined
  ) {
    throw new MegapotPoolInvariantError("invalid-digest");
  }
  return {
    normals: [one, two, three, four, five],
    bonusball: (nextByte() % input.bonusballMax) + 1,
  };
}

export function buildMegapotBeneficiarySnapshot(input: {
  readonly poolLegId: string;
  readonly drawingId: bigint;
  readonly termsHash: string;
  readonly fallback: boolean;
  readonly beneficiaries: readonly MegapotSnapshotBeneficiary[];
  readonly sha256: Digest32;
}): MegapotBeneficiarySnapshot {
  if (!validId(input.poolLegId)) throw new MegapotPoolInvariantError("invalid-identifier");
  if (input.drawingId < 0n) throw new MegapotPoolInvariantError("invalid-drawing");
  const terms = bytes32(input.termsHash);
  if (input.beneficiaries.length === 0) {
    throw new MegapotPoolInvariantError("empty-beneficiaries");
  }
  if (input.fallback && input.beneficiaries.length !== 1) {
    throw new MegapotPoolInvariantError("invalid-snapshot");
  }
  const seen = new Set<string>();
  const drawingBytes = uint256(input.drawingId);
  const poolBytes = lengthPrefixed(input.poolLegId);
  const leaves = input.beneficiaries.map((beneficiary) => {
    if (!validId(beneficiary.accountId) || !validId(beneficiary.personaId)) {
      throw new MegapotPoolInvariantError("invalid-identifier");
    }
    if (seen.has(beneficiary.accountId)) {
      throw new MegapotPoolInvariantError("duplicate-beneficiary");
    }
    seen.add(beneficiary.accountId);
    const orderKeyBytes = checkedDigest(
      input.sha256,
      concat(lengthPrefixed(beneficiary.accountId), poolBytes, drawingBytes),
    );
    const leafBytes = checkedDigest(
      input.sha256,
      concat(
        encoder.encode(MEGAPOT_SNAPSHOT_DOMAIN),
        Uint8Array.of(0),
        encoder.encode("leaf"),
        orderKeyBytes,
      ),
    );
    return {
      accountId: beneficiary.accountId,
      personaId: beneficiary.personaId,
      orderKey: hex(orderKeyBytes),
      leafCommitment: hex(leafBytes),
    };
  });
  leaves.sort(
    (left, right) =>
      left.orderKey.localeCompare(right.orderKey) || left.accountId.localeCompare(right.accountId),
  );
  const fallbackByte = Uint8Array.of(input.fallback ? 1 : 0);
  const snapshotHash = hex(
    checkedDigest(
      input.sha256,
      concat(
        encoder.encode(MEGAPOT_SNAPSHOT_DOMAIN),
        Uint8Array.of(0),
        poolBytes,
        drawingBytes,
        terms,
        lengthPrefixed(MEGAPOT_BENEFICIARY_ALGORITHM_VERSION),
        fallbackByte,
        uint32(leaves.length),
        ...leaves.map((leaf) => bytes32(leaf.leafCommitment)),
      ),
    ),
  );
  return {
    privateLeaves: leaves,
    published: {
      domain: MEGAPOT_SNAPSHOT_DOMAIN,
      poolLegId: input.poolLegId,
      drawingId: input.drawingId.toString(),
      termsHash: input.termsHash,
      algorithmVersion: MEGAPOT_BENEFICIARY_ALGORITHM_VERSION,
      fallback: input.fallback,
      leafCount: leaves.length,
      leafCommitments: leaves.map((leaf) => leaf.leafCommitment),
      snapshotHash,
    },
  };
}

export function allocateMegapotWinnings(input: {
  readonly netAtomic: bigint;
  readonly snapshot: MegapotBeneficiarySnapshot;
}): MegapotAllocationOutcome {
  if (input.netAtomic < 0n) throw new MegapotPoolInvariantError("invalid-amount");
  const leaves = input.snapshot.privateLeaves;
  if (
    leaves.length === 0 ||
    leaves.length !== input.snapshot.published.leafCount ||
    leaves.some(
      (leaf, index) => leaf.leafCommitment !== input.snapshot.published.leafCommitments[index],
    )
  ) {
    throw new MegapotPoolInvariantError("invalid-snapshot");
  }
  if (input.snapshot.published.fallback) {
    const sponsor = leaves[0];
    if (leaves.length !== 1 || sponsor === undefined) {
      throw new MegapotPoolInvariantError("invalid-snapshot");
    }
    return {
      kind: "fallback_sponsorship_credit",
      sponsorAccountId: sponsor.accountId,
      sponsorPersonaId: sponsor.personaId,
      amountAtomic: input.netAtomic,
    };
  }
  const count = BigInt(leaves.length);
  const base = input.netAtomic / count;
  const remainder = input.netAtomic % count;
  const allocations = leaves.map((leaf, index) => ({
    accountId: leaf.accountId,
    personaId: leaf.personaId,
    amountAtomic: base + (BigInt(index) < remainder ? 1n : 0n),
    ordinal: index,
  }));
  return { kind: "user_allocations", allocations, totalAtomic: input.netAtomic };
}

export type MegapotPoolDrawingStatus =
  | "entry_open"
  | "cutoff_frozen"
  | "committed"
  | "purchase_pending"
  | "tickets_confirmed"
  | "drawing_pending"
  | "no_win"
  | "winnings_detected"
  | "claim_pending"
  | "claimed"
  | "allocated"
  | "credited"
  | "closed_no_entries"
  | "closed_unfunded"
  | "closed_fallback_ineligible"
  | "closed_fallback_unavailable"
  | "closed_fallback_ceiling"
  | "operational_hold";

export type MegapotPoolDrawing = Readonly<{
  poolLegId: string;
  drawingId: bigint;
  version: number;
  status: MegapotPoolDrawingStatus;
  beneficiaryCount: number;
  fallback: boolean;
  snapshotHash: string | null;
  commitmentRef: string | null;
  purchaseEffectId: string | null;
  ticketIds: readonly bigint[];
  winningsAtomic: bigint | null;
  claimEffectId: string | null;
  allocationBatchId: string | null;
  holdReason: string | null;
}>;

export type MegapotPoolDrawingEvent =
  | Readonly<{
      type: "cutoff";
      expectedVersion: number;
      shareCount: number;
      emptyPoolPolicy: "no_purchase" | "funder_fallback";
      fallbackEligible: boolean;
      activitiesAvailable: boolean;
      ceilingReserved: boolean;
      budgetReserved: boolean;
      snapshotHash: string | null;
    }>
  | Readonly<{
      type: "commitment_published";
      expectedVersion: number;
      commitmentRef: string;
    }>
  | Readonly<{
      type: "purchase_reserved";
      expectedVersion: number;
      purchaseEffectId: string;
    }>
  | Readonly<{
      type: "purchase_confirmed";
      expectedVersion: number;
      ticketIds: readonly bigint[];
    }>
  | Readonly<{ type: "drawing_waiting"; expectedVersion: number }>
  | Readonly<{
      type: "sweep_completed";
      expectedVersion: number;
      winningsAtomic: bigint;
    }>
  | Readonly<{ type: "claim_reserved"; expectedVersion: number; claimEffectId: string }>
  | Readonly<{
      type: "claim_confirmed";
      expectedVersion: number;
      receivedAtomic: bigint;
    }>
  | Readonly<{
      type: "allocation_recorded";
      expectedVersion: number;
      allocationBatchId: string;
    }>
  | Readonly<{ type: "credits_recorded"; expectedVersion: number }>
  | Readonly<{ type: "hold"; expectedVersion: number; reason: string }>;

export function createMegapotPoolDrawing(input: {
  readonly poolLegId: string;
  readonly drawingId: bigint;
}): MegapotPoolDrawing {
  if (!validId(input.poolLegId)) throw new MegapotPoolInvariantError("invalid-identifier");
  if (input.drawingId < 0n) throw new MegapotPoolInvariantError("invalid-drawing");
  return {
    poolLegId: input.poolLegId,
    drawingId: input.drawingId,
    version: 1,
    status: "entry_open",
    beneficiaryCount: 0,
    fallback: false,
    snapshotHash: null,
    commitmentRef: null,
    purchaseEffectId: null,
    ticketIds: [],
    winningsAtomic: null,
    claimEffectId: null,
    allocationBatchId: null,
    holdReason: null,
  };
}

const transitions: Readonly<Record<MegapotPoolDrawingStatus, readonly MegapotPoolDrawingStatus[]>> =
  {
    entry_open: [
      "cutoff_frozen",
      "closed_no_entries",
      "closed_unfunded",
      "closed_fallback_ineligible",
      "closed_fallback_unavailable",
      "closed_fallback_ceiling",
      "operational_hold",
    ],
    cutoff_frozen: ["committed", "operational_hold"],
    committed: ["purchase_pending", "operational_hold"],
    purchase_pending: ["tickets_confirmed", "operational_hold"],
    tickets_confirmed: ["drawing_pending", "operational_hold"],
    drawing_pending: ["no_win", "winnings_detected", "operational_hold"],
    no_win: [],
    winnings_detected: ["claim_pending", "operational_hold"],
    claim_pending: ["claimed", "operational_hold"],
    claimed: ["allocated", "operational_hold"],
    allocated: ["credited", "operational_hold"],
    credited: [],
    closed_no_entries: [],
    closed_unfunded: [],
    closed_fallback_ineligible: [],
    closed_fallback_unavailable: [],
    closed_fallback_ceiling: [],
    operational_hold: [],
  };

function assertDrawingInvariants(state: MegapotPoolDrawing): void {
  if (
    !validId(state.poolLegId) ||
    state.drawingId < 0n ||
    !Number.isSafeInteger(state.version) ||
    state.version < 1 ||
    !Number.isSafeInteger(state.beneficiaryCount) ||
    state.beneficiaryCount < 0 ||
    (state.fallback && state.beneficiaryCount !== 1) ||
    state.ticketIds.some((ticketId) => ticketId < 0n) ||
    new Set(state.ticketIds.map(String)).size !== state.ticketIds.length ||
    (state.winningsAtomic !== null && state.winningsAtomic < 0n)
  ) {
    throw new MegapotPoolInvariantError("invalid-state");
  }
  const afterFreeze = ![
    "entry_open",
    "closed_no_entries",
    "closed_unfunded",
    "closed_fallback_ineligible",
    "closed_fallback_unavailable",
    "closed_fallback_ceiling",
  ].includes(state.status);
  if (afterFreeze && (state.snapshotHash === null || state.beneficiaryCount < 1)) {
    throw new MegapotPoolInvariantError("invalid-state");
  }
  if (
    [
      "committed",
      "purchase_pending",
      "tickets_confirmed",
      "drawing_pending",
      "no_win",
      "winnings_detected",
      "claim_pending",
      "claimed",
      "allocated",
      "credited",
    ].includes(state.status) &&
    state.commitmentRef === null
  ) {
    throw new MegapotPoolInvariantError("invalid-state");
  }
  if (
    [
      "purchase_pending",
      "tickets_confirmed",
      "drawing_pending",
      "no_win",
      "winnings_detected",
      "claim_pending",
      "claimed",
      "allocated",
      "credited",
    ].includes(state.status) &&
    state.purchaseEffectId === null
  ) {
    throw new MegapotPoolInvariantError("invalid-state");
  }
  if (
    [
      "tickets_confirmed",
      "drawing_pending",
      "no_win",
      "winnings_detected",
      "claim_pending",
      "claimed",
      "allocated",
      "credited",
    ].includes(state.status) &&
    state.ticketIds.length !== 1
  ) {
    throw new MegapotPoolInvariantError("invalid-state");
  }
}

const megapotPoolDrawingMachine = defineMoneyFlowMachine<
  MegapotPoolDrawing,
  MegapotPoolDrawingEvent,
  MegapotPoolDrawingStatus
>({
  stateOf: (state) => state.status,
  allowedTransitions: transitions,
  assertInvariants: assertDrawingInvariants,
  reduce: (state, event) => {
    if (event.expectedVersion !== state.version) return rejectTransition("stale_version");
    if (event.type === "hold") {
      if (!validId(event.reason)) return rejectTransition("invalid_hold_reason");
      return {
        ...state,
        version: state.version + 1,
        status: "operational_hold",
        holdReason: event.reason,
      };
    }
    if (event.type === "cutoff") {
      if (
        state.status !== "entry_open" ||
        !Number.isSafeInteger(event.shareCount) ||
        event.shareCount < 0
      ) {
        return rejectTransition("invalid_cutoff");
      }
      if (event.shareCount === 0 && event.emptyPoolPolicy === "no_purchase") {
        return { ...state, version: state.version + 1, status: "closed_no_entries" };
      }
      if (event.shareCount === 0) {
        if (!event.fallbackEligible) {
          return { ...state, version: state.version + 1, status: "closed_fallback_ineligible" };
        }
        if (!event.activitiesAvailable) {
          return { ...state, version: state.version + 1, status: "closed_fallback_unavailable" };
        }
        if (!event.ceilingReserved) {
          return { ...state, version: state.version + 1, status: "closed_fallback_ceiling" };
        }
      }
      if (!event.budgetReserved) {
        return { ...state, version: state.version + 1, status: "closed_unfunded" };
      }
      if (event.snapshotHash === null || !bytes32Pattern.test(event.snapshotHash)) {
        return rejectTransition("snapshot_required");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "cutoff_frozen",
        beneficiaryCount: event.shareCount === 0 ? 1 : event.shareCount,
        fallback: event.shareCount === 0,
        snapshotHash: event.snapshotHash,
      };
    }
    if (event.type === "commitment_published") {
      if (state.status !== "cutoff_frozen" || !validId(event.commitmentRef)) {
        return rejectTransition("commitment_not_allowed");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "committed",
        commitmentRef: event.commitmentRef,
      };
    }
    if (event.type === "purchase_reserved") {
      if (state.status !== "committed" || !validId(event.purchaseEffectId)) {
        return rejectTransition("purchase_not_allowed");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "purchase_pending",
        purchaseEffectId: event.purchaseEffectId,
      };
    }
    if (event.type === "purchase_confirmed") {
      if (
        state.status !== "purchase_pending" ||
        event.ticketIds.length !== 1 ||
        event.ticketIds[0] === undefined ||
        event.ticketIds[0] < 0n
      ) {
        return rejectTransition("ticket_confirmation_invalid");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "tickets_confirmed",
        ticketIds: [event.ticketIds[0]],
      };
    }
    if (event.type === "drawing_waiting") {
      if (state.status !== "tickets_confirmed") return rejectTransition("drawing_wait_not_allowed");
      return { ...state, version: state.version + 1, status: "drawing_pending" };
    }
    if (event.type === "sweep_completed") {
      if (state.status !== "drawing_pending" || event.winningsAtomic < 0n) {
        return rejectTransition("sweep_invalid");
      }
      return {
        ...state,
        version: state.version + 1,
        status: event.winningsAtomic === 0n ? "no_win" : "winnings_detected",
        winningsAtomic: event.winningsAtomic,
      };
    }
    if (event.type === "claim_reserved") {
      if (state.status !== "winnings_detected" || !validId(event.claimEffectId)) {
        return rejectTransition("claim_not_allowed");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "claim_pending",
        claimEffectId: event.claimEffectId,
      };
    }
    if (event.type === "claim_confirmed") {
      if (state.status !== "claim_pending" || event.receivedAtomic < 0n) {
        return rejectTransition("claim_confirmation_invalid");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "claimed",
        winningsAtomic: event.receivedAtomic,
      };
    }
    if (event.type === "allocation_recorded") {
      if (state.status !== "claimed" || !validId(event.allocationBatchId)) {
        return rejectTransition("allocation_not_allowed");
      }
      return {
        ...state,
        version: state.version + 1,
        status: "allocated",
        allocationBatchId: event.allocationBatchId,
      };
    }
    if (event.type === "credits_recorded") {
      if (state.status !== "allocated") return rejectTransition("credit_not_allowed");
      return { ...state, version: state.version + 1, status: "credited" };
    }
    return rejectTransition("event_not_allowed");
  },
});

export function transitionMegapotPoolDrawing(
  state: MegapotPoolDrawing,
  event: MegapotPoolDrawingEvent,
): MegapotPoolDrawing | TransitionRejection {
  return transitionMachineEvent(megapotPoolDrawingMachine, state, event);
}
