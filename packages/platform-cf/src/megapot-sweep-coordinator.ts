import type {
  MegapotSweepFailure,
  MegapotSweepResult,
  MegapotSweepStore,
} from "@pirate/application";
import { Data, Effect } from "effect";
import { keccak256, toBytes } from "viem";
import { MEGAPOT_REFERRAL_SPLIT_SCALE } from "./megapot-v2.ts";
import type { MegapotV2RpcClient } from "./megapot-v2-rpc.ts";

export class MegapotSweepCoordinatorFailed extends Data.TaggedError(
  "MegapotSweepCoordinatorFailed",
)<{
  readonly reason:
    | "deployment_attestation_mismatch"
    | "drawing_evidence_invalid"
    | "invalid_config"
    | "production_disabled"
    | "ticket_owner_mismatch";
}> {}

export type MegapotSweepCoordinatorResult =
  | Readonly<{
      kind: "drawing_pending";
      poolLegId: string;
      drawingId: bigint;
      observationBlockNumber: bigint | null;
    }>
  | (MegapotSweepResult & Readonly<{ kind: "complete" }>);

export interface MegapotSweepCoordinator {
  readonly sweep: (input: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) => Effect.Effect<
    MegapotSweepCoordinatorResult,
    MegapotSweepCoordinatorFailed | MegapotSweepFailure
  >;
}

const failed = (reason: MegapotSweepCoordinatorFailed["reason"]): MegapotSweepCoordinatorFailed =>
  new MegapotSweepCoordinatorFailed({ reason });

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function deriveMegapotSweepId(poolLegId: string, drawingId: bigint): string {
  if (poolLegId.length === 0 || poolLegId !== poolLegId.trim() || drawingId < 0n) {
    throw failed("invalid_config");
  }
  return keccak256(toBytes(`pirate.megapot.drawing-sweep.v1\u0000${poolLegId}\u0000${drawingId}`));
}

const sha256Hex = Effect.fn("megapotSweepSha256Hex")(function* (input: string) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", toBytes(input)),
    catch: () => failed("drawing_evidence_invalid"),
  });
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
});

function completed(result: MegapotSweepResult): MegapotSweepCoordinatorResult {
  return { kind: "complete", ...result };
}

export function makeMegapotSweepCoordinator(input: {
  readonly store: MegapotSweepStore;
  readonly rpc: MegapotV2RpcClient;
  readonly requiredConfirmations: number;
  readonly now?: () => number;
}): MegapotSweepCoordinator {
  if (!Number.isSafeInteger(input.requiredConfirmations) || input.requiredConfirmations < 1) {
    throw failed("invalid_config");
  }
  const now = input.now ?? Date.now;
  const rpcEffect = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: () => failed("drawing_evidence_invalid"),
    });

  const sweep = Effect.fn("MegapotSweepCoordinator.sweep")(function* (command: {
    readonly poolLegId: string;
    readonly drawingId: bigint;
  }) {
    const sweepId = deriveMegapotSweepId(command.poolLegId, command.drawingId);
    const existing = yield* input.store.findResult(sweepId);
    if (existing !== null) return completed(existing);
    const candidate = yield* input.store.loadCandidate(command);
    if (candidate.environment === "production" || candidate.chainId !== 84_532) {
      return yield* failed("production_disabled");
    }
    yield* rpcEffect(() => input.rpc.attestDeployment()).pipe(
      Effect.mapError(() => failed("deployment_attestation_mismatch")),
    );
    const head = yield* rpcEffect(() => input.rpc.readHead());
    const confirmationOffset = BigInt(input.requiredConfirmations - 1);
    if (head.blockNumber < confirmationOffset) {
      yield* input.store.markDrawingPending(candidate);
      return {
        kind: "drawing_pending",
        poolLegId: candidate.poolLegId,
        drawingId: candidate.drawingId,
        observationBlockNumber: null,
      } as const;
    }
    const observationBlockNumber = head.blockNumber - confirmationOffset;
    const [block, currentDrawingId, drawingState] = yield* rpcEffect(() =>
      Promise.all([
        input.rpc.readBlock(observationBlockNumber),
        input.rpc.readCurrentDrawingId(observationBlockNumber),
        input.rpc.readDrawing(candidate.drawingId, observationBlockNumber),
      ]),
    );
    if (currentDrawingId <= candidate.drawingId || drawingState.winningTicket === 0n) {
      yield* input.store.markDrawingPending(candidate);
      return {
        kind: "drawing_pending",
        poolLegId: candidate.poolLegId,
        drawingId: candidate.drawingId,
        observationBlockNumber,
      } as const;
    }
    const [tierIds, tierPayouts, owner] = yield* rpcEffect(() =>
      Promise.all([
        input.rpc.readTicketTierIds([candidate.ticketId], observationBlockNumber),
        input.rpc.readDrawingTierPayouts(candidate.drawingId, observationBlockNumber),
        input.rpc.readTicketOwner(candidate.ticketId, observationBlockNumber),
      ]),
    );
    const tierIdBig = tierIds[0];
    if (
      tierIdBig === undefined ||
      tierIdBig > 11n ||
      tierPayouts.length !== 12 ||
      !sameAddress(owner, candidate.custodyAddress)
    ) {
      return yield* failed(
        !sameAddress(owner, candidate.custodyAddress)
          ? "ticket_owner_mismatch"
          : "drawing_evidence_invalid",
      );
    }
    const tierId = Number(tierIdBig);
    const grossWinningsAtomic = tierPayouts[tierId];
    if (grossWinningsAtomic === undefined) return yield* failed("drawing_evidence_invalid");
    const winning = tierId !== 0 && tierId !== 2;
    if ((winning && grossWinningsAtomic < 1n) || (!winning && grossWinningsAtomic !== 0n)) {
      return yield* failed("drawing_evidence_invalid");
    }
    const referralAccrualAtomic =
      (grossWinningsAtomic * drawingState.referralWinShare) / MEGAPOT_REFERRAL_SPLIT_SCALE;
    const netWinningsAtomic = grossWinningsAtomic - referralAccrualAtomic;
    const drawingStateHash = yield* sha256Hex(
      JSON.stringify({
        drawingId: candidate.drawingId.toString(),
        currentDrawingId: currentDrawingId.toString(),
        prizePool: drawingState.prizePool.toString(),
        referralWinShare: drawingState.referralWinShare.toString(),
        winningTicket: drawingState.winningTicket.toString(),
        ballMax: drawingState.ballMax,
        bonusballMax: drawingState.bonusballMax,
        payoutCalculator: drawingState.payoutCalculator,
        ticketId: candidate.ticketId.toString(),
        tierId,
        grossWinningsAtomic: grossWinningsAtomic.toString(),
        referralAccrualAtomic: referralAccrualAtomic.toString(),
        netWinningsAtomic: netWinningsAtomic.toString(),
      }),
    );
    const result = yield* input.store.complete({
      candidate,
      sweepId,
      observationBlockNumber,
      observationBlockHash: block.blockHash,
      drawingStateHash,
      tierId,
      custodyOwnerAddress: owner.toLowerCase(),
      grossWinningsAtomic,
      referralWinShareAtomic: drawingState.referralWinShare,
      referralAccrualAtomic,
      netWinningsAtomic,
      observedAt: new Date(now()).toISOString(),
    });
    return completed(result);
  });

  return { sweep };
}
