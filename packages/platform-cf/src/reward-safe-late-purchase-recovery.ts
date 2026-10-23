import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { verifyRewardSafePurchase } from "./reward-safe-purchase-coordinator.ts";
import { makeControlPlaneRewardSafePurchaseStore } from "./reward-safe-purchase-repository.ts";
import {
  admitRewardSafeDeployment,
  assertRewardSafeRuntimeOptions,
  type RewardSafeRuntimeOptions,
} from "./reward-safe-settlement.ts";

type HeldPurchase = Effect.Success<
  ReturnType<ReturnType<typeof makeControlPlaneRewardSafePurchaseStore>["loadHeld"]>
>[number];

/**
 * The owner procedure for a Safe ticket purchase that executed after its ticket-first
 * drawing closed unexecuted. Settlement holds such a purchase with its reservation,
 * which the solvency observation then counts on top of the USDC already spent.
 *
 * Only a purchase held as `safe_purchase_after_close`, whose drawing closed as
 * `safe_purchase_not_executed`, is assessed, and only fresh chain evidence through the
 * same verifier as settlement makes it recoverable. Anything else, a pending or
 * unreadable receipt included, stays held. Recovery itself is the owner-only database
 * function, which also requires paused operations and the assessed effect version.
 */
export function makeRewardSafeLatePurchaseRecovery(options: RewardSafeRuntimeOptions) {
  assertRewardSafeRuntimeOptions(options);
  const now = options.now ?? Date.now;
  const purchases = makeControlPlaneRewardSafePurchaseStore();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(options.layer)(effect);

  const assess = Effect.fn("RewardSafeLatePurchaseRecovery.assess")(function* (held: HeldPurchase) {
    const subject = {
      effectId: held.effectId,
      legId: held.legId,
      drawingId: held.drawingId,
      transactionHash: held.transactionHash,
      safeNonce: held.safeNonce,
      costAtomic: held.reservedAtomic,
    };
    const stays = (reason: string) => ({ kind: "held" as const, ...subject, reason });
    if (
      held.failureReason !== "safe_purchase_after_close" ||
      held.drawingStatus !== "closed_purchase_unavailable" ||
      held.drawingTerminalReason !== "safe_purchase_not_executed"
    ) {
      return stays(held.failureReason ?? "safe_purchase_held");
    }
    yield* admitRewardSafeDeployment(options, held.deployment);
    const verifiedAt = new Date(now()).toISOString();
    const verified = yield* verifyRewardSafePurchase(options, held).pipe(
      Effect.catchTag("RewardSafeSettlementFailed", (error) =>
        Effect.succeed({ kind: "unreadable" as const, reason: error.reason }),
      ),
    );
    if (verified.kind === "unreadable") return stays(`safe_execution_${verified.reason}`);
    if (verified.kind === "pending") return stays("safe_execution_pending");
    if (verified.kind === "failed") return stays("safe_purchase_execution_failed");
    if (verified.kind === "held") return stays(verified.reason);
    return {
      kind: "recoverable" as const,
      ...subject,
      effectVersion: held.effectVersion,
      ticketId: verified.ticketId,
      purchaseLogIndex: verified.purchaseLogIndex,
      mintLogIndex: verified.mintLogIndex,
      blockNumber: verified.evidence.blockNumber,
      blockHash: verified.evidence.blockHash,
      receiptHash: verified.execution.receiptHash,
      confirmations: verified.execution.confirmations,
      referralFeesAtomic: verified.evidence.referralFeesAtomic,
      lpEarningsAtomic: verified.evidence.lpEarningsAtomic,
      verifiedAt,
    };
  });

  /** Held purchases of the attestation, or the one named, if it is the attestation's. */
  const load = (input: { readonly attestationId: string; readonly effectId?: string }) =>
    provide(
      purchases.loadHeld(
        input.effectId === undefined
          ? { attestationId: input.attestationId }
          : { effectId: input.effectId },
      ),
    ).pipe(
      Effect.map((held) =>
        held.filter((row) => row.deployment.attestationId === input.attestationId),
      ),
    );

  /** Read-only: what recovery would do for each held purchase. */
  const inspect = Effect.fn("RewardSafeLatePurchaseRecovery.inspect")(function* (input: {
    readonly attestationId: string;
    readonly effectId?: string;
  }) {
    return yield* Effect.forEach(yield* load(input), assess);
  });

  /** Re-verifies one purchase on chain and settles it, or reports why it stays held. */
  const recover = Effect.fn("RewardSafeLatePurchaseRecovery.recover")(function* (input: {
    readonly attestationId: string;
    readonly effectId: string;
    readonly brakeRevision: bigint;
  }) {
    const [held] = yield* load(input);
    if (held === undefined) return { kind: "not_held" as const, effectId: input.effectId };
    const assessed = yield* assess(held);
    if (assessed.kind !== "recoverable") return assessed;
    yield* provide(purchases.recoverLate({ ...assessed, brakeRevision: input.brakeRevision }));
    return { ...assessed, kind: "recovered" as const, brakeRevision: input.brakeRevision };
  });

  return { inspect, recover };
}
