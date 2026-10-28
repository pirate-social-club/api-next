import { Effect } from "effect";
import type { Hex } from "viem";
import { validateMegapotUsdcTransferReceipt } from "./megapot-v2.ts";
import { rewardSafeCall, rewardSafeTransactionBuilderFile } from "./reward-safe-command.ts";
import { makeControlPlaneRewardSafeRefundStore } from "./reward-safe-refund-repository.ts";
import {
  admitRewardSafeDeployment,
  assertRewardSafeRuntimeOptions,
  type RewardSafeRuntimeOptions,
  readRewardSafeExecution,
  rewardSafeFailed,
} from "./reward-safe-settlement.ts";

/** Prepare original-sender refunds and reconcile owner executions. No signer or broadcaster. */
export function makeRewardSafeRefundCoordinator(options: RewardSafeRuntimeOptions) {
  assertRewardSafeRuntimeOptions(options);
  const store = makeControlPlaneRewardSafeRefundStore(options.layer);
  const rpc = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: () => rewardSafeFailed("rpc_unavailable"),
    });
  const prepare = Effect.fn("RewardSafeRefund.prepare")(function* (refundId: string) {
    const candidate = yield* store.loadCandidate(refundId);
    yield* admitRewardSafeDeployment(options, candidate.deployment);
    const head = yield* rpc(() => options.rpc.readHead());
    const prepared = yield* store.prepare(
      refundId,
      `safe-refund-${crypto.randomUUID()}`,
      head.blockNumber,
    );
    const call = rewardSafeCall({
      effectId: prepared.effectId,
      to: candidate.deployment.usdcAddress,
      data: prepared.data as Hex,
    });
    return {
      ...prepared,
      transactionBuilderFile: rewardSafeTransactionBuilderFile({
        chainId: candidate.deployment.chainId,
        safeAddress: candidate.deployment.custodyAddress,
        call,
        name: `Pirate refund ${refundId}`,
        description: `Return ${candidate.amountAtomic} atomic units to the original sender`,
        createdAtMs: (options.now ?? Date.now)(),
      }),
    };
  });
  const settle = Effect.fn("RewardSafeRefund.settle")(function* (effectId: string) {
    const candidate = yield* store.loadSettlement(effectId);
    if (candidate === null) return { kind: "not_bound" as const };
    yield* admitRewardSafeDeployment(options, candidate.deployment);
    const execution = yield* readRewardSafeExecution(options, {
      effectId,
      chainId: candidate.deployment.chainId,
      safeAddress: candidate.deployment.custodyAddress,
      to: candidate.deployment.usdcAddress,
      calldata: candidate.calldata as Hex,
      safeNonce: candidate.safeNonce,
      transactionHash: candidate.transactionHash,
      recordedOutcome: candidate.outcome,
      observedAt: candidate.observedAt,
    });
    if (execution.kind === "pending") return { kind: "pending" as const };
    if (execution.kind === "invalid") {
      yield* store.requireReconciliation(effectId, execution.reason);
      return { kind: "reconciliation_required" as const };
    }
    const evidence = {
      effectId,
      transactionHash: candidate.transactionHash,
      outcome: execution.outcome,
      blockNumber: execution.receipt.blockNumber.toString(),
      blockHash: execution.receipt.blockHash,
      receiptHash: execution.receiptHash,
      confirmations: execution.confirmations,
      confirmedAt: execution.confirmedAt,
    };
    if (execution.outcome === "failure") {
      yield* store.settle(evidence);
      return { kind: "released" as const };
    }
    let transfer: ReturnType<typeof validateMegapotUsdcTransferReceipt>;
    try {
      transfer = validateMegapotUsdcTransferReceipt({
        deployment: candidate.deployment,
        receipt: execution.receipt,
        recipient: candidate.destinationAddress,
        amountAtomic: candidate.amountAtomic,
        safeExecution: { command: execution.command, transaction: execution.transaction },
      });
    } catch {
      yield* store.requireReconciliation(effectId, "safe_refund_receipt_invalid");
      return { kind: "reconciliation_required" as const };
    }
    const balance = yield* rpc(() =>
      options.rpc.readUsdcBalance(
        candidate.deployment.custodyAddress,
        execution.receipt.blockNumber,
      ),
    );
    yield* store.settle({
      ...evidence,
      transferLogIndex: transfer.transferLogIndex,
      custodyBalanceAfterAtomic: balance.toString(),
    });
    return { kind: "confirmed" as const, transactionHash: candidate.transactionHash };
  });
  return { prepare, settle };
}
