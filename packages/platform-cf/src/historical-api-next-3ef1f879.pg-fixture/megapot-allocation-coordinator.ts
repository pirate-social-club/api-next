import type {
  MegapotAllocationCandidate,
  MegapotAllocationFailure,
  MegapotAllocationResult,
  MegapotAllocationStore,
  MegapotPreparedAllocation,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { keccak256, toBytes } from "viem";

export class MegapotAllocationCoordinatorFailed extends Data.TaggedError(
  "MegapotAllocationCoordinatorFailed",
)<{
  readonly reason: "allocation_invalid";
}> {}

const failed = () => new MegapotAllocationCoordinatorFailed({ reason: "allocation_invalid" });

export function deriveMegapotAllocationBatchId(
  poolLegId: string,
  drawingId: bigint,
  claimEffectId: string,
): string {
  if (
    poolLegId.length === 0 ||
    poolLegId !== poolLegId.trim() ||
    drawingId < 0n ||
    claimEffectId.length === 0 ||
    claimEffectId !== claimEffectId.trim()
  ) {
    throw failed();
  }
  return keccak256(
    toBytes(
      `pirate.megapot-allocation-batch.v1\u0000${poolLegId}\u0000${drawingId}\u0000${claimEffectId}`,
    ),
  );
}

export function deriveMegapotAllocationCreditId(
  allocationBatchId: string,
  ordinal: number,
  accountId: string,
): string {
  if (
    allocationBatchId.length === 0 ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    accountId.length === 0 ||
    accountId !== accountId.trim()
  ) {
    throw failed();
  }
  return keccak256(
    toBytes(
      `pirate.megapot-allocation-credit.v1\u0000${allocationBatchId}\u0000${ordinal}\u0000${accountId}`,
    ),
  );
}

function allocationKind(
  candidate: MegapotAllocationCandidate,
): MegapotPreparedAllocation["allocationKind"] {
  if (!candidate.fallback) return "participant";
  return candidate.fundingSource === "leg_budget" ? "external_fallback" : "platform_sponsorship";
}

export function prepareEqualMegapotAllocations(
  candidate: MegapotAllocationCandidate,
  allocationBatchId: string,
): readonly MegapotPreparedAllocation[] {
  const leaves = candidate.leaves;
  if (
    candidate.algorithmVersion !== "equal_v1" ||
    candidate.netWinningsAtomic <= 0n ||
    leaves.length === 0 ||
    candidate.netWinningsAtomic < BigInt(leaves.length) ||
    (candidate.fallback && leaves.length !== 1)
  ) {
    throw failed();
  }

  const seenAccounts = new Set<string>();
  for (const [ordinal, leaf] of leaves.entries()) {
    if (
      leaf.ordinal !== ordinal ||
      leaf.accountId.length === 0 ||
      leaf.personaId.length === 0 ||
      seenAccounts.has(leaf.accountId)
    ) {
      throw failed();
    }
    seenAccounts.add(leaf.accountId);
  }

  if (candidate.fallback) {
    const leaf = leaves[0];
    if (
      leaf === undefined ||
      candidate.fallbackBeneficiaryAccountId !== leaf.accountId ||
      (candidate.fundingSource === "leg_budget" &&
        candidate.fallbackPayoutPersonaId !== leaf.personaId) ||
      (candidate.fundingSource === "shared_sponsor_budget" &&
        candidate.fallbackPayoutPersonaId !== null)
    ) {
      throw failed();
    }
  }

  const count = BigInt(leaves.length);
  const base = candidate.netWinningsAtomic / count;
  const remainder = candidate.netWinningsAtomic - base * count;
  const kind = allocationKind(candidate);
  return leaves.map((leaf) => {
    const amountAtomic = base + (BigInt(leaf.ordinal) < remainder ? 1n : 0n);
    const creditId =
      kind === "platform_sponsorship"
        ? null
        : deriveMegapotAllocationCreditId(allocationBatchId, leaf.ordinal, leaf.accountId);
    return {
      ordinal: leaf.ordinal,
      accountId: leaf.accountId,
      personaId: leaf.personaId,
      amountAtomic,
      allocationKind: kind,
      creditId,
      creditSourceReference:
        creditId === null ? null : `${allocationBatchId}:${leaf.ordinal.toString(10)}`,
    };
  });
}

const sha256Hex = Effect.fn("megapotAllocationSha256Hex")(function* (input: string) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", toBytes(input)),
    catch: () => failed(),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

function allocationPreimage(
  candidate: MegapotAllocationCandidate,
  allocationBatchId: string,
  allocations: readonly MegapotPreparedAllocation[],
): string {
  return [
    "pirate.megapot-allocation.v1",
    allocationBatchId,
    candidate.poolLegId,
    candidate.drawingId.toString(10),
    candidate.snapshotId,
    candidate.claimEffectId,
    candidate.netWinningsAtomic.toString(10),
    ...allocations.map((allocation) =>
      [
        allocation.ordinal.toString(10),
        allocation.accountId,
        allocation.personaId,
        allocation.amountAtomic.toString(10),
        allocation.allocationKind,
        allocation.creditId ?? "",
      ].join("\u0000"),
    ),
  ].join("\u0000");
}

export interface MegapotAllocationCoordinator {
  readonly allocate: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<
    MegapotAllocationResult,
    MegapotAllocationCoordinatorFailed | MegapotAllocationFailure
  >;
}

export function makeMegapotAllocationCoordinator(input: {
  readonly store: MegapotAllocationStore;
  readonly now?: () => number;
}): MegapotAllocationCoordinator {
  const now = input.now ?? Date.now;
  return {
    allocate: Effect.fn("MegapotAllocationCoordinator.allocate")(function* (request) {
      const candidate = yield* input.store.loadCandidate(request);
      const allocationBatchId = deriveMegapotAllocationBatchId(
        candidate.poolLegId,
        candidate.drawingId,
        candidate.claimEffectId,
      );
      const existing = yield* input.store.findResult(allocationBatchId);
      if (existing !== null) return existing;

      const allocations = prepareEqualMegapotAllocations(candidate, allocationBatchId);
      const allocationHash = yield* sha256Hex(
        allocationPreimage(candidate, allocationBatchId, allocations),
      );
      return yield* input.store.credit({
        candidate,
        allocationBatchId,
        allocationHash,
        allocations,
        creditedAt: new Date(now()).toISOString(),
      });
    }),
  };
}
