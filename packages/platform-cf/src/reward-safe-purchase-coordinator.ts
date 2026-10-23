import type { ControlPlaneDb } from "@pirate/application";
import { deriveMegapotTicket } from "@pirate/domain";
import { Effect } from "effect";
import { hexToBytes } from "viem";
import { deriveMegapotPurchaseEffectId } from "./megapot-purchase-coordinator.ts";
import { makeControlPlaneMegapotPurchaseStore } from "./megapot-purchase-repository.ts";
import {
  encodeMegapotBuyTickets,
  MEGAPOT_REFERRAL_SPLIT_SCALE,
  MegapotV2EvidenceInvalid,
  megapotKeccak256,
  validateMegapotPurchaseReceipt,
} from "./megapot-v2.ts";
import { rewardSafeCall, rewardSafeTransactionBuilderFile } from "./reward-safe-command.ts";
import { makeControlPlaneRewardSafePurchaseStore } from "./reward-safe-purchase-repository.ts";
import {
  admitRewardSafeDeployment,
  assertRewardSafeRuntimeOptions,
  type RewardSafeRuntimeOptions,
  readRewardSafeExecution,
  rewardSafeFailed,
  sha256Hex,
} from "./reward-safe-settlement.ts";

/**
 * Ticket-first purchases for owner-executed Safe pools. Pirate prepares the drawing's
 * one ticket purchase and creates the drawing in ticket_pending; entries open only when
 * reconciliation confirms the ticket in that drawing, owned by the Safe. A late
 * execution that lands in another drawing never moves anyone: it is held.
 */
/** The pilot cycle runs every minute. */
const PILOT_CYCLE_MS = 60_000;

type RewardSafePurchaseSettlement = NonNullable<
  Effect.Success<
    ReturnType<ReturnType<typeof makeControlPlaneRewardSafePurchaseStore>["loadSettlement"]>
  >
>;

/**
 * Everything the chain must show before a bound purchase may count as a ticket: the
 * canonical receipt of the exact prepared call, a ticket for the intended drawing, and
 * the Safe as its owner at that block. Settlement and the late purchase recovery both
 * decide from this alone. `held` names why the evidence does not qualify.
 */
export function verifyRewardSafePurchase(
  options: RewardSafeRuntimeOptions,
  settlement: RewardSafePurchaseSettlement,
) {
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });
  return Effect.gen(function* () {
    const execution = yield* readRewardSafeExecution(options, {
      effectId: settlement.effectId,
      chainId: settlement.deployment.chainId,
      safeAddress: settlement.deployment.custodyAddress,
      to: settlement.deployment.jackpotAddress,
      calldata: settlement.calldata,
      safeNonce: settlement.safeNonce,
      transactionHash: settlement.transactionHash,
      recordedOutcome: settlement.outcome,
      observedAt: settlement.observedAt,
    });
    if (execution.kind === "pending") return { kind: "pending" as const };
    if (execution.kind === "invalid") return { kind: "held" as const, reason: execution.reason };
    if (execution.outcome === "failure") return { kind: "failed" as const, execution };
    let evidence: ReturnType<typeof validateMegapotPurchaseReceipt>;
    try {
      evidence = validateMegapotPurchaseReceipt({
        deployment: settlement.deployment,
        receipt: execution.receipt,
        drawingId: settlement.drawingId,
        source: settlement.sourceTag,
        tickets: [settlement.ticket],
        safeExecution: { command: execution.command, transaction: execution.transaction },
      });
    } catch (error) {
      // Includes a late execution that bought a ticket in a later drawing.
      return {
        kind: "held" as const,
        reason:
          error instanceof MegapotV2EvidenceInvalid && error.reason === "wrong-drawing"
            ? "safe_purchase_wrong_drawing"
            : "safe_purchase_receipt_invalid",
      };
    }
    const ticketId = evidence.ticketIds[0];
    const purchaseLogIndex = evidence.purchaseLogIndices[0];
    const mintLogIndex = evidence.mintLogIndices[0];
    if (ticketId === undefined || purchaseLogIndex === undefined || mintLogIndex === undefined) {
      return { kind: "held" as const, reason: "safe_purchase_receipt_incomplete" };
    }
    const owner = yield* rpc(() =>
      options.rpc.readTicketOwner(ticketId, execution.receipt.blockNumber),
    );
    if (owner.toLowerCase() !== settlement.deployment.custodyAddress.toLowerCase()) {
      return { kind: "held" as const, reason: "safe_purchase_ticket_owner_mismatch" };
    }
    return {
      kind: "verified" as const,
      execution,
      evidence,
      ticketId,
      purchaseLogIndex,
      mintLogIndex,
    };
  });
}

export function makeRewardSafePurchaseCoordinator(
  options: RewardSafeRuntimeOptions &
    Readonly<{
      /** Entry time that must remain after a ticket confirms; also the purchase deadline. */
      minimumEntrySeconds: number;
      /** Blocks the pilot cycle scans per run; defaults to one window. */
      scanBlocksPerCycle?: number;
    }>,
) {
  assertRewardSafeRuntimeOptions(options);
  const scanBlocksPerCycle = options.scanBlocksPerCycle ?? options.maximumScanBlocks;
  if (
    !Number.isSafeInteger(options.minimumEntrySeconds) ||
    options.minimumEntrySeconds < 60 ||
    !Number.isSafeInteger(scanBlocksPerCycle) ||
    scanBlocksPerCycle < 1
  ) {
    throw rewardSafeFailed("invalid_config");
  }
  const now = options.now ?? Date.now;
  const purchases = makeControlPlaneRewardSafePurchaseStore();
  const ledger = makeControlPlaneMegapotPurchaseStore(options.layer);
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(options.layer)(effect);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({ try: operation, catch: () => rewardSafeFailed("rpc_unavailable") });

  const prepare = Effect.fn("RewardSafePurchaseCoordinator.prepare")(function* (legId: string) {
    const candidate = yield* provide(
      purchases.loadCandidate({ legId, minimumEntrySeconds: options.minimumEntrySeconds }),
    );
    if (candidate === null) return { kind: "no_drawing" as const };
    yield* admitRewardSafeDeployment(options, candidate.deployment);
    const effectId = deriveMegapotPurchaseEffectId(candidate.legId, candidate.drawingId);
    const ticket = deriveMegapotTicket({
      effectId,
      drawingId: candidate.drawingId,
      ticketIndex: 0,
      ballMax: candidate.ballMax,
      bonusballMax: candidate.bonusballMax,
      keccak256: megapotKeccak256,
    });
    const call = rewardSafeCall({
      effectId,
      to: candidate.deployment.jackpotAddress,
      data: encodeMegapotBuyTickets({
        tickets: [ticket],
        recipient: candidate.deployment.custodyAddress,
        referrers: [candidate.deployment.referrerAddress],
        referralSplit: [MEGAPOT_REFERRAL_SPLIT_SCALE],
        source: candidate.sourceTag,
      }),
    });
    const [allowance, balance, head] = yield* rpc(() =>
      Promise.all([
        options.rpc.readUsdcAllowance(
          candidate.deployment.custodyAddress,
          candidate.deployment.jackpotAddress,
        ),
        options.rpc.readUsdcBalance(candidate.deployment.custodyAddress),
        options.rpc.readHead(),
      ]),
    );
    // The owner sets the Safe's Jackpot allowance once; Pirate never spends without it.
    if (allowance < candidate.ticketPriceAtomic) return { kind: "allowance_insufficient" as const };
    if (balance < candidate.ticketPriceAtomic) return { kind: "balance_insufficient" as const };
    // The scan must reach the owner's execution before the purchase deadline, or a real
    // ticket ends in reconciliation, as drawing 11161 did in the October 23 rehearsal.
    // It needs the cycles to catch up to the settled head, then one more to bind.
    const cursor = yield* provide(
      purchases.scanCursor({
        chainId: candidate.deployment.chainId,
        safeAddress: candidate.deployment.custodyAddress,
      }),
    );
    const settledHead = head.blockNumber - BigInt(options.requiredConfirmations - 1);
    const lagBlocks = cursor === null || settledHead < cursor ? 0n : settledHead - cursor + 1n;
    const perCycle = BigInt(scanBlocksPerCycle);
    const cycles = (lagBlocks + perCycle - 1n) / perCycle + 1n;
    const purchaseDeadline =
      Date.parse(candidate.entryCutoffAt) - options.minimumEntrySeconds * 1_000;
    if (now() + Number(cycles) * PILOT_CYCLE_MS >= purchaseDeadline) {
      return { kind: "scan_lagging" as const };
    }
    const calldataHash = yield* rpc(() => sha256Hex(hexToBytes(call.data)));
    const preparedBlockNumber = yield* provide(
      purchases.prepare({
        effectId,
        candidate,
        ticket,
        calldata: call.data,
        calldataHash,
        headBlockNumber: head.blockNumber,
      }),
    );
    return {
      kind: "prepared" as const,
      effectId,
      drawingId: candidate.drawingId,
      preparedBlockNumber,
      transactionBuilderFile: rewardSafeTransactionBuilderFile({
        chainId: candidate.deployment.chainId,
        safeAddress: candidate.deployment.custodyAddress,
        call,
        name: `Pirate ticket ${candidate.legId} drawing ${candidate.drawingId}`,
        description: `One Megapot ticket for drawing ${candidate.drawingId}; execute before ${candidate.entryCutoffAt}`,
        createdAtMs: now(),
      }),
    };
  });

  /** Confirm a bound purchase: the ticket must be the Safe's, in the intended drawing. */
  const settle = Effect.fn("RewardSafePurchaseCoordinator.settle")(function* (effectId: string) {
    const settlement = yield* provide(purchases.loadSettlement(effectId));
    if (settlement === null) return { kind: "not_bound" as const };
    yield* admitRewardSafeDeployment(options, settlement.deployment);
    const hold = Effect.fn("RewardSafePurchaseCoordinator.hold")(function* (reason: string) {
      yield* ledger.requireReconciliation({
        effectId,
        transactionHash: settlement.transactionHash,
        reason,
      });
      yield* provide(purchases.holdDrawing({ effectId, reason }));
      return { kind: "reconciliation_required" as const, reason };
    });
    const verified = yield* verifyRewardSafePurchase(options, settlement);
    if (verified.kind === "pending") return { kind: "pending" as const };
    if (verified.kind === "held") return yield* hold(verified.reason);
    if (verified.kind === "failed") {
      const { execution } = verified;
      yield* provide(
        purchases.releaseFailedExecution({
          effectId,
          transactionHash: settlement.transactionHash,
          blockNumber: execution.receipt.blockNumber,
          blockHash: execution.receipt.blockHash,
          receiptHash: execution.receiptHash,
          confirmations: execution.confirmations,
          confirmedAt: execution.confirmedAt,
        }),
      );
      return { kind: "released" as const };
    }
    const { execution, evidence, ticketId, purchaseLogIndex, mintLogIndex } = verified;
    const confirmed = yield* ledger
      .confirm({
        effectId,
        transactionHash: settlement.transactionHash,
        ticketId,
        purchaseLogIndex,
        mintLogIndex,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        receiptHash: execution.receiptHash,
        confirmations: execution.confirmations,
        referralFeesAtomic: evidence.referralFeesAtomic,
        lpEarningsAtomic: evidence.lpEarningsAtomic,
        confirmedAt: execution.confirmedAt,
      })
      .pipe(
        Effect.map(() => true),
        // The drawing closed before this execution: the ticket is real but too late.
        Effect.catchTag("MegapotPurchaseRejected", () => Effect.succeed(false)),
      );
    if (!confirmed) return yield* hold("safe_purchase_after_close");
    return { kind: "confirmed" as const, ticketId, drawingId: settlement.drawingId };
  });

  const closeUnexecuted = Effect.fn("RewardSafePurchaseCoordinator.closeUnexecuted")(function* (
    limit: number,
  ) {
    return yield* provide(
      purchases.closeUnexecuted({ minimumEntrySeconds: options.minimumEntrySeconds, limit }),
    );
  });

  return { prepare, settle, closeUnexecuted };
}
