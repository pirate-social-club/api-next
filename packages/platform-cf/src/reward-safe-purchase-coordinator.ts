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
export function makeRewardSafePurchaseCoordinator(
  options: RewardSafeRuntimeOptions &
    Readonly<{
      /** Entry time that must remain after a ticket confirms; also the purchase deadline. */
      minimumEntrySeconds: number;
    }>,
) {
  assertRewardSafeRuntimeOptions(options);
  if (!Number.isSafeInteger(options.minimumEntrySeconds) || options.minimumEntrySeconds < 60) {
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
    const execution = yield* readRewardSafeExecution(options, {
      effectId,
      safeAddress: settlement.deployment.custodyAddress,
      to: settlement.deployment.jackpotAddress,
      calldata: settlement.calldata,
      safeNonce: settlement.safeNonce,
      transactionHash: settlement.transactionHash,
      recordedOutcome: settlement.outcome,
      observedAt: settlement.observedAt,
    });
    if (execution.kind === "pending") return { kind: "pending" as const };
    if (execution.kind === "invalid") return yield* hold(execution.reason);
    if (execution.outcome === "failure") {
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
      return yield* hold(
        error instanceof MegapotV2EvidenceInvalid && error.reason === "wrong-drawing"
          ? "safe_purchase_wrong_drawing"
          : "safe_purchase_receipt_invalid",
      );
    }
    const ticketId = evidence.ticketIds[0];
    const purchaseLogIndex = evidence.purchaseLogIndices[0];
    const mintLogIndex = evidence.mintLogIndices[0];
    if (ticketId === undefined || purchaseLogIndex === undefined || mintLogIndex === undefined) {
      return yield* hold("safe_purchase_receipt_incomplete");
    }
    const owner = yield* rpc(() =>
      options.rpc.readTicketOwner(ticketId, execution.receipt.blockNumber),
    );
    if (owner.toLowerCase() !== settlement.deployment.custodyAddress.toLowerCase()) {
      return yield* hold("safe_purchase_ticket_owner_mismatch");
    }
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
